# dsh-opencode-live

把 [OpenCode](https://opencode.ai) 当作 DSH 的子智能体来用，并把它**实际**使用的 agent、工具调用和它自己派生的子 agent（fixer、explorer…）实时显示在 DSH 的一个面板里。

- **委派**：DSH 里的 `opencode` 工具，一次任务启动一个独立的 `opencode acp` 子进程；
- **实时**：Host 端把 ACP 事件镜像成 trace，Client 插件直接渲染：右侧栏按会话显示，左侧栏图标进入**全局页**汇总所有会话；面板只消费 `/opencode-live/events`（SSE：连接时先发一份 `snapshot`，之后逐事件推送），不再提供 HTML 页面；`/opencode-live/state` 保留为只读 API（返回同一份快照），面板本身不使用它；
- **不多加耦合**：OpenCode 用它自己的配置、模型和认证，DSH 只传 cwd + 任务文本。

装好并重启后：

- **右侧边栏**的「+」引导页里会出现 **OpenCode Live**，点开是一个常驻标签页，只显示**当前会话**的委派；
- **左侧栏**出现 **OpenCode Live** 图标，点开是**全局页**，按会话分组汇总所有会话的委派（running/error 优先），页面右侧标注「所有 session」，并可一键「返回对话」。

两个视图共用同一条 SSE 全局流和同一套卡片渲染；打开全局页会替换中央对话区，右栏标签页内容此时隐藏，返回对话即恢复。

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

ACP 客户端只用 Node 内置模块；`@deepseek-ai/schemastery`（声明插件 Config 用）声明为
**peerDependency**，由 DSH 安装提供，link 方式安装时也会被正确解析，不需要本地
`node_modules`。

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
    # ask    = 把 OpenCode 的权限请求转成 DSH 问题卡片（允许一次 / 始终允许 / 拒绝）
    # allow  = 自动同意（OpenCode 自己的 deny 规则仍然生效）
    # reject = 只读子智能体
    permission: ask
    # 问题送不到你面前时的回退（没有应答者 / 超时；运行被取消时直接回 cancelled）
    askFallback: reject
    # 问题等待上限（毫秒，0 = 一直等）
    askTimeoutMs: 600000
    # 面板路径（Host 路由与浏览器端都会跟随），默认 /opencode-live
    path: /opencode-live
    # 跨重启保留最近 N 条 run（0 = 关闭持久化）
    historyRuns: 30
    # 早于 N 天的记录自动清理（0 = 不按时间清理）
    historyDays: 7
    # 每条 run 只持久化最近 N 条事件
    historyEvents: 200
    # 传给子进程的环境变量（在凭据清洗之后合并）
    env: {}
    # 模型/agent 同样属于插件配置，可以在「设置 → 插件 → dsh-opencode-live」
    # 的配置页里改（会写回 profile patch）。留空则用 OpenCode 的默认值：
    # ACP 不会继承 preset 里 agent→model 的映射。
    # model: opencode-go/deepseek-v4.1-flash
    # mode: orchestrator
```

## 历史记录与清理

运行记录默认只在内存里；现在会把最近若干条镜像到磁盘，重启 DSH 后仍然可见。

- 位置：`$DSH_HOME/opencode-live/history.json`（未设置时为 `~/.dsh/opencode-live/history.json`），文件权限 `0600`，纯文本 JSON；
- 落盘内容：每条 run 的目录名与命令名（均为 basename，不保存绝对路径）、session id、起止时间与结束原因，以及最近 `historyEvents` 条事件——
  其中可能包含**模型思考片段**（每条最多 600 字符）、**工具标题与描述**、**最终回答**（最多 20 000 字符）、
  token 用量，以及 OpenCode 的 **stderr 尾部**（最多 600 字符）。共享机器上请把它当作敏感数据；
- 写入时机：每次 run 结束（1 秒内多次结束合并成一次写），临时文件 + rename 原子替换；
- 清理规则（加载和写入都会执行）：

  | 配置 | 默认 | 作用 |
  | --- | --- | --- |
  | `historyRuns` | 30 | 最多保留多少条，超出丢最老的；`0` 关闭持久化 |
  | `historyDays` | 7 | 早于 N 天的记录丢弃；`0` 不按时间清理 |
  | `historyEvents` | 200 | 每条 run 只存最近的 N 条事件 |
  | — | 2 MB | 单文件超过上限时继续丢最老的 run |

- 文件损坏或版本不匹配：忽略并从空开始，不阻塞插件启动；
- 重启时仍在 `running` 的记录会标记成 `done / aborted`，不会以绿灯回归。

## 安全边界

- 子进程**不在 DSH 的文件沙箱之下**。`permission: ask`（默认）把 OpenCode 的每次权限请求
  转成一道 DSH 问题卡片：**允许一次**回 `allow_once`、**始终允许**回 `allow_always`（由 OpenCode
  自己记住，和它的 TUI 一致）、**拒绝**回 reject。问题送不到用户时（没有应答者、超时
  `askTimeoutMs`）按 `askFallback`（默认 `reject`）fail-closed，并在面板 trace 里记一条 note。
  运行以别的方式结束时（取消、子进程退出、错误），尚未回答的问题会被撤回，run 不会回落到
  `askFallback`；取消路径直接向 ACP 回 `cancelled`。`allow` 会自动同意，`reject` 让子智能体只读。
- 面板复用 DSH Web UI 自己的鉴权：`/opencode-live/*` 在进入任何数据逻辑前调用宿主的
  `connection.requestRejection`——外来 Origin / 不可信 Host 返回 `403`，缺失或无效的
  `dsh-auth-*` cookie 返回 `401`。同源页面用登录后已有的 cookie 即可，无需额外配置；
  通过局域网 IP 访问时，也要先在该 authority 上正常登录 DSH。取不到 host 的 connection
  服务时路由一律 fail-closed（`403`）。
- 发往浏览器的 trace 只带目录名 / 命令名（basename），不下发绝对路径。
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
