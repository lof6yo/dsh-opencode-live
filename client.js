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
        autoOpen: '任务开始时自动展开右侧栏',
        autoOpenDesc: '关闭后，OpenCode 任务只在面板里静默更新，不再把右侧栏弹出来。',
        sectionTitle: 'OpenCode Live',
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
        autoOpen: 'Expand the right sidebar when a task starts',
        autoOpenDesc: 'Off: OpenCode runs still stream into the panel, but the panel no longer opens itself.',
        sectionTitle: 'OpenCode Live',
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

    const AUTO_KEY = 'dsh-opencode-live:auto-open';

    function autoOpenEnabled() {
      try {
        return localStorage.getItem(AUTO_KEY) !== '0';
      } catch {
        return true;
      }
    }

    function setAutoOpen(enabled) {
      try {
        localStorage.setItem(AUTO_KEY, enabled ? '1' : '0');
      } catch {
        // storage unavailable: the default stands
      }
    }

    const feed = {
      runs: new Map(),
      order: [],
      connected: false,
      listeners: new Set(),
      started: false,
      source: null,
    };

    function upsertRun(run) {
      if (run === null || typeof run !== 'object' || typeof run.id !== 'string') return;
      if (!feed.runs.has(run.id)) feed.order.unshift(run.id);
      const previous = feed.runs.get(run.id);
      feed.runs.set(run.id, {
        ...previous,
        ...run,
        events: Array.isArray(run.events) ? run.events : (previous?.events ?? []),
      });
    }

    function applyPayload(payload) {
      if (payload === undefined) return;
      if (payload.type === 'snapshot') {
        feed.runs.clear();
        feed.order = [];
        for (const run of payload.runs ?? []) upsertRun(run);
        return;
      }
      if (payload.type === 'run') {
        upsertRun(payload.run);
        return;
      }
      if (payload.type === 'event') {
        const run = feed.runs.get(payload.runId);
        if (run === undefined) return;
        run.events.push(payload.event);
        if (payload.mode !== undefined) run.mode = payload.mode;
        if (payload.model !== undefined) run.model = payload.model;
        return;
      }
      if (payload.type === 'finish') {
        const run = feed.runs.get(payload.runId);
        if (run === undefined) return;
        run.status = payload.status;
        run.stopReason = payload.stopReason;
        run.finishedAt = payload.finishedAt;
      }
    }

    function notify(payload) {
      applyPayload(payload);
      for (const listener of [...feed.listeners]) {
        try {
          listener(payload);
        } catch {
          // a broken subscriber never blocks the others
        }
      }
    }

    function ensureFeed() {
      if (feed.started) return feed;
      feed.started = true;
      fetch(`${BASE}/state`)
        .then((response) => response.json())
        .then((body) => notify({ type: 'snapshot', runs: body?.runs ?? [] }))
        .catch(() => {});
      const source = new EventSource(`${BASE}/events`);
      feed.source = source;
      source.onopen = () => {
        feed.connected = true;
        notify();
      };
      source.onerror = () => {
        feed.connected = false;
        notify();
      };
      source.onmessage = (message) => {
        let payload;
        try {
          payload = JSON.parse(message.data);
        } catch {
          return;
        }
        notify(payload);
      };
      return feed;
    }

    function subscribeFeed(listener) {
      ensureFeed();
      feed.listeners.add(listener);
      return () => {
        feed.listeners.delete(listener);
      };
    }

    function closeFeed() {
      if (feed.source !== null) {
        try {
          feed.source.close();
        } catch {
          // already closed
        }
        feed.source = null;
      }
      feed.started = false;
    }

    function useTrace() {
      const [, bump] = React.useReducer((n) => n + 1, 0);
      React.useEffect(() => {
        let frame = 0;
        const listener = () => {
          if (frame !== 0) return;
          frame = requestAnimationFrame(() => {
            frame = 0;
            bump();
          });
        };
        const unsubscribe = subscribeFeed(listener);
        return () => {
          unsubscribe();
          if (frame !== 0) cancelAnimationFrame(frame);
        };
      }, []);
      return feed;
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

    function Section({ ctx }) {
      const t = dict(ctx);
      const [autoOpen, setAutoOpenState] = React.useState(() => autoOpenEnabled());
      const row = {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        fontSize: 13,
        color: 'inherit',
        cursor: 'pointer',
      };
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 620, padding: '2px 0' } },
        h('div', { style: { fontSize: 14, fontWeight: 650 } }, t.sectionTitle),
        h('label', { style: row },
          h('input', {
            type: 'checkbox',
            checked: autoOpen,
            onChange: (event) => {
              setAutoOpen(event.target.checked);
              setAutoOpenState(event.target.checked);
            },
          }),
          h('span', null, t.autoOpen)),
        h('div', { style: { fontSize: 12, opacity: 0.6, lineHeight: 1.5 } }, t.autoOpenDesc));
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
        // This half must never break the Web boot, and it must wait for the
        // right-Sidebar services: at page boot our module may load before
        // ui-sidebar-right has provided them.
        ctx.inject(['sidebarRightTabs'], (scope) => {
          try {
            const tabs = scope.sidebarRightTabs;
            if (tabs === null || tabs === undefined || typeof tabs.register !== 'function') return;
            scope.effect(() => tabs.register({
              id: 'dsh-opencode-live',
              kind: 'opencode-live',
              priority: 'extension',
              keepMounted: true,
              title: () => 'OpenCode Live',
              guide: [{
                id: 'opencode-live',
                order: 100,
                title: () => 'OpenCode Live',
                description: () => dict(ctx).guideDesc,
                icon: Icon,
              }],
            }));
            scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
              name: 'sidebar.right.pane.tab',
              key: 'dsh-opencode-live',
            }, () => h(Panel, { ctx }))));
          } catch (error) {
            console.error('[dsh-opencode-live] right sidebar registration failed', error);
          }
        });

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'opencode-live',
          order: 21,
          label: () => 'OpenCode Live',
        }, () => h(Section, { ctx })));

        ctx.effect(() => {
          const unsubscribe = subscribeFeed((payload) => {
            if (payload === undefined || payload.type !== 'run') return;
            if (!autoOpenEnabled()) return;
            try {
              const layout = typeof ctx.get === 'function' ? ctx.get('layout') : undefined;
              const right = typeof ctx.get === 'function' ? ctx.get('sidebarRight') : undefined;
              layout?.openRightbar?.(true, false);
              right?.openTab?.('opencode-live');
            } catch (error) {
              console.error('[dsh-opencode-live] auto-open failed', error);
            }
          });
          return () => {
            unsubscribe();
            closeFeed();
          };
        });
      },
    };
  },
});
