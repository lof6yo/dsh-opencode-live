window.__ModuleLoader__.load({
  id: 'dsh-opencode-live',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const BASE = '/opencode-live';
    const MAX_EVENTS_PER_RUN = 600;

    const TEXT = {
      zh: {
        empty: '等待委派… 在 DSH 里调用 opencode 工具后，这里会实时出现它的 agent、工具和子 agent。',
        live: '实时',
        offline: '重连中…',
        running: '运行中',
        done: '完成',
        starting: '启动中…',
        autoOpen: '任务开始时自动展开右侧栏',
        collapse: '收起',
        expand: '展开',
        scrollTop: '回到顶部',
        scrollBottom: '回到底部',
        autoOpenDesc: '关闭后，OpenCode 任务只在面板里静默更新，不再把右侧栏弹出来。',
        sectionTitle: 'OpenCode Live',
        cfgTitle: '会话配置',
        cfgModel: '会话模型（model）',
        cfgModelPlaceholder: '留空 = 用 OpenCode 默认模型',
        cfgMode: '会话 agent（mode）',
        cfgModePlaceholder: '留空 = 用 OpenCode 默认 agent',
        cfgPermission: '权限策略（permission）',
        cfgAskFallback: '拿不到用户回答时的回退（askFallback）',
        cfgAskTimeout: '提问等待上限（毫秒，0 = 一直等）',
        cfgSave: '保存',
        cfgSaving: '保存中…',
        cfgSaved: '已保存；插件重载后生效',
        cfgError: '保存失败',
        cfgReadonly: '当前环境没有 config editor，无法保存',
        guideDesc: '实时查看 OpenCode 的 agent、工具调用和它自己派生的子 agent。',
        globalTitle: 'OpenCode Live',
        allSessions: '所有 session',
        globalEmpty: '还没有任何 OpenCode 委派。在任意会话里调用 opencode 工具后，这里会按会话汇总。',
        unscoped: '未关联会话',
        asking: '等待权限',
        filterAll: '全部',
        filterRunning: '运行中',
        filterError: '出错',
        filterDone: '已完成',
        backToChat: '返回对话',
        refresh: '刷新',
        runsUnit: '个 run',
        rightHint: '右侧栏按会话显示；这里汇总所有会话。',
      },
      en: {
        empty: 'Waiting for a delegation. Call the opencode tool in DSH and its agent, tools, and subagents appear here live.',
        live: 'live',
        offline: 'reconnecting…',
        running: 'running',
        done: 'done',
        starting: 'starting…',
        autoOpen: 'Expand the right sidebar when a task starts',
        collapse: 'Collapse',
        expand: 'Expand',
        scrollTop: 'Back to top',
        scrollBottom: 'Jump to bottom',
        autoOpenDesc: 'Off: OpenCode runs still stream into the panel, but the panel no longer opens itself.',
        sectionTitle: 'OpenCode Live',
        cfgTitle: 'Session configuration',
        cfgModel: 'Session model',
        cfgModelPlaceholder: 'empty = OpenCode default',
        cfgMode: 'Session agent (mode)',
        cfgModePlaceholder: 'empty = OpenCode default agent',
        cfgPermission: 'Permission policy',
        cfgAskFallback: 'Fallback when the question cannot reach the user (askFallback)',
        cfgAskTimeout: 'Question timeout in milliseconds (0 waits forever)',
        cfgSave: 'Save',
        cfgSaving: 'Saving…',
        cfgSaved: 'Saved; applies after the plugin reloads',
        cfgError: 'Save failed',
        cfgReadonly: 'No config editor here; cannot save',
        guideDesc: 'Live view of OpenCode\'s agent, tool calls, and the subagents it spawns.',
        globalTitle: 'OpenCode Live',
        allSessions: 'all sessions',
        globalEmpty: 'No OpenCode delegations yet. Call the opencode tool in any session and runs aggregate here by session.',
        unscoped: 'Unscoped session',
        asking: 'permission',
        filterAll: 'All',
        filterRunning: 'Running',
        filterError: 'Errors',
        filterDone: 'Done',
        backToChat: 'Back to chat',
        refresh: 'Refresh',
        runsUnit: ' runs',
        rightHint: 'The right sidebar is per session; this page aggregates every session.',
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
        const runs = payload.runs ?? [];
        for (let index = runs.length - 1; index >= 0; index -= 1) upsertRun(runs[index]);
        return;
      }
      if (payload.type === 'run') {
        upsertRun(payload.run);
        return;
      }
      if (payload.type === 'removed') {
        feed.runs.delete(payload.runId);
        feed.order = feed.order.filter((id) => id !== payload.runId);
        return;
      }
      if (payload.type === 'event') {
        const run = feed.runs.get(payload.runId);
        if (run === undefined) return;
        run.events.push(payload.event);
        if (run.events.length > MAX_EVENTS_PER_RUN) run.events.shift();
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
      feed.listeners.clear();
      feed.runs.clear();
      feed.order = [];
      feed.connected = false;
      feed.started = false;
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
        case 'note':
          return h('div', { style: { ...mono, opacity: 0.5 } }, `· ${event.text ?? ''}`);
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

    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error };
      }
      componentDidCatch(error) {
        console.error('[dsh-opencode-live] panel render failed', error);
      }
      render() {
        if (this.state.error !== null) {
          return h('div', { style: { padding: 12, display: 'flex', flexDirection: 'column', gap: 8 } },
            h('pre', {
              style: { whiteSpace: 'pre-wrap', color: 'var(--color-red-500, #f87171)', fontSize: 12, margin: 0 },
            }, `OpenCode Live 渲染出错：\n${String(this.state.error?.stack ?? this.state.error)}`),
            h('button', {
              type: 'button',
              onClick: () => this.setState({ error: null }),
              style: {
                alignSelf: 'flex-start',
                padding: '4px 10px',
                borderRadius: 6,
                border: '1px solid color-mix(in oklab, currentColor 25%, transparent)',
                background: 'transparent',
                color: 'inherit',
                cursor: 'pointer',
                fontSize: 12,
              },
            }, '重试'));
        }
        return this.props.children;
      }
    }

    function Section({ ctx }) {
      const t = dict(ctx);
      const [autoOpen, setAutoOpenState] = React.useState(() => autoOpenEnabled());
      const [config, setConfig] = React.useState(null);
      const [status, setStatus] = React.useState('');
      const baseline = React.useRef(null);

      React.useEffect(() => {
        let alive = true;
        fetch(`${BASE}/config`)
          .then((response) => response.json())
          .then((body) => {
            if (!alive) return;
            baseline.current = { ...(body?.values ?? {}) };
            setConfig(body);
          })
          .catch(() => {
            if (alive) setConfig({ writable: false, values: {} });
          });
        return () => {
          alive = false;
        };
      }, []);

      const values = config?.values ?? {};
      const writable = config?.writable === true;
      const set = (key, value) => setConfig((previous) => ({
        ...(previous ?? { writable: false, values: {} }),
        values: { ...(previous?.values ?? {}), [key]: value },
      }));
      const save = () => {
        const base = baseline.current ?? {};
        const changed = {};
        for (const key of ['model', 'mode', 'permission', 'askFallback', 'askTimeoutMs']) {
          if (JSON.stringify(values[key]) !== JSON.stringify(base[key])) changed[key] = values[key];
        }
        if (Object.keys(changed).length === 0) {
          setStatus('saved');
          return;
        }
        setStatus('saving');
        fetch(`${BASE}/config`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(changed),
        })
          .then((response) => response.json())
          .then((body) => setStatus(body?.ok === true ? 'saved' : 'error'))
          .catch(() => setStatus('error'));
      };

      const field = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 };
      const input = {
        padding: '6px 8px',
        borderRadius: 6,
        border: '1px solid color-mix(in oklab, currentColor 20%, transparent)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
      };
      const hint = { fontSize: 11, opacity: 0.55 };

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 620, padding: '2px 0' } },
        h('div', { style: { fontSize: 14, fontWeight: 650 } }, t.sectionTitle),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' } },
          h('input', {
            type: 'checkbox',
            checked: autoOpen,
            onChange: (event) => {
              setAutoOpen(event.target.checked);
              setAutoOpenState(event.target.checked);
            },
          }),
          h('span', null, t.autoOpen)),
        h('div', { style: hint }, t.autoOpenDesc),
        h('div', { style: { height: 1, background: 'color-mix(in oklab, currentColor 12%, transparent)' } }),
        h('div', { style: { fontSize: 13, fontWeight: 600 } }, t.cfgTitle),
        config === null
          ? h('div', { style: hint }, '…')
          : h(React.Fragment, null,
            h('label', { style: field },
              h('span', null, t.cfgModel),
              h('input', {
                style: input,
                value: values.model ?? '',
                placeholder: t.cfgModelPlaceholder,
                onChange: (event) => set('model', event.target.value),
              })),
            h('label', { style: field },
              h('span', null, t.cfgMode),
              h('input', {
                style: input,
                value: values.mode ?? '',
                placeholder: t.cfgModePlaceholder,
                onChange: (event) => set('mode', event.target.value),
              })),
            h('label', { style: field },
              h('span', null, t.cfgPermission),
              h('select', {
                style: input,
                value: values.permission ?? 'ask',
                onChange: (event) => set('permission', event.target.value),
              },
                h('option', { value: 'ask' }, 'ask'),
                h('option', { value: 'allow' }, 'allow'),
                h('option', { value: 'reject' }, 'reject'))),
            values.permission === 'ask' || values.permission === undefined
              ? h('label', { style: field },
                h('span', null, t.cfgAskFallback),
                h('select', {
                  style: input,
                  value: values.askFallback ?? 'reject',
                  onChange: (event) => set('askFallback', event.target.value),
                },
                  h('option', { value: 'reject' }, 'reject'),
                  h('option', { value: 'allow' }, 'allow')))
              : null,
            values.permission === 'ask' || values.permission === undefined
              ? h('label', { style: field },
                h('span', null, t.cfgAskTimeout),
                h('input', {
                  style: input,
                  type: 'number',
                  min: 0,
                  step: 1000,
                  max: 2147483647,
                  value: values.askTimeoutMs ?? 600000,
                  onChange: (event) => {
                    const next = Number(event.target.value);
                    set('askTimeoutMs', Number.isFinite(next) ? Math.max(0, Math.min(next, 2147483647)) : 0);
                  },
                }))
              : null,
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
              h('button', {
                type: 'button',
                disabled: !writable || status === 'saving',
                onClick: save,
                style: {
                  padding: '6px 12px',
                  borderRadius: 6,
                  border: '1px solid color-mix(in oklab, currentColor 25%, transparent)',
                  background: 'transparent',
                  color: 'inherit',
                  cursor: writable ? 'pointer' : 'not-allowed',
                  opacity: writable ? 1 : 0.5,
                },
              }, t.cfgSave),
              h('span', { style: hint },
                status === 'saved'
                  ? t.cfgSaved
                  : status === 'error'
                    ? t.cfgError
                    : status === 'saving'
                      ? t.cfgSaving
                      : writable ? '' : t.cfgReadonly))));
    }

    function RunCard({ run, t, showCwd = true }) {
      const [open, setOpen] = React.useState(true);
      const status = run.status === 'running' ? t.running : (run.stopReason ?? run.status);
      const toggle = () => setOpen((value) => !value);
      return h('div', {
        style: {
          border: '1px solid color-mix(in oklab, currentColor 14%, transparent)',
          borderRadius: 10,
          padding: '10px 12px',
          marginBottom: 12,
        },
      },
        h('div', {
          role: 'button',
          tabIndex: 0,
          onClick: toggle,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              toggle();
            }
          },
          title: open ? t.collapse : t.expand,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
            marginBottom: open ? 8 : 0,
            cursor: 'pointer',
            userSelect: 'none',
          },
        },
          h('span', { style: { width: 12, fontSize: 11, opacity: 0.55 } }, open ? '▾' : '▸'),
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
          showCwd
            ? h('span', { style: { fontFamily: 'ui-monospace, monospace', fontSize: 12, opacity: 0.85 } }, run.cwd)
            : null,
          run.mode ? h('span', { style: { ...chip, color: 'var(--color-purple-500, #c4b5fd)' } }, run.mode) : null,
          run.model ? h('span', { style: { ...chip, fontFamily: 'ui-monospace, monospace' } }, run.model) : null,
          h('span', { style: { ...chip, opacity: 0.75 } }, status),
          h('span', { style: { marginLeft: 'auto', fontSize: 11, opacity: 0.55 } }, clock(run.startedAt))),
        open
          ? h('div', null,
            run.events.length === 0
              ? h('div', { style: { fontSize: 12, opacity: 0.5 } }, t.starting)
              : run.events.map((event, index) => h(EventRow, { key: `${event.seq ?? index}`, event })))
          : null);
    }

    function useScopedTrace(sessionId) {
      const storeRef = React.useRef(null);
      const [, bump] = React.useReducer((n) => n + 1, 0);
      const key = sessionId ?? '';
      if (storeRef.current === null || storeRef.current.key !== key) {
        storeRef.current = { key, runs: new Map(), order: [], connected: false };
      }
      React.useEffect(() => {
        const store = storeRef.current;
        let frame = 0;
        let closed = false;
        const schedule = () => {
          if (frame !== 0) return;
          frame = requestAnimationFrame(() => {
            frame = 0;
            bump();
          });
        };
        if (sessionId === undefined) {
          const unsubscribe = subscribeFeed(() => schedule());
          return () => {
            unsubscribe();
            if (frame !== 0) cancelAnimationFrame(frame);
          };
        }
        const upsert = (run) => {
          if (run === null || typeof run !== 'object' || typeof run.id !== 'string') return;
          if (!store.runs.has(run.id)) store.order.unshift(run.id);
          const previous = store.runs.get(run.id);
          store.runs.set(run.id, {
            ...previous,
            ...run,
            events: Array.isArray(run.events) ? run.events : (previous?.events ?? []),
          });
        };
        const query = `?sessionId=${encodeURIComponent(sessionId)}`;
        const source = new EventSource(`${BASE}/events${query}`);
        source.onopen = () => {
          store.connected = true;
          schedule();
        };
        source.onerror = () => {
          store.connected = false;
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
            store.runs.clear();
            store.order = [];
            const runs = payload.runs ?? [];
            for (let index = runs.length - 1; index >= 0; index -= 1) upsert(runs[index]);
          } else if (payload.type === 'run') {
            upsert(payload.run);
          } else if (payload.type === 'removed') {
            store.runs.delete(payload.runId);
            store.order = store.order.filter((id) => id !== payload.runId);
          } else if (payload.type === 'event') {
            const run = store.runs.get(payload.runId);
            if (run !== undefined) {
              run.events.push(payload.event);
              if (run.events.length > MAX_EVENTS_PER_RUN) run.events.shift();
              if (payload.mode !== undefined) run.mode = payload.mode;
              if (payload.model !== undefined) run.model = payload.model;
            }
          } else if (payload.type === 'finish') {
            const run = store.runs.get(payload.runId);
            if (run !== undefined) {
              run.status = payload.status;
              run.stopReason = payload.stopReason;
              run.finishedAt = payload.finishedAt;
            }
          }
          schedule();
        };
        return () => {
          closed = true;
          source.close();
          if (frame !== 0) cancelAnimationFrame(frame);
        };
      }, [sessionId]);
      return sessionId === undefined ? feed : storeRef.current;
    }

    function useMountedSession(ctx) {
      const right = typeof ctx.get === 'function' ? ctx.get('sidebarRight') : undefined;
      const subscribe = React.useCallback((notify) => {
        if (typeof right?.mounted?.subscribe === 'function') return right.mounted.subscribe(notify);
        return () => {};
      }, [right]);
      const read = React.useCallback(() => {
        try {
          return typeof right?.mounted?.getSnapshot === 'function' ? right.mounted.getSnapshot() : undefined;
        } catch {
          return undefined;
        }
      }, [right]);
      if (typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(subscribe, read, read);
      }
      return read();
    }

    function Panel({ ctx, sessionId: sessionIdProp }) {
      const t = dict(ctx);
      const mounted = useMountedSession(ctx);
      const sessionId = typeof sessionIdProp === 'string' && sessionIdProp.length > 0 ? sessionIdProp : mounted;
      const trace = useScopedTrace(sessionId);
      const scroller = React.useRef(null);
      const jump = (edge) => {
        const node = scroller.current;
        if (node === null) return;
        node.scrollTo({ top: edge === 'top' ? 0 : node.scrollHeight, behavior: 'smooth' });
      };
      const scrollButton = {
        width: 26,
        height: 26,
        borderRadius: 13,
        border: '1px solid color-mix(in oklab, currentColor 20%, transparent)',
        background: 'color-mix(in oklab, currentColor 8%, transparent)',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: 12,
        lineHeight: 1,
        opacity: 0.7,
      };
      return h('div', { style: { position: 'relative', height: '100%' } },
        h('div', { ref: scroller, style: { height: '100%', overflow: 'auto', padding: '14px 16px' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 } },
            h('span', {
              style: {
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: trace.connected
                  ? 'var(--color-green-500, #34d399)'
                  : 'var(--color-amber-500, #fbbf24)',
              },
            }),
            h('span', { style: { fontSize: 11, opacity: 0.55 } }, trace.connected ? t.live : t.offline),
            h('span', {
              style: {
                marginLeft: 'auto',
                fontSize: 10,
                opacity: 0.45,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              },
            }, sessionId === undefined ? 'session ?' : sessionId)),
          trace.order.length === 0
            ? h('div', { style: { opacity: 0.6, textAlign: 'center', padding: '48px 12px' } }, t.empty)
            : trace.order.map((id) => {
              const run = trace.runs.get(id);
              return run ? h(RunCard, { key: id, run, t }) : null;
            })),
        h('div', { style: { position: 'absolute', right: 10, bottom: 10, display: 'flex', gap: 6 } },
          h('button', { type: 'button', title: t.scrollTop, style: scrollButton, onClick: () => jump('top') }, '↑'),
          h('button', { type: 'button', title: t.scrollBottom, style: scrollButton, onClick: () => jump('bottom') }, '↓')));
    }


    function ago(since, now) {
      if (typeof since !== 'number' || !Number.isFinite(since)) return '';
      const seconds = Math.max(0, Math.round((now - since) / 1000));
      if (seconds < 60) return `${seconds}s`;
      const minutes = Math.round(seconds / 60);
      if (minutes < 60) return `${minutes}m`;
      const hours = Math.round(minutes / 60);
      if (hours < 24) return `${hours}h`;
      return `${Math.round(hours / 24)}d`;
    }

    function groupRuns(store, filter) {
      const groups = new Map();
      for (const id of store.order) {
        const run = store.runs.get(id);
        if (run === undefined) continue;
        const status = run.status ?? 'running';
        if (filter === 'running' && status !== 'running') continue;
        if (filter === 'error' && status !== 'error') continue;
        if (filter === 'done' && status === 'running') continue;
        const key = typeof run.sessionId === 'string' && run.sessionId.length > 0 ? run.sessionId : '__unscoped';
        if (!groups.has(key)) {
          groups.set(key, { key, runs: [], running: 0, error: 0, asking: 0, lastAt: 0, cwd: run.cwd });
        }
        const group = groups.get(key);
        group.runs.push(run);
        if (status === 'running') {
          group.running += 1;
          if (lastPermissionDecision(run) === 'asking') group.asking += 1;
        }
        if (status === 'error') group.error += 1;
        const at = run.finishedAt ?? run.startedAt ?? 0;
        if (at > group.lastAt) group.lastAt = at;
      }
      return [...groups.values()].sort((a, b) => (b.asking - a.asking) || (b.running - a.running) || (b.error - a.error) || (b.lastAt - a.lastAt));
    }

    function shortSessionId(id) {
      const raw = typeof id === 'string' ? id : '';
      const body = raw.startsWith('session-') ? raw.slice('session-'.length) : raw;
      const candidate = body.length > 0 ? body : raw;
      return candidate.length > 0 ? candidate.slice(0, 8) : '?';
    }

    function sessionGroupTitle(byId, key, t) {
      if (key === '__unscoped') return t.unscoped;
      const title = byId?.[key]?.title;
      if (typeof title === 'string' && title.trim().length > 0) return title.trim();
      return `Session ${shortSessionId(key)}`;
    }

    function GlobalWithSessions({ ctx, useSessions }) {
      const byId = useSessions((state) => state?.byId);
      return h(GlobalBody, { ctx, sessionsById: byId });
    }

    function sessionListOf(ctx) {
      try {
        const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
        return sessions?.list;
      } catch {
        return undefined;
      }
    }

    function GlobalWithStore({ ctx }) {
      const list = sessionListOf(ctx);
      const subscribe = React.useCallback((notify) => (
        typeof list?.subscribe === 'function' ? list.subscribe(notify) : () => {}
      ), [list]);
      const read = React.useCallback(() => {
        try {
          return typeof list?.getSnapshot === 'function' ? list.getSnapshot() : undefined;
        } catch {
          return undefined;
        }
      }, [list]);
      const state = typeof React.useSyncExternalStore === 'function'
        ? React.useSyncExternalStore(subscribe, read, read)
        : read();
      return h(GlobalBody, { ctx, sessionsById: state?.byId });
    }

    function GlobalPanel({ ctx, useSessions }) {
      if (typeof useSessions === 'function') return h(GlobalWithSessions, { ctx, useSessions });
      if (sessionListOf(ctx) !== undefined) return h(GlobalWithStore, { ctx });
      return h(GlobalBody, { ctx, sessionsById: undefined });
    }

    function lastPermissionDecision(run) {
      const events = run?.events;
      if (!Array.isArray(events)) return undefined;
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event !== null && typeof event === 'object' && event.kind === 'permission') {
          return event.decision;
        }
      }
      return undefined;
    }

    function groupDot(group) {
      if (group.asking > 0) return 'var(--color-amber-500, #fbbf24)';
      if (group.error > 0) return 'var(--color-red-500, #f87171)';
      if (group.running > 0) return 'var(--color-green-500, #34d399)';
      return 'color-mix(in oklab, currentColor 22%, transparent)';
    }

    function LiveIcon({ size = 16, active = false }) {
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
        h('path', { d: 'M13 15h4' }),
        h('circle', {
          cx: 19.5,
          cy: 4.5,
          r: 2.4,
          fill: active ? 'var(--color-green-500, #34d399)' : 'currentColor',
          stroke: 'none',
          opacity: active ? 1 : 0.45,
        }));
    }

    function GlobalBody({ ctx, sessionsById }) {
      const t = dict(ctx);
      const store = useScopedTrace(undefined);
      const [filter, setFilter] = React.useState('all');
      const [collapsed, setCollapsed] = React.useState(() => new Set());
      const [now, setNow] = React.useState(() => Date.now());
      React.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 10000);
        timer.unref?.();
        return () => clearInterval(timer);
      }, []);
      const groups = groupRuns(store, filter);
      const totalRunning = groups.reduce((sum, group) => sum + group.running, 0);
      const totalRuns = groups.reduce((sum, group) => sum + group.runs.length, 0);
      const buttonStyle = {
        padding: '3px 10px',
        borderRadius: 999,
        border: '1px solid color-mix(in oklab, currentColor 20%, transparent)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: 11.5,
        lineHeight: 1.5,
      };
      const activeButtonStyle = {
        ...buttonStyle,
        background: 'color-mix(in oklab, currentColor 14%, transparent)',
        borderColor: 'color-mix(in oklab, currentColor 40%, transparent)',
      };
      const toggle = (key) => {
        setCollapsed((previous) => {
          const next = new Set(previous);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
      };
      const refresh = () => {
        if (store.source !== null) {
          try {
            store.source.close();
          } catch {
            // already closed
          }
          store.source = null;
          store.started = false;
        }
        ensureFeed();
        setNow(Date.now());
      };
      const back = () => {
        try {
          ctx.get('layout')?.selectPanel?.(null);
        } catch {
          // layout not available in this context
        }
      };
      const filterButton = (key, label) => h('button', {
        type: 'button',
        'aria-pressed': filter === key,
        onClick: () => setFilter(key),
        style: filter === key ? activeButtonStyle : buttonStyle,
      }, label);
      return h('div', { style: { height: '100%', overflow: 'auto' } },
        h('div', { style: { maxWidth: 980, margin: '0 auto', padding: '22px 24px 48px' } },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 6 } },
            h('h2', { style: { margin: 0, fontSize: 20, fontWeight: 650 } }, t.globalTitle),
            h('span', {
              style: {
                ...chip,
                color: store.connected
                  ? 'var(--color-green-500, #34d399)'
                  : 'var(--color-amber-500, #fbbf24)',
              },
            }, store.connected ? t.live : t.offline),
            h('span', { style: { fontSize: 11, opacity: 0.6 } }, `${totalRunning} / ${totalRuns} ${t.runsUnit}`),
            h('span', { style: { marginLeft: 'auto', fontSize: 11, opacity: 0.5 } }, t.allSessions)),
          h('div', { style: { fontSize: 11, opacity: 0.5, marginBottom: 14 } }, t.rightHint),
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 } },
            filterButton('all', t.filterAll),
            filterButton('running', t.filterRunning),
            filterButton('error', t.filterError),
            filterButton('done', t.filterDone),
            h('span', { style: { marginLeft: 'auto' } }),
            h('button', { type: 'button', style: buttonStyle, onClick: refresh }, t.refresh),
            h('button', { type: 'button', style: buttonStyle, onClick: back }, t.backToChat)),
          groups.length === 0
            ? h('div', { style: { opacity: 0.6, textAlign: 'center', padding: '48px 12px' } }, t.globalEmpty)
            : groups.map((group) => {
              const open = !collapsed.has(group.key);
              const title = sessionGroupTitle(sessionsById, group.key, t);
              const cwdName = typeof group.cwd === 'string'
                ? group.cwd.split('/').filter(Boolean).pop()
                : undefined;
              return h('section', { key: group.key, style: { marginBottom: 18 } },
                h('div', {
                  role: 'button',
                  tabIndex: 0,
                  'aria-expanded': open,
                  onClick: () => toggle(group.key),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      toggle(group.key);
                    }
                  },
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    flexWrap: 'wrap',
                    padding: '6px 2px',
                    cursor: 'pointer',
                    userSelect: 'none',
                    borderBottom: '1px solid color-mix(in oklab, currentColor 10%, transparent)',
                  },
                },
                  h('span', { style: { width: 12, fontSize: 11, opacity: 0.55 } }, open ? '▾' : '▸'),
                  h('span', {
                    title: group.asking > 0
                      ? t.asking
                      : group.error > 0
                        ? t.filterError
                        : group.running > 0
                          ? t.running
                          : t.filterDone,
                    style: {
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: groupDot(group),
                    },
                  }),
                  h('span', { style: { fontSize: 12.5, fontWeight: 600 }, title: group.key }, title),
                  cwdName !== undefined
                    ? h('span', { style: { ...chip, opacity: 0.75, fontFamily: 'ui-monospace, monospace' } }, cwdName)
                    : null,
                  group.asking > 0
                    ? h('span', { style: { ...chip, color: 'var(--color-amber-500, #fbbf24)' } }, `${group.asking} ${t.asking}`)
                    : null,
                  group.running > 0
                    ? h('span', { style: { ...chip, color: 'var(--color-green-500, #34d399)' } }, `${group.running} ${t.running}`)
                    : null,
                  group.error > 0
                    ? h('span', { style: { ...chip, color: 'var(--color-red-500, #f87171)' } }, `${group.error} ${t.filterError}`)
                    : null,
                  h('span', { style: { fontSize: 11, opacity: 0.5 } }, `${group.runs.length} ${t.runsUnit}`),
                  h('span', { style: { marginLeft: 'auto', fontSize: 11, opacity: 0.5 } }, ago(group.lastAt, now))),
                open
                  ? h('div', { style: { paddingTop: 10 } },
                    group.runs.map((run) => h(RunCard, { key: run.id, run, t, showCwd: false })))
                  : null);
            })));
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
      inject: ['slots', 'locale'],
      apply(ctx) {
        // Restored to the shape that demonstrably worked: one inject fiber owns
        // both the tab type and its body, with no timers or retries inside.
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
            }, (props) => h(PanelBoundary, null, h(Panel, { ctx, sessionId: props?.sessionId })))));
          } catch (error) {
            console.error('[dsh-opencode-live] right sidebar registration failed', error);
          }
        });

        ctx.effect(() => {
          // Left rail entry + global page, mirroring how dsh-context pairs
          // `sidebar.panellist` (id) with `main` (key). Right panel is untouched.
          const disposers = [
            ctx.slots.inject('main', () => ctx.slots.register({
              name: 'main',
              key: 'opencode-live',
            }, (props) => h(PanelBoundary, null, h(GlobalPanel, { ctx, useSessions: props?.useSessions })))),
            ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
              name: 'sidebar.panellist',
              id: 'opencode-live',
              order: 30,
              label: () => 'OpenCode Live',
            }, ({ size = 16, active = false } = {}) => h(LiveIcon, { size, active }))),
          ];
          return () => {
            for (const dispose of disposers) {
              try {
                dispose();
              } catch {
                // already disposed
              }
            }
          };
        });

        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'opencode-live',
          order: 18,
          label: () => 'OpenCode Live',
        }, () => h(Section, { ctx }))));

        ctx.effect(() => {
          const unsubscribe = subscribeFeed((payload) => {
            if (payload === undefined || payload.type !== 'run') return;
            if (!autoOpenEnabled()) return;
            try {
              const layout = typeof ctx.get === 'function' ? ctx.get('layout') : undefined;
              const right = typeof ctx.get === 'function' ? ctx.get('sidebarRight') : undefined;
              const mounted = typeof right?.mounted?.getSnapshot === 'function' ? right.mounted.getSnapshot() : undefined;
              if (typeof mounted !== 'string' || typeof payload.sessionId !== 'string' || payload.sessionId !== mounted) return;
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
