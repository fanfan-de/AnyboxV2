# Claude Agent Runs 组件

0.1.10 的 `accountUsage(threadId?, cwd?, signal?)` 是受准入/清理跟踪的只读操作：指定线程先校验归属，活动且未取消时读取该 Run 的实际 Query，否则按线程项目（无线程时按显式 cwd 或设备 home）创建独立无提示词发现查询。它不创建线程、Run、会话或存储账号数据。界面关闭只取消读取观察，不能取消已有 Run；整个组件关闭等待已接纳查询退出。

[Claude Agent 模块](README.md) · [设计](../../claude-agent-design.md)

## 职责与入口

线程与 Run 的业务门面：创建线程、准入 Run（同线程一个，不同线程并行，幂等键）、取消与等待实际退出、审批桥接、每个 Run 的有界实时投影、线程标题（提示词 → Claude 会话标题）、最近项目与目录浏览，以及应用停止保护。持久事实经 [Store](store.md)，进程与 Claude 环境的会话文件经 [SDK 适配器](sdk.md)。

| 项目 | 定义 |
| --- | --- |
| 源码 | [core/runs/component.ts](../../../packages/app-claude-agent/src/core/runs/component.ts)；纯状态 [approvals.ts](../../../packages/app-claude-agent/src/core/runs/approvals.ts)；fold [core/events.ts](../../../packages/app-claude-agent/src/core/events.ts)；最近项目合并 [core/projects.ts](../../../packages/app-claude-agent/src/core/projects.ts)；目录浏览 [core/directories.ts](../../../packages/app-claude-agent/src/core/directories.ts) |
| 工厂 / Nya 名称 | `createClaudeAgentRunsComponent(options?)` / `claude-agent-runs` |
| 服务 | `claude-agent.runs: ClaudeAgentRunsPort`、`claude-agent.run-admission: { busy, pauseIfIdle, closeAdmission }` |
| `inject` | `claude-agent.store`、`claude-agent.sdk` |
| Nya 事件 | `claude-agent.run.changed`（`RunChangedView`）、`claude-agent.run.event`（`RunEventFrameView`，按 Run 的 seq 编号） |

## 配置与接口

| 选项 | 默认值 | 含义 |
| --- | --- | --- |
| `clock` | 当前时间 / `randomUUID` | 显式时间与 ID |
| `cancel.interruptTimeoutMs/resultTimeoutMs/exitTimeoutMs` | 3 s / 10 s / 5 s | 取消流程各步上限 |
| `directoryExists` | `realpath` + `fs.stat` 为目录 | 线程目录存在性检查，可替换；最近项目用同一判断并按真实路径去重 |
| `retainedViews` | 64 | 进程内保留的实时视图数（活动 Run 不被淘汰） |
| `homeDirectory` | `os.homedir()` | 目录浏览中 `~` 的展开目标 |
| `recentProjectLimit` | 20 | 最近项目条数上限 |

接口：`createThread/listThreads/getThread/readThreadMessages`、`listRuns/startRun/getRun/getRunView/waitRun/cancelRun`、`listPendingApprovals/resolveApproval`、`listRecentProjects(signal?)`、`browseDirectory({ path, showHidden }, signal?)`、`listRecentModels()`。输入经 `core/domain.ts` 校验：目录绝对路径（400 `project-path-invalid`）且存在（404 `project-path-missing`）；提示词非空且 ≤ 256 KiB，幂等键 `[A-Za-z0-9._:-]{1,200}`，模型 ≤ 100 字符，强度为 `low|medium|high|xhigh|max`。`ThreadView` 附带 `titleSource` 与内存中的 `pendingApprovals` 计数，`RunView` 附带 init 报告的 `resolvedModel`。

最近项目：并行读取索引中的线程目录与适配器的 `listSessionProjects`，适配器失败只记 `partial: true`；每个候选目录按 `normalizeProjectPath` 去掉尾部分隔符后经 `directoryExists`/`realpath` 解析，不存在的丢弃，再由纯函数 `mergeRecentProjects` 按真实路径合并来源、取最近使用时间、倒序并截断。目录浏览：`parseDirectoryRequest` 展开 `~`、要求绝对路径并解析 `showHidden`，`listDirectory` 只列目录项（符号链接不跟随）、默认隐藏点目录、按名称排序、最多 500 项；ENOENT/ENOTDIR → 404 `project-path-missing`，EACCES/EPERM → 403 `directory-unreadable`，其余 503 `directory-unreadable`，请求取消 → `cancelled`。两者都不持有状态。

## 功能流程

`startRun`：校验 → 线程存在 → 幂等键命中则返回已接受 Run（内容不同 409 `idempotency-conflict`）→ 线程已有活动或正在启动的 Run 则 409 `run-active` → 可执行文件缺失则 503（带解析文案）→ 事务创建 `running` 记录并更新线程（仍以目录名命名的线程此时取 `promptTitle`：提示词首个非空行、最多 60 字，来源 prompt）→ `openRun` 开启句柄；开启失败把记录改为 `failed` 并抛出。`init` 事件把原生 session id（首次出现时）与报告的模型 `resolvedModel` 写入 Run，session id 同时写入线程；之后的 Run 以 `resume` 续接。

实时投影：每个事件经纯函数 `applyRunEvent` 折叠成 `RunLiveView`（seq 递增），同步发出 `claude-agent.run.event`；状态变化发出 `claude-agent.run.changed`。视图在内存中保留到淘汰或重启。

审批：`canUseTool` 回调创建 `ApprovalView`（`permission` 或 `question`），持久化并发事件，等待 `resolveApproval`；`allow-session` 只在适配器报告可用时接受，问题类必须覆盖全部问题。SDK 放弃等待（signal 中止）记为 `cancelled`；Run 取消或已关闭时直接 deny。

结算：等待 `result` 再等待 `done`；线程有 session 且标题来源不是 user 时经适配器 `readSessionInfo` 读取 Claude 环境的会话标题（失败或相同则忽略）；结清遗留审批；`cancelRequested` → `cancelled`，否则成功结果 → `completed`、错误结果或失败 → `failed`（`is_error` 的结果文本成为错误消息）；写回 Run 与线程（含新的 claude 标题），再释放线程占用与活动登记，发出终态变化，唤醒 `waitRun`。状态只在进程实际退出后变为终态，结算写入期间仍视为忙碌，关闭必须等待完整结算；已经确定终态的 Run 收到取消请求时直接返回该终态。终态变化在标题写入之后发出，浏览器重读线程即可看到新标题。

## 执行、取消与清理

`cancelRun`：标记 `cancelling` → deny 全部待审批 → `interrupt()`（最多等 `interruptTimeoutMs`）→ 等 `result` → 等 `done` → 超时则 `close()`。`waitRun(id, signal)` 在结算后或 signal 中止时返回。`pauseIfIdle` 在没有活动、正在启动 Run 或准入写入时冻结新调用并返回释放函数，供 Anybox 注册适配的停止保护使用；业务装配本身不要求 `app.activity`。`closeAdmission` 只关闭准入。Effect 关闭准入，先等待已接受的 `createThread` / `startRun` 准入写入退出，再取得活动 Run 快照并取消，等待全部结算与索引写入。SDK 启动前再次复核准入，避免关闭期间排队事务完成后启动漏取消的进程。

## 失败与兼容

索引写入失败记录到日志，不改变已退出进程的事实；Run 不跨重启存活。错误码与 HTTP 状态：`run-active`/`idempotency-conflict`/`approval-resolved` 409，`thread-not-found`/`run-not-found`/`project-path-missing` 404，`invalid-input`/`project-path-invalid` 400，`request-too-large` 413，`claude-binary-*`/`service-unavailable` 503。

## 测试

[claude-agent-runs.test.mjs](../../../tests/claude-agent-runs.test.mjs)：准入与并行、幂等、投影与 session 固定、审批阻塞/回答/取消、`result` 早于 `done`、超时终止、重启标记、卸载排空、真实 SQLite 排队结算时保持忙碌并等待 Run/线程索引写入、最近项目合并与 partial、提示词/Claude/用户标题、实际模型、待审批计数、v1 样本升级。[claude-agent-projects.test.mjs](../../../tests/claude-agent-projects.test.mjs)：`mergeRecentProjects`、`parseDirectoryRequest`、`listDirectory` 的纯函数与临时目录行为。

## 0.1.5 权限模式与任务控制

`startRun` 可接收 permissionMode，优先显式选择，再用线程保存的选择，最后 default；复制到 Run 并传给适配器。`capabilities(threadId, signal?)` 在活动任务存在时读取该句柄，否则读取项目环境；`controlRun(runId, input)` 经过准入、运行状态和字段白名单校验，每个 Run 同时最多一个控制操作。MCP 名称须在该 Run 的真实目录中存在，stop-task 只能停止该 Run 观察到的活动任务。跨 Run/未知任务、已结束、取消中和并发控制均明确拒绝。

权限切换收到 SDK 确认后才保存线程/Run 的选择；失败保持旧值。MCP 启停与重连仅作用于当前 Run；关闭能力面板只取消读取，不撤回已接受的控制。能力读取与控制计入 admission，生效 guard 不跳过这些操作。实时任务与子 Agent 输出只在内存有界保留，不承诺后台任务跨 Run/进程生存。

## 0.1.6 整个会话的批准

sessionPermissions(threadId) 返回有效授权与 canRevoke；revokeSessionPermission(threadId, grantId) 只允许空闲线程且校验归属。startRun 在保留启动准入之后读取会话授权，合并并交给适配器。读取期间与撤销/审批保存互斥，其他线程不继承。

canUseTool 只在已取得原生 session id 且存在完整可复用建议时提供始终允许。resolveApproval 在 allow-session 时先原子保存授权和审批决定，然后才向 SDK 交付决定；写入失败保留待审批，不放行工具。保存与取消竞争时撤销该次新增授权；后续 Run 必须等待这段清理结束，无法确认清理则关闭该线程准入。一次允许/拒绝/取消均不会保存会话授权。

新增 tests/claude-agent-session-permissions.test.mjs 覆盖跨消息、重启、同项目不同线程、撤销、原生会话换代、写入失败与取消竞争，以及真实 SDK 对受控 CLI 的三轮交互（匹配规则不再询问、未匹配仍询问）。本机真实 Claude 双轮验证记录在会话授权修复文档。

## 0.1.7 会话工作区操作

Runs 在原组件内通过 `core/runs/workspace.ts` 闭包管理会话设置、上下文查询、子 Agent 分页、改名/标签、归档/恢复、分叉、文件预览、检查点恢复及 MCP 连接与认证请求，不增加根或组件。设置、分叉、恢复和连接检查与 startRun 共用线程准入；活动任务中不更改下一轮配置。接受的异步工作全部跟踪，停止先关闭准入并取消控制进程/认证等待，再取消并等待 Run 和其实际退出，最后等待工作区操作退出。

新分支只复制原生对话到指定 UUID，沿用项目路径和配置，不复制授权或检查点；线程索引记 forkedFrom。归档只改变本应用列表和继续执行资格，原生历史保留。改名和标签通过 SDK 更新原生文件后更新本应用索引。所有原生变更先保留耐久 idempotencyKey 操作意图；结果未知不自动重放。分叉成功后先登记原生新身份，索引失败仍保留此身份供核对。恢复请求验证检查点属于当前线程/原生会话，写入也遵守相同意图规则。

MCP 连接检查是应用拥有的短期任务，HTTP 接受后保留 Activity 租约直到实际退出；浏览器关闭不伪造取消，重新打开可查询本线程 jobs 并显式取消。认证请求按 threadId + id 精确回答且只可回答一次；拒绝、取消、应用关闭清除等待，内容仅在内存转交，其他会话无法读取或回答。恢复预览和真实执行分开，UI 显示实际 skippedLinks/错误，不能用预览的计数冒充恢复结果。

测试：`tests/claude-agent-workspace.test.mjs` 验证重启、配置快照、跨线程隔离、原生分叉位置、未知写不重放，以及 MCP 取消后退出前仍 busy。

## 0.1.8 追加消息与会话管理

`appendMessage/listMessages/cancelMessage` 使用 Run 级追加账本和单进程队列；每个任务最多同时排队 20 条。消息在本轮结束后依次发送，允许移除尚未发送的项；任务取消关闭队列并等待进程及索引实际退出。重连可以读取已保存的 queued/sent/completed/cancelled/unknown 状态。提交响应丢失后使用原请求键观察，不自动创建新输入。

`beginAttachment/appendAttachment/discardAttachment` 由 Store 拥有二进制，运行准入加载已完成的资产、固定附件元数据，再把字节传给 SDK。上传不启动模型；接受 Run 后仍由执行端持有任务。

`controlRun` 增加动态 MCP 配置、逐服务收紧权限和前台任务后台化。当前 Query 的变更与持久会话配置明确分开，失败不更新界面为成功。`readThreadMessages` 默认返回最新原生历史页面，前页/后页偏移来自 SDK worker。`nativeSessions/importSession` 只索引同项目中实际存在的原生会话；不导入外部存储或复制历史。会话管理增加显式删除，空闲和未知副作用保护与分叉一致。
