# Claude Agent 设计

[文档首页](README.md) · [组件手册](modules/claude-agent/README.md) · [宿主与应用边界](harness-module-boundary.md)

Claude Agent 是 Anybox 正式目录中的第二个应用（稳定 ID `claude-agent`）。它原生消费 `@anthropic-ai/claude-agent-sdk`（精确版本 0.3.301），用自己的界面驱动用户电脑上已安装、已登录的 Claude 环境；与 Anybox Harness（`agent`）并列，是另一种产品形态，不是 Harness 的第五种协议。

核心原则：**一台电脑只有一个 Claude 环境。** 用户在 VS Code、终端 `claude` 和 Anybox 里看到的登录、设置、hooks、插件、MCP、CLAUDE.md 与会话历史完全一致；Anybox 只是又一个使用这个环境的界面。

[D0a.1 独立业务服务](application-standalone-services.md)增加应用自己的 `anybox-claude-agent` 入口与 `createClaudeAgentServer()`。`installClaudeAgentBusiness` / `createClaudeAgentRuntime` 装配相同 Store、SDK、Runs 和 HTTP，独立及 Anybox 集成复用；宿主活动保护留在注册适配。独立服务拥有自己的 HTTP、设备访问认证与关闭，不导入 host、distribution 或 Harness；它沿用既有 SQLite 文件和 host-access v2 身份/令牌表，不能与原持有者双开。用户 Claude 认证和环境仍遵守下列原规则，未增加独立桌面或下载安装。

## 已确定的决策

### 状态与环境

- 共享用户的 `~/.claude`。不设独立 `CLAUDE_CONFIG_DIR`；进程环境里已有该变量就原样继承。绝不覆盖 `HOME`（覆盖后 macOS 钥匙串找不到 OAuth 凭据，CLI 报未登录）。
- 会话就是 Claude 的会话：不用 `sessionStore` 镜像，不把 `persistSession` 设为 false。Anybox 里的线程可以在 VS Code 或 `claude --resume <sessionId>` 里继续，反之亦然。
- Anybox 自己的 SQLite 保存应用索引、明确提交的输入账本与附件资产：线程 → 原生 session id、项目目录、标题及其来源、时间、最近一次 Run 状态，Run 记录（含 init 报告的实际模型），以及审批记录。0.1.8 附件字节归应用资产表，公开观察只返回元数据；追加输入账本不替代 Claude 的完整历史。转录不复制，通过 SDK 的 `getSessionMessages` 读取；线程标题优先取 Claude 环境自己的会话标题（`getSessionInfo`），最近项目也读取环境的会话目录（`listSessions`）。

### 二进制与认证

- 使用用户自己安装的 `claude` 可执行文件，经 `pathToClaudeCodeExecutable` 传给 SDK；不使用 SDK 自带的平台二进制。启动时按顺序解析绝对路径：`ANYBOX_CLAUDE_AGENT_BINARY` 覆盖 → PATH（Windows 结合 PATHEXT）→ Unix 官方安装位置 `~/.local/bin/claude`（GUI 启动的桌面进程只继承极简 PATH）。Windows 上 npm 的 `.cmd/.bat/.ps1` 垫片不能直接 spawn，解析到同目录 `node_modules/@anthropic-ai/claude-code/` 下的 `bin/claude.exe` 或 `cli.js`。
- 认证完全继承：订阅登录用用户自己的 `claude auth login`，API Key 用进程环境变量。本产品不保管任何凭据，不接 Models Vault。
- 第一阶段不做“检测并引导安装”。二进制缺失或 CLI 报未登录时，把错误原样、清楚地显示在界面上，提示用户在执行设备上安装或运行 `claude auth login`。

### SDK 选项

- `settingSources` 保持默认（user/project/local 全部加载）；不设 `strictMcpConfig`。
- `systemPrompt: { type: 'preset', preset: 'claude_code', append }`，append 只加一句说明宿主是 Anybox。
- `permissionMode` 默认 default，可按线程选择；`allowedTools: []`；所有权限提示经 `canUseTool` 桥接到界面，`AskUserQuestion` 走同一条通道。
- `includePartialMessages: true` 做流式展示；`thinking: { type: 'adaptive', display: 'summarized' }`。
- `env` 整体替换子进程环境，固定传 `{ ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'anybox' }`。
- 每次 Run 可选传 `model` 与 `effort`，省略即用 CLI 默认。

### 进程与取消

- 每个 Run 一个 SDK 子进程，归属由 Nya 的 Fiber/Effect 登记。每轮原生 `result` 推进追加队列，输入与所属后台工作收束后才确定 Run 的业务结果（`result`），子进程实际退出才是 `done`，两者不混淆：Run 状态只在 `done` 之后结算。
- Unix 上通过 `spawnClaudeCodeProcess` 以 `detached: true` 启动进程组，自行接管 stderr 尾部用于错误展示；子进程退出时对整个进程组 SIGKILL，迭代器结束后 10 秒仍未退出也 SIGKILL。Windows 没有进程组，交给 SDK 自己 spawn，`done` 以迭代器结束并 `close()` 近似。
- 浏览器或客户端断开不取消 Run；待审批请求在断开后继续等待。用户取消 Run 时，待审批请求一律以 deny 结清，再执行取消流程。应用停止或整根关闭时先关准入，再取消并等待全部子进程退出。Run 不跨进程重启存活（重启时索引里的 running/cancelling 行标为 interrupted），线程可以凭原生 session id 继续。

### 边界与品牌

- 不复用 Anybox Harness 的 Session、Run、RunRuntime、Models、Prompt、Computer worker、协议 Loop 和工具库，也不注入它们的服务。
- 远端 Computer 附着不适用：执行设备就是装了 Claude 并已登录的设备，项目目录必须在执行设备上。
- SDK 类型只出现在 `core/sdk/` 目录（适配器与历史子进程入口）；HTTP DTO 与持久化记录使用自己的版本化结构（`schemaVersion: 1`），只做白名单投影，不透传 SDK 对象。边界由 `tests/application-boundaries.test.mjs` 固定。
- 产品名 Claude Agent；界面不出现“Claude Code”字样（提示用户运行 `claude` 命令除外），描述使用“Powered by Claude”。

## 客户端如何到达执行端

Claude Agent 是同一个应用，客户端与执行端是该应用的两个角色。正式安装的本机两侧通过应用内部协议衔接；宿主只管理进程、相同 appId/确切包身份的通用通道与取消退出，不提供设备配对业务。

- runtime 客户端取得 `ApplicationPackageRuntimeContext.channel.request`，执行端纯注册声明 `channel.handle(root, payload, context)`。应用的 `claude-agent-local-execution` 组件在 execution 唯一根拥有本机观察资源，首次运行期请求时安装，独立于业务打开目标。读取本机描述或产品状态不会打开 Store、SDK、Runs 与业务 HTTP；显式打开仍通过 Products，停止仍受应用 guard 保护。
- 私有消息由应用定义为 describe、request、read、close 和 watch；内存 HTTP 适配复用既有 handler、白名单 DTO、背压与 SSE，不新增公开监听。请求体上限 512 KiB、响应每帧 64 KiB，通过 base64 保持原字节。取消或关闭观察等待 handler 实际退出；已经接受的 Run 继续运行，执行根关闭才按原生命周期取消并排空。
- `GET /api/client/v1/apps/claude-agent/local` 给出独立 `kind: 'local'` 的本机目标；`/local/v1/<path>` 与 `/local/pick` 分别处理本机业务和目录窗口。本机不进入 connections 表，不发行设备 token，不保存 Vault 条目；本机角色未 ready、退出或换代时清楚显示不可用，不引导用户手动添加本机地址。
- 远端继续由 `claude-agent-client-connections` 提供 `claude-agent.connections`，网关注入它并使用私有 `connection-proxy.ts` 转发。v2 私有表、凭据 namespace `anybox.client.claude-agent`、旧共享数据只读迁入和访问凭据完全归应用；不使用 Harness 的连接实现。`/connections` 及 `/:id/check|delete|pick` 保留，`/connections/:id/v1/<path>` 固定远端身份与修订，拒绝浏览器认证、重定向、保留查询绑定和越界路由。
- 客户端打开时装配自己的连接与网关，停止时取消并等待本机观察、远端网络和凭据操作实际退出。旧 distribution 完整默认发行尚未整体迁入受管角色通道，仍保留已有 `localPairing`/managed owner 兼容；不能把新安装路径的完成称为 D3 完成。
- D0b 客户端注册声明 required `storage.sqlite@^1.0.0` 和 optional `system.directory-picker@^1.0.0`。每代工厂接收冻结的能力版本元数据，只在取得兼容能力时声明目录 inject，并从本轮 deps 读取服务；缺少、不支持或版本冲突时降级为本应用目录浏览，不消费根上其他应用持有的不兼容版本。目录选择仍只对受信本机目标开放。
- 宿主通过 Activity 及应用生命周期契约协调启停与桌面退出，Claude Agent 自行登记忙碌保护、自行停止业务准入、取消并等待 Run 和 SDK 子进程；宿主不读取线程、审批、Run、Claude 环境状态或私有消息内容来判断生命周期。

应用间不建立共享业务包。具体边界、旧数据迁入与行为验收见[应用客户端业务独立归属](application-client-isolation.md)。

## 架构落点

```text
packages/app-claude-agent/src/
  definition.ts            稳定 ID、名称、描述、HTTP 服务名（两侧共享的纯元数据）
  config.ts                ANYBOX_CLAUDE_AGENT_BINARY 解析
  server-config.ts         独立服务监听、数据与名称配置；仍使用既有数据默认位置
  server-runtime.ts        installClaudeAgentBusiness / createClaudeAgentRuntime：同一业务装配
  server.ts, server-http.ts 独立服务唯一根、应用自己的 HTTP/认证与请求关闭
  server-access.ts         claude-agent-access：兼容既有 host-access v2 表和令牌
  main.ts                  anybox-claude-agent serve/init/recover-access/new-identity
  registration.ts          Anybox 执行端注册：复用业务装配，额外登记停止保护
  client/registration.ts   客户端注册：浏览器入口、资源清单、网关（不加载执行端代码）
  client/gateway.ts        claude-agent.gateway：独立本机目标、远端列表、白名单转发
  client/local-execution.ts 本机私有协议客户端与流式响应转发
  local-execution/         本机通道组件、私有消息校验与内存 HTTP/SSE 适配
  core/view.ts             版本化 DTO（线程、Run、审批、实时视图、事件、历史消息、最近项目、目录列表、最近模型）
  core/domain.ts           失败码、输入校验与提示词标题
  core/events.ts           实时视图的纯 fold `applyRunEvent`
  core/projects.ts         最近项目的纯合并；core/directories.ts 目录浏览的请求解析与 fs 列举
  core/store/component.ts  claude-agent.store：索引库，迁移域 claude-agent v4
  core/sdk/adapter.ts      claude-agent.sdk：唯一接触 SDK 的组件；executable.ts、translate.ts、history-worker.ts（messages/sessions/info 三个子进程命令）
  core/runs/component.ts   claude-agent.runs / claude-agent.run-admission：准入、取消、审批桥接、实时投影、最近项目、目录浏览、标题
  http/                    claude-agent.http：业务路由、有界 SSE
  web/                     浏览器入口 app.ts、设备客户端、项目面板 projects.ts、纯状态函数、DOM 渲染
packages/app-claude-agent/web/style.css
```

Nya 服务前缀 `claude-agent.`，迁移域 `claude-agent`，环境变量前缀 `ANYBOX_CLAUDE_AGENT_`。执行端 `/api/v1/apps/claude-agent`，客户端 `/api/client/v1/apps/claude-agent`，不加旧别名。两侧注册加入 `packages/distribution/src/entrypoints/` 的正式目录（客户端、执行端、`serve`、桌面 worker）；`createHarnessServer` 通过 `additionalApplications` 并列装配，不在 Harness 内导入本应用。products 表把新 ID 默认关闭，用户从“我的应用”打开。各组件的服务、依赖、资源与清理见[组件手册](modules/claude-agent/README.md)。

## 输入模式与 Run 生命周期

`query()` 的 prompt 使用**流式输入模式**（异步可迭代的用户消息）：先发送初始消息，运行中追加的消息进入有界队列，在每轮 result 后依次发送。只有流式输入模式提供 `interrupt()`，取消时可让 CLI 结束当前轮并写入原生转录。最后一轮结果且所属后台工作收束后结束输入，SDK 关闭 stdin，等待 CLI 实际退出；仍保持每个 Run 一个 SDK 子进程。

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
| `GET /models?cwd=<绝对项目路径>` | `AvailableModelsView`：当前执行设备在该项目环境中经 SDK `supportedModels()` 返回的模型名称、说明和可选能力；省略 cwd 使用设备 home；按请求取消与实际进程退出后返回，不发送用户消息 |
| `GET /models/recent` | `RecentModelsView`：最近 Run 请求或 init 报告的模型名去重，最多 12 个；仅保留已安装 0.1.2 客户端的兼容读取，新选择器不消费此接口 |
| `GET /threads/:id`、`/runs`、`/messages`、`/approvals` | 线程、Run 列表、转录（`getSessionMessages` 投影）、待处理审批 |
| `POST /threads/:id/runs { prompt, idempotencyKey, model?, effort?, permissionMode? }` | 202 `RunView`；接受后以 `retainUntil(waitRun)` 延续应用租约到进程退出 |
| `GET /runs/:id`、`GET /runs/:id/view` | Run / 进程内的实时视图（重启后 404 `view-unavailable`） |
| `GET /runs/:id/wait?timeoutMs` | `{ done, timedOut, run }`（0..10000，默认 10000；代理握手上限 15 秒），超时只释放 waiter |
| `POST /runs/:id/cancel {}` | 请求取消，返回当前状态 |
| `POST /approvals/:id { decision, answers? }` | `allow` / `allow-session` / `deny`，问题类必须给全部答案 |
| `GET /events?threadId=…`（1..4） | SSE：`ready`、`run-changed`、`run-event`（带 seq），15 秒心跳，背压超限关闭该流；无重放游标，每次 `ready` 补读线程、转录、Run 与审批，活动 Run 再用 `/runs/:id/view` 校准 |

DTO 定义在 `core/view.ts`：`ThreadView`（含 `titleSource`：default/prompt/claude/user，以及内存中的 `pendingApprovals` 计数）、`RunView`（含 `resolvedModel`、`RunResultView` 用量与 `RunErrorView`）、`ApprovalView`、`RunEventView`、`RunLiveView`（有界：单块 64 KiB、400 条、50 条通知、200 条审批）、`HistoryMessageView`、`RecentProjectsView`、`DirectoryListingView`、`RecentModelsView`、`AvailableModelsView`。全部 `schemaVersion: 1`，只做追加。

## 选项目

- 项目目录必须在执行设备上存在；浏览器永远不把本机文件系统路径交给远端设备。
- 最近项目合并两个来源：本应用已有线程的 `projectPath`，以及执行设备 Claude 环境自己记录的项目目录（`listSessions({ includeProgrammatic: false, limit: 200 })` 的 `cwd`，即用户在终端和 VS Code 用过的目录）。`listSessions` 与 `getSessionInfo` 和 `getSessionMessages` 一样在 `history-worker` 子进程中执行，分别有 15 秒 / 1 MiB 与 10 秒 / 64 KiB 上限。Runs 按真实路径（`realpath`）合并去重、只保留仍存在的目录、按最近使用倒序最多 20 条；环境列表读取失败时只返回线程目录并标记 `partial`。
- 目录浏览 `GET /directories` 是 Claude Agent 自己的纯函数 + fs 实现（`core/directories.ts`），不复用 Anybox Harness 的目录浏览或 Projects，不持有长期资源，不新建 Nya 组件，随请求取消。
- 浏览器的路径输入以 350 ms 防抖复用该接口校验：校验仅更新有效状态，点击“使用此项目”或按 Enter 后才切换项目，取消窗口不切走当前会话；目录名作为可选标题占位，不作为用户标题提交。
- 系统目录窗口：所选目标是受管本机或旧发行受信本机连接且平台支持时，项目面板显示“系统目录窗口…”，经客户端网关 `POST /local/pick`（旧发行兼容连接使用 `POST /connections/:id/pick`） 调用本代已选且按消费者装配的 `host.directory-picker`；缺少可用能力或所选设备为远端时使用本应用目录浏览。切换设备或销毁项目面板会取消窗口请求，旧请求的迟到结果与错误不会应用到新设备。
- 首条消息即创建线程：选定项目（最近项目、浏览、输入或线程组的“在此项目新建线程”）后直接发送，浏览器先 `POST /threads` 再 `POST /threads/:id/runs`，中途失败保留提示词草稿。
- 线程标题：显式标题来源为 user，永不覆盖；仍以目录名命名的线程在首个 Run 接受时取提示词首个非空行（最多 60 字）为 prompt 标题；Run 结算、进程退出后经 `getSessionInfo(sessionId, { dir })` 读取 `customTitle ?? summary ?? firstPrompt` 更新为 claude 标题，读取失败保留当前标题。本期不做改名。

## Web 界面

最左侧窄栏始终由 Anybox 宿主拥有，只提供应用入口与宿主的关闭/停止操作；Claude Agent 不向该栏放置会话、审批或测试场景入口。Claude 自己的项目、会话、搜索和设备管理位于宿主应用面板内部。

`mount(container, context)` 按宿主容器的可用高度布局，侧栏和转录各自滚动，输入区始终位于主区底部。完整问题、参考依据与截图见 [界面审计与改进](claude-agent-ui-audit.md)。

- 侧栏优先展示“新建会话”、本地搜索和按项目分组的会话；设备状态、远端连接和未发送草稿入口位于底部。按项目目录分组，组内 updatedAt 倒序；折叠偏好存 sessionStorage。行内用文字与状态点提示运行、待审批、失败/中断；其他会话有活动 Run 时每 10 秒重读列表。搜索只过滤已查询导航，不切换会话或请求服务端搜索。
- `web/projects.ts` 按需打开原生 dialog，提供最近项目、路径校验、目录浏览、本机系统目录窗口和可折叠的自定义标题。选择项目关闭窗口并聚焦输入；首条消息创建线程并执行。明确“创建空会话”仍支持自定义标题。关闭、隐藏、切换设备和销毁取消目录读取/窗口请求，忽略迟到结果并恢复焦点。
- 主区顶部显示项目短名、会话标题与真实 Run/待审批状态；完整目录在 title。空态提供项目入口与可编辑的任务建议，建议只填输入，不自动发送。窄于 760px 时侧栏变为抽屉，主区仍可直接选择项目。
- 助手正文使用应用自有的安全 GFM Markdown 渲染器；用户消息保留原文。支持标题、列表、行内代码、代码复制和表格。HTML 作为文本；图片只呈现显式链接，外链仅允许无凭据的 HTTP(S)。解析具有大小、节点和深度上限。思考、工具调用与结果默认折叠，错误结果默认展开；摘要包含工具名、已知命令/路径和真实返回状态，ID 和完整内容在详情中。流式与历史对账保留展开选择，同 ID 的内容更正可以更新。
- 阅读区最大 800px。靠近末尾时跟随新增内容；用户上翻后暂停跟随，点击“回到最新”恢复。历史、实时内容、Run 错误及审批仍由已有投影/API 提供。转录不作为整体 aria-live 区域反复播报，任务状态保留独立 role=status；完整辅助技术验收仍需单列。
- 输入框自动增长，Enter 发送、Shift+Enter 换行；IME 组合键不提交。按钮、Enter 和表单共用 `composerBlock` 准入，活动 Run 期间允许编辑下一条草稿，无法再提交。停止按钮区分取消请求与实际取消中。模型入口打开后直接列出当前设备及项目环境返回的可选模型名称和说明，提供明确的“Claude 默认模型”、选中状态、加载/失败/重试反馈；自定义模型名收纳为次级入口。目录按设备与项目隔离，切换或关闭取消读取，不把历史模型名当作可用列表；强度显式保存；用量详情显示已有结果与实际模型。
- 草稿、模型、强度与重试键按设备实例和会话/待创建项目保存在当前页面内存中，切换后恢复，不写入浏览器存储。发送成功只清除对应原稿，不删除后来输入；迟到成功/失败不会覆盖新选中的会话。`canClose` 对在途发送和任一未发送草稿返回 false；底部草稿窗口允许显式丢弃各项，包括已失去设备入口的草稿。刷新/强制关页不保证恢复草稿。
- 错误条可关闭；可执行文件/环境失败单独横幅显示；Run 错误在转录下方。列表、转录、最近项目延迟 200ms 出现占位。激活、设备发现、仅显式 open 启动产品的规则，以及 HTTP/SSE 和真实 dispose 等待保持原契约。DOM、ID、样式限定在应用容器内，局部路由仍为 `host/<instanceId>/thread/<threadId>`。

## 分阶段计划

第一阶段（本设计）：执行端 core、HTTP/SSE、客户端代理、Web 界面、文档与行为测试。0.1.5 已增加权限模式、技能、MCP 和子 Agent 的上下文入口；0.1.6 修复完整会话授权；0.1.7 增加上下文/预算、子 Agent 原生历史、线程分叉/改名/标签/归档、会话 MCP 配置与认证交互、文本文件预览及检查点恢复，契约见模块 SDK/Runs/Store/HTTP 手册。0.1.8 继续接入消息队列、图片/PDF/文本附件、动态 MCP 与认证状态、子 Agent 实时工具结果、详细上下文、原生会话发现/打开/删除与长历史分页、文件图片预览和局部编辑差异。仍不做 hooks 界面、结构化输出、多 Provider、安装检测与引导、远端 Computer 附着、分屏。Markdown 渲染与可用性改进已在 0.1.3 接入。

后续：在统一发行与原生运行时工作（`feat/composable-units-u0`）合入后处理打包；再评估线程管理与转录搜索。

## 打包要求（待实施）

SDK 的 optionalDependencies `@anthropic-ai/claude-agent-sdk-<platform>` 每个约 200 MB，是 SDK 自带的 Claude 可执行文件；本产品始终把用户自己安装的 `claude` 传给 SDK，这些包是无用负载。`npm ci --omit=dev --include=optional` 会拉取当前平台的那一个，桌面与 Node 发行物必须排除 `**/node_modules/@anthropic-ai/claude-agent-sdk-*/**`（保留 SDK 自身的 JS 包，不能用 `--omit=optional`，否则 sharp 等平台包也会丢失）。本分支基于 main，尚未包含统一发行与原生运行时工作，打包改动等那条分支合入后再做。

## 验证

隔离浏览器验收：构建后运行 `node tests/helpers/claude-agent-browser-host.mjs`，使用输出的回环 URL 检查完成会话、审批、长历史与空态；全部 API、目录与 Run 为内存样本，不读取真实项目、SDK、数据库或凭据。

`tests/claude-agent-transcript.test.mjs` 验证安全 Markdown、复制与折叠对账；`tests/claude-agent-reconnect.test.mjs` 验证断线补读、发送准入、滚动与各会话草稿、迟到提交隔离及退出保护；项目弹窗取消与焦点由 `tests/claude-agent-project-panel.test.mjs` 验证。

- `tests/application-optional-capabilities.test.mjs` 验证本应用目录能力的可选降级与版本隔离，`tests/desktop-application-lifecycle.test.mjs` 验证本应用与其他应用同等参与通用退出保护。
- `packages/app-claude-agent/tests/local-execution.test.mjs`、`packages/host/tests/application-channel.test.mjs`、`tests/claude-agent-local-client.test.mjs`：同包身份、运行期门控、JSON 边界、无本机连接/token/Vault、惰性打开、SSE 和取消实际退出，以及独立本机设备 UI。
- `npm run check`：类型检查、构建、资源图校验与全部行为测试。本产品的测试：`claude-agent-executable`、`claude-agent-projection`、`claude-agent-projects`（最近项目合并、会话投影、目录浏览）、`claude-agent-runs`（含标题流程、实际模型、待审批计数与 v1 样本升级）、`claude-agent-http`、`claude-agent-client`（含目录窗口只对本机开放）、`claude-agent-web`（分组、状态点、相对时间、设备过滤、输入框原因），以及 `application-boundaries` 中的边界断言。
- `ANYBOX_CLAUDE_AGENT_TESTS=1 node --test tests/claude-agent-sdk.test.mjs`：用本机已安装并登录的 `claude` 完成一轮、固定可续接的 session、读取转录与会话标题、在会话目录列表中找到该项目、resume 后 interrupt，以及经客户端网关与执行宿主的端到端一轮。跳过不代表验收通过。
- 浏览器：`npm run web` 或 `node tests/helpers/products-browser-host.mjs` 后打开 Claude Agent：确认只列出具备能力的设备、单设备时只显示一行状态；在项目面板点最近项目、浏览目录、输入存在/不存在的路径观察校验与“新建线程”启用；选定项目后直接发送第一条消息观察线程创建、提示词标题与 Run 结束后的 Claude 标题；观察分组列表的状态点、审批面板与取消；缩窄到 760px 以下用抽屉打开侧栏；取消一次 Run 后确认 `pgrep -fl versions/` 没有残留进程，再在终端 `claude --resume <sessionId>` 续接同一会话。

## 权限与能力交互（0.1.5）

输入区的权限模式选择器采用逐项解释与当前选择状态；任务运行时切换会向真实 SDK 发送控制，等待确认后才保存。技能入口在输入区“＋”和顶部“技能与工具”；搜索与选择只填入草稿，不自动发送。能力侧面板用原生 dialog 管理键盘焦点与 Escape 退出，分技能、MCP、子 Agent 三页；MCP 清楚区分连接失败、需要登录与停用，运行时提供启停重连；子 Agent 显示可委派类型以及本轮任务状态、输出与单独停止。

审批保留在会话输入区上方，分别显示“仅允许这次”“本轮记住以上规则”和“拒绝”。记住的具体规则与本轮有效期默认展开，额外显示为什么询问及可展开的 Claude 原始原因。不把 session 临时规则描述为跨消息持续授权。宿主最左侧应用栏不变。

交互参考 [Claude 桌面端的权限、提示框与扩展入口](https://code.claude.com/docs/en/desktop) 以及 [Codex 应用功能](https://developers.openai.com/codex/app/features/)，采用任务上下文内的按需控制。代码为现有应用实现，没有复制第三方视觉资源。边界、测试与正式生效凭据见 [0.1.5 使用及验收记录](claude-agent-permissions-and-capabilities.md)。

## 0.1.6 会话授权

“本次会话始终允许”对完整会话有效。审批中明确展示将保存的规则；事务提交后再放行，后续消息/应用重启后由 SDK 原生 allowedTools/additionalDirectories 复用。规则绑定当前线程、原生 session id 与项目路径，不写 Claude 设置文件，不扩散到其他会话。输入区权限菜单提供查看会话授权，空闲时可撤销。未匹配的操作、管理员 ask/deny、规划模式限制及其他原生强制确认继续由 Claude 处理。完整边界与验证见 [会话授权修复](claude-agent-session-permissions.md)。
