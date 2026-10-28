/**
 * In-memory run registry and SSE fan-out for the OpenCode Live panel.
 *
 * Each delegated run owns an ordered event list; browsers receive one snapshot
 * on connect and then one framed message per event. Memory is bounded by
 * `maxRuns` and `maxEventsPerRun`, so a long-lived process cannot grow without
 * limit.
 */

const MAX_RUNS = 50;
const MAX_EVENTS_PER_RUN = 600;

/** One run's mutable record. */
class RunRecord {
  constructor({ id, cwd, command, startedAt }) {
    this.id = id;
    this.cwd = cwd;
    this.command = command;
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
      cwd: this.cwd,
      command: this.command,
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

  constructor({ maxRuns = MAX_RUNS } = {}) {
    this.#maxRuns = maxRuns;
  }

  /**
   * Register a run before its child process is spawned.
   * @param {{id: string, cwd: string, command: string, startedAt?: number}} spec
   * @returns {RunRecord} the mutable record owned by the provider.
   */
  startRun({ id, cwd, command, startedAt = Date.now() }) {
    const run = new RunRecord({ id, cwd, command, startedAt });
    this.#runs.set(id, run);
    this.#trim();
    this.#publish({ type: 'run', run: run.view() });
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
    const event = { seq: ++run.seq, at: Date.now(), kind, ...data };
    if (event.kind === 'config') {
      if (typeof data.mode === 'string') run.mode = data.mode;
      if (typeof data.model === 'string') run.model = data.model;
    }
    run.events.push(event);
    if (run.events.length > MAX_EVENTS_PER_RUN) run.events.shift();
    this.#publish({ type: 'event', runId, event, mode: run.mode, model: run.model });
  }

  /**
   * Mark a run finished and publish its terminal state.
   * @param {string} runId
   * @param {{status: 'done' | 'error', stopReason?: string, output?: string}} info
   */
  finish(runId, info) {
    const run = this.#runs.get(runId);
    if (run === undefined) return;
    run.status = info.status;
    run.stopReason = info.stopReason;
    run.finishedAt = Date.now();
    this.#publish({ type: 'finish', runId, status: info.status, stopReason: info.stopReason, finishedAt: run.finishedAt });
  }

  /** @returns {Array<Record<string, unknown>>} all retained runs, newest first. */
  snapshot() {
    return [...this.#runs.values()].map((run) => run.view()).reverse();
  }

  /**
   * Attach one SSE client.
   * @param {(payload: unknown) => void} send
   * @returns {() => void} unsubscribe
   */
  subscribe(send) {
    this.#subscribers.add(send);
    return () => {
      this.#subscribers.delete(send);
    };
  }

  #publish(payload) {
    for (const send of this.#subscribers) {
      try {
        send(payload);
      } catch {
        this.#subscribers.delete(send);
      }
    }
  }

  #trim() {
    while (this.#runs.size > this.#maxRuns) {
      const oldest = this.#runs.keys().next().value;
      this.#runs.delete(oldest);
    }
  }
}
