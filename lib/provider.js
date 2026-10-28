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
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const STARTUP_TIMEOUT_MS = 20000;
const CANCEL_GRACE_MS = 5000;
const EXIT_GRACE_MS = 3000;
const MAX_DIAGNOSTIC_BYTES = 4096;

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
      if (statSync(candidate).isFile()) return candidate;
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
    if (/(API_KEY|_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PASSWD)/i.test(key)) continue;
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
  if (prompt.length === 0) prompt.push({ type: 'text', text: '' });
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
    case 'cancelled':
      return 'aborted';
    default:
      return 'error';
  }
}

function failureDiagnostic(stage, category) {
  const text = `Subagent failure (provider: OpenCode Live; stage: ${stage}; category: ${category})`;
  return Buffer.byteLength(text) > MAX_DIAGNOSTIC_BYTES ? text.slice(0, MAX_DIAGNOSTIC_BYTES) : text;
}

/**
 * Minimal newline-delimited JSON-RPC client for one ACP child.
 */
class RpcClient {
  #child;
  #buffer = '';
  #pending = new Map();
  #nextId = 1;
  #onNotification;
  #onRequest;

  constructor(child, handlers) {
    this.#child = child;
    this.#onNotification = handlers.onNotification;
    this.#onRequest = handlers.onRequest;
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
      this.#write({ jsonrpc: '2.0', id, method, params });
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
      if (this.#child.stdin.destroyed || !this.#child.stdin.writable) return;
      this.#child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // The exit handler settles the run.
    }
  }

  #feed(chunk) {
    this.#buffer += chunk;
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
      if (message.error !== undefined) entry.reject(new Error(message.error?.message ?? 'JSON-RPC error'));
      else entry.resolve(message.result);
      return;
    }
    if (message.id !== undefined && typeof message.method === 'string') {
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
  const command = resolveCommand(config);
  const id = randomUUID();
  const sessionId = typeof request.parent?.id === 'string' ? request.parent.id : undefined;
  hub.startRun({ id, cwd, command, sessionId });

  const child = spawn(command, config.args, {
    cwd,
    env: buildEnv(config.env),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', () => {
    // stderr is inherited by the host's stream in the stock backend; here it is
    // deliberately not copied into trace events, which may be viewed remotely.
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
  let resolveResult;
  const result = new Promise((resolve) => {
    resolveResult = resolve;
  });
  let mainSessionId;
  let teardownPromise;

  const teardown = () => {
    if (teardownPromise !== undefined) return teardownPromise;
    teardownPromise = (async () => {
      try {
        child.stdin.end();
      } catch {
        // already closed
      }
      if (await waitExit(child, 1500)) return;
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
      if (await waitExit(child, EXIT_GRACE_MS)) return;
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
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
    request.signal?.removeEventListener?.('abort', onAbort);
    resolveResult(value);
  };

  const fail = (stage, category) => {
    if (settled) return;
    hub.event(id, 'error', { stage, category });
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
    const timer = setTimeout(() => {
      if (settled) return;
      hub.event(id, 'status', { status: 'cancelled' });
      hub.finish(id, { status: 'done', stopReason: 'aborted' });
      finish({ output: output(), stopReason: 'aborted' });
      void teardown();
    }, CANCEL_GRACE_MS);
    timer.unref?.();
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

  const applyConfig = (options) => {
    if (!Array.isArray(options)) return;
    const mode = options.find((option) => option?.category === 'mode')?.currentValue;
    const model = options.find((option) => option?.category === 'model')?.currentValue;
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

  const onRequest = (message) => {
    if (message.method !== 'session/request_permission') return {};
    const params = message.params ?? {};
    const options = Array.isArray(params.options) ? params.options : [];
    let chosen;
    if (config.permission === 'reject') {
      chosen = options.find((option) => option.kind === 'reject_once') ?? options.find((option) => option.kind === 'reject_always');
    } else {
      chosen = options.find((option) => option.kind === 'allow_once')
        ?? options.find((option) => option.kind === 'allow_always')
        ?? options[0];
    }
    hub.event(id, 'permission', {
      tool: params.toolCall?.title,
      decision: config.permission,
      option: chosen?.kind,
    });
    return chosen !== undefined
      ? { outcome: { outcome: 'selected', optionId: chosen.optionId } }
      : { outcome: { outcome: 'cancelled' } };
  };

  const rpc = new RpcClient(child, {
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
    const aborted = new Promise((_, reject) => {
      if (request.signal.aborted) reject(new Error('aborted'));
      else request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    const started = await Promise.race([startup, aborted]);
    init = started.initResult;
    session = started.sessionResult;
  } catch (error) {
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
  applyConfig(session.configOptions);
  request.signal?.addEventListener?.('abort', onAbort, { once: true });

  void rpc
    .request('session/prompt', { sessionId: mainSessionId, prompt: toAcpPrompt(request.prompt) }, 0)
    .then((response) => {
      if (settled) return;
      const stopReason = foldStopReason(response?.stopReason);
      const text = mainText.join('').trim();
      hub.event(id, 'done', { stopReason, output: text.slice(0, 20000), usage: response?.usage });
      hub.finish(id, { status: 'done', stopReason });
      finish({ output: output(), stopReason });
      void teardown();
    })
    .catch((error) => {
      if (settled) return;
      if (/exited/.test(error?.message ?? '')) return;
      fail('prompt', 'protocol');
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
