> 本文保留 0.1.4 的历史审计快照；0.1.8 的消息队列、附件、动态 MCP、实时观察和会话/文件接入进展，见 [实现与正式验收](claude-agent-permissions-and-capabilities.md#018-交互扩展)。旧统计不代表当前版本。

# Claude Agent SDK API 接入审计（2026-10-18）

> 本文保留 0.1.4 的审计快照与统计。权限模式、审批范围以及技能/MCP/子 Agent 的第一批接入已在 0.1.5 完成并生效，见 [实现与正式验收](claude-agent-permissions-and-capabilities.md)。
[文档首页](README.md) · [Claude Agent 组件](modules/claude-agent/README.md) · [应用架构](architecture/claude-agent-architecture-2026-10-18.md) · [应用设计](claude-agent-design.md)

## 范围与结论

审计对象为应用 `@anybox/app-claude-agent` **0.1.4**，固定依赖 `@anthropic-ai/claude-agent-sdk` **0.3.301**。依据已安装包的 `package.json`、公开 `.d.ts`、应用生产源码及官方文档，采用静态对照；没有运行新模型任务、调用写入型 SDK API、更改用户的 Claude 配置或升级正式环境。

这里的“已使用”指应用生产源码显式调用或传入，不统计 SDK 内部调用、测试替身、类型导入以及 Claude 原生环境自行加载的配置。未显式传入的选项可能仍采用 SDK/CLI 默认行为，不能理解为相应能力被关闭。

全量统计限于根入口函数、Query 自身声明的方法及 Options 顶层选项；不把继承的 AsyncGenerator 方法、全部 Settings 嵌套设置、工具输入输出类型和控制协议联合类型成员重复计算为可调用功能。

| 公开入口 | SDK 提供 | 应用显式使用 | 未接入 |
| --- | ---: | ---: | ---: |
| 根入口导出函数 | 18 | 4 | 14 |
| `Query` 自身声明的方法 | 30 | 3 | 27 |
| `Options` 顶层选项 | 69 | 21 | 48 |

21 项选项中，正常 Run 使用 15 项，另有 6 项只用于模型目录查询的限制与清理。根入口另外导出 2 个类、9 个运行期常量，均未被应用直接引用。计数仅描述接入面，不是功能完成度评分。可机读逐项清单见 [JSON](claude-agent-sdk-api-audit-2026-10-18.json)。

SDK 包元数据附带 Claude Code 2.1.301，但应用通过 `pathToClaudeCodeExecutable` 使用用户安装的可执行文件；SDK 类型存在不证明该设备 CLI、账户、平台或会话传输支持相同能力。接入时仍需核验实际 `claudeCodeVersion`、`system/init.capabilities` 与控制请求的失败结果。

## 当前已经接通的能力

| 当前能力 | 使用位置 | 限制 |
| --- | --- | --- |
| 执行与原生会话续接 | [`adapter.ts`](../packages/app-claude-agent/src/core/sdk/adapter.ts)：`query`、`resume`、流式输入 | 每 Run 只 yield 一条用户消息，收到 result 后结束输入；每 Run 一个 Claude 子进程 |
| 取消与退出等待 | 同文件：`interrupt`、`close`、`abortController`、Unix 进程组 | 应用自己的 result/done 分离；Windows 退出证明边界沿用已有实现 |
| 当前模型目录 | 同文件：`supportedModels()` | 初始化控制查询，不发用户消息；不创建业务 Run、不保存原生会话 |
| 模型与 effort 选择 | 同文件：`model`、`effort` | 通过新 Run 的启动选项设置，未使用 `Query.setModel()` 热切换 |
| 权限审批与提问 | [`translate.ts`](../packages/app-claude-agent/src/core/sdk/translate.ts)、[`approvals.ts`](../packages/app-claude-agent/src/core/runs/approvals.ts)：`canUseTool`、`updatedPermissions`、问题答案 | 正常 Run 固定 default 模式；前端没有权限规则/来源/期限面板 |
| 历史、标题与最近项目 | [`history-worker.ts`](../packages/app-claude-agent/src/core/sdk/history-worker.ts)：`getSessionMessages`、`getSessionInfo`、`listSessions` | 历史读取只投影主会话；环境会话列表用于最近项目，并非完整原生历史会话管理 |
| 正文、思考、工具过程 | `createMessageTranslator`、`blockView` | 只保留白名单消息；有 parent_tool_use_id 的子 Agent 内容被过滤 |
| 基础用量与费用 | `resultView` | 已保存总费用和主循环 usage；未保留 modelUsage、完整配额/上下文信息 |

正常 Run 不指定 `settingSources`。**本版本类型注释明确缺省加载全部文件来源**；也没有为正常 Run 设置 `strictMcpConfig` 或空 `tools`。因此用户环境中的技能、插件、hooks、MCP 或子 Agent 可能已被 Claude 自己使用。准确结论是“应用尚未提供发现、配置、观察和控制入口”，不是“Claude 不能使用这些功能”。

## 适合增加的产品能力

以下优先级与工作量是基于当前代码的工程判断，不是 SDK 保证。小：主要补白名单投影和界面；中：增加业务接口、并发控制或持久事实；大：改变会话/进程生命周期或接入新的服务体系。

| 建议顺序 | 产品能力 | 可用 API / 数据 | 当前缺口与工作量 |
| --- | --- | --- | --- |
| P0 | 审批范围、期限、再次询问原因；显式权限模式 | `canUseTool` 的 suggestions/decisionReason/suppressAlwaysAllowRule、`PermissionUpdate`、`setPermissionMode`、`applyFlagSettings`；`resolveSettings`（alpha）用于来源诊断 | 当前只传给业务 session 布尔值，规则留在 SDK 回调；界面未展示完整范围。先做审批解释，再设计跨 Run 授权的保存/撤销。中 |
| P1 | 当前设备的能力检查器 | `initializationResult`、`supportedCommands`、`supportedAgents`、`accountInfo`、`mcpServerStatus`、init 中的 tools/capabilities | 模型已实现，其他目录和实际加载状态未展示；可先做只读页面。小到中 |
| P1 | 技能与命令选择器 | `supportedCommands`、`skills`、`reloadSkills`、`SDKCommandsChangedMessage` | 手工输入命令和原生自动技能不等于有命令面板；需处理失效、项目切换和刷新。小到中 |
| P1 | 子 Agent 任务树、进度与转录 | `supportedAgents`、`agents`、`forwardSubagentText`、`agentProgressSummaries`、task_* 事件、`listSubagents`、`getSubagentMessages` | 当前翻译器过滤子 Agent 消息，不展示 task 事件；先补观察，再考虑自定义定义。中 |
| P1 | MCP 状态、重连与开关 | `mcpServerStatus`、`reconnectMcpServer`、`toggleMcpServer`、`setMcpServers`、`onElicitation` | 先做现有服务器的状态/故障入口，再做配置和交互。新增服务器需要处理进程、认证和清理归属。中 |
| P1 | 上下文占用、按模型用量与预算 | `getContextUsage({detail:'summary'})`、result.modelUsage、`maxBudgetUsd`、`maxTurns`、`fallbackModel` | 已有基础费用，但缺少上下文、细分用量和控制上限；不必先依赖实验性 usage 方法。小到中 |
| P1 | 原生会话重命名、标签、发现与分叉 | `renameSession`、`tagSession`、`listSessions`、`forkSession`、`resumeSessionAt`、`forkSession` 选项 | 可把环境会话加入应用导航，仍复用原生历史。需协调原生写入、应用索引和未知结果。分叉不会创建 Git worktree。中 |
| P1 | 执行设备上的文件预览、图片/文档输入 | `Query.readFile`；`SDKUserMessage.message.content` 的块数组 | 当前请求和 SDK port 只接受字符串 prompt；需资源引用、大小限制、目标绑定与显示投影。不是加一个附件按钮即可。中 |
| P2 | 文件改动检查点与回退预览 | `enableFileCheckpointing`、用户消息 UUID、`rewindFiles({dryRun:true})` | 必须在修改前启用并记录检查点；Bash 写入等不覆盖，不能宣传为完整工作区回滚。中 |
| P2 | JSON Schema 结果、表单和可交互提问预览 | `outputFormat`、result.structured_output、`toolConfig.askUserQuestion.previewFormat`、`onUserDialog`、`supportedDialogKinds` | 当前结构化结果被 resultView 丢弃；HTML 预览需隔离渲染，不能直接插入应用 DOM。中 |
| P2 | 后台任务面板与单任务停止 | `backgroundTasks`、`stopTask`、`perTaskStopAffordance`、task/background 事件 | 当前 Run 结束会退出并清理进程组；增加面板还不够，需调整结果与后台资源的生命周期。大 |
| P2 | 运行中追加消息、消息排队与插话 | `streamInput`、`SDKUserMessage.priority/uuid/shouldQuery`、interrupt receipt | 当前一个 Run 一条用户输入；SDK 的消息队列、result 累计和取消回执尚未映射。大 |
| P2 | 降低启动延迟 | `startup` / `WarmQuery`；`prewarm` / `SpareProcess`（alpha） | 两种预热都是单次消费，不是跨线程共享 Query；必须纳入 Nya 所有权、失效、退出和内存约束。中到大 |
| P3 | 外部转录镜像或 Claude 云会话 | `sessionStore` 等 alpha API；`/browser`、`/bridge` | 当前产品以用户本机 Claude 历史为本体；镜像、云会话、OAuth/worker 身份需要另立设计。大 |

### 与近期审批问题直接相关的边界

1. `setPermissionMode()` 可以给正在运行的 Query 增加明确模式选择，但它不会把“一条命令规则”自动变成“本聊天全工具免审批”。权限顺序仍包含 hooks、deny、ask 与交互要求，见 [官方权限文档](https://code.claude.com/docs/en/agent-sdk/permissions)。
2. `resolveSettings()` 是 alpha 静态设置级联检查；不启动 Claude CLI，也不是当前 session 的全部临时授权状态。它不执行 policyHelper，升级权限模式还要考虑 `filterEscalatingDefaultMode()` 的信任过滤。
3. 本版导出了 `SDKControlListPermissionRulesResponse`，控制协议中也有 list_permission_rules，但 **`Query` 的 30 个方法中没有 `listPermissionRules()` 或通用公开 request 方法**。不能把协议类型名称当成可直接调用的 SDK 函数。
4. `applyFlagSettings()` 是 flag 层修改，不是完整权限账本的读写器；连续调用对顶层键浅合并，再传 permissions 会替换先前的整个 permissions 对象。`updateSettings()` 也仅支持其明确允许的少量文件键，不能当成通用权限设置保存接口。

### 已接通的数据也存在展示缺口

- `system/init` 目前只保留 sessionId、模型、cwd、权限模式、版本和 toolCount。工具名称、MCP、命令、Agent 等加载细节没有完整投影。
- 模型目录目前保留名称、说明、resolvedModel、effort 能力；ModelInfo 中的 supportsAdaptiveThinking、supportsFastMode、supportsAutoMode 没有展示，可用于后续按模型约束设置入口。
- 审批回调还提供 blockedPath、displayName、MCP server/source 等信息；当前 port 未保留这些字段。已有 reason 字段也没有成为清楚的再次审批解释，属于投影与界面的缺口。
- `assistant`、`user` 和 `stream_event` 的子 Agent 内容被显式过滤，任务事件又落入未知消息分支；看到外层 Agent 工具摘要不等于看到内部进度。
- result 中的 `structured_output`、`modelUsage`、`permission_denials`、`terminal_reason`、`queued_turn_count` 及多项时延/fast-mode 字段未保留。
- `usage` 是主 Agent 循环的每轮数据，SDK 文档将更全面的 query-pipeline 统计放在 `modelUsage`；两者覆盖范围不同。
- `total_cost_usd` 和 `modelUsage` 按 SDK 注释可跨流式回合累计，resume/fork 还可能带入历史累计值。当前页面有费用数字，不代表可以直接相加得到各 Run 的净新增费用；新增用量面板时必须定义统计基线、清零和差值。
- `prompt_suggestion`、hook 进度、认证状态、插件安装、后台任务、会话重置等消息未接入。`promptSuggestions` 的建议在 result 之后到达；当前 result 后结束输入的设计需要一并检查。

## Query 全部 30 个方法

声明依据：本机 `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` 的 Query 接口。以下“未接”指未直接调用，不代表相关启动选项也没用。

| 方法 | 当前状态 | 能增加什么 / 接入边界 |
| --- | --- | --- |
| `interrupt()` | 已用 | 取消 Run；当前适配器未向业务暴露新的 queued-message 中断回执 |
| `close()` | 已用 | 终止 Query 与资源清理 |
| `supportedModels()` | 已用 | 当前设备/项目可选模型目录 |
| `setPermissionMode(mode)` | 未接 | 当前 Query 的权限模式切换；需流式输入 |
| `setMcpPermissionModeOverride(server, mode)` | 未接 | 对某 MCP server 收紧为 default/auto 或清除覆盖；不能扩权 |
| `setModel(model?)` | 未接 | 后续响应热切模型；现有应用已通过新 Run 的 model 选项选模 |
| `setMaxThinkingTokens(...)` | 未接，deprecated | 不建议新接；优先 query 的 thinking 选项 |
| `applyFlagSettings(settings)` | 未接 | 当前 Query 设置，如 effort/model/权限覆盖；顶层浅合并语义 |
| `updateSettings(source, settings)` | 未接 | 通过 CLI 写入并应用受限设置；本版只允许 local outputStyle / user effortLevel 等明确键 |
| `initializationResult()` | 未接 | 命令、模型、Agent、账户、输出风格与加载结果 |
| `reinitialize()` | 未接 | 传输断点后重新握手并重投待处理交互；回调需请求级幂等；当前 stdio 进程并非可重附着后台服务 |
| `supportedCommands()` | 未接 | 当前会话技能/命令目录 |
| `supportedAgents()` | 未接 | 当前会话可用子 Agent 定义 |
| `mcpServerStatus()` | 未接 | MCP 连接状态与配置投影 |
| `getContextUsage(opts?)` | 未接 | 上下文分类；full 会做额外 token 计数请求，优先 summary |
| `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(opts?)` | 未接，实验性 | 费用、tokens、可用时的套餐配额；不作为首批稳定依赖 |
| `readFile(path, options?)` | 未接 | 执行设备文件预览；受 Read 权限约束，默认大小上限；不是写文件接口 |
| `reloadPlugins(options?)` | 未接 | 重新加载插件；可检查缓存影响后决定是否应用 |
| `reloadSkills()` | 未接 | 当前 Query 刷新技能 |
| `reloadOutputStyles()` | 未接 | 刷新输出风格及相关磁盘扫描缓存 |
| `accountInfo()` | 未接 | 当前登录账户/组织/订阅诊断；不是登录或发放凭据接口 |
| `rewindFiles(uuid, options?)` | 未接 | 受跟踪文件回退与 dryRun；需要事先启用检查点 |
| `seedReadState(path, mtime)` | 未接 | 为已观察过但从上下文移除的 Read 恢复缓存；属于编辑正确性辅助，不是通用权限绕过 |
| `reconnectMcpServer(name)` | 未接 | MCP 故障重连 |
| `toggleMcpServer(name, enabled)` | 未接 | MCP 启停开关 |
| `readMcpResource(server, uri)` | 未接，alpha | 读取 ui:// MCP Apps 资源；需要 CLI capability，第三方 HTML 必须隔离 |
| `setMcpServers(servers)` | 未接 | 动态连接集变更；settings/plugin 所有权并不全部受此集合覆盖 |
| `streamInput(stream)` | 未接 | 向当前 Query 追加输入；现有 query 已使用流式输入，但只有一条消息，不是调用此方法 |
| `stopTask(taskId)` | 未接 | 单任务停止，配合任务事件与 UI |
| `backgroundTasks(toolUseId?)` | 未接 | 将前台工具/子 Agent 转到后台；不赋予跨进程存活能力 |

## 根入口全部 18 个函数

| 函数 | 当前状态 | 产品用途 / 约束 |
| --- | --- | --- |
| `query` | 已用 | 任务执行、独立模型目录控制查询 |
| `getSessionInfo` | 已用 | 从原生历史读取线程标题 |
| `getSessionMessages` | 已用 | 主会话转录；SDK 的 limit/offset/includeSystemMessages 没有成为应用查询能力 |
| `listSessions` | 已用 | 最近项目；只映射 sessionId/cwd/lastModified，未展示完整原生历史清单 |
| `listSubagents` | 未接 | 原生子 Agent ID 列表 |
| `getSubagentMessages` | 未接 | 原生子 Agent 转录 |
| `renameSession` | 未接 | 原生标题修改，需同步应用 titleSource 与索引 |
| `tagSession` | 未接 | 原生会话标签 |
| `deleteSession` | 未接 | 删除原生 JSONL 与子 Agent 转录；不是应用“归档”接口 |
| `forkSession` | 未接 | 指定消息分叉新原生会话；不复制文件撤销历史，不创建 Git worktree |
| `createSdkMcpServer` | 未接 | 让应用自己的工具以 SDK MCP 形式运行 |
| `tool` | 未接 | 定义自有工具的 schema 与 handler，配合 createSdkMcpServer |
| `startup` | 未接 | 已知项目与参数的进程预热；返回 WarmQuery，一次 query 消费 |
| `prewarm` | 未接，alpha | 项目未知时预热 spare，claim 后单次消费；存在配置不兼容与拒绝情况 |
| `resolveSettings` | 未接，alpha | 设置来源与合并结果诊断；不是运行期全授权账本 |
| `filterEscalatingDefaultMode` | 未接，alpha | 对解析结果应用升级权限模式的信任过滤 |
| `importSessionToStore` | 未接，alpha | 将本地历史导入外部 SessionStore；不是单纯“把环境会话显示在侧栏” |
| `foldSessionSummary` | 未接，alpha | 外部存储的增量摘要 sidecar 辅助 |

根入口两个类 `AbortError`、`InMemorySessionStore` 未直接引用。后者是 alpha 测试/开发存储，不能直接作为生产持久化。

九个常量均未直接引用：`BUILTIN_TOOL_NAMES`、`EXIT_REASONS`、`HOOK_EVENTS`、`LEGACY_TOOL_NAME_ALIASES`、`ORG_POLICY_LIMIT_PREFIXES`、`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`、`USAGE_LIMIT_ERROR_PREFIXES`、`USAGE_TRANSITION_PREFIXES`、`USAGE_WARNING_PREFIXES`。它们适合目录校验、缓存边界或诊断分类，不能按九项产品功能计算。尤其 BUILTIN_TOOL_NAMES 注释明确：名称列出不代表当前可用，列表也不是全部工具；实际工具应看该会话的 init。

## 其他公开子入口

| 入口 | 公开表面 | 当前使用 | 判断 |
| --- | --- | --- | --- |
| `/core` | query/startup/tool/MCP/设置/会话变更函数及类型的轻量重导出 | 无 | 属于打包优化，不是另一个执行内核。官方 README 要求同一进程不要混用 root 与 core 的运行期导入 |
| `/browser` | `query`；重导出的 `tool/createSdkMcpServer`；`getSseDropCounts`、`getSseLastSequenceNum`、`getCcrEvent`、就绪 sentinel；SSE/WS 类型 | 无 | 面向相应远端会话协议，不是给现有 Anybox SSE 换一个 import 即可 |
| `/bridge` | `attachBridgeSession`、`createCodeSession`、`fetchRemoteCredentials`、三个 failure/rejection type guard；BridgeSession 句柄 | 无 | 全部 alpha，独立兼容边界；涉及 OAuth、远端 worker 身份与服务准入，不是现有 Anybox 远端连接的替代件 |
| `/extract` | `extractFromBunfs` | 无 | Bun 编译单文件提取二进制；当前 Node/Electron + 用户安装的 claude 不需要 |
| `/sdk-tools`、`/sdk-tools.js` | 内置工具输入/输出类型 | 无 | types-only，不会自动注册工具或提供执行器 |

## 消息与参数层还有哪些能力

SDKMessage 联合类型包含 39 个具名成员；有多个成员共享 system/user 等外层判别值，不能按 switch 的 case 数计算覆盖率。

| 数据/参数 | 当前处理 | 可扩展能力 |
| --- | --- | --- |
| `SDKUserMessage.message.content` | 应用只构造字符串输入 | 图片/文档内容块；需模型能力核验、资源归属与历史呈现 |
| `priority/uuid/shouldQuery` | 未构造 | 可跟踪输入队列、插话、仅写入上下文；需要新的 Run/消息关联 |
| `pasted_content/inline_pastes` | 未构造 | 区分用户输入与粘贴材料，保留原文呈现 |
| `client_composed/verbatimPrompts` | 未设置 | 产品生成提示词时控制命令/@引用展开；会影响附加上下文，不能全局随意开启 |
| `parent_tool_use_id/agent_id`、task_* | 子 Agent 帧过滤；任务事件不投影 | 任务树、嵌套转录、进度和停止 |
| hook_*、includeHookEvents、hooks | 正常 Run 未注入 hooks，也不展示 hook 生命周期 | 可见的策略执行、事件追踪、受控扩展；用户原生 hooks 仍可能加载 |
| auth_status、plugin_install、commands_changed | 未投影 | 登录/插件/命令加载状态 |
| prompt_suggestion | 未开启、未投影 | 下一步建议；到达时间在 result 之后 |
| session_state_changed、conversation_reset、worker_shutting_down | 未投影 | 会话切换/清空/后台退出的准确状态 |
| `onElicitation` | 未设置 | MCP 表单或 URL 认证交互；不同于 AskUserQuestion |
| `onUserDialog/supportedDialogKinds` | 未设置 | CLI 主动要求宿主渲染的专用窗口；只能声明真正实现的种类 |

## 不能宣传为“一接 API 就有”的能力

1. **完整工作区撤销**：文件检查点只覆盖受支持的文件工具，不覆盖一般 Bash 写入、数据库、网络副作用或所有子 Agent 修改；文件回退和对话回退是两件事。见 [官方检查点说明](https://code.claude.com/docs/en/agent-sdk/file-checkpointing)。
2. **后台任务跨 Run/宿主重启存活**：当前生命周期主动等待并清理 Run 进程组。stopTask/backgroundTasks 需要与进程所有权一起设计。
3. **权限完全绕过**：SDK 有更多模式和规则入口，但不改变原生组织策略、交互要求与关键路径限制。应展示真实范围，不把模糊“始终允许”扩展为默认全放行。
4. **全量文件读写、Git diff、通用归档 API**：Query.readFile 是受限读接口；SDK 的会话分叉不是 Git worktree，deleteSession 不是归档。其余产品能力仍需应用自己实现。
5. **通用远程控制或云执行**：browser/bridge 适配专门协议与凭据。现有应用远端网关、本机角色通道继续由应用拥有，不把业务协议迁入宿主。
6. **完全替代本地历史的 SessionStore**：本版本是 dual-write 镜像，仍写本地环境，不能和 persistSession:false 合用。当前设计明确以用户原生 Claude 历史为本体，接入属于产品方向改变。

## 建议实施顺序

第一批先做只读能力与解释：审批原因/建议规则的可理解投影、设备能力检查器、MCP 状态、技能/Agent 目录、上下文 summary 与细分用量。这批最能修正“底层已经做了，界面却看不见”的问题。

第二批再做明确操作：原生会话重命名/标签/分叉、文件预览与附件、预算、MCP 重连/开关，以及真实有范围和撤销语义的授权设置。

第三批单独设计生命周期：多消息 Query、任务后台化、进程预热池、外部转录存储和云会话；不把这些作为一组前端按钮直接加上。

接入仍经过现有 `core/sdk` 边界：给应用 port 增加必要契约，SDK 对象保持私有，HTTP/通道提供白名单 DTO，并为取消、实际退出、重启恢复和生效 guard 补充相应行为测试。不是在宿主或浏览器暴露整个 Query。

大多数控制方法需要仍存活的流式 Query。当前已使用流式输入，但一个 Run 结束后进程就退出，空闲线程没有可调用的旧 Query。设置界面必须区分“下次 Run 的启动配置”与“当前 Run 的控制命令”；不能用一个新建目录查询 Query 的状态冒充旧会话的运行状态。预算是 query 的执行控制，费用字段仍是估算，不是账户级扣费硬上限。

## 依据与复核

- 固定版本：[`package.json`](../packages/app-claude-agent/package.json)、本机 node_modules 中同名包的 package.json。
- SDK 清单：同包 `sdk.d.ts`（Options:1552、Query:2892）、`core.d.ts`、`browser-sdk.d.ts`、`bridge.d.ts`、`extractFromBunfs.d.ts`；JSON 保存本机声明行号。
- 调用核对：[`adapter.ts`](../packages/app-claude-agent/src/core/sdk/adapter.ts)、[`port.ts`](../packages/app-claude-agent/src/core/sdk/port.ts)、[`translate.ts`](../packages/app-claude-agent/src/core/sdk/translate.ts)、[`history-worker.ts`](../packages/app-claude-agent/src/core/sdk/history-worker.ts)、应用 Runs/HTTP/Web。
- 官方补充：[审批输入](https://code.claude.com/docs/en/agent-sdk/user-input)、[权限](https://code.claude.com/docs/en/agent-sdk/permissions)、[子 Agent](https://code.claude.com/docs/en/agent-sdk/subagents)、[MCP](https://code.claude.com/docs/en/agent-sdk/mcp)、[结构化输出](https://code.claude.com/docs/en/agent-sdk/structured-outputs)、[文件检查点](https://code.claude.com/docs/en/agent-sdk/file-checkpointing)。这些网页可持续更新；与固定包发生差异时，本次清单按 0.3.301 声明限定范围。

以下附录列出全部 69 项顶层选项；“目录查询”只描述不发送用户消息的模型目录初始化过程。

复核结果：清单覆盖、计数与报告相对链接检查通过；`npm run check` 通过，2015 项测试、2001 通过、14 项按环境门控跳过、0 失败。这里的项目检查不代表上述未接入 API 已经过真实设备调用验收。

## 附录：Options 全量对照

| 选项 | 正常 Run | 模型目录查询 | 当前用途 / 可增加能力 |
| --- | --- | --- | --- |
| `abortController` | 显式设置 | 显式设置 | 已用于取消和退出清理 |
| `additionalDirectories` | — | — | 额外工作目录；需要界面明确范围 |
| `projectConfigRoot` | — | — | 可信原 checkout 的配置根；工作树场景，需保持代码/配置归属 |
| `agent` | — | — | 主会话角色选择 |
| `agents` | — | — | 自定义子 Agent：提示词、工具、模型、技能、memory 等 |
| `allowedTools` | 显式设置 | 显式设置 | 两处都固定空数组；未提供可配置自动允许规则 |
| `canUseTool` | 显式设置 | 显式设置 | 已用于工具审批和 AskUserQuestion |
| `continue` | — | — | 未用；应用按明确 sessionId resume，不隐式选最近会话 |
| `cwd` | 显式设置 | 显式设置 | 已有执行设备项目路径 |
| `disallowedTools` | — | — | 工具禁用/限制预设 |
| `toolAliases` | — | — | 将模型工具名映射到应用自有工具，不代替禁用规则 |
| `tools` | — | 显式设置 | 仅目录查询用空数组禁用工具；正常 Run 未做工具选择器 |
| `env` | 显式设置 | 显式设置 | 继承进程环境并固定应用标识；不是可编辑的任意环境变量入口 |
| `executable` | — | — | 执行 JavaScript CLI 的运行时选择，当前依赖 SDK 缺省 |
| `executableArgs` | — | — | JavaScript CLI 运行时参数，属于部署适配 |
| `extraArgs` | — | — | CLI 扩展参数；不能无校验开放给浏览器 |
| `fallbackModel` | — | — | 主模型不可用时的回退选择 |
| `enableFileCheckpointing` | — | — | 文件工具检查点与回退，需先启用 |
| `toolConfig` | — | — | 内置工具配置，如 AskUserQuestion 的 HTML/Markdown 选项预览 |
| `forkSession` | — | — | resume 时分叉新 sessionId；不同于 Git 分支 |
| `betas` | — | — | 显式 beta 功能；取决于模型与服务支持 |
| `hooks` | — | — | 应用注入 hooks 未用；不等于原生 hooks 没有加载 |
| `onElicitation` | — | — | MCP 表单/URL 交互 |
| `onUserDialog` | — | — | 宿主渲染 CLI 专用对话框 |
| `supportedDialogKinds` | — | — | 只声明界面真正支持的对话种类 |
| `perTaskStopAffordance` | — | — | 声明有单任务停止 UI，会改变中断/后台任务语义 |
| `persistSession` | — | 显式设置 | 仅目录查询设 false；正常 Run 使用原生持久历史的缺省行为 |
| `sessionStore` | — | — | alpha；外部转录镜像，当前产品不采用 |
| `sessionStoreFlush` | — | — | alpha；镜像刷写策略，依赖 sessionStore |
| `loadTimeoutMs` | — | — | alpha；外部镜像恢复的读取超时，依赖 sessionStore |
| `includeHookEvents` | — | — | hook 生命周期的流式观察 |
| `includePartialMessages` | 显式设置 | — | 正常 Run 开启流式文本/思考/工具块 |
| `forwardSubagentText` | — | — | 子 Agent 正文和思考；还需移除当前主会话投影过滤 |
| `verbatimPrompts` | — | — | 不展开命令/@引用的产品组合提示词；同时影响附加上下文 |
| `thinking` | 显式设置 | — | 固定 adaptive + summarized；没有完整 thinking 配置入口 |
| `effort` | 显式设置 | — | 前端按 Run 设置；不是运行中 applyFlagSettings |
| `maxThinkingTokens` | — | — | deprecated；不建议新增使用 |
| `maxTurns` | — | — | 本次 query 轮数上限 |
| `maxBudgetUsd` | — | — | 本次 query 费用预算 |
| `taskBudget` | — | — | alpha；API 侧 token 任务预算 |
| `mcpServers` | — | 显式设置 | 仅目录查询设为空；正常 Run 未做 SDK MCP 管理入口 |
| `model` | 显式设置 | — | 已有每 Run 的模型选择 |
| `outputFormat` | — | — | JSON Schema 结构化结果；需保留 structured_output |
| `pathToClaudeCodeExecutable` | 显式设置 | 显式设置 | 明确使用用户安装的 claude |
| `permissionMode` | 显式设置 | — | 正常 Run 固定 default；未开放模式选择 |
| `planModeInstructions` | — | — | 计划模式的自定义工作流程文本 |
| `allowDangerouslySkipPermissions` | — | — | 绕过模式显式开关；不是推荐的默认能力 |
| `permissionPromptToolName` | — | — | 将审批委托给 MCP 工具的替代路径 |
| `permissionPrompts` | — | — | 是否提供审批面；none 会拒绝原本需要提问的请求 |
| `plugins` | — | — | 显式加载本地插件；不等于原生环境的插件未加载 |
| `pluginDelivery` | — | — | 插件由 argv 或初始化载入；需相应 CLI 版本 |
| `promptSuggestions` | — | — | 下一步输入建议，在 result 之后产生 |
| `agentProgressSummaries` | — | — | 模型生成的子 Agent 进度摘要，可能增加调用 |
| `resume` | 显式设置 | — | 按线程保存的原生 sessionId 续接 |
| `sessionId` | — | — | 显式新会话 ID；当前由 init 报告后固定 |
| `resumeSessionAt` | — | — | 从指定消息/链条位置续接 |
| `resumeDropsTurn` | — | — | 截断续接的丢弃范围校验，拒绝后不能盲目重试 |
| `sandbox` | — | — | 文件系统/网络/凭据隔离；需要真实平台依赖与退出验收 |
| `settings` | — | 显式设置 | 仅目录查询用于关闭 discretionary hooks；无用户设置编辑器 |
| `managedSettings` | — | 显式设置 | 仅目录查询用于 hooks 限制；仍受实际管理策略影响 |
| `settingSources` | — | — | 未指定，0.3.301 缺省加载全部文件来源 |
| `skills` | — | — | 技能过滤/启用配置；未指定不表示技能关闭 |
| `debug` | — | — | 受控诊断开关；注意日志内容与资源归属 |
| `debugFile` | — | — | 诊断日志文件；需要执行设备路径和清理约束 |
| `stderr` | 显式设置 | 显式设置 | 正常 Run 有界尾部错误；目录查询限制输出 |
| `strictMcpConfig` | — | 显式设置 | 仅目录查询开启；正常 Run 未强制隔离原生 MCP |
| `systemPrompt` | 显式设置 | — | 固定 claude_code preset + 应用追加说明 |
| `title` | — | — | 未设置；应用标题不等于同步写入原生 session 标题 |
| `spawnClaudeCodeProcess` | 显式设置 | 显式设置 | 进程所有权适配；正常 Run 在 Unix 使用，目录查询捕获进程 |
