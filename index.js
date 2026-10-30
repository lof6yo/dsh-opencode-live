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

import { homedir } from 'node:os';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { createHistory } from './lib/history.js';
import { LiveProvider } from './lib/provider.js';
import { TraceHub } from './lib/trace.js';

export const name = 'opencode-live';
export const inject = ['subagents', 'webServer'];

/** Keys the settings page may write back. */
const EDITABLE_KEYS = ['model', 'mode', 'permission', 'askFallback', 'askTimeoutMs'];
const PERMISSION_VALUES = new Set(['ask', 'allow', 'reject']);
const ASK_FALLBACK_VALUES = new Set(['reject', 'allow']);
const MAX_TIMEOUT_MS = 0x7fffffff;

/**
 * Loader-row configuration. Declaring it gives the row a real schema, so the
 * settings page can render typed fields and persist them through the profile
 * patch layer instead of hand-edited YAML.
 */
export const Config = z.object({
  command: z.string().description('OpenCode executable; omit to use $OPENCODE_BIN, ~/.opencode/bin/opencode, or PATH.'),
  args: z.array(z.string()).default(['acp']).description('Arguments passed to the executable.'),
  permission: z.union(['ask', 'allow', 'reject']).default('ask')
    .description('How to answer OpenCode ACP permission requests: ask (a DSH question card with allow once / allow always / reject), allow (auto-approve), or reject (read-only).'),
  askFallback: z.union(['reject', 'allow']).default('reject')
    .description('When permission is ask and the question cannot reach the user (no answerer, timeout, cancelled run): fall back to this decision.'),
  askTimeoutMs: z.number().default(600000)
    .description('How long an ask question may stay unanswered, in milliseconds; 0 waits forever. After it, askFallback applies.'),
  promptTimeoutMs: z.number().default(1800000)
    .description('Hard upper bound for one OpenCode turn, in milliseconds; 0 disables the bound.'),
  historyRuns: z.number().default(30)
    .description('Runs kept on disk across restarts; 0 disables persistence.'),
  historyDays: z.number().default(7)
    .description('Drop persisted runs older than this many days; 0 keeps them until the run cap.'),
  historyEvents: z.number().default(200)
    .description('Events persisted per run (the newest ones).'),
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
  let history;
  const hub = new TraceHub({ onFinish: (runs) => history?.schedule(runs) });
  history = createHistory({
    file: join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'opencode-live', 'history.json'),
    maxRuns: resolved.historyRuns,
    maxEventsPerRun: resolved.historyEvents,
    retentionDays: resolved.historyDays,
    logger: ctx.logger,
  });
  const ready = history.load()
    .then((runs) => {
      hub.restore(runs);
    })
    .catch((error) => {
      ctx.logger?.warn?.(`opencode-live: history load failed: ${error?.message ?? error}`);
    });
  const provider = new LiveProvider({ ctx, config: resolved, hub });

  ctx.effect(() => ctx.subagents.registerProvider(provider));
  ctx.effect(() => () => {
    void history.flush();
  });
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: resolved.path,
    handler: createHandler(resolved, hub, ctx, ready),
  }));

  try {
    const origin = ctx.webServer.getOrigin();
    ctx.logger.info(`opencode-live: trace panel at ${origin}${resolved.path}`);
  } catch (error) {
    // getOrigin throws before the listener binds; the route still works afterwards.
    ctx.logger.debug?.(`opencode-live: panel origin unavailable: ${error?.message ?? error}`);
  }
}

function clampInt(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function normalizeConfig(config) {
  const raw = typeof config.path === 'string' && config.path.startsWith('/')
    ? config.path.replace(/\/+$/, '')
    : '';
  const path = raw.length > 0 ? raw : '/opencode-live';
  return {
    path,
    command: typeof config.command === 'string' && config.command.length > 0 ? config.command : undefined,
    args: Array.isArray(config.args) ? config.args.map((value) => String(value)) : ['acp'],
    permission: config.permission === 'allow' || config.permission === 'reject' ? config.permission : 'ask',
    askFallback: config.askFallback === 'allow' ? 'allow' : 'reject',
    askTimeoutMs: typeof config.askTimeoutMs === 'number' && Number.isFinite(config.askTimeoutMs) && config.askTimeoutMs >= 0
      ? Math.min(config.askTimeoutMs, MAX_TIMEOUT_MS)
      : 600000,
    promptTimeoutMs: typeof config.promptTimeoutMs === 'number' && Number.isFinite(config.promptTimeoutMs) && config.promptTimeoutMs >= 0
      ? Math.min(config.promptTimeoutMs, MAX_TIMEOUT_MS)
      : 1800000,
    historyRuns: clampInt(config.historyRuns, 0, 50, 30),
    historyDays: clampInt(config.historyDays, 0, 365, 7),
    historyEvents: clampInt(config.historyEvents, 0, 600, 200),
    env: config.env !== null && typeof config.env === 'object' ? config.env : {},
    mode: typeof config.mode === 'string' && config.mode.length > 0 ? config.mode : undefined,
    model: typeof config.model === 'string' && config.model.length > 0 ? config.model : undefined,
  };
}

function createHandler(config, hub, ctx, ready) {
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
    if (path === `${config.path}/state`) {
      void ready.then(() => serveState(res, hub, sessionId)).catch(() => {});
      return undefined;
    }
    if (path === `${config.path}/events`) {
      void ready.then(() => serveEvents(req, res, hub, sessionId)).catch(() => {});
      return undefined;
    }
    if (path === `${config.path}/config`) {
      if (req.method === 'GET' || req.method === undefined) return serveConfig(res, ctx);
      if (req.method === 'POST') {
        if (!sameOriginRequest(req)) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'forbidden' }));
          return undefined;
        }
        if (!isJsonRequest(req)) {
          res.writeHead(415, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'content-type-must-be-application-json' }));
          return undefined;
        }
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

const MAX_SSE_SUBSCRIBERS = 20;

function serveEvents(req, res, hub, sessionId) {
  if (hub.subscriberCount >= MAX_SSE_SUBSCRIBERS) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('too many panel subscribers');
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': opencode-live\n\n');

  let saturated = false;
  const send = (payload) => {
    // One slow browser must not grow the socket buffer without bound: while the
    // stream is saturated, high-frequency event frames are dropped (the client
    // re-syncs from the next snapshot).
    if (saturated && payload !== undefined && payload.type === 'event') return;
    if (!res.write(`data: ${JSON.stringify(payload)}\n\n`)) saturated = true;
  };
  res.on('drain', () => {
    saturated = false;
  });
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

/** Browsers send Sec-Fetch-Site same-origin or an Origin header for same-origin POSTs. */
function sameOriginRequest(req) {
  const site = req.headers['sec-fetch-site'];
  if (site === 'same-origin') return true;
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (typeof origin !== 'string' || origin.length === 0) return false;
  try {
    return typeof host === 'string' && new URL(origin).host === host;
  } catch {
    return false;
  }
}

function isJsonRequest(req) {
  const type = String(req.headers['content-type'] ?? '').toLowerCase();
  return type.startsWith('application/json');
}

/** Validate the editable subset; unknown keys are ignored, wrong types are reported. */
function sanitizePatch(body) {
  const patch = {};
  const clear = [];
  const errors = [];
  if (body === null || typeof body !== 'object') return { patch, clear, errors: ['body'] };
  for (const key of EDITABLE_KEYS) {
    if (!Object.hasOwn(body, key)) continue;
    const value = body[key];
    if (key === 'model' || key === 'mode') {
      if (value === '' || value === null) clear.push(key);
      else if (typeof value !== 'string' || value.length > 200) errors.push(key);
      else patch[key] = value;
    } else if (key === 'permission') {
      if (!PERMISSION_VALUES.has(value)) errors.push(key);
      else patch[key] = value;
    } else if (key === 'askFallback') {
      if (!ASK_FALLBACK_VALUES.has(value)) errors.push(key);
      else patch[key] = value;
    } else if (key === 'askTimeoutMs') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_TIMEOUT_MS) errors.push(key);
      else patch[key] = value;
    }
  }
  return { patch, clear, errors };
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
    if (ids.some((id) => id === 'opencode-live' || id.endsWith(':opencode-live'))) {
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
    const tooLarge = error?.code === 'TOO_LARGE';
    res.writeHead(tooLarge ? 413 : 400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: tooLarge ? 'body-too-large' : 'invalid-json' }));
    return;
  }
  const editor = editorOf(ctx);
  const row = editor === undefined ? undefined : rowOf(editor);
  if (editor === undefined || row === undefined) {
    res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'no-config-editor' }));
    return;
  }
  const { patch, clear, errors } = sanitizePatch(body);
  if (errors.length > 0) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'invalid-value', fields: errors }));
    return;
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
    let tooLarge = false;
    let finished = false;
    const chunks = [];
    const fail = (error) => {
      if (finished) return;
      finished = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        const error = new Error('body too large');
        error.code = 'TOO_LARGE';
        fail(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (finished) return;
      finished = true;
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text.length === 0 ? {} : JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    req.on('aborted', () => fail(new Error('request aborted')));
    req.on('error', fail);
  });
}
