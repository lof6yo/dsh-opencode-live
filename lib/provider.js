/**
 * The `opencode-live` subagent provider: one `opencode acp` child process per
 * delegation, driven over the Agent Client Protocol, with every meaningful
 * protocol event mirrored into the trace hub for the live panel.
 *
 * Unlike the stock ACP backend this client advertises
 * `_meta["opencode/child-session-updates"]`, so OpenCode also streams the
 * sessions its own agents spawn (fixer, explorer, …). Those updates stay in the
 * trace: the subagent result itself is still only the main session's final
 * assistant text.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const STARTUP_TIMEOUT_MS = 20000;
const CANCEL_GRACE_MS = 5000;
const EXIT_GRACE_MS = 3000;

/** Subagent backend that publishes its progress to the trace hub. */
export class LiveProvider {
  name = 'opencode-live';
  capabilities = {
    agentOptions: false,
    agentPreset: false,
    outputSchema: false,
    depthLimit: false,
  };
  inheritsParentContext = false;

  /**
   * @param {{ctx: import('@deepseek-ai/cordis').Context, config: object, hub: import('./trace.js').TraceHub}} parts
   */
  constructor({ ctx, config, hub }) {
    this.ctx = ctx;
    this.config = config;
    this.hub = hub;
  }

  /**
   * Establish one OpenCode ACP child and publish its run handle.
   * @param {object} request subagent start request from the seam
   * @returns {Promise<{id: string, result: Promise<object>, dispose: () => Promise<void>}>}
   */
  start(request) {
    return startRun({ ctx: this.ctx, request, config: this.config, hub: this.hub });
  }
}

/**
 * Resolve the OpenCode executable without requiring configuration.
 * @param {object} config resolved plugin config
 * @returns {string} executable path or bare command
 */
export function resolveCommand(config) {
  if (typeof config.command === 'string' && config.command.length > 0) return config.command;
  if (typeof process.env.OPENCODE_BIN === 'string' && process.env.OPENCODE_BIN.length > 0) {
    return process.env.OPENCODE_BIN;
  }
  const candidates = [join(homedir(), '.opencode', 'bin', 'opencode'), '/usr/local/bin/opencode', '/usr/bin/opencode'];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      }
    } catch {
      // keep looking
    }
  }
  return 'opencode';
}

function usableCwd(cwd) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
    throw new Error('opencode-live: the child working directory must be an absolute path');
  }
  let stat;
  try {
    stat = statSync(cwd);
  } catch {
    throw new Error('opencode-live: the child working directory does not exist');
  }
  if (!stat.isDirectory()) throw new Error('opencode-live: the child working directory is not a directory');
  return cwd;
}

/** Keep the child's environment useful but drop credential-shaped variables. */
function buildEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/(API_KEY|_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PASSWD|SSH_AUTH_SOCK|DATABASE_URL|GIT_ASKPASS)/i.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

/** Map DSH content blocks onto ACP prompt content. */
function toAcpPrompt(blocks) {
  const prompt = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      prompt.push({ type: 'text', text: block.text });
    } else if (block?.type === 'image' && typeof block.data === 'string') {
      prompt.push({ type: 'image', data: block.data, mimeType: block.mimeType ?? block.mediaType ?? 'image/png' });
    }
  }
  return prompt;
}

function contentText(content) {
  if (content?.type === 'text' && typeof content.text === 'string') return content.text;
  return '';
}

function foldStopReason(reason) {
  switch (reason) {
    case 'end_turn':
      return 'completed';
    case 'max_tokens':
      return 'max-tokens';
    case 'refusal':
      return 'refusal';
    case 'max_turn_requests':
      return 'max-turns';
    case 'cancelled':
      return 'aborted';
    default:
      return 'error';
  }
}

function failureDiagnostic(stage, category) {
  return `Subagent failure (provider: OpenCode Live; stage: ${stage}; category: ${category})`;
}

/**
 * Minimal newline-delimited JSON-RPC client for one ACP child.
 */
const MAX_RPC_LINE_BYTES = 8 * 1024 * 1024;

class RpcClient {
  #child;
  #buffer = '';
  #pending = new Map();
  #nextId = 1;
  #onNotification;
  #onRequest;
  #onFault;
  #methods;

  constructor(child, handlers) {
    this.#child = child;
    this.#onNotification = handlers.onNotification;
    this.#onRequest = handlers.onRequest;
    this.#onFault = handlers.onFault;
    this.#methods = handlers.methods ?? new Set();
    child.stdout.on('data', (chunk) => this.#feed(chunk));
  }

  request(method, params, timeoutMs) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      let timer;
      const entry = {
        resolve: (value) => {
          if (timer !== undefined) clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          if (timer !== undefined) clearTimeout(timer);
          reject(error);
        },
      };
      this.#pending.set(id, entry);
      if (typeof timeoutMs === 'number' && timeoutMs > 0) {
        timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }, timeoutMs);
      }
      if (!this.#write({ jsonrpc: '2.0', id, method, params })) {
        this.#pending.delete(id);
        if (timer !== undefined) clearTimeout(timer);
        reject(new Error(`cannot write ${method}: child stdin closed`));
      }
    });
  }

  notify(method, params) {
    this.#write({ jsonrpc: '2.0', method, params });
  }

  rejectAll(error) {
    for (const [id, entry] of this.#pending) {
      this.#pending.delete(id);
      entry.reject(error);
    }
  }

  #write(message) {
    try {
      if (this.#child.stdin.destroyed || !this.#child.stdin.writable) return false;
      return this.#child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      return false;
    }
  }

  #feed(chunk) {
    this.#buffer += chunk;
    if (this.#buffer.length > MAX_RPC_LINE_BYTES) {
      this.#buffer = '';
      this.#onFault?.(new Error('ACP output exceeded the line buffer limit'));
      return;
    }
    let index;
    while ((index = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.length === 0) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this.#dispatch(message);
    }
  }

  #dispatch(message) {
    if (message.id !== undefined && message.method === undefined) {
      const entry = this.#pending.get(message.id);
      if (entry === undefined) return;
      this.#pending.delete(message.id);
      if (message.error !== undefined) {
        const error = new Error(message.error?.message ?? 'JSON-RPC error');
        error.code = message.error?.code;
        error.data = message.error?.data;
        entry.reject(error);
      } else entry.resolve(message.result);
      return;
    }
    if (message.id !== undefined && typeof message.method === 'string') {
      if (!this.#methods.has(message.method)) {
        this.#write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
        return;
      }
      Promise.resolve()
        .then(() => this.#onRequest?.(message))
        .then((result) => this.#write({ jsonrpc: '2.0', id: message.id, result: result ?? {} }))
        .catch(() => this.#write({ jsonrpc: '2.0', id: message.id, result: {} }));
      return;
    }
    if (typeof message.method === 'string') this.#onNotification?.(message.method, message.params);
  }
}

function waitExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

async function startRun({ ctx, request, config, hub }) {
  if (request.signal.aborted) throw new Error('opencode-live: the request was aborted before the child started');

  const cwd = usableCwd(request.cwd);
  const prompt = toAcpPrompt(request.prompt);
  if (prompt.length === 0) throw new Error('opencode-live: the delegation carries no text to send');
  const command = resolveCommand(config);
  const id = randomUUID();
  const sessionId = typeof request.parent?.id === 'string' ? request.parent.id : undefined;
  hub.startRun({ id, cwd, command, sessionId });

  const child = spawn(command, config.args, {
    cwd,
    env: buildEnv(config.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    // Own process group so teardown can reclaim OpenCode's own children too.
    detached: process.platform !== 'win32',
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stderrTail = '';
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-2000);
  });

  try {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  } catch (error) {
    hub.event(id, 'error', { stage: 'spawn' });
    hub.finish(id, { status: 'error', stopReason: 'error' });
    throw new Error(`opencode-live: failed to spawn OpenCode: ${error.message}`);
  }

  const mainText = [];
  let settled = false;
  let cancelTimer;
  let resolveResult;
  const result = new Promise((resolve) => {
    resolveResult = resolve;
  });
  let mainSessionId;
  let teardownPromise;

  const signalTree = (signal) => {
    try {
      if (process.platform !== 'win32' && typeof child.pid === 'number') process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // already gone
    }
  };

  const teardown = () => {
    if (teardownPromise !== undefined) return teardownPromise;
    teardownPromise = (async () => {
      try {
        child.stdin.end();
      } catch {
        // already closed
      }
      if (await waitExit(child, 1500)) return;
      signalTree('SIGTERM');
      if (await waitExit(child, EXIT_GRACE_MS)) return;
      signalTree('SIGKILL');
      await waitExit(child, 1500);
    })();
    return teardownPromise;
  };

  const output = () => {
    const text = mainText.join('').trim();
    return text.length > 0 ? [{ type: 'text', text }] : [];
  };

  const finish = (value) => {
    if (settled) return;
    settled = true;
    if (cancelTimer !== undefined) clearTimeout(cancelTimer);
    request.signal?.removeEventListener?.('abort', onAbort);
    resolveResult(value);
  };

  const fail = (stage, category) => {
    if (settled) return;
    hub.event(id, 'error', { stage, category });
    if (typeof stderrTail === 'string' && stderrTail.trim().length > 0) {
      hub.event(id, 'note', { text: `stderr: ${stderrTail.trim().slice(-600)}` });
    }
    hub.finish(id, { status: 'error', stopReason: 'error' });
    finish({ output: output(), stopReason: 'error', diagnostic: failureDiagnostic(stage, category) });
    void teardown();
  };

  const onAbort = () => {
    if (settled) return;
    hub.event(id, 'status', { status: 'cancelling' });
    if (mainSessionId !== undefined) {
      try {
        rpc.notify('session/cancel', { sessionId: mainSessionId });
      } catch {
        // the child may already be gone
      }
    }
    cancelTimer = setTimeout(() => {
      if (settled) return;
      hub.event(id, 'status', { status: 'cancelled' });
      hub.finish(id, { status: 'done', stopReason: 'aborted' });
      finish({ output: output(), stopReason: 'aborted' });
      void teardown();
    }, CANCEL_GRACE_MS);
    cancelTimer.unref?.();
  };

  const pushTool = (update, kind) => {
    const raw = update.rawInput !== null && typeof update.rawInput === 'object' ? update.rawInput : {};
    hub.event(id, kind, {
      toolCallId: update.toolCallId,
      title: update.title,
      toolKind: update.kind,
      status: update.status,
      agent: typeof raw.agent === 'string' ? raw.agent : undefined,
      description: typeof raw.description === 'string' ? raw.description : undefined,
    });
  };

  let configEmitted = false;
  const applyConfig = (options) => {
    if (!Array.isArray(options)) return;
    const mode = options.find((option) => option?.category === 'mode')?.currentValue;
    const model = options.find((option) => option?.category === 'model')?.currentValue;
    configEmitted = true;
    hub.event(id, 'config', { mode, model });
  };

  const onChildUpdate = (params) => {
    if (params === null || typeof params !== 'object') return;
    if (params.type === 'status') {
      hub.event(id, 'child', {
        childSessionId: params.childSessionId,
        parentSessionId: params.parentSessionId,
        title: params.title,
        depth: params.depth,
        status: params.status,
      });
      return;
    }
    if (params.type !== 'update' || params.update === null || typeof params.update !== 'object') return;
    const update = params.update;
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      pushTool(update, 'child_tool');
      return;
    }
    if (update.sessionUpdate === 'agent_message_chunk') {
      const text = contentText(update.content);
      if (text.length > 0) hub.event(id, 'child_text', { childSessionId: params.childSessionId, text: text.slice(0, 400) });
    }
  };

  const onSessionUpdate = (params) => {
    if (params?.sessionId !== mainSessionId) return;
    const update = params.update;
    if (update === null || typeof update !== 'object') return;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = contentText(update.content);
        if (text.length > 0) mainText.push(text);
        return;
      }
      case 'agent_thought_chunk': {
        const text = contentText(update.content);
        if (text.length > 0) hub.event(id, 'thought', { text: text.slice(0, 600) });
        return;
      }
      case 'tool_call':
      case 'tool_call_update':
        pushTool(update, 'tool');
        return;
      case 'usage_update':
        hub.event(id, 'usage', { used: update.used, size: update.size, cost: update.cost });
        return;
      case 'config_option_update':
        applyConfig(update.configOptions);
        return;
      case 'current_mode_update':
        hub.event(id, 'config', { mode: update.currentModeId });
        return;
      default:
        return;
    }
  };

  const pickOption = (options, kinds) => {
    for (const kind of kinds) {
      const found = options.find((option) => option.kind === kind);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  const askPermission = async ({ toolTitle, toolKind }) => {
    const questions = typeof ctx.get === 'function' ? ctx.get('userQuestions') : undefined;
    if (request.signal.aborted || settled) {
      return { decision: 'cancel', source: 'run-cancelled' };
    }
    if (questions === undefined || typeof questions.ask !== 'function') {
      return { decision: config.askFallback, source: 'no-question-service' };
    }
    const question = toolTitle === undefined
      ? `OpenCode 请求使用 ${toolKind ?? '工具'}`
      : `OpenCode 请求权限：${toolTitle}`;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    request.signal?.addEventListener?.('abort', onAbort, { once: true });
    let timer;
    const timeout = new Promise((_, reject) => {
      if (typeof config.askTimeoutMs !== 'number' || config.askTimeoutMs <= 0) return;
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('question timeout'));
      }, config.askTimeoutMs);
      timer.unref?.();
    });
    try {
      const answer = await Promise.race([
        questions.ask({
          agent: request.parent,
          signal: controller.signal,
          questions: [{
            id: 'opencode-permission',
            header: 'OpenCode 权限',
            question,
            options: [
              { label: '允许一次' },
              { label: '始终允许' },
              { label: '拒绝' },
            ],
          }],
        }),
        timeout,
      ]);
      const selected = answer?.answers?.find((item) => item.id === 'opencode-permission')?.selected?.[0];
      if (selected === '始终允许') return { decision: 'always', source: 'question:always' };
      if (selected === '允许一次') return { decision: 'allow', source: 'question:once' };
      return { decision: 'reject', source: 'question:reject' };
    } catch (error) {
      if (request.signal.aborted) return { decision: 'cancel', source: 'run-cancelled' };
      return {
        decision: config.askFallback,
        source: /timeout/.test(String(error?.message ?? '')) ? 'question-timeout' : 'question-unavailable',
      };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener?.('abort', onAbort);
    }
  };

  const onRequest = async (message) => {
    if (message.method !== 'session/request_permission') return {};
    const params = message.params ?? {};
    const options = Array.isArray(params.options) ? params.options : [];
    const toolTitle = params.toolCall?.title;
    const toolKind = params.toolCall?.kind;
    let decision = config.permission;
    let source = 'config';

    if (decision === 'ask') {
      hub.event(id, 'permission', { tool: toolTitle, decision: 'asking' });
      const outcome = await askPermission({ toolTitle, toolKind });
      decision = outcome.decision;
      source = outcome.source;
      if (source === 'question-timeout' || source === 'question-unavailable' || source === 'no-question-service') {
        hub.event(id, 'note', { text: `未能向用户请求权限（${source}），按 ${decision} 处理` });
      }
    }

    if (decision === 'cancel') {
      hub.event(id, 'permission', { tool: toolTitle, decision: 'cancelled', source });
      return { outcome: { outcome: 'cancelled' } };
    }

    let chosen;
    if (decision === 'always') chosen = pickOption(options, ['allow_always', 'allow_once']);
    else if (decision === 'allow') chosen = pickOption(options, ['allow_once', 'allow_always']) ?? options[0];
    else chosen = pickOption(options, ['reject_once', 'reject_always']);

    hub.event(id, 'permission', {
      tool: toolTitle,
      decision,
      source,
      option: chosen?.kind,
    });
    return chosen !== undefined
      ? { outcome: { outcome: 'selected', optionId: chosen.optionId } }
      : { outcome: { outcome: 'cancelled' } };
  };
  const rpc = new RpcClient(child, {
    methods: new Set(['session/request_permission']),
    onFault: () => fail('prompt', 'protocol-overflow'),
    onNotification: (method, params) => {
      if (method === 'session/update') onSessionUpdate(params);
      else if (method === 'opencode/session/child_update') onChildUpdate(params);
    },
    onRequest,
  });

  child.on('exit', () => {
    rpc.rejectAll(new Error('opencode child exited'));
    if (!settled) fail('prompt', 'process-exit');
  });

  let init;
  let session;
  try {
    const startup = (async () => {
      const initResult = await rpc.request(
        'initialize',
        { protocolVersion: 1, clientCapabilities: { _meta: { 'opencode/child-session-updates': true } } },
        STARTUP_TIMEOUT_MS,
      );
      const sessionResult = await rpc.request('session/new', { cwd, mcpServers: [] }, STARTUP_TIMEOUT_MS);
      return { initResult, sessionResult };
    })();
    let rejectStartup;
    const aborted = new Promise((_, reject) => {
      rejectStartup = reject;
    });
    const onStartupAbort = () => rejectStartup(new Error('aborted'));
    if (request.signal.aborted) onStartupAbort();
    else request.signal.addEventListener('abort', onStartupAbort, { once: true });
    try {
      const started = await Promise.race([startup, aborted]);
      init = started.initResult;
      session = started.sessionResult;
    } finally {
      request.signal.removeEventListener('abort', onStartupAbort);
    }
  } catch (error) {
    settled = true;
    hub.event(id, 'error', { stage: 'startup' });
    hub.finish(id, { status: 'error', stopReason: 'error' });
    await teardown();
    throw new Error(`opencode-live: OpenCode ACP startup failed: ${error.message}`);
  }

  mainSessionId = session.sessionId;
  if (typeof mainSessionId !== 'string') {
    fail('startup', 'missing-session');
    throw new Error('opencode-live: OpenCode returned no session id');
  }

  hub.event(id, 'session', { agent: init?.agentInfo?.name, version: init?.agentInfo?.version });
  if (config.mode === undefined && config.model === undefined) applyConfig(session.configOptions);

  // ACP starts the session on the provider's default model and agent, ignoring
  // the configured agent -> model mapping (TUI does honor it). Pin them through
  // the session config options when the plugin config asks for it.
  const chooseOption = async (configId, value) => {
    if (typeof value !== 'string' || value.length === 0) return;
    const options = Array.isArray(session.configOptions) ? session.configOptions : [];
    const current = options.find((option) => option?.id === configId || option?.category === configId)?.currentValue;
    if (current === value) return;
    try {
      const updated = await rpc.request(
        'session/set_config_option',
        { sessionId: mainSessionId, configId, value },
        STARTUP_TIMEOUT_MS,
      );
      applyConfig(updated?.configOptions);
      hub.event(id, 'note', { text: `${configId} → ${value}` });
    } catch (error) {
      // An explicit pin that cannot be applied must fail closed: silently running
      // on a different model/agent would hide a cost/behaviour change.
      hub.event(id, 'note', { text: `${configId} 无法设为 ${value}，本次委派终止` });
      fail('startup', `pin-${configId}`);
      throw new Error(`opencode-live: could not pin ${configId}=${value}: ${error?.message ?? error}`);
    }
  };
  if (request.signal.aborted) onAbort();
  else request.signal?.addEventListener?.('abort', onAbort, { once: true });

  await chooseOption('mode', config.mode);
  await chooseOption('model', config.model);
  if (!configEmitted) applyConfig(session.configOptions);

  void rpc
    .request('session/prompt', { sessionId: mainSessionId, prompt }, config.promptTimeoutMs)
    .then((response) => {
      if (settled) return;
      const stopReason = foldStopReason(response?.stopReason);
      const text = mainText.join('').trim();
      hub.event(id, 'done', { stopReason, output: text.slice(0, 20000), usage: response?.usage });
      hub.finish(id, { status: stopReason === 'error' ? 'error' : 'done', stopReason });
      finish({ output: output(), stopReason });
      void teardown();
    })
    .catch((error) => {
      if (settled) return;
      const message = String(error?.message ?? '');
      if (/exited/.test(message)) return;
      fail('prompt', /timeout/i.test(message) ? 'timeout' : 'protocol');
    });

  return {
    id,
    result,
    dispose: async () => {
      if (!settled) {
        hub.finish(id, { status: 'done', stopReason: 'aborted' });
        finish({ output: output(), stopReason: 'aborted' });
      }
      await teardown();
    },
  };
}
