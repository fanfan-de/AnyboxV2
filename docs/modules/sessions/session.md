# Session 组件

[返回项目与会话模块](README.md) · [返回组件文档](../README.md)

Session 是会话、新会话初始化默认值、不可变对话节点、Run 状态、事件和原生恢复记录的唯一领域所有者。一个组件提供公开事实查询和受信执行记录两个端口；内部 SQLite 实现不是另一个 Nya 组件。活跃模型、调用句柄、取消控制器归 [RunRuntime](../execution/run-runtime.md)。

## 实现与装配

- 源码：[组件](../../../src/applications/harness/core/session/component.ts)、[完整端口](../../../src/applications/harness/core/session/port.ts)、[领域值与路径校验](../../../src/applications/harness/core/session/domain.ts)、[SQLite 记录实现](../../../src/applications/harness/core/session/sqlite-records.ts)、[Run 事件读写](../../../src/applications/harness/core/run/execution.ts)。
- 工厂：`createSessionComponent(inputs, agents)`；组件名：`harness-sessions`；配置类型：`void`。
- `inputs` 注入 now/newId；`agents` 是组合根启动时校验的只读定义，用于创建校验与默认模型。
- 注入 `local-storage`、`harness.projects`、`harness.image-assets`、`harness.project-files` 和 [Computer Operations](../computers/computer-operations.md) 的 `harness.computer-operations`；提供 `harness.sessions: SessionPort` 与 `harness.session-runs: SessionRunPort`。服务名称不构成访问权限边界。

## 公开查询与会话接口

| 方法 | 语义 |
| --- | --- |
| `getSessionDefaults(agentId)` | 查询该执行设备上指定 Agent 的新会话模型覆盖、启动后备值、有效默认值和 revision |
| `setSessionDefaults(agentId, modelId, expectedRevision)` | CAS 保存模型配置 ID；modelId 为 null 时清除覆盖，恢复启动后备值；初始 revision 为 0 |
| `getAgentTools(agentId)` / `setAgentTools(agentId, { toolIds, expectedRevision })` | 查询或 CAS 保存该设备上 Agent 的新会话工具选择；独立 revision；空数组明确关闭工具 |
| `createSession(projectId, agentId, modelId?)` | 检查 Agent 和可用项目，在创建事务内按显式模型、已保存覆盖、Agent 启动默认、null 的顺序选定并复制 modelId |
| `selectSessionModel(sessionId, modelId, protocolId?)` | 保存后续 Run 默认模型；已绑定协议时必须匹配，旧 Session 不可修改 |
| `getSession(id)` / `listSessions(projectId)` | 按 ID 查询包含归档会话；项目列表只返回未归档会话，要求项目存在但目录可暂时不可用 |
| `archiveSession(id)` / `restoreSession(id)` | 幂等归档与恢复，返回 Session；归档时间使用注入时钟，不依赖项目目录、模型或凭据 |
| `listArchivedSessions()` | 跨项目归档列表，按 archivedAt 倒序、id 升序 |
| `getNode(sessionId, id)` | 查询指定 Session 内节点；不存在返回 undefined |
| `getNodePath(sessionId, id)` | 返回从根到指定节点的完整路径；null 返回空路径 |
| `listNodes(sessionId, parentId, query?)` | 查询同父直接子节点；limit 默认 50，范围 1–100；cursor 必须是同 Session 同父的节点 ID |
| `getRun(id)` / `getRunByKey(sessionId, key)` | 按身份或会话内幂等键查询 Run |
| `listRuns(sessionId, query?)` | 按创建时间和 ID 列出，可按 active 或明确可空 parentNodeId 过滤 |
| `getRunEvents(id, afterSeq?)` | 按递增 seq 读取事件，游标默认 0、必须为非负安全整数；未知 Run 返回 undefined |
| `getRunRecords(id)` | 读取该 Run 的不可变受信原生记录；未知 Run 抛错 |

Session 保存 id、projectId、agentId、可空 modelId、toolSelection、historyMode、可空 protocolId、可空 archivedAt、createdAt。ConversationNode 保存 id、sessionId、parentId、原始 input、output、sourceRunId，并从来源 Run 的 nativeInput 投影 images 和 files：v1 两者为空，v2 只有图片，v3 包含图片和文件引用。节点不承载当前选中位置或全局 head。harness server API 在显式选模时先通过 Models 验证配置，并传入真实协议 ID；Session 本身不注入 Models，也不查凭据。

所有返回 Session 的入口统一提供可空 `title` 展示投影，列表读取即可获得，无须打开会话或加载历史。原生会话使用首个已接受 Run 的原始 input，按保留的 SQLite rowid 接受顺序选取，因此同时间、失败、取消、中断、后续分支和选中路径均不改变标题。旧 `dialogue-v1` 会话使用 seq 最早的根节点，不从关联不明确的旧 Run 推断。标题压缩空白，最多 120 个 Unicode 字符，超出以省略号截断；无正文时提供图片/文件数量摘要，空会话返回 null。标题读取不使用 task-template 展开正文，不写回历史或增加迁移，也不包含恢复记录、凭据和执行句柄。

## 新会话默认模型

默认值属于执行设备的 harness server，会按 Agent ID 保存，适用于该设备上所有项目及浏览器/API 调用。`SessionDefaults` 返回 `{ agentId, modelId, fallbackModelId, effectiveModelId, revision }`：modelId 是可空的持久覆盖，fallbackModelId 来自启动时只读 AgentDefinition，effectiveModelId 为覆盖或后备值，二者都不存在时为 null。保存的是本机 Models 执行配置 ID，包含连接与参数预设身份，不是目录模型定义、名称或远端 ID。

默认值只用于创建 Session，并与新会话写入同一事务读取和复制；不会在每次 Run 动态解析。修改默认、清除覆盖、切换其他会话的模型均不改已有 Session，选择本会话模型也不反向修改默认。协议仍在首次接受原生 Run 时固定，创建会话及设置默认都不提前绑定协议。Run 维持显式输入模型、Session 已保存模型、Agent 启动默认的既有优先级。

harness server API 及 HTTP 保存非空覆盖时检查 Models 配置存在且当前可用；Session 组件只拥有初始化数据和 CAS，不引入 Models 依赖。已保存模型后来停用、删除 Key 或删除连接时，保留引用和 revision，新会话仍复制原 ID，展示层报告不可用并允许用户重新选择，不能静默切换到后备、其他账号或目录第一项。覆盖和启动后备值均未设置时允许创建 modelId 为 null 的会话。

首次查询没有持久记录时 revision 为 0；写入与清除都提交新 revision，过期 expectedRevision 返回 `session-defaults-conflict`，不覆盖另一调用方的结果。此配置复用 Session 既有操作跟踪、业务 SQLite 连接与生命周期，没有额外 Nya 组件、数据库或项目级继承。

## Agent 工具与会话固定

Agent 工具选择使用统一工具库的稳定 toolId，可跨 Codex、Claude Code、DeepSeek Harness 来源组合；来源标签只描述出处，不选择模型协议或执行器。保存先验证已知工具及明确依赖，再通过独立 revision 提交，冲突返回 `agent-tools-conflict`。默认配置仅在尚无保存记录时使用；保存 `[]` 与默认配置有不同语义。

创建 Session 的同一业务库事务读取 Agent 的最新选择，并保存 `ToolSelectionSnapshot { schemaVersion: 1, tools: [{ toolId, version, definition }] }`。后续修改 Agent、模型或来源展示不会改变已有会话工具；Session 没有改工具入口，数据库禁止更新 tool_selection_json。工具运行资源归对应执行组件，配置和快照不保存运行句柄。

首次 Run 的原生 initialization v2 保存该选择与实际模型声明，接受事务复核选择等于 Session 快照；其后所有根、分支和重新生成复用同一 initialization。无工具能力模型继续纯文本调用。旧会话迁移保存原 Bash/Apply Patch 选择，历史 initialization v1 和记录 JSON 原样保留。

## 受信执行记录端口

| 方法 | 职责 |
| --- | --- |
| `findAcceptedRun(input)` | 在解析当前配置之前查已接受幂等键，同时验证原始输入、附件 ID 与顺序、父节点和显式模型一致 |
| `describeImages(sessionId, assetIds)` | 准备阶段读取受信图片元数据 |
| `readFileSnapshots(sessionId, ids, signal?)` | 返回受管文件正文读取；只读取保存的快照，不重新打开项目源文件 |
| `registerRun(id, input, now, prompts, model, native)` | 原子复核并接受 Run，返回 `{ run, created }` |
| `loadNativeInitialization(sessionId)` | 读取首次接受后固定的 instruction/context 与工具声明 |
| `loadNativeHistory(sessionId, parentNodeId)` | 校验所选成功路径，临时物化其原生记录、绑定、快照和 checkpoint |
| `startOperation(runId, operation, at)` | running 接受正常操作；cancelling 仅接受显式 cleanup:true 且 kind:operation 的清理操作；保存 intent、初始记录及 started 事件，返回是否准入 |
| `observeOperation(runId, operationId, observation, at)` | 允许 running/cancelling 的已开始操作提交结果、错误或清理失败事实 |
| `loadRunContext(id)` | 返回已接受 Run 与项目 ID，不含运行期模型计划 |
| `getRun(id)` / `getRunExecution(id)` | 读取 Run 和执行计数/阶段 |
| `loadRunResume(id)` / `listRunResumes()` | 查询独立版本化恢复信封与可接管活动 Run |
| `claimRunResume(id,expectedEpoch,at)` | 同事务 CAS 提升 owner，并调用 Operations.claimRunIn；旧 owner 写入被拒绝 |
| `saveRunResume(id,ownerEpoch,patch,at)` | 同事务固定批次、游标、清理或结算提案；重复相同 patch 幂等 |
| `getRunOperation(runId,id)` | 查询原意图与已提交观察，用于重启后复用原事实 |
| `requestCancellation(id, now)` | 把 running 改为 cancelling；未知 ID 返回 undefined，终态不改变 |
| `settleRun(id, outcome, now)` | 原子保存终态和成功节点；调用前 Runtime 必须已经等待所有资源实际退出 |

`RunOperationStart` 包含 id、kind（model/operation/tool）、JSON intent、可选 records 与 tool，以及只用于通用 operation 的 cleanup:true 准入标记。Session 不解释 intent 来推断清理，模型或工具操作不能利用该标记在取消后启动。observation 的 kind 为 value/error/cleanup-failed，可携 records、checkpoint、工具事实、通用 JSON result 和失败分类；结果在现有 observation_json 中持久化，不增加事件种类。

计算工具的 startOperation 在同一业务事务中复核固定工具声明，调用 Computer Operations.acceptIn，提交 Session 意图、started 事件、计算声明和逻辑实例/工作区需求。observeOperation 同事务提交真实工具观察、图片保留以及 Operations.observeIn 的 observed 标记。事务内不等待激活、目录检查或实际工具退出；计划和模型 operation 不创建 computer 声明。新增账本仍归各领域组件，Session 不直接读写其表。

run-state v10 新增独立版本化 RunResumeState，不复活旧 Run phase 写入器。接受、模型意图、完整工具批次、工具观察/额度、清理及结算提案与恢复游标原子提交；runOwnerEpoch 是授权，写操作拒绝旧 owner。protocolCursor 由 Loop 解释，Session 只保存不透明 JSON。startOperation、observeOperation 与 settleRun 接受 ownerEpoch，缺省值只用于原 owner 兼容调用。

当前消费事实使用 Operations 的 observed:boolean 及 Session 原观察账本。下一原生请求记录与 stage=model-pending 同事务固定，是工具结果已进入请求的隐含证明；目标三态中的 incorporated 尚无独立持久字段。重复消费不增事件、计数或额度；下一响应未保存时不会从 model-pending 重发请求，任意模型阶段接续仍待独立 exchange owner。

## 接受、分支与成功结算

新 Session 使用 `native-local-v1`。registerRun 在事务内先检查已接受幂等键，再检查归档状态、Session 模式、schemaVersion 3 模型快照、模型/绑定协议、父节点路径以及精确的 parentContextRef，并通过附件组件的 retainIn 保留引用。首次接受原子固定 Session 协议和 initialization；后续根分支和后代必须使用同一初始化，竞争提交不同初始化会拒绝。即使首次 Run 最终失败，已经固定的协议也不撤销。

父路径校验拒绝不存在、跨 Session、断链和循环节点。原生恢复还要求每个节点来自 completed 原生 Run，context 的 Session、协议、父引用、initialization 和记录版本一致。只在准备时拼接所选路径记录；数据库保存每个 Run 自己的增量请求/响应和不可变链节，避免每轮复制全部历史。

每次 operation 先保存 intent 和 started，再保存 observation；取消不会删除已经发生的操作。成功结算要求没有仍为 started 的操作，必须有 checkpoint 和非空、不重复且属于本 Run 的结果记录引用。事务同时写入 Run 终态、记录、执行状态、终态事件、context 链节、完整节点、结果引用及 resultNodeId；任一步失败全部回滚。重复结算返回既有终态，不创建第二个节点。

## 表、通知与资源归属

迁移继续使用历史 `run-state` 账本，当前版本 10（v10 增加 harness_run_resumes 的 owner、Runtime 状态和协议游标；v6 增加原生记录 resource_refs_json，v7 增加 Session archived_at 和归档列表索引，v8 增加按 Agent 保存的新会话默认模型表，v9 增加 Agent 工具配置和不可变 Session 工具快照；旧 JSON 原样保留）。该组件拥有 `harness_run_resumes`、`harness_agent_tool_settings`、`harness_session_defaults`、`harness_sessions`、`harness_runs`、`harness_nodes`、`harness_run_events`、`harness_native_initializations`、`harness_native_records`、`harness_run_operations`、`harness_native_contexts`、`harness_native_results` 的领域规则。节点、原生记录和恢复链受不可变约束保护；SQLite 连接与排他锁归[存储组件](../infrastructure/local-sqlite.md)。

每次 Run 变更提交后发送 `harness.run.changed`，载荷为 sessionId、runId、revision。监听失败只记录警告，不回滚已提交事实。原生记录可能含签名、加密续接和工具原生 ID，属于受信恢复面；浏览器必须使用白名单投影。Key、认证头、凭据引用和运行句柄不得写入历史。

工具读取图片的 `observation.tool.images` 在同一观察事务通过图片组件 retainIn 保留，所有者键为 `run-tool:<runId>:<operationId>`；失败事务不保留图片或半份观察。随后增量原生请求可引用同 Run 已观察图片，资源元数据必须与受信输入或已保存观察一致。tool-failed 同样保留清理失败时已有的工具 result/images，工具名称必须与 started 意图一致。普通操作还可在 observation.result 保存版本化 JSON 事实，例如实际进程清理结果，并附在 operation-observed/failed 内部事件；不保存实时进程对象。浏览器只接收 HTTP 白名单投影的进程退出字段。

## 关闭、恢复与兼容

Effect 先停止新调用，取消并等待图片及文件搜索/预览/准备/读取的包装调用退出，再等待已接受的记录操作，包括新会话默认值写入、尚在项目检查中的 Session 创建、归档/恢复及附件续期。包装调用同时观察 result/done；done 清理失败必须上报，不能因底层结果悬空而无限等待。图片与文件组件在 Session 之后清理。组件不负责取消模型或工具；Nya 的依赖关系让执行消费者先退出。

打开记录实现时，保留带有效恢复状态的 response/cleanup/settling 活动 Run 供 Run 组件提升 owner 后接管。没有新恢复凭证的旧 Run、未保存模型响应的 model-pending 在事务内结算 interrupted，追加中断事件和 revision，不重发模型或未知工具，也不生成成功节点。已留下 worker scope 的 interrupted Run 由 Operations 独立协调耐久取消及真实排空。清理失败或状态写入故障不能被普通取消覆盖；失败、取消、interrupted 的原生诊断可读但不能作为继续节点。

旧 `dialogue-v1` Session 保留查询，不导入或继续执行；历史 turns 迁移为不可变节点。旧模型快照与事件 JSON 保持原样；`bashCalls` 和 `bash-*` 只在读取时归一化为 toolCalls 与 tool-*，不保留旧写入路径。原生恢复不支持跨协议或任意账户/参数转换，具体兼容性由 Models execution 验证。

## 验证

[Agent 工具测试](../../../tests/agent-tools.test.mjs) 验证混合选择、空配置、Agent 隔离、CAS、原子复制、重启、关闭等待、不可变会话快照及工具图片观察与引用的事务保留。

[Session 生命周期](../../../tests/session.test.mjs) 验证关闭等待与替换后事实保留；[新会话默认模型](../../../tests/session-defaults.test.mjs) 验证创建复制、显式优先、Agent 隔离、CAS、无效引用保留、重启与关闭等待；[原生 Session](../../../tests/native-session.test.mjs) 验证列表标题、首次失败、分支与同时间接受顺序、Unicode 截断、重启、协议固定、父引用复核、原生记录不可变和事务回滚；[HTTP](../../../tests/harness-server-http.test.mjs) 验证未加载历史的标题投影与文件摘要；[原生协议](../../../tests/native-protocol-agents.test.mjs) 验证纯图片标题；[会话树](../../../tests/conversation-tree.test.mjs) 验证并发兄弟、路径隔离、结算与取消竞争；[迁移](../../../tests/conversation-migration.test.mjs) 验证旧标题来源与历史不改写，[多项目](../../../tests/multi-project.test.mjs) 与[Apply Patch 循环](../../../tests/apply-patch-loop.test.mjs) 验证旧数据、重启和不重放副作用。统一执行 `npm run check`。

## 图片输入与引用

`importImage(sessionId, bytes, signal?)` 和 `getImage(sessionId, assetId, signal?)` 返回 OwnedCall；`renewImages(sessionId, assetIds)` 续期草稿，所有入口先验证 Session。受信 `describeImages` 在准备时取得服务端元数据；Run 接受事务调用图片组件 `retainIn`，核对不可变元数据并写入不透明 Run 保留凭证。已接受失败/取消 Run 同样保留输入。图片字节、读取与 GC 归[图片组件](../images/image-assets.md)。

原生 v2 请求的顶层 resourceRefs 保存到独立列，Session 校验其与本 Run 已接受图片一致；不解释 payload 中的协议图片块。幂等比较包含图片 ID 和顺序，重复接纳不会重复保留或重新检查已接受输入的草稿期限。

## 项目文件引用

Session 对外提供 openProjectFileTree、readProjectFileTreePage、closeProjectFileTree、onProjectFileTreeRetired，以及 searchProjectFiles、previewProjectFile、prepareProjectFiles、getFileSnapshot、renewProjectFiles，先验证会话，再调用 [Project Files](project-files.md)。受信 session-runs 提供 readFileSnapshots，Run 准入等待读取和实际退出。树游标和文件搜索/读取句柄归 Project Files；Session 固定项目，跟踪并在关闭时取消、等待包装调用与自己接纳的游标。关闭树入口幂等且不重新读取会话；HTTP actor 不能由请求体或头部改写。

项目目录、搜索和当前文件预览只读取所属项目，允许旧 `dialogue-v1` 及归档会话使用。此例外不开放旧会话的快照、图片或原生恢复入口；文件准备、图片导入和 Run 继续遵守原生会话及归档只读限制。旧格式资源限制返回带 code 的 `legacy-session-readonly`，HTTP 映射为 409，不退为通用 500。

NativeRunInput v3 保存文件引用及顺序，v1/v2 读取时 files=[]，旧 JSON 不改写。Run 和节点投影返回 files 元数据；正文经单独的会话作用域接口读取。接受事务复核引用 ID、项目及元数据，并调用同步 retainIn，与图片及 Run 一起提交。已接受失败/取消/interrupted 仍永久保留。新表归 project-files 迁移域，文件引用不增加 run-state 迁移；会话归档使用 v7，新会话默认模型使用 v8。

## 归档与恢复

归档事务检查 running/cancelling Run；存在活动记录返回 `session-has-active-runs`，不主动取消。Run 接受事务在幂等检查后复核 archivedAt，与归档串行裁决；已接受幂等请求仍返回原 Run，冲突仍报错。准备后拒绝的 program 由 Run 清理并等待退出，不发布节点或保留资源。重复归档保留原时间，恢复清空时间。归档后选模和新 Run 返回 `session-archived`；旧 dialogue-v1 也可归档/恢复，但恢复不解除旧格式只读限制。

归档不改历史、协议绑定、节点、原生记录、图片和文件快照。图片导入/文件准备在准入时拒绝归档会话，已开始的草稿操作继续按原生命周期退出；历史查询、附件读取和草稿续期保持可用。归档/恢复通过现有 track 操作管理，组件关闭等待已接受写入。

[会话树测试](../../../tests/conversation-tree.test.mjs) 覆盖幂等、并发裁决、取消实际退出、准备清理和重启；[Session 生命周期测试](../../../tests/session.test.mjs) 覆盖归档写入关闭等待；[迁移测试](../../../tests/conversation-migration.test.mjs) 验证旧数据保持只读。
