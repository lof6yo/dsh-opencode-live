/**
 * In-memory run registry and SSE fan-out for the OpenCode Live panel.
 *
 * Each delegated run owns an ordered event list and the DSH session that
 * started it; browsers receive one snapshot on connect and then one framed
 * message per event. A subscriber may scope itself to one session, so a panel
 * opened in a session shows only that session's runs.
 *
 * Memory is bounded by `maxRuns` and `maxEventsPerRun`, so a long-lived process
 * cannot grow without limit.
 */

import { basename } from 'node:path';

const MAX_RUNS = 50;
const MAX_EVENTS_PER_RUN = 600;

/**
 * The panel only needs the directory/executable name. Keeping the absolute
 * path off the wire (and out of the persisted history) removes the workspace
 * layout from every frame.
 */
function displayName(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  const name = basename(value);
  return name.length > 0 ? name : value;
}

/** One run's mutable record. */
class RunRecord {
  constructor({ id, cwd, command, sessionId, startedAt }) {
    this.id = id;
    this.cwd = cwd;
    this.command = command;
    this.sessionId = sessionId;
    this.startedAt = startedAt;
    this.finishedAt = undefined;
    this.status = 'running';
    this.stopReason = undefined;
    this.mode = undefined;
    this.model = undefined;
    this.events = [];
    this.seq = 0;
  }

  view() {
    return {
      id: this.id,
      cwd: displayName(this.cwd),
      command: displayName(this.command),
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      status: this.status,
      stopReason: this.stopReason,
      mode: this.mode,
      model: this.model,
      events: this.events,
    };
  }
}

export class TraceHub {
  #runs = new Map();
  #subscribers = new Set();
  #maxRuns;
  #onFinish;
  #disposed = false;

  /** Live SSE subscribers, for the transport's own admission check. */
  get subscriberCount() {
    return this.#subscribers.size;
  }

  constructor({ maxRuns = MAX_RUNS, onFinish } = {}) {
    this.#maxRuns = maxRuns;
    this.#onFinish = onFinish;
  }

  /**
   * Register a run before its child process is spawned.
   * @param {{id: string, cwd: string, command: string, sessionId?: string, startedAt?: number}} spec
   * @returns {RunRecord} the mutable record owned by the provider.
   */
  startRun({ id, cwd, command, sessionId, startedAt = Date.now() }) {
    const run = new RunRecord({ id, cwd, command, sessionId, startedAt });
    this.#runs.set(id, run);
    this.#trim();
    this.#publish({ type: 'run', sessionId: run.sessionId, run: run.view() });
    return run;
  }

  /**
   * Append one event to a run and fan it out.
   * @param {string} runId
   * @param {string} kind
   * @param {Record<string, unknown>} [data]
   */
  event(runId, kind, data = {}) {
    const run = this.#runs.get(runId);
    if (run === undefined) return;
    const event = { ...data, seq: ++run.seq, at: Date.now(), kind };
    if (event.kind === 'config') {
      if (typeof data.mode === 'string') run.mode = data.mode;
      if (typeof data.model === 'string') run.model = data.model;
    }
    run.events.push(event);
    if (run.events.length > MAX_EVENTS_PER_RUN) run.events.shift();
    this.#publish({ type: 'event', runId, sessionId: run.sessionId, event, mode: run.mode, model: run.model });
  }

  /**
   * Mark a run finished and publish its terminal state.
   * @param {string} runId
   * @param {{status: 'done' | 'error', stopReason?: string}} info
   */
  finish(runId, info) {
    const run = this.#runs.get(runId);
    if (run === undefined) return;
    run.status = info.status;
    run.stopReason = info.stopReason;
    run.finishedAt = Date.now();
    this.#publish({
      type: 'finish',
      runId,
      sessionId: run.sessionId,
      status: info.status,
      stopReason: info.stopReason,
      finishedAt: run.finishedAt,
    });
    this.#onFinish?.(this.snapshot());
  }

  /**
   * Insert runs loaded from disk without re-publishing them; the next snapshot
   * carries them to every client.
   * @param {Array<Record<string, unknown>>} views newest first
   */
  restore(views) {
    if (!Array.isArray(views)) return;
    // Oldest first: `snapshot()` reverses the Map, so insertion order is what
    // keeps persisted runs in the same chronological wire order as live ones.
    const ordered = views
      .filter((view) => view !== null && typeof view === 'object')
      .sort((a, b) => (Number.isFinite(a.startedAt) ? a.startedAt : 0) - (Number.isFinite(b.startedAt) ? b.startedAt : 0));
    for (const view of ordered) {
      if (view === null || typeof view !== 'object' || typeof view.id !== 'string') continue;
      if (this.#runs.has(view.id)) continue;
      const run = new RunRecord({
        id: view.id,
        cwd: typeof view.cwd === 'string' ? view.cwd : '',
        command: typeof view.command === 'string' ? view.command : 'opencode',
        sessionId: typeof view.sessionId === 'string' ? view.sessionId : undefined,
        startedAt: Number.isFinite(view.startedAt) ? view.startedAt : Date.now(),
      });
      run.status = view.status === 'error' ? 'error' : 'done';
      run.stopReason = typeof view.stopReason === 'string' ? view.stopReason : 'aborted';
      run.finishedAt = Number.isFinite(view.finishedAt) ? view.finishedAt : run.startedAt;
      run.mode = typeof view.mode === 'string' ? view.mode : undefined;
      run.model = typeof view.model === 'string' ? view.model : undefined;
      run.events = Array.isArray(view.events) ? view.events.filter((event) => event !== null && typeof event === 'object') : [];
      run.seq = run.events.reduce((max, event) => (
        Number.isFinite(event.seq) && event.seq > max ? event.seq : max
      ), 0);
      this.#runs.set(run.id, run);
    }
    this.#trim();
  }

  /**
   * @param {string} [sessionId] When set, only that session's runs.
   * @returns {Array<Record<string, unknown>>} retained runs, newest first.
   */
  snapshot(sessionId) {
    // Oldest first, then reversed: the wire order must be newest first and must
    // not depend on Map insertion order (restored runs are inserted differently).
    const runs = [...this.#runs.values()].sort((a, b) => a.startedAt - b.startedAt);
    return (sessionId === undefined ? runs : runs.filter((run) => run.sessionId === sessionId))
      .map((run) => run.view())
      .reverse();
  }

  /**
   * Attach one SSE client, optionally scoped to one session.
   * @param {(payload: unknown) => void} send
   * @param {string} [sessionId] When set, only payloads for that session.
   * @param {() => void} [onClose] Called by `dispose()` so the transport can end
   *   the connection instead of leaving a heartbeat on a dead hub.
   * @returns {() => void} unsubscribe
   */
  subscribe(send, sessionId, onClose) {
    const listener = sessionId === undefined
      ? send
      : (payload) => {
        if (payload === null || typeof payload !== 'object') return;
        if (payload.sessionId !== sessionId) return;
        send(payload);
      };
    if (this.#disposed) {
      try {
        onClose?.('dispose');
      } catch {
        // the transport is already gone
      }
      return () => {};
    }
    const entry = { send: listener, close: typeof onClose === 'function' ? onClose : undefined };
    this.#subscribers.add(entry);
    return () => {
      this.#subscribers.delete(entry);
    };
  }

  /**
   * Detach every subscriber: the plugin is being reloaded or disabled, so the
   * old sockets must reconnect against the next hub instead of staying open
   * with a heartbeat but no events.
   */
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    const entries = [...this.#subscribers];
    this.#subscribers.clear();
    for (const entry of entries) {
      try {
        entry.close?.('dispose');
      } catch {
        // one broken transport must not block the rest
      }
    }
  }

  #publish(payload) {
    for (const entry of this.#subscribers) {
      try {
        entry.send(payload);
      } catch {
        this.#subscribers.delete(entry);
      }
    }
  }

  #trim() {
    while (this.#runs.size > this.#maxRuns) {
      let victim;
      let victimStartedAt = Number.POSITIVE_INFINITY;
      for (const [runId, run] of this.#runs) {
        if (run.status !== 'running' && run.startedAt < victimStartedAt) {
          victim = runId;
          victimStartedAt = run.startedAt;
        }
      }
      if (victim === undefined) victim = this.#runs.keys().next().value;
      const run = this.#runs.get(victim);
      this.#runs.delete(victim);
      if (run !== undefined) {
        this.#publish({ type: 'removed', runId: victim, sessionId: run.sessionId });
      }
    }
  }
}
