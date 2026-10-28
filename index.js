/**
 * `opencode-live` bundle plugin.
 *
 * Registers one subagent provider (`opencode-live`, which drives `opencode acp`)
 * and the trace/config routes the native Client panel reads:
 *
 *   GET  <path>/state    – run snapshot (optionally ?sessionId=…)
 *   GET  <path>/events   – SSE stream (optionally ?sessionId=…)
 *   GET  <path>/config   – the row's editable configuration
 *   POST <path>/config   – persist configuration through the config editor
 *
 * The browser renders all UI; these routes carry data only.
 *
 * @module dsh-opencode-live
 */

import z from '@deepseek-ai/schemastery';
import { LiveProvider } from './lib/provider.js';
import { TraceHub } from './lib/trace.js';

export const name = 'opencode-live';
export const inject = ['subagents', 'webServer'];

/** Keys the settings page may write back. */
const EDITABLE_KEYS = ['command', 'args', 'permission', 'env', 'path', 'model', 'mode'];

/**
 * Loader-row configuration. Declaring it gives the row a real schema, so the
 * settings page can render typed fields and persist them through the profile
 * patch layer instead of hand-edited YAML.
 */
export const Config = z.object({
  command: z.string().description('OpenCode executable; omit to use $OPENCODE_BIN, ~/.opencode/bin/opencode, or PATH.'),
  args: z.array(z.string()).default(['acp']).description('Arguments passed to the executable.'),
  permission: z.union(['ask', 'allow', 'reject']).default('ask')
    .description('How to answer OpenCode ACP permission requests: ask (DSH user approval), allow (auto-approve), or reject (read-only).'),
  askFallback: z.union(['reject', 'allow']).default('reject')
    .description('When permission is ask and the approval cannot be requested (no open turn, no answerer): fall back to this decision.'),
  env: z.dict(z.string()).default({}).description('Extra environment for the child, merged after credential scrubbing.'),
  path: z.string().default('/opencode-live').description('Route that serves the panel data (state + SSE).'),
  model: z.string().description('Pin the ACP session model, e.g. opencode-go/deepseek-v4.1-flash. Omit to keep the OpenCode default.'),
  mode: z.string().description('Pin the ACP session agent (mode), e.g. orchestrator. Omit to keep the OpenCode default.'),
});

/**
 * Install the provider and the panel routes.
 *
 * Registrations go through `ctx.effect` so Cordis owns their disposal: disabling
 * or reloading this row must unregister the route before the next activation
 * registers it again.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config] loader row config
 */
export function apply(ctx, config = {}) {
  const resolved = normalizeConfig(config);
  const hub = new TraceHub();
  const provider = new LiveProvider({ ctx, config: resolved, hub });

  ctx.effect(() => ctx.subagents.registerProvider(provider));
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: resolved.path,
    handler: createHandler(resolved, hub, ctx),
  }));

  try {
    const origin = ctx.webServer.getOrigin();
    ctx.logger.info(`opencode-live: trace panel at ${origin}${resolved.path}`);
  } catch {
    // getOrigin throws before the listener binds; the route still works afterwards.
  }
}

function normalizeConfig(config) {
  const path = typeof config.path === 'string' && config.path.startsWith('/')
    ? config.path.replace(/\/+$/, '')
    : '/opencode-live';
  return {
    path,
    command: typeof config.command === 'string' && config.command.length > 0 ? config.command : undefined,
    args: Array.isArray(config.args) ? config.args.map((value) => String(value)) : ['acp'],
    permission: config.permission === 'allow' || config.permission === 'reject' ? config.permission : 'ask',
    askFallback: config.askFallback === 'allow' ? 'allow' : 'reject',
    env: config.env !== null && typeof config.env === 'object' ? config.env : {},
    mode: typeof config.mode === 'string' && config.mode.length > 0 ? config.mode : undefined,
    model: typeof config.model === 'string' && config.model.length > 0 ? config.model : undefined,
  };
}

function createHandler(config, hub, ctx) {
  return (req, res) => {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('bad request');
      return;
    }
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const sessionId = url.searchParams.get('sessionId') ?? undefined;
    if (path === config.path) return serveInfo(res);
    if (path === `${config.path}/state`) return serveState(res, hub, sessionId);
    if (path === `${config.path}/events`) return serveEvents(req, res, hub, sessionId);
    if (path === `${config.path}/config`) {
      if (req.method === 'GET' || req.method === undefined) return serveConfig(res, ctx);
      if (req.method === 'POST') {
        void saveConfigRoute(req, res, ctx);
        return undefined;
      }
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('method not allowed');
      return undefined;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return undefined;
  };
}

/** Base path: a small machine-readable statement. */
function serveInfo(res) {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify({ ok: true, panel: 'native', state: 'state', events: 'events', config: 'config' }));
}

function serveState(res, hub, sessionId) {
  const body = JSON.stringify({ runs: hub.snapshot(sessionId) });
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function serveEvents(req, res, hub, sessionId) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': opencode-live\n\n');

  const send = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  send({ type: 'snapshot', runs: hub.snapshot(sessionId) });

  const unsubscribe = hub.subscribe(send, sessionId);
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 15000);
  heartbeat.unref?.();

  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on('close', close);
  req.on('error', close);
  res.on('error', close);
}

function editorOf(ctx) {
  return typeof ctx.get === 'function' ? ctx.get('configEditor') : undefined;
}

function rowOf(editor) {
  const rows = typeof editor?.configuration === 'function' ? editor.configuration() : [];
  for (const row of rows) {
    const entry = row?.entry ?? row;
    const ids = [entry?.id, entry?.options?.id, entry?.options?.patchId]
      .filter((value) => typeof value === 'string');
    if (ids.some((id) => id === 'opencode-live' || id.endsWith('opencode-live') || id.endsWith(':opencode-live'))) {
      return row;
    }
  }
  return undefined;
}

function readConfig(ctx) {
  const editor = editorOf(ctx);
  if (editor === undefined) return { writable: false, values: {} };
  const row = rowOf(editor);
  if (row === undefined) return { writable: false, values: {} };
  const merged = { ...(row.inherited ?? {}), ...(row.override ?? {}) };
  const values = {};
  for (const key of EDITABLE_KEYS) {
    if (merged[key] !== undefined) values[key] = merged[key];
  }
  return { writable: true, values };
}

function serveConfig(res, ctx) {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(readConfig(ctx)));
}

async function saveConfigRoute(req, res, ctx) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'invalid-json' }));
    return;
  }
  const editor = editorOf(ctx);
  const row = editor === undefined ? undefined : rowOf(editor);
  if (editor === undefined || row === undefined) {
    res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'no-config-editor' }));
    return;
  }
  const patch = {};
  const clear = [];
  if (body !== null && typeof body === 'object') {
    for (const key of EDITABLE_KEYS) {
      if (!Object.hasOwn(body, key)) continue;
      const value = body[key];
      if ((key === 'model' || key === 'mode') && (value === '' || value === null)) {
        clear.push(key);
        continue;
      }
      patch[key] = value;
    }
  }
  if (Object.keys(patch).length === 0 && clear.length === 0) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'nothing-to-save' }));
    return;
  }
  // Answer first: the write reconciles the Loader and may reload this plugin.
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, saved: patch }));
  void Promise.resolve()
    .then(() => editor.edit(row.entry, (current) => {
      const next = { ...current, ...patch };
      for (const key of clear) delete next[key];
      return next;
    }))
    .catch((error) => {
      ctx.logger?.warn?.(`opencode-live: config save failed: ${error?.message ?? error}`);
    });
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text.length === 0 ? {} : JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}
