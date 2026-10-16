# Claude Agent 设计

[文档首页](README.md) · [组件手册](modules/claude-agent/README.md) · [宿主与应用边界](harness-module-boundary.md)

Claude Agent 是 Anybox 正式目录中的第二个应用（稳定 ID `claude-agent`）。它原生消费 `@anthropic-ai/claude-agent-sdk`（精确版本 0.3.301），用自己的界面驱动用户电脑上已安装、已登录的 Claude 环境；与 Anybox Harness（`agent`）并列，是另一种产品形态，不是 Harness 的第五种协议。

核心原则：**一台电脑只有一个 Claude 环境。** 用户在 VS Code、终端 `claude` 和 Anybox 里看到的登录、设置、hooks、插件、MCP、CLAUDE.md 与会话历史完全一致；Anybox 只是又一个使用这个环境的界面。

## 已确定的决策

### 状态与环境

- 共享用户的 `~/.claude`。不设独立 `CLAUDE_CONFIG_DIR`；进程环境里已有该变量就原样继承。绝不覆盖 `HOME`（覆盖后 macOS 钥匙串找不到 OAuth 凭据，CLI 报未登录）。
- 会话就是 Claude 的会话：不用 `sessionStore` 镜像，不把 `persistSession` 设为 false。Anybox 里的线程可以在 VS Code 或 `claude --resume <sessionId>` 里继续，反之亦然。
- Anybox 自己的 SQLite 只存索引：线程 → 原生 session id、项目目录、标题及其来源、时间、最近一次 Run 状态，Run 记录（含 init 报告的实际模型），以及审批记录。转录不复制，通过 SDK 的 `getSessionMessages` 读取；线程标题优先取 Claude 环境自己的会话标题（`getSessionInfo`），最近项目也读取环境的会话目录（`listSessions`）。

### 二进制与认证

- 使用用户自己安装的 `claude` 可执行文件，经 `pathToClaudeCodeExecutable` 传给 SDK；不使用 SDK 自带的平台二进制。启动时按顺序解析绝对路径：`ANYBOX_CLAUDE_AGENT_BINARY` 覆盖 → PATH（Windows 结合 PATHEXT）→ Unix 官方安装位置 `~/.local/bin/claude`（GUI 启动的桌面进程只继承极简 PATH）。Windows 上 npm 的 `.cmd/.bat/.ps1` 垫片不能直接 spawn，解析到同目录 `node_modules/@anthropic-ai/claude-code/` 下的 `bin/claude.exe` 或 `cli.js`。
- 认证完全继承：订阅登录用用户自己的 `claude auth login`，API Key 用进程环境变量。本产品不保管任何凭据，不接 Models Vault。
- 第一阶段不做“检测并引导安装”。二进制缺失或 CLI 报未登录时，把错误原样、清楚地显示在界面上，提示用户在执行设备上安装或运行 `claude auth login`。

### SDK 选项

- `settingSources` 保持默认（user/project/local 全部加载）；不设 `strictMcpConfig`。
- `systemPrompt: { type: 'preset', preset: 'claude_code', append }`，append 只加一句说明宿主是 Anybox。
- `permissionMode: 'default'`，`allowedTools: []`；所有权限提示经 `canUseTool` 桥接到界面，`AskUserQuestion` 走同一条通道。
- `includePartialMessages: true` 做流式展示；`thinking: { type: 'adaptive', display: 'summarized' }`。
- `env` 整体替换子进程环境，固定传 `{ ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'anybox' }`。
- 每次 Run 可选传 `model` 与 `effort`，省略即用 CLI 默认。

### 进程与取消

- 每个 Run 一个 SDK 子进程，归属由 Nya 的 Fiber/Effect 登记。迭代器收到 `result` 是业务结果（`result`），子进程实际退出才是 `done`，两者不混淆：Run 状态只在 `done` 之后结算。
- Unix 上通过 `spawnClaudeCodeProcess` 以 `detached: true` 启动进程组，自行接管 stderr 尾部用于错误展示；子进程退出时对整个进程组 SIGKILL，迭代器结束后 10 秒仍未退出也 SIGKILL。Windows 没有进程组，交给 SDK 自己 spawn，`done` 以迭代器结束并 `close()` 近似。
- 浏览器或客户端断开不取消 Run；待审批请求在断开后继续等待。用户取消 Run 时，待审批请求一律以 deny 结清，再执行取消流程。应用停止或整根关闭时先关准入，再取消并等待全部子进程退出。Run 不跨进程重启存活（重启时索引里的 running/cancelling 行标为 interrupted），线程可以凭原生 session id 继续。

### 边界与品牌

- 不复用 Anybox Harness 的 Session、Run、RunRuntime、Models、Prompt、Computer worker、协议 Loop 和工具库，也不注入它们的服务。
- 远端 Computer 附着不适用：执行设备就是装了 Claude 并已登录的设备，项目目录必须在执行设备上。
- SDK 类型只出现在 `core/sdk/` 目录（适配器与历史子进程入口）；HTTP DTO 与持久化记录使用自己的版本化结构（`schemaVersion: 1`），只做白名单投影，不透传 SDK 对象。边界由 `tests/application-boundaries.test.mjs` 固定。
- 产品名 Claude Agent；界面不出现“Claude Code”字样（提示用户运行 `claude` 命令除外），描述使用“Powered by Claude”。

## 客户端如何到达执行端

执行设备连接库原来由 Anybox Harness 客户端应用安装，而 AGENTS.md 规定共同提供方归宿主、不注入另一个可停止应用的专属服务。采用方案 A：

- `client.connections`（组件 `client-connections`，源码 `src/host/connections.ts`）提升为客户端宿主的常驻提供方，由 `createClientHost({ connections })` 在业务 SQLite 之后安装一次；组件名、服务名、迁移域 `client-connections` 与凭据命名空间 `anybox.client` 全部保持，已有数据零迁移。
- 代理的通用部分（请求绑定头/保留查询参数校验、租约、`Authorization` 与 `X-Anybox-Instance-Id`、不跟随重定向、响应实例不匹配判定、双向流管道与超时）抽成 `src/host/connection-proxy.ts` 的 `forwardConnectionRequest`。
- Anybox Harness 的 `client.gateway` 改为消费宿主提供方与通用转发，白名单、连接管理路由、本机状态与目录窗口保持原样；连接的管理界面暂留 Harness。
- Claude Agent 客户端只读设备列表与 `localStatus()`，用相同的 `localInstanceId` 标记“本机”，并保留自己的白名单（设备上的 `/instance`、`/products/claude-agent` 控制与 `/apps/claude-agent/...`）。本机系统目录窗口同样是宿主常驻提供方 `host.directory-picker`（`src/host/directory-picker.ts`），本应用网关的 `POST /connections/:id/pick` 只在所选连接是受信本机且平台支持时调用它。

方案 B（新应用自带连接库）会让用户配置两次设备，与“一个环境”的产品原则相悖，未采用。

## 架构落点

```text
src/applications/claude-agent/
  definition.ts            稳定 ID、名称、描述、HTTP 服务名（两侧共享的纯元数据）
  config.ts                ANYBOX_CLAUDE_AGENT_BINARY 解析
  registration.ts          执行端注册：store → sdk → runs → http，停止保护
  client/registration.ts   客户端注册：浏览器入口、资源清单、网关（不加载执行端代码）
  client/gateway.ts        claude-agent.gateway：设备列表、本机身份、白名单转发
  core/view.ts             版本化 DTO（线程、Run、审批、实时视图、事件、历史消息、最近项目、目录列表、最近模型）
  core/domain.ts           失败码、输入校验与提示词标题
  core/events.ts           实时视图的纯 fold `applyRunEvent`
  core/projects.ts         最近项目的纯合并；core/directories.ts 目录浏览的请求解析与 fs 列举
  core/store/component.ts  claude-agent.store：索引库，迁移域 claude-agent v2
  core/sdk/adapter.ts      claude-agent.sdk：唯一接触 SDK 的组件；executable.ts、translate.ts、history-worker.ts（messages/sessions/info 三个子进程命令）
  core/runs/component.ts   claude-agent.runs / claude-agent.run-admission：准入、取消、审批桥接、实时投影、最近项目、目录浏览、标题
  http/                    claude-agent.http：业务路由、有界 SSE
  web/                     浏览器入口 app.ts、设备客户端、项目面板 projects.ts、纯状态函数、DOM 渲染
web/apps/claude-agent/style.css
```

Nya 服务前缀 `claude-agent.`，迁移域 `claude-agent`，环境变量前缀 `ANYBOX_CLAUDE_AGENT_`。执行端 `/api/v1/apps/claude-agent`，客户端 `/api/client/v1/apps/claude-agent`，不加旧别名。两侧注册加入 `src/entrypoints/` 的正式目录（客户端、执行端、`serve`、桌面 worker）；`createHarnessServer` 通过 `additionalApplications` 并列装配，不在 Harness 内导入本应用。products 表把新 ID 默认关闭，用户从“我的应用”打开。各组件的服务、依赖、资源与清理见[组件手册](modules/claude-agent/README.md)。

## 输入模式与 Run 生命周期

`query()` 的 prompt 使用**流式输入模式**（异步可迭代的用户消息）：迭代器只 yield 一条用户消息，然后等待 Run 结束才 return。理由：只有流式输入模式提供 `interrupt()`，取消可以让 CLI 优雅结束当前轮并写入完整转录，供 `claude --resume` 续接；字符串 prompt 模式只能 abort + kill，转录可能截断。收到 `result` 后立即结束输入迭代器，SDK 关闭 stdin，CLI 自行退出，仍然满足“每个 Run 一个子进程”。

Run 状态：`running → completed | failed | cancelled`，重启后遗留为 `interrupted`，取消请求期间为 `cancelling`。首个 Run 不传 `sessionId`，从 `init` 消息读取 `session_id` 并立即持久化到线程；之后的 Run 用 `resume`。同一线程同一时刻只允许一个 Run（409 `run-active`），不同线程并行；`idempotencyKey` 返回已接受的 Run，内容不同返回 409 `idempotency-conflict`。

取消流程：标记 `cancelling` → 以 deny 结清全部待审批 → `interrupt()`（最多等 3 秒）→ 等 `result` 最多 10 秒 → 结束输入后等退出最多 5 秒 → 仍未退出则 `close()` 杀进程 → 等 `done` → 结算为 `cancelled`。

审批：`canUseTool` 把每个请求投影为 `ApprovalView`（`permission` 或 `question`），持久化后在界面等待决定。`allow` 返回 `updatedInput`；`allow-session`（仅 SDK 给出 suggestions 且未 suppress 时提供）附 destination 为 `session` 的 `updatedPermissions`；`deny` 返回 deny；AskUserQuestion 以 `updatedInput.answers`（问题文本 → 选项 label）回答。SDK 放弃等待（signal 中止）时记为 `cancelled`。

## HTTP / SSE 契约

执行端前缀 `/api/v1/apps/claude-agent`。错误为 `{ error: { code, message? } }`，message 只来自产品自己的安全文案（例如二进制缺失的解析结果）。

| 方法 / 路径 | 行为 |
| --- | --- |
| `GET /environment` | `EnvironmentView`：平台、可执行文件路径/来源或解析错误 |
| `GET /threads`、`POST /threads { projectPath, title? }` | 列表（updatedAt 倒序）/ 创建，目录必须是该设备上的绝对路径且存在，返回 201；显式 `title` 的来源为 user |
| `GET /projects/recent` | `RecentProjectsView`：本应用线程目录与 Claude 环境交互式会话目录按真实路径合并去重，只保留该设备上仍存在的目录，按最近使用倒序最多 20 条；环境列表读取失败时 `partial: true`，只含线程目录 |
| `GET /directories?path=<绝对路径或 ~>&showHidden=1` | `DirectoryListingView`：只列子目录、不跟随符号链接、默认隐藏点目录、按名称排序、最多 500 项并标记 `truncated`；`~` 展开为执行设备 home；缺失 404 `project-path-missing`，无权限 403 `directory-unreadable`；随请求取消 |
| `GET /models/recent` | `RecentModelsView`：最近 Run 请求或 init 报告的模型名去重，最多 12 个 |
| `GET /threads/:id`、`/runs`、`/messages`、`/approvals` | 线程、Run 列表、转录（`getSessionMessages` 投影）、待处理审批 |
| `POST /threads/:id/runs { prompt, idempotencyKey, model?, effort? }` | 202 `RunView`；接受后以 `retainUntil(waitRun)` 延续应用租约到进程退出 |
| `GET /runs/:id`、`GET /runs/:id/view` | Run / 进程内的实时视图（重启后 404 `view-unavailable`） |
| `GET /runs/:id/wait?timeoutMs` | `{ done, timedOut, run }`（0..10000，默认 10000；代理握手上限 15 秒），超时只释放 waiter |
| `POST /runs/:id/cancel {}` | 请求取消，返回当前状态 |
| `POST /approvals/:id { decision, answers? }` | `allow` / `allow-session` / `deny`，问题类必须给全部答案 |
| `GET /events?threadId=…`（1..4） | SSE：`ready`、`run-changed`、`run-event`（带 seq），15 秒心跳，背压超限关闭该流；无重放游标，重连后用 `/runs/:id/view` 校准 |

DTO 定义在 `core/view.ts`：`ThreadView`（含 `titleSource`：default/prompt/claude/user，以及内存中的 `pendingApprovals` 计数）、`RunView`（含 `resolvedModel`、`RunResultView` 用量与 `RunErrorView`）、`ApprovalView`、`RunEventView`、`RunLiveView`（有界：单块 64 KiB、400 条、50 条通知、200 条审批）、`HistoryMessageView`、`RecentProjectsView`、`DirectoryListingView`、`RecentModelsView`。全部 `schemaVersion: 1`，只做追加。

## 选项目

- 项目目录必须在执行设备上存在；浏览器永远不把本机文件系统路径交给远端设备。
- 最近项目合并两个来源：本应用已有线程的 `projectPath`，以及执行设备 Claude 环境自己记录的项目目录（`listSessions({ includeProgrammatic: false, limit: 200 })` 的 `cwd`，即用户在终端和 VS Code 用过的目录）。`listSessions` 与 `getSessionInfo` 和 `getSessionMessages` 一样在 `history-worker` 子进程中执行，分别有 15 秒 / 1 MiB 与 10 秒 / 64 KiB 上限。Runs 按真实路径（`realpath`）合并去重、只保留仍存在的目录、按最近使用倒序最多 20 条；环境列表读取失败时只返回线程目录并标记 `partial`。
- 目录浏览 `GET /directories` 是 Claude Agent 自己的纯函数 + fs 实现（`core/directories.ts`），不复用 Anybox Harness 的目录浏览或 Projects，不持有长期资源，不新建 Nya 组件，随请求取消。
- 浏览器的路径输入以 350 ms 防抖复用该接口校验：存在即成为所选项目，目录名作为标题占位（不作为用户标题提交）；不存在时禁用“新建线程”。
- 系统目录窗口：所选连接是受信本机且平台支持时，项目面板显示“系统目录窗口…”，经客户端网关 `POST /connections/:id/pick` 调用宿主常驻的 `host.directory-picker`；远端设备用应用内浏览。
- 首条消息即创建线程：选定项目（最近项目、浏览、输入或线程组的“在此项目新建线程”）后直接发送，浏览器先 `POST /threads` 再 `POST /threads/:id/runs`，中途失败保留提示词草稿。
- 线程标题：显式标题来源为 user，永不覆盖；仍以目录名命名的线程在首个 Run 接受时取提示词首个非空行（最多 60 字）为 prompt 标题；Run 结算、进程退出后经 `getSessionInfo(sessionId, { dir })` 读取 `customTitle ?? summary ?? firstPrompt` 更新为 claude 标题，读取失败保留当前标题。本期不做改名。

## Web 界面

`mount(container, context)` 从顶边呈现。左栏：执行设备（启动时经网关读取每台已保存设备的 `/instance`，只列能力含 `claude-agent.v1` 的设备，无法连接或未安装的只在提示中计数；只有一台合格设备时不显示下拉，只显示“本机 · 运行中 / 尚未启动”一行与启动按钮，两台以上才显示选择器；默认按路由、本机、记住的选择、第一台的顺序选择）、项目面板（`web/projects.ts`：路径输入与实时校验、应用内目录浏览、系统目录窗口、最近项目）、按项目目录分组的线程列表（目录名为组标题，完整路径在 title，组内 updatedAt 倒序，每组“在此项目新建线程”，折叠状态存 sessionStorage；每行状态点区分运行中、等待审批、失败/中断，并显示相对时间；其他线程有活动 Run 时每 10 秒重读列表）。主区：没有线程时显示三步引导（选项目 → 输入提示词 → 审批与取消）；转录（历史 + 当前 Run 的提示词与实时投影合并；纯文本，不做 Markdown，``` / ~~~ 围栏由纯函数 `splitCodeFences` 切出并以等宽块显示）；审批面板（允许 / 本次会话始终允许 / 拒绝；AskUserQuestion 单选/多选；`defaultToNo` 时默认聚焦拒绝）；输入框（Enter 发送；没有可发送目标时在输入框下方写明原因：先选择设备/启动、先选择项目或线程、正在执行请等待或取消）；模型为带 datalist 的输入（候选为该设备最近 Run 请求或报告的模型名），强度下拉；取消；结果与用量栏。可关闭的错误条在下一次成功请求后自动消失；可执行文件缺失/未登录的文案单独横幅原样显示；Run 的错误显示在转录下方。读取线程列表、转录和最近项目时延迟 200 ms 才显示占位文本，避免闪烁。窄于 760px 时左栏变为抽屉，主区标题栏有打开按钮。只有 `open` 激活原因会自动打开所选设备上的应用，选择设备、切换应用、刷新和恢复位置不隐式启动目标；未启动时提供显式“启动 Claude Agent”按钮。DOM、ID、样式全部限定在容器内（`@scope ([data-app-id="claude-agent"])`），局部路由 `host/<instanceId>/thread/<threadId>`。

## 分阶段计划

第一阶段（本设计）：执行端 core、HTTP/SSE、客户端代理、Web 界面、文档与行为测试。不做：MCP 注入、子 Agent 与 hooks 的界面、结构化输出、线程 fork/归档/重命名、多 Provider、安装检测与引导、远端 Computer 附着、图片与项目文件引用、分屏、Markdown 渲染、发行打包修改。

后续：在统一发行与原生运行时工作（`feat/composable-units-u0`）合入后处理打包；再评估线程管理、Markdown 渲染与转录搜索。

## 打包要求（待实施）

SDK 的 optionalDependencies `@anthropic-ai/claude-agent-sdk-<platform>` 每个约 200 MB，是 SDK 自带的 Claude 可执行文件；本产品始终把用户自己安装的 `claude` 传给 SDK，这些包是无用负载。`npm ci --omit=dev --include=optional` 会拉取当前平台的那一个，桌面与 Node 发行物必须排除 `**/node_modules/@anthropic-ai/claude-agent-sdk-*/**`（保留 SDK 自身的 JS 包，不能用 `--omit=optional`，否则 sharp 等平台包也会丢失）。本分支基于 main，尚未包含统一发行与原生运行时工作，打包改动等那条分支合入后再做。

## 验证

- `npm run check`：类型检查、构建、资源图校验与全部行为测试。本产品的测试：`claude-agent-executable`、`claude-agent-projection`、`claude-agent-projects`（最近项目合并、会话投影、目录浏览）、`claude-agent-runs`（含标题流程、实际模型、待审批计数与 v1 样本升级）、`claude-agent-http`、`claude-agent-client`（含目录窗口只对本机开放）、`claude-agent-web`（分组、状态点、相对时间、设备过滤、输入框原因、代码围栏切分），以及 `application-boundaries` 中的边界断言。
- `ANYBOX_CLAUDE_AGENT_TESTS=1 node --test tests/claude-agent-sdk.test.mjs`：用本机已安装并登录的 `claude` 完成一轮、固定可续接的 session、读取转录与会话标题、在会话目录列表中找到该项目、resume 后 interrupt，以及经客户端网关与执行宿主的端到端一轮。跳过不代表验收通过。
- 浏览器：`npm run web` 或 `node tests/helpers/products-browser-host.mjs` 后打开 Claude Agent：确认只列出具备能力的设备、单设备时只显示一行状态；在项目面板点最近项目、浏览目录、输入存在/不存在的路径观察校验与“新建线程”启用；选定项目后直接发送第一条消息观察线程创建、提示词标题与 Run 结束后的 Claude 标题；观察分组列表的状态点、审批面板与取消；缩窄到 760px 以下用抽屉打开侧栏；取消一次 Run 后确认 `pgrep -fl versions/` 没有残留进程，再在终端 `claude --resume <sessionId>` 续接同一会话。
