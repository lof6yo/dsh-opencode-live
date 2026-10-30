/**
 * Durable run history for the OpenCode Live panel.
 *
 * The hub keeps runs in memory; this module mirrors a bounded copy to disk so a
 * restarted DSH still shows recent delegations. Loading and every write apply
 * the same cleanup rules — age cutoff, run count, events per run, total bytes —
 * so the file cannot grow without limit, a stale file is pruned instead of
 * trusted, and an interrupted run never comes back looking green.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {{file: string, maxRuns?: number, maxEventsPerRun?: number,
 *   retentionDays?: number, maxBytes?: number, debounceMs?: number,
 *   logger?: {warn?: (message: string) => void}}} options
 */
export function createHistory({
  file,
  maxRuns = 30,
  maxEventsPerRun = 200,
  retentionDays = 7,
  maxBytes = 2 * 1024 * 1024,
  debounceMs = 1000,
  logger,
} = {}) {
  if (typeof file !== 'string' || file.length === 0) throw new Error('history: file is required');
  let timer;
  let pending;
  let disposed = false;

  const cutoff = () => (retentionDays > 0 ? Date.now() - retentionDays * DAY_MS : 0);

  function normalize(view) {
    if (view === null || typeof view !== 'object' || typeof view.id !== 'string') return undefined;
    const events = Array.isArray(view.events)
      ? view.events.filter((event) => event !== null && typeof event === 'object').slice(-maxEventsPerRun)
      : [];
    const interrupted = view.status === 'running';
    return {
      id: view.id,
      cwd: typeof view.cwd === 'string' ? view.cwd : '',
      command: typeof view.command === 'string' ? view.command : 'opencode',
      sessionId: typeof view.sessionId === 'string' ? view.sessionId : undefined,
      startedAt: Number.isFinite(view.startedAt) ? view.startedAt : Date.now(),
      finishedAt: Number.isFinite(view.finishedAt)
        ? view.finishedAt
        : (interrupted ? undefined : Date.now()),
      // A run cut off by a host restart did not complete; show it finished.
      status: interrupted ? 'done' : (view.status === 'error' ? 'error' : 'done'),
      stopReason: interrupted
        ? 'aborted'
        : (typeof view.stopReason === 'string' ? view.stopReason : 'completed'),
      mode: typeof view.mode === 'string' ? view.mode : undefined,
      model: typeof view.model === 'string' ? view.model : undefined,
      events,
    };
  }

  /** Age cutoff, newest-first count cap, per-run event cap. */
  function trim(runs) {
    const floor = cutoff();
    const kept = [];
    for (const view of runs) {
      const run = normalize(view);
      if (run === undefined) continue;
      if (retentionDays > 0 && run.startedAt < floor) continue;
      kept.push(run);
      if (kept.length >= maxRuns) break;
    }
    return kept;
  }

  /** @returns {Promise<Array<Record<string, unknown>>>} newest first. */
  async function load() {
    if (maxRuns <= 0) return [];
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      return [];
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed === null || parsed.version !== VERSION || !Array.isArray(parsed.runs)) return [];
      return trim(parsed.runs);
    } catch {
      logger?.warn?.(`opencode-live: ignoring unreadable history file ${file}`);
      return [];
    }
  }

  async function save(runs) {
    if (maxRuns <= 0) return;
    const payload = { version: VERSION, savedAt: Date.now(), runs: trim(runs) };
    let text = JSON.stringify(payload);
    while (text.length > maxBytes && payload.runs.length > 0) {
      payload.runs.pop();
      text = JSON.stringify(payload);
    }
    if (payload.runs.length === 0) return;
    try {
      await mkdir(dirname(file), { recursive: true });
      const temporary = `${file}.tmp`;
      await writeFile(temporary, text, { mode: 0o600 });
      await rename(temporary, file);
    } catch (error) {
      logger?.warn?.(`opencode-live: history write failed: ${error?.message ?? error}`);
    }
  }

  /** Debounced write: several runs finishing together cost one disk write. */
  function schedule(runs) {
    if (disposed || maxRuns <= 0) return;
    pending = runs;
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      const next = pending;
      pending = undefined;
      if (next !== undefined) void save(next);
    }, debounceMs);
    timer.unref?.();
  }

  async function flush() {
    disposed = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const next = pending;
    pending = undefined;
    if (next !== undefined) await save(next);
  }

  return { load, schedule, flush };
}
