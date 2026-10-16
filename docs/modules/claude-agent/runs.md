# Claude Agent Runs 组件

[Claude Agent 模块](README.md) · [设计](../../claude-agent-design.md)

## 职责与入口

线程与 Run 的业务门面：创建线程、准入 Run（同线程一个，不同线程并行，幂等键）、取消与等待实际退出、审批桥接、每个 Run 的有界实时投影、线程标题（提示词 → Claude 会话标题）、最近项目与目录浏览，以及应用停止保护。持久事实经 [Store](store.md)，进程与 Claude 环境的会话文件经 [SDK 适配器](sdk.md)。

| 项目 | 定义 |
| --- | --- |
| 源码 | [core/runs/component.ts](../../../src/applications/claude-agent/core/runs/component.ts)；纯状态 [approvals.ts](../../../src/applications/claude-agent/core/runs/approvals.ts)；fold [core/events.ts](../../../src/applications/claude-agent/core/events.ts)；最近项目合并 [core/projects.ts](../../../src/applications/claude-agent/core/projects.ts)；目录浏览 [core/directories.ts](../../../src/applications/claude-agent/core/directories.ts) |
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

结算：等待 `result` 再等待 `done`；线程有 session 且标题来源不是 user 时经适配器 `readSessionInfo` 读取 Claude 环境的会话标题（失败或相同则忽略）；结清遗留审批；`cancelRequested` → `cancelled`，否则成功结果 → `completed`、错误结果或失败 → `failed`（`is_error` 的结果文本成为错误消息）；写回 Run 与线程（含新的 claude 标题），发出终态变化，唤醒 `waitRun`。状态只在进程实际退出后变为终态，终态变化在标题写入之后发出，浏览器重读线程即可看到新标题。

## 执行、取消与清理

`cancelRun`：标记 `cancelling` → deny 全部待审批 → `interrupt()`（最多等 `interruptTimeoutMs`）→ 等 `result` → 等 `done` → 超时则 `close()`。`waitRun(id, signal)` 在结算后或 signal 中止时返回。`pauseIfIdle` 在没有活动或正在启动的 Run 时冻结新 Run 并返回释放函数，供应用停止保护使用；`closeAdmission` 只关闭准入。Effect 关闭准入，取消全部活动 Run，等待它们结算与索引写入。

## 失败与兼容

索引写入失败记录到日志，不改变已退出进程的事实；Run 不跨重启存活。错误码与 HTTP 状态：`run-active`/`idempotency-conflict`/`approval-resolved` 409，`thread-not-found`/`run-not-found`/`project-path-missing` 404，`invalid-input`/`project-path-invalid` 400，`request-too-large` 413，`claude-binary-*`/`service-unavailable` 503。

## 测试

[claude-agent-runs.test.mjs](../../../tests/claude-agent-runs.test.mjs)：准入与并行、幂等、投影与 session 固定、审批阻塞/回答/取消、`result` 早于 `done`、超时终止、重启标记、卸载排空、最近项目合并与 partial、提示词/Claude/用户标题、实际模型、待审批计数、v1 样本升级。[claude-agent-projects.test.mjs](../../../tests/claude-agent-projects.test.mjs)：`mergeRecentProjects`、`parseDirectoryRequest`、`listDirectory` 的纯函数与临时目录行为。
