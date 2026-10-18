# Claude Agent SDK 适配器组件

[Claude Agent 模块](README.md) · [设计](../../claude-agent-design.md)

## 职责与入口

0.1.10 通过 `readAccountUsage(cwd?, signal?)` 读取当前设备/项目真实账号和套餐额度。`sdk/account.ts` 隔离实验性 `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors:true})` 与 `accountInfo()`，仅投影账号邮箱、组织、套餐、认证提供方以及 5 小时/每周已用百分比和重置时间；不输出凭据来源、原始错误或其他会话统计，不持久化账号快照。单项读取 8 秒有界，额度失败仍返回可读账号；缺失窗口/数值为 null，不能解释为 0%。API/云认证或缺少 profile 授权明确报告不可用。初始化查询不发送用户消息、不创建会话，采用模型目录相同的空工具/MCP 与 hooks 请求屏蔽，结束/取消/关闭均等待实际进程退出。活动 Run 的账号查询经 `inspect({action:'account'})` 复用其实际 Query，不打断任务；该 Query 持有的未完成原生读取仍随其生命周期清理。测试见 `tests/claude-agent-account.test.mjs`。

唯一接触 `@anthropic-ai/claude-agent-sdk` 的组件。启动时解析用户自己的 `claude` 可执行文件；按 Run 启动一个流式输入模式的 `query()` 子进程，把 SDK 帧翻译成应用自己的事件，把 `canUseTool` 桥接为审批请求；以只初始化、不发送用户消息的独立查询读取当前 Claude 环境的可选模型；经子进程读取会话转录、Claude 环境的会话目录列表与单个会话的标题。拥有它启动的全部进程。

| 项目 | 定义 |
| --- | --- |
| 源码 | [core/sdk/adapter.ts](../../../packages/app-claude-agent/src/core/sdk/adapter.ts)；纯投影 [models.ts](../../../packages/app-claude-agent/src/core/sdk/models.ts)、[executable.ts](../../../packages/app-claude-agent/src/core/sdk/executable.ts)、[translate.ts](../../../packages/app-claude-agent/src/core/sdk/translate.ts)；子进程入口 [history-worker.ts](../../../packages/app-claude-agent/src/core/sdk/history-worker.ts) |
| 工厂 / Nya 名称 | `createClaudeAgentSdkComponent(options?)` / `claude-agent-sdk` |
| 服务 | `claude-agent.sdk: ClaudeAgentSdkPort`（契约在 [port.ts](../../../packages/app-claude-agent/src/core/sdk/port.ts)，不含 SDK 类型） |
| `inject` | 无 |

## 配置与接口

| 选项 | 默认值 | 含义 |
| --- | --- | --- |
| `executableOverride` | `ANYBOX_CLAUDE_AGENT_BINARY` | 显式可执行文件路径；存在即跳过 PATH 解析 |
| `env` / `platform` / `homeDirectory` / `isFile` | 进程实际值 | 解析输入，可替换以便测试 |
| `historyWorker` | 同目录 `history-worker.js` | 会话文件子进程入口（`messages` / `sessions` / `info` 三个命令） |
| `historyTimeoutMs` / `historyLimitBytes` | 30 秒 / 8 MiB | 转录读取上限；会话列表固定 15 秒 / 1 MiB，单会话信息固定 10 秒 / 64 KiB |
| `modelsTimeoutMs` / `modelsLimitBytes` | 10 秒 / 1 MiB | CLI 初始化期限及 stdout+stderr 累计上限（前置目录检查仍等待实际完成）；最多同时 4 个查询 |
| `sessionScanLimit` | 200 | 为最近项目扫描的最新交互式会话数 |
| `hostInstructions` | 一句说明宿主是 Anybox | `systemPrompt` preset 的 append |

`environment()` 返回 `EnvironmentView`（平台、路径与来源 `override|path|fallback`，或 `claude-binary-missing` / `claude-binary-shim` 错误与可展示文案）。`openRun({ cwd, prompt, resume, model?, effort?, permissionMode? }, { onEvent, canUseTool })` 同步返回句柄：`result` 为业务结果（收到 `result` 帧，或迭代器异常结束的失败），`done` 在进程实际退出后才结算，`interrupt()` 发送优雅中断，`close()` 终止进程；两者都不会 reject。`readSessionMessages(sessionId, dir, signal?)` 返回 `HistoryMessageView[]`；`listSessionProjects(signal?)` 返回环境中交互式会话（`listSessions({ includeProgrammatic: false, limit })`）去重后的目录及其最新修改时间，最新在前；`readSessionInfo(sessionId, dir, signal?)` 返回 `getSessionInfo` 的标题（`customTitle ?? summary ?? firstPrompt` 的首行、最多 200 字），会话不存在时为 `undefined`。

`listAvailableModels(cwd?, signal?)` 返回应用自有的 `AvailableModelsView`；cwd 必须是当前执行设备上存在的绝对目录，省略使用该设备 home。查询先解析实际目录路径，调用 `Query.supportedModels()`；只保留模型值、显示名称、说明、解析后模型和可选强度能力，不转发账号或完整初始化对象。目录最多 200 项，标识/名称/说明分别限制 100/200/4000 字符，模型值去重；长上下文别名（如 `sonnet[1m]`）与供应商路径标识和 Run 使用同一校验规则。

## 功能流程

解析顺序：覆盖 → PATH（Windows 结合 PATHEXT，`.cmd/.bat/.ps1` 垫片换成同目录包内的 `bin/claude.exe` 或 `cli.js`）→ Unix `~/.local/bin/claude`。缺失不让组件失败，而是记录到 `environment()`，`openRun` 以同样的错误码同步拒绝。

Run 固定 SDK 选项：`pathToClaudeCodeExecutable`、`cwd`、`resume`（线程已有 session 时）、`systemPrompt` preset + append、`permissionMode`（线程选择，缺省 default）、`allowedTools`（缺省空，会话授权按原生规则复用）、`includePartialMessages: true`、`thinking: { type: 'adaptive', display: 'summarized' }`、`env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'anybox' }`、`abortController`、`stderr` 回调、可选 `model`/`effort`。不设置 `settingSources`、`strictMcpConfig`、`persistSession`、`sessionStore`，不覆盖 `HOME`。

模型目录查询单独使用 `persistSession: false`、空工具与 MCP 列表、`strictMcpConfig: true`，以 settings 和 restrictive managedSettings 请求禁用 hooks；如设备存在管理员策略且不接纳父设置，管理员强制的启动 hooks 仍按策略执行。保留当前设备/项目的模型及认证设置，不覆盖 HOME。不 yield 用户消息，不调用模型、不生成业务 Run 或可恢复会话。查询成功、失败、超时、超限、请求取消与组件关闭均终止该查询进程；Unix 清理所拥有进程组，Windows 等待该子进程实际退出；查询 Promise 在退出确认后才完成。此实现不代表 Windows 已完成实机验收。

prompt 是只 yield 一条用户消息的异步迭代器，收到 `result` 后结束输入，SDK 关闭 stdin，CLI 自行退出。Unix 上 `spawnClaudeCodeProcess` 以 `detached: true` 启动进程组，接管 stderr 尾部（8 KiB），子进程退出时对进程组 SIGKILL 并发出 `exit` 事件；迭代器结束 10 秒后仍未退出也 SIGKILL。Windows 交给 SDK spawn，`done` 以迭代器结束近似。

`translate.ts`：`system/init`→`init`（带 session id、模型、cwd、权限模式、版本）、`stream_event`→`message-start`/`block-start`/`text-delta`/`thinking-delta`/`block-stop`（只在 `message_start` 之后有效）、`assistant`→完整块、`user` 的 `tool_result`→`tool-result`、`status`、`compact_boundary`、`permission_denied`/`api_retry`/`rate_limit_event`→`notice`、`result`→`RunResultView`；子 Agent 完成消息进入独立有界输出，流式子帧与未知帧忽略，不混入主线程。`canUseTool` 把 `toolUseID`、`title/description/decisionReason`、`defaultToNo`、`suggestions` 与 `AskUserQuestion` 的问题投影为 `SdkPermissionRequest`；决定转回 `PermissionResult`（`allow` 带 `updatedInput`，会话级允许附 destination 为 `session` 的 `updatedPermissions`，问题类以 `updatedInput.answers` 回答）。

会话文件读取用 `process.execPath` 启动 `history-worker.js`（`ELECTRON_RUN_AS_NODE=1`，与本机 computer worker 一致），每次一个子进程：`messages <sessionId> [dir]` 调用 `getSessionMessages` 输出转录，`sessions <limit>` 调用 `listSessions` 输出 `{ sessionId, cwd, lastModified }` 列表，`info <sessionId> [dir]` 调用 `getSessionInfo` 输出标题字段或 `null`。父进程按各命令的时间与字节上限收集 JSON，超时或超限 SIGKILL，取消信号同样终止；纯投影 `historyMessages`、`sessionProjects`、`sessionInfo` 位于 `translate.ts`。

## 执行、取消与清理

每个 Run 句柄、模型目录查询与 worker 登记在组件内；Effect 关闭全部模型查询、对全部句柄 `close()`、对 worker SIGKILL，然后等待所有 `done` 与退出，包括目录校验阶段尚未 spawn 的查询。取消语义由 [Runs](runs.md) 编排：先 `interrupt()`，超时才 `close()`。

## 失败与兼容

`models-unavailable`（当前环境无法返回合法目录）、`models-timeout`（504）、`models-too-large`（413）、`project-path-invalid` / `project-path-missing`（目录查询参数）；`agent-exited`（无结果即退出，附 stderr 尾部）、`agent-failure`（SDK 抛错）、`cancelled`（中止）、`history-unavailable`（任一会话文件子进程失败或解析失败，附 stderr 尾部）、`history-too-large`（413）、`invalid-input`（非 UUID session id）。最近项目把 `listSessionProjects` 的失败降级为 partial 结果，标题读取失败保留现有标题。登录失败等 CLI 错误以 `result` 帧（`is_error`）或 stderr 文本原样进入 Run 错误，界面直接显示。SDK 精确固定 0.3.301，升级需重新核对帧与选项。

## 测试

纯函数：[claude-agent-executable.test.mjs](../../../packages/app-claude-agent/tests/claude-agent-executable.test.mjs)、[claude-agent-projection.test.mjs](../../../packages/app-claude-agent/tests/claude-agent-projection.test.mjs)。纯投影 `sessionProjects` / `sessionInfo`：[claude-agent-projects.test.mjs](../../../tests/claude-agent-projects.test.mjs)。真实二进制：[claude-agent-sdk.test.mjs](../../../tests/claude-agent-sdk.test.mjs)（`ANYBOX_CLAUDE_AGENT_TESTS=1`），覆盖完整一轮、session 固定、转录读取、会话标题与会话目录列表、resume 与 interrupt、以及经客户端网关的端到端。

模型目录：[claude-agent-models.test.mjs](../../../tests/claude-agent-models.test.mjs) 覆盖纯白名单投影、初始化控制查询无用户消息、成功退出等待、取消、超时、超限、组件关闭与长上下文模型标识。目录发现使用模拟 CLI 协议，不替代跨平台实机验收。

## 0.1.5 权限与能力控制

`listCapabilities(cwd?, signal?)` 复用初始化查询的准入、期限、输出限制、取消和真实退出等待，调用 `supportedCommands/supportedAgents/mcpServerStatus`。与模型查询不同，保留环境的 MCP 配置；仍不发送提示词，不开放工具审批，以 settings/managedSettings 请求关闭可选 hooks。查询可能启动配置的 MCP 连接，结束会关闭所属进程。投影最多 500 个技能/命令、200 类 Agent、200 个 MCP 服务，服务只返回名称、状态、来源及工具名，不返回配置、URL、环境、认证头或原始连接错误。

活动 Run 句柄增加 `capabilities()` 和白名单 `control()`，分别转接 `setPermissionMode/reloadSkills/toggleMcpServer/reconnectMcpServer/stopTask`。控制不自动重试；结束或取消后拒绝新控制，SDK 拥有在途控制，`done` 同时等待进程退出与控制结束。权限模式提供 default、acceptEdits、plan、auto、dontAsk；不开放 bypassPermissions。auto 的账户/CLI 可用性由真实环境判断，失败不冒充已应用。

审批返回完整可展示的建议规则、blockedPath 和不可记住的原因。只在建议存在、完整可展示且未 suppress 时允许记住；缺失建议直接拒绝 allow-session，删除原先隐式授权整个工具的 fallback。始终把建议 destination 改为 session，不写用户或项目权限文件。session 的原生边界是当前 Run 的 SDK 进程；0.1.6 由应用保存明确选择的可复用规则并在后续 Run 重新注入，详见下节。

`forwardSubagentText: true` 接入子 Agent 完成消息；task_started/progress/updated/notification 映射为应用任务投影。按任务 generation 忽略旧代迟到消息，主线程流式 ID 与子线程消息分开；最多 200 个任务、100 条子线程消息，单条子线程块序列约 32 KiB（最多 32 块）。完整子 Agent 历史仍由 Claude 原生环境拥有，此版不新增其持久历史浏览。

验证：[claude-agent-capabilities.test.mjs](../../../tests/claude-agent-capabilities.test.mjs) 使用真实 SDK 与受控 CLI 协议验证能力白名单、初始化无提示词、每个控制请求、关闭后拒绝、实际进程退出及纯状态/浏览器控制行为。真实设备能力目录读取单独记录，不把模拟协议视为跨平台实测。

## 0.1.6 会话授权复用

SdkPermissionRequest 新增应用自有 reusablePermissions，只接受 SDK 建议中的 addRules + allow 和 addDirectories；含替换、移除、deny/ask、setMode、无法完整展示或 suppress 的建议不提供会话记住按钮。SDK 原生对象仍留在 core/sdk，纯转换位于 sdk/permissions.ts，应用校验和去重位于 core/permissions.ts。

openRun 的 sessionPermissions 由 Runs 读取当前线程的有效授权传入；适配器精确保留工具名和规则内容并转换成 allowedTools 的原生 `Tool(pattern)` 形式，额外目录使用 additionalDirectories。应用不实现命令或路径模式匹配，不在 canUseTool 里直接按工具名自动放行。Claude 继续执行 deny/ask、权限模式、管理员强制确认等规则。当前调用的明确授权仍以 destination session 更新 SDK；下一轮由已保存的完整会话授权重建。

授权撤销只允许空闲线程，以避免把下一轮撤销伪装成已从当前进程删除规则。不会写用户/项目设置，也不永久保留空闲 Claude 进程。真实双轮验证与正式升级见 [会话授权修复](../../claude-agent-session-permissions.md)。

## 0.1.7：上下文、原生历史、MCP 交互与文件恢复

`SdkRunRequest.options` 接收应用自己的 `SessionOptions`，适配器映射 `maxBudgetUsd`、`maxTurns`、`fallbackModel`、`mcpServers`、`enableFileCheckpointing` 与 `replay-user-messages`。预算由原生 CLI 执行；每个 Run 固定配置快照。检查点只接收本 Run 提交的 UUID 的回显，历史回显不能成为新检查点。

`inspectSession(request, input, hooks, signal)` 使用没有用户消息的独立流式 Query，支持 `getContextUsage({detail:'summary'})`、受原生 Read 权限控制的 `readFile`、`rewindFiles({dryRun})` 和 MCP 连接检查；不发送模型提示词。普通检查仍受 10 秒/1 MiB 限制；显式 MCP 连接最多 120 秒。取消和关闭均等待进程及进程组退出。活动 Run 的上下文/文件检查复用同一 Query；收到 result 后尽力获取上下文快照，失败不改变业务结果，实际进程退出后才结算。

`history-worker` 增加 `listSubagents`、`getSubagentMessages`（100 条一页，多读一条判断下一页）、`renameSession`、`tagSession`、`forkSession` 和受信测试清理用 `deleteSession`。转录仍保存在原生环境，子 Agent 用户帧与工具结果不会经过主线程过滤器。SDK 类型只在本目录出现，新增投影位于 `sdk/workspace.ts`。

`onElicitation` 将 URL / 原始类型表单投影为应用 DTO，由 Runs 等待用户显式提交或拒绝。复杂嵌套 schema 暂不支持并取消请求；URL 只允许 HTTP(S)。认证回答不写业务库、历史或日志。仅报告 needs-auth 而未发出认证请求的服务，仍需通过执行设备的 Claude 原生环境登录，SDK 没有通用的 OAuth 发起 API。

上下文为估算；分类使用 SDK 的 kind，不按英文分类名称猜测。result 增加 modelUsage 白名单；累计费用可能包含 resume/fork 之前的历史，界面不把各 Run 累计数相加。文件预览最多 128 KiB，恢复只覆盖原生跟踪的工具编辑，不承诺 Bash、全部子 Agent 编辑、目录或整个工作树回滚。

新增行为入口：`tests/claude-agent-workspace.test.mjs`。2026-10-18 本机真实 Claude 验证：MCP 表单 1 次、Explore 子 Agent 1 个（完整原生历史分页读取）、上下文及文件预览成功，检查点把 after 恢复为 before，指定首条消息分叉后只有该条历史，重启仍可读取原生子 Agent、配置和检查点。证明 `/tmp/anybox-claude-ui-audit/real-workspace-0.1.7.json`，测试项目和专用原生会话已清理。

## 0.1.8：运行中消息、附件与执行观察

适配器内部的 `sdk/input.ts` 为同一 Query 提供单条在途输入及有界待发送队列。运行中追加先进入应用队列，在当前结果返回后依次交给原生输入流；不会把“排队”冒充已经影响正在执行的模型调用。每条消息使用真实 UUID；检查点接收本 Run 初始及追加输入的 UUID。收到失败结果、取消或关闭后停止准入，未发送项 cancelled，已发出但未收到结果的项 unknown。后台任务集合非空时保持输入开放；集合清空且前台空闲才结束，不把后台任务误当成独立持久服务。应用的停止仍停止本 Run 及所属进程组。

附件经应用私有上传接口分块传入，适配器只在发送时把受信资产转换为原生 image/document/text 内容块。PDF 与图片保留原始字节；文本作为明确标记的附件内容。消息索引只保存资产 ID、名称、MIME、大小和 SHA-256；完整原生历史仍由 Claude 管理。附件内容和认证回答不进入观察事件。

新增 `setMcpServers` 与 `setMcpPermissionModeOverride`、`backgroundTasks` 控制。MCP 动态变更仅作用于当前 Query，原生设置及插件拥有的服务遵循 SDK 自己的规则；部分失败或响应丢失不重试。权限覆盖仅开放 default/auto/null，不扩大权限。`auth_status` 只投影认证中/失败，不泄漏原始认证输出或链接；服务交互 URL 仍仅来自显式 elicitation。

观察新增工具运行时长、控制请求进度、后台任务完整集合，以及按 parent_tool_use_id 分离的子 Agent 流式文字、完成消息和用户工具结果。主线程和子线程流式 ID 独立。子 Agent 实时观察仍有显示上限，完整记录按原生历史读取。

上下文支持用户显式请求 full 分类计数及记忆、工具、Agent、技能明细；默认摘要不增加逐项计数请求。文件读取使用原生权限，返回 UTF-8 文本或白名单图片/PDF，二进制最多 384 KiB、文本显示最多 128 KiB；截断内容不能被展示为完整文件。原生历史分页通过独立 worker 输出有界页面，默认取最新 100 条；支持更早消息、项目内原生会话发现、打开已有会话和显式删除历史。

验证入口：`tests/claude-agent-interactive.test.mjs`，包含队列、停止/未知状态、分块幂等与资产私有性、重启不重放、子线程投影及真实 SDK 控制协议。真实 Claude 验证另记录到 `/tmp/anybox-claude-ui-audit/real-interactive-0.1.8.json`。
