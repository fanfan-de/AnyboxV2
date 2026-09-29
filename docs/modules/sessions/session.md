# Session 组件

[返回项目与会话模块](README.md) · [返回组件文档](../README.md)

Session 是会话、不可变对话节点、Run 状态、事件和原生恢复记录的唯一领域所有者。一个组件提供公开事实查询和受信执行记录两个端口；内部 SQLite 实现不是另一个 Nya 组件。活跃模型、调用句柄、取消控制器归 [RunRuntime](../execution/run-runtime.md)。

## 实现与装配

- 源码：[组件](../../../src/session/component.ts)、[完整端口](../../../src/session/port.ts)、[领域值与路径校验](../../../src/session/domain.ts)、[SQLite 记录实现](../../../src/session/sqlite-records.ts)、[Run 事件读写](../../../src/run/execution.ts)。
- 工厂：`createSessionComponent(inputs, agents)`；组件名：`harness-sessions`；配置类型：`void`。
- `inputs` 注入 now/newId；`agents` 是组合根启动时校验的只读定义，用于创建校验与默认模型。
- 注入 `local-storage`、`harness.projects` 和 `harness.image-assets`；提供 `harness.sessions: SessionPort` 与 `harness.session-runs: SessionRunPort`。服务名称不构成访问权限边界。

## 公开查询与会话接口

| 方法 | 语义 |
| --- | --- |
| `createSession(projectId, agentId, modelId?)` | 检查 Agent 和可用项目，创建原生 Session；省略模型时使用 Agent 默认或 null |
| `selectSessionModel(sessionId, modelId, protocolId?)` | 保存后续 Run 默认模型；已绑定协议时必须匹配，旧 Session 不可修改 |
| `getSession(id)` / `listSessions(projectId)` | 查询会话；列表要求项目存在，但目录可暂时不可用 |
| `getNode(sessionId, id)` | 查询指定 Session 内节点；不存在返回 undefined |
| `getNodePath(sessionId, id)` | 返回从根到指定节点的完整路径；null 返回空路径 |
| `listNodes(sessionId, parentId, query?)` | 查询同父直接子节点；limit 默认 50，范围 1–100；cursor 必须是同 Session 同父的节点 ID |
| `getRun(id)` / `getRunByKey(sessionId, key)` | 按身份或会话内幂等键查询 Run |
| `listRuns(sessionId, query?)` | 按创建时间和 ID 列出，可按 active 或明确可空 parentNodeId 过滤 |
| `getRunEvents(id, afterSeq?)` | 按递增 seq 读取事件，游标默认 0、必须为非负安全整数；未知 Run 返回 undefined |
| `getRunRecords(id)` | 读取该 Run 的不可变受信原生记录；未知 Run 抛错 |

Session 保存 id、projectId、agentId、可空 modelId、historyMode、可空 protocolId、createdAt。ConversationNode 保存 id、sessionId、parentId、原始 input、output、sourceRunId，并从来源 Run 的 v2 nativeInput 投影 images；旧节点图片为空。节点不承载当前选中位置或全局 head。Harness 门面在显式选模时先通过 Models 验证配置，并传入真实协议 ID；Session 本身不注入 Models，也不查凭据。

## 受信执行记录端口

| 方法 | 职责 |
| --- | --- |
| `findAcceptedRun(input)` | 在解析当前配置之前查已接受幂等键，同时验证原始输入、父节点和显式模型一致 |
| `registerRun(id, input, now, prompts, model, native)` | 原子复核并接受 Run，返回 `{ run, created }` |
| `loadNativeInitialization(sessionId)` | 读取首次接受后固定的 instruction/context 与工具声明 |
| `loadNativeHistory(sessionId, parentNodeId)` | 校验所选成功路径，临时物化其原生记录、绑定、快照和 checkpoint |
| `startOperation(runId, operation, at)` | 运行态才接受；保存操作 intent、初始记录及 started 事件，返回是否准入 |
| `observeOperation(runId, operationId, observation, at)` | 允许 running/cancelling 的已开始操作提交结果、错误或清理失败事实 |
| `loadRunContext(id)` | 返回已接受 Run 与项目 ID，不含运行期模型计划 |
| `getRun(id)` / `getRunExecution(id)` | 读取 Run 和执行计数/阶段 |
| `requestCancellation(id, now)` | 把 running 改为 cancelling；未知 ID 返回 undefined，终态不改变 |
| `settleRun(id, outcome, now)` | 原子保存终态和成功节点；调用前 Runtime 必须已经等待所有资源实际退出 |

`RunOperationStart` 包含 id、kind（model/operation/tool）、JSON intent、可选 records 与 tool；observation 的 kind 为 value/error/cleanup-failed，可携 records、checkpoint、工具事实和失败分类。

## 接受、分支与成功结算

新 Session 使用 `native-local-v1`。registerRun 在事务内再次检查幂等键、Session 模式、schemaVersion 3 模型快照、模型/绑定协议、父节点路径以及精确的 parentContextRef。首次接受原子固定 Session 协议和 initialization；后续根分支和后代必须使用同一初始化，竞争提交不同初始化会拒绝。即使首次 Run 最终失败，已经固定的协议也不撤销。

父路径校验拒绝不存在、跨 Session、断链和循环节点。原生恢复还要求每个节点来自 completed 原生 Run，context 的 Session、协议、父引用、initialization 和记录版本一致。只在准备时拼接所选路径记录；数据库保存每个 Run 自己的增量请求/响应和不可变链节，避免每轮复制全部历史。

每次 operation 先保存 intent 和 started，再保存 observation；取消不会删除已经发生的操作。成功结算要求没有仍为 started 的操作，必须有 checkpoint 和非空、不重复且属于本 Run 的结果记录引用。事务同时写入 Run 终态、记录、执行状态、终态事件、context 链节、完整节点、结果引用及 resultNodeId；任一步失败全部回滚。重复结算返回既有终态，不创建第二个节点。

## 表、通知与资源归属

迁移继续使用历史 `run-state` 账本，当前版本 6（v6 只增加原生记录 resource_refs_json；旧 JSON 原样保留）。该组件拥有 `harness_sessions`、`harness_runs`、`harness_nodes`、`harness_run_events`、`harness_native_initializations`、`harness_native_records`、`harness_run_operations`、`harness_native_contexts`、`harness_native_results` 的领域规则。节点、原生记录和恢复链受不可变约束保护；SQLite 连接与排他锁归[存储组件](../infrastructure/local-sqlite.md)。

每次 Run 变更提交后发送 `harness.run.changed`，载荷为 sessionId、runId、revision。监听失败只记录警告，不回滚已提交事实。原生记录可能含签名、加密续接和工具原生 ID，属于受信恢复面；浏览器必须使用白名单投影。Key、认证头、凭据引用和运行句柄不得写入历史。

## 关闭、恢复与兼容

Effect 先停止新调用，再等待已经接受的所有记录操作，包括尚在项目检查中的 Session 创建。图片导入/读取的委托句柄单独受管，关闭先取消并等待 result/done 退出，再允许图片组件清理。组件不负责取消模型或工具；Nya 的依赖关系让执行消费者先退出。

打开记录实现时，在事务内把遗留 running/cancelling Run 标为 interrupted，追加中断事件和 revision，不重新执行任何副作用，也不生成成功节点。清理失败或状态写入故障不能被普通取消覆盖；失败、取消、interrupted 的原生诊断可读但不能作为继续节点。

旧 `dialogue-v1` Session 保留查询，不导入或继续执行；历史 turns 迁移为不可变节点。旧模型快照与事件 JSON 保持原样；`bashCalls` 和 `bash-*` 只在读取时归一化为 toolCalls 与 tool-*，不保留旧写入路径。原生恢复不支持跨协议或任意账户/参数转换，具体兼容性由 Models execution 验证。

## 验证

[Session 生命周期](../../../tests/session.test.mjs) 验证关闭等待与替换后事实保留；[原生 Session](../../../tests/native-session.test.mjs) 验证协议固定、父引用复核、原生记录不可变和事务回滚；[会话树](../../../tests/conversation-tree.test.mjs) 验证并发兄弟、路径隔离、结算与取消竞争；[迁移](../../../tests/conversation-migration.test.mjs)、[多项目](../../../tests/multi-project.test.mjs) 与[Apply Patch 循环](../../../tests/apply-patch-loop.test.mjs) 验证旧数据、重启和不重放副作用。统一执行 `npm run check`。

## 图片输入与引用

`importImage(sessionId, bytes, signal?)` 和 `getImage(sessionId, assetId, signal?)` 返回 OwnedCall；`renewImages(sessionId, assetIds)` 续期草稿，所有入口先验证 Session。受信 `describeImages` 在准备时取得服务端元数据；Run 接受事务调用图片组件 `retainIn`，核对不可变元数据并写入不透明 Run 保留凭证。已接受失败/取消 Run 同样保留输入。图片字节、读取与 GC 归[图片组件](../images/image-assets.md)。

原生 v2 请求的顶层 resourceRefs 保存到独立列，Session 校验其与本 Run 已接受图片一致；不解释 payload 中的协议图片块。幂等比较包含图片 ID 和顺序，重复接纳不会重复保留或重新检查已接受输入的草稿期限。
