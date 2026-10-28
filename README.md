# dsh-opencode-live

把 [OpenCode](https://opencode.ai) 当作 DSH 的子智能体来用，并把它**实际**使用的 agent、工具调用和它自己派生的子 agent（fixer、explorer…）实时显示在 DSH 的一个面板里。

- **委派**：DSH 里的 `opencode` 工具，一次任务启动一个独立的 `opencode acp` 子进程；
- **实时**：Host 端把 ACP 事件镜像成 trace，原生面板（Client 插件，`main` + 侧边栏图标）直接渲染；数据走 `/opencode-live/state` + `/opencode-live/events`（SSE），不再提供 HTML 页面；
- **不多加耦合**：OpenCode 用它自己的配置、模型和认证，DSH 只传 cwd + 任务文本。

装好并重启后，右侧边栏的「+」引导页里会出现 **OpenCode Live**，点开就是一个常驻的右侧标签页（和文件预览、浏览器同一栏），与 DSH 同主题、不经过 iframe。

## 面板里能看到什么

| 事件 | 来源 |
|---|---|
| 主会话的 agent（`mode`）和 model | `session/new` 的 `configOptions`，以及 `config_option_update` |
| 每次工具调用（标题 / kind / 状态） | `session/update` → `tool_call` / `tool_call_update` |
| OpenCode 派给子 agent 的任务（含 agent 名） | `tool_call_update.rawInput.agent` |
| 子会话的生命周期（created/running/completed） | `opencode/session/child_update`（需要客户端声明 `_meta["opencode/child-session-updates"]`） |
| 子会话里的工具调用和消息 | 同上的 `child_update.update` |
| 思考片段、token 用量、结束原因 | `agent_thought_chunk`、`usage_update`、`prompt` 结果 |

> 子 agent 的**模型**不在 ACP 流里。面板能确认主会话的 model，以及每个子 agent 的名字和动作；子 agent 自己用的模型要看 OpenCode 的会话存储。

## 安装

在 DSH profile 里用 `plugin_manager` 的 `install_bundle` 安装本目录。bundle 的
`cordis.patch.yml` 插入两行：provider（`opencode-live`）和工具（`opencode`，
`maxDepth: provider-managed`）。

没有运行时依赖：ACP 客户端只用 Node 内置模块，所以可以直接以目录方式安装（link）。

bundle 同时声明了 `dsh.client`，所以安装后需要**重启一次 DSH**（新的 Client 模块在启动时扫描），
之后每次委派都会出现在面板里。卸载/禁用时 Host 侧通过 `ctx.effect` 释放路由与 provider。

## 配置

```yaml
- id: opencode-live
  name: dsh-opencode-live
  config:
    # 省略时依次尝试 $OPENCODE_BIN、~/.opencode/bin/opencode、PATH
    command: opencode
    args: ['acp']
    # allow = 自动同意 OpenCode 的改文件/执行命令请求；OpenCode 自己的 deny 规则仍然生效
    # reject = 只读子智能体
    permission: allow
    # 面板路径，默认 /opencode-live
    path: /opencode-live
    # 传给子进程的环境变量（在凭据清洗之后合并）
    env: {}
    # ACP 会话的模型/agent：不填就用 OpenCode 的默认；填了会在 session/new 之后
    # 用 session/set_config_option 钉住（ACP 不会继承 preset 里 agent 的 model）
    model: opencode-go/deepseek-v4.1-flash
    # mode: orchestrator
```

## 安全边界

- 子进程**不在 DSH 的文件沙箱和审批 UI 之下**；`permission: allow` 会让 OpenCode 按其自身
  权限规则自动放行改动和命令。需要保守就改 `reject`。
- 面板**没有鉴权**：任何能访问 DSH 监听地址的人都能读到这次运行的提示词片段、工具标题和模型名。
  它默认只挂在你自己 profile 的 Web 端口上；共享网络里跑时请用防火墙限制，或只监听 loopback。
- 子进程的环境变量会过滤掉 `*_API_KEY`、`*_TOKEN`、`*SECRET*`、`*PASSWORD*` 这类名字；
  确实需要时用 `config.env` 显式补回。

## 限制

- 外部子智能体是**一次性**的：只回最终文本，不能 `send_message` 追问。
- 面板是本进程内存里的环形记录（最多 50 个 run、每个 600 条事件），进程重启即清空。
- 只为 OpenCode 的 ACP 扩展做了适配；换成别的 ACP agent 时，`child_update` 相关行不会出现。

## 结构

```
index.js           插件入口：注册 provider + /opencode-live 数据路由（state / SSE）
client.js          Client 模块：侧边栏图标 + main 面板（React，订阅 SSE）
lib/provider.js    ACP 客户端与 subagent provider（无第三方依赖）
lib/trace.js       运行记录与 SSE 扇出
```

## 开发

```bash
node --check index.js client.js lib/provider.js lib/trace.js
```

`lib/provider.js` 不依赖 DSH，可以脱离宿主单独驱动一个 `opencode acp` 子进程做联调。

## License

MIT
