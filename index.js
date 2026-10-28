/**
 * `opencode-live` bundle plugin.
 *
 * Registers one subagent provider (`opencode-live`, which drives `opencode acp`)
 * and the trace data route the native Client panel reads (`/opencode-live/state`
 * snapshot, `/opencode-live/events` SSE). The browser renders the panel itself;
 * this route carries data only.
 *
 * @module dsh-opencode-live
 */

import { LiveProvider } from './lib/provider.js';
import { TraceHub } from './lib/trace.js';

export const name = 'opencode-live';
export const inject = ['subagents', 'webServer'];

/**
 * Install the provider and the panel route.
 *
 * Both registrations go through `ctx.effect` so Cordis owns their disposal:
 * disabling or reloading this row must unregister the route before the next
 * activation registers it again.
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
    handler: createHandler(resolved, hub),
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
    permission: config.permission === 'reject' ? 'reject' : 'allow',
    env: config.env !== null && typeof config.env === 'object' ? config.env : {},
    mode: typeof config.mode === 'string' && config.mode.length > 0 ? config.mode : undefined,
    model: typeof config.model === 'string' && config.model.length > 0 ? config.model : undefined,
  };
}

function createHandler(config, hub) {
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
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  };
}

/** Base path: a small machine-readable statement, not the removed HTML page. */
function serveInfo(res) {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify({ ok: true, panel: 'native', state: 'state', events: 'events' }));
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
