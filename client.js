window.__ModuleLoader__.load({
  id: 'dsh-opencode-live',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const BASE = '/opencode-live';

    const TEXT = {
      zh: {
        empty: '等待委派… 在 DSH 里调用 opencode 工具后，这里会实时出现它的 agent、工具和子 agent。',
        live: '实时',
        offline: '重连中…',
        running: '运行中',
        done: '完成',
        tokens: 'tokens',
        starting: '启动中…',
        guideDesc: '实时查看 OpenCode 的 agent、工具调用和它自己派生的子 agent。',
      },
      en: {
        empty: 'Waiting for a delegation. Call the opencode tool in DSH and its agent, tools, and subagents appear here live.',
        live: 'live',
        offline: 'reconnecting…',
        running: 'running',
        done: 'done',
        tokens: 'tokens',
        starting: 'starting…',
        guideDesc: 'Live view of OpenCode\'s agent, tool calls, and the subagents it spawns.',
      },
    };

    function dict(ctx) {
      let active = 'en';
      try {
        active = ctx.locale?.getLocale?.().active ?? 'en';
      } catch {
        active = 'en';
      }
      return TEXT[active] ?? TEXT.en;
    }

    function clock(at) {
      try {
        return new Date(at ?? Date.now()).toLocaleTimeString([], { hour12: false });
      } catch {
        return '';
      }
    }

    function trim(value, max) {
      const text = String(value ?? '');
      return text.length > max ? `${text.slice(0, max)}…` : text;
    }

    function useTrace() {
      const store = React.useRef({ runs: new Map(), order: [], connected: false, version: 0 });
      const [, bump] = React.useReducer((n) => n + 1, 0);
      React.useEffect(() => {
        let frame = 0;
        let closed = false;
        const schedule = () => {
          if (frame !== 0) return;
          frame = requestAnimationFrame(() => {
            frame = 0;
            store.current.version += 1;
            bump();
          });
        };
        const upsert = (run) => {
          if (run === null || typeof run !== 'object' || typeof run.id !== 'string') return;
          const runs = store.current.runs;
          if (!runs.has(run.id)) store.current.order.unshift(run.id);
          const previous = runs.get(run.id);
          runs.set(run.id, {
            ...previous,
            ...run,
            events: Array.isArray(run.events) ? run.events : previous?.events ?? [],
          });
        };
        fetch(`${BASE}/state`)
          .then((response) => response.json())
          .then((body) => {
            if (closed) return;
            store.current.runs.clear();
            store.current.order = [];
            for (const run of body?.runs ?? []) upsert(run);
            schedule();
          })
          .catch(() => {});
        const source = new EventSource(`${BASE}/events`);
        source.onopen = () => {
          store.current.connected = true;
          schedule();
        };
        source.onerror = () => {
          store.current.connected = false;
          schedule();
        };
        source.onmessage = (message) => {
          let payload;
          try {
            payload = JSON.parse(message.data);
          } catch {
            return;
          }
          if (payload.type === 'snapshot') {
            store.current.runs.clear();
            store.current.order = [];
            for (const run of payload.runs ?? []) upsert(run);
          } else if (payload.type === 'run') {
            upsert(payload.run);
          } else if (payload.type === 'event') {
            const run = store.current.runs.get(payload.runId);
            if (run === undefined) return;
            run.events.push(payload.event);
            if (payload.mode !== undefined) run.mode = payload.mode;
            if (payload.model !== undefined) run.model = payload.model;
          } else if (payload.type === 'finish') {
            const run = store.current.runs.get(payload.runId);
            if (run === undefined) return;
            run.status = payload.status;
            run.stopReason = payload.stopReason;
            run.finishedAt = payload.finishedAt;
          }
          schedule();
        };
        return () => {
          closed = true;
          if (frame !== 0) cancelAnimationFrame(frame);
          source.close();
        };
      }, []);
      return store.current;
    }

    const chip = {
      display: 'inline-block',
      padding: '0 8px',
      borderRadius: 999,
      border: '1px solid color-mix(in oklab, currentColor 22%, transparent)',
      fontSize: 11,
      lineHeight: '18px',
      opacity: 0.9,
    };

    function EventRow({ event }) {
      const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, margin: '2px 0' };
      switch (event.kind) {
        case 'session':
          return h('div', { style: { ...mono, color: 'var(--dsw-alias-brand-primary, #7dd3fc)' } }, `OpenCode ${event.version ?? ''}`);
        case 'config':
          return h('div', { style: { ...mono, color: 'var(--dsw-alias-brand-primary, #7dd3fc)' } },
            `agent ${event.mode ?? '?'} · model ${event.model ?? '?'}`);
        case 'thought':
          return h('div', { style: { ...mono, opacity: 0.55, fontStyle: 'italic', borderLeft: '2px solid currentColor', paddingLeft: 8 } },
            `“${trim(event.text, 320)}”`);
        case 'tool':
          return h('div', { style: { ...mono, color: 'var(--color-amber-500, #fbbf24)' } },
            `⚙ ${event.title ?? event.toolKind ?? 'tool'}`,
            event.agent ? h('span', { style: { ...chip, marginLeft: 8, color: 'var(--color-purple-500, #c4b5fd)' } }, event.agent) : null,
            event.status ? h('span', { style: { ...chip, marginLeft: 8, opacity: 0.7 } }, event.status) : null);
        case 'child':
          return h('div', { style: { ...mono, color: 'var(--color-green-500, #34d399)' } },
            `↳ ${event.title ?? 'child session'}`,
            event.status ? h('span', { style: { ...chip, marginLeft: 8, opacity: 0.7 } }, event.status) : null);
        case 'child_tool':
          return h('div', { style: { ...mono, paddingLeft: 14, opacity: 0.8 } },
            `↳ ⚙ ${event.title ?? event.toolKind ?? 'tool'}`,
            event.status ? h('span', { style: { ...chip, marginLeft: 8, opacity: 0.7 } }, event.status) : null);
        case 'child_text':
          return h('div', { style: { ...mono, paddingLeft: 14, opacity: 0.6 } }, `↳ ${trim(event.text, 220)}`);
        case 'permission':
          return h('div', { style: { ...mono, opacity: 0.65 } },
            `permission · ${event.tool ?? ''} → ${event.option ?? event.decision ?? ''}`);
        case 'usage':
          return h('div', { style: { ...mono, color: 'var(--dsw-alias-brand-primary, #7dd3fc)' } },
            `tokens ${event.used ?? '?'}/${event.size ?? '?'}${event.cost ? ` · $${event.cost.amount}` : ''}`);
        case 'status':
          return h('div', { style: { ...mono, opacity: 0.65 } }, `… ${event.status}`);
        case 'done':
          return h('div', { style: { ...mono, color: 'var(--color-green-500, #34d399)' } },
            `done · ${event.stopReason}`,
            event.output ? h('div', { style: { marginTop: 4, opacity: 0.65, whiteSpace: 'pre-wrap' } }, trim(event.output, 800)) : null);
        case 'error':
          return h('div', { style: { ...mono, color: 'var(--color-red-500, #f87171)' } },
            `error · ${event.stage ?? ''}${event.category ? ` · ${event.category}` : ''}`);
        default:
          return null;
      }
    }

    function RunCard({ run, t }) {
      const status = run.status === 'running' ? t.running : (run.stopReason ?? run.status);
      return h('div', {
        style: {
          border: '1px solid color-mix(in oklab, currentColor 14%, transparent)',
          borderRadius: 10,
          padding: '10px 12px',
          marginBottom: 12,
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 } },
          h('span', {
            style: {
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: run.status === 'running'
                ? 'var(--color-amber-500, #fbbf24)'
                : run.status === 'error'
                  ? 'var(--color-red-500, #f87171)'
                  : 'var(--color-green-500, #34d399)',
            },
          }),
          h('span', { style: { fontFamily: 'ui-monospace, monospace', fontSize: 12, opacity: 0.85 } }, run.cwd),
          run.mode ? h('span', { style: { ...chip, color: 'var(--color-purple-500, #c4b5fd)' } }, run.mode) : null,
          run.model ? h('span', { style: { ...chip, fontFamily: 'ui-monospace, monospace' } }, run.model) : null,
          h('span', { style: { ...chip, opacity: 0.75 } }, status),
          h('span', { style: { marginLeft: 'auto', fontSize: 11, opacity: 0.55 } }, clock(run.startedAt))),
        h('div', null,
          run.events.length === 0
            ? h('div', { style: { fontSize: 12, opacity: 0.5 } }, t.starting)
            : run.events.map((event, index) => h(EventRow, { key: `${event.seq ?? index}`, event }))));
    }

    function Panel({ ctx }) {
      const t = dict(ctx);
      const trace = useTrace();
      return h('div', { style: { height: '100%', overflow: 'auto', padding: '14px 16px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 } },
          h('span', { style: { fontWeight: 650 } }, 'OpenCode Live'),
          h('span', { style: { fontSize: 12, opacity: 0.6 } }, trace.connected ? t.live : t.offline)),
        trace.order.length === 0
          ? h('div', { style: { opacity: 0.6, textAlign: 'center', padding: '48px 12px' } }, t.empty)
          : trace.order.map((id) => {
            const run = trace.runs.get(id);
            return run ? h(RunCard, { key: id, run, t }) : null;
          }));
    }

    function Icon({ size = 20 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 4 }),
        h('path', { d: 'M7 9l3 3-3 3' }),
        h('path', { d: 'M13 15h4' }));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // This half must never break the Web boot: a missing right-Sidebar
        // service or a rejected tab definition only disables the panel.
        try {
          const tabs = typeof ctx.get === 'function' ? ctx.get('sidebarRightTabs') : undefined;
          if (tabs === undefined || tabs === null || typeof tabs.register !== 'function') return;
          ctx.effect(() => tabs.register({
            id: 'dsh-opencode-live',
            kind: 'opencode-live',
            priority: 'extension',
            keepMounted: true,
            title: () => 'OpenCode Live',
            guide: [{
              id: 'opencode-live',
              order: 40,
              title: () => 'OpenCode Live',
              description: () => dict(ctx).guideDesc,
              icon: Icon,
            }],
          }));
          ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab',
            key: 'dsh-opencode-live',
          }, () => h(Panel, { ctx }))));
        } catch (error) {
          console.error('[dsh-opencode-live] right sidebar registration failed', error);
        }
      },
    };
  },
});
