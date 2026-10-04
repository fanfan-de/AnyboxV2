# Run 准入与控制组件

[返回执行模块](README.md) · [返回组件文档](../README.md)

Run 把外部请求验证为一个已接受的执行计划，并把所有权交给 [RunRuntime](run-runtime.md)。它不持有持续运行的协议状态，也不提供持久历史查询；历史经 [Session](../sessions/session.md) 查询。

## 实现与装配

- 源码：[组件](../../../src/applications/harness/core/run/component.ts)、[输入和状态转换](../../../src/applications/harness/core/run/domain.ts)、[程序契约](../../../src/applications/harness/core/run/program.ts)、[等待者](../../../src/applications/harness/core/run/waiters.ts)。
- 工厂：`createRunComponent(inputs, agents, isHarnessServerClosing?)`；组件名：`harness-runs`；配置类型：`void`。
- `inputs` 提供 `now()`、`newId()`；`agents` 是已验证的只读 Agent 定义；可选 `isHarnessServerClosing()` 默认为 false，用于区分整个应用关闭与依赖失效。
- 提供 `harness.runs: RunPort` 和受信宿主控制服务 `harness.run-admission: RunAdmissionPort`。
- 注入 `harness.sessions`、`harness.session-runs`、`harness.agent-prompts`、`models`、`harness.protocol-agents`、`harness.run-runtime`、`harness.projects`。

## 服务接口

| 方法 | 行为 |
| --- | --- |
| `startRun(input)` | 接受并启动 Run；返回已启动或提前结算的 Run，不承诺执行已经完成 |
| `cancelRun(id)` | 对准备交接中的 program 或 Runtime 发出取消，并返回当前 Run；未知 ID 可返回 undefined |
| `waitRun(id, signal?)` | 等待准入交接及实际结束，返回 Run；中止 signal 只退出此次等待 |
| `getView(id)` | 获取当前有界临时展示快照；结束后通常为 undefined |

`RunInput` 必须包含非空 `sessionId`、`idempotencyKey`，以及显式的 `parentNodeId: string | null`；可选非空 `modelId` 是 Models 执行配置 ID。`input` 是文本字符串，`images?: { assetId }[]` 为有序图片引用，`files?: { snapshotId }[]` 为已准备的有序文件快照引用；三者至少一项非空，支持纯图片或纯文件输入。不能直接传文件路径或正文代替 snapshotId。旧 `modelProfileId`、`model`、`selection`、`llmPlan` 参数被拒绝。

## 准入流程

同一个 Session 和幂等键的并发调用共享一个准备 Promise。相同键但原始输入、图片或文件快照身份/顺序、父节点或显式模型不同会抛出 `idempotency-conflict`。数据库中的已接受 Run 在读取当前 Agent、模型、Prompt 和附件前返回，因此配置更新、归档或草稿过期不会让重复请求重新执行。

首次请求按以下顺序处理：读取 Session，拒绝归档状态和旧历史模式；检查项目目录可用；解析 Agent；以 `input.modelId ?? session.modelId ?? agent.modelId` 选模；检查 Session 固定协议；加载父路径历史和 Session 固定初始化。固定工具声明必须与当前 Bash/Apply Patch 定义精确匹配，否则拒绝续接。

没有固定初始化时，[Agent Prompt](../prompts/agent-prompts.md) 提供 instruction/context；模型有效 tools 能力为 true 时声明 Bash 和 Apply Patch，否则为空。task-template 每次重新解析，但只把 `{{input}}` 替换为本次原始输入一次，并保存 v3 raw/text/template/images/files 快照，图片和文件内容不参与模板替换。历史不重新套用模板。

[协议注册表](protocol-agent-registry.md) 为这些输入创建 `PreparedRunProgram`。Session 的 `registerRun` 事务复核父上下文引用、协议和初始化，并通过图片与项目文件组件的同步 retainIn 固定资源引用，再保存接受结果；引用与 Run 一起提交或回滚。只有 `created: true` 的 Run 会交给 Runtime。事务返回已有幂等结果时，当前多余 program 仍需关闭和释放。

## 所有权、取消和关闭

Run 持有尚未交接的 program 和准备阶段 AbortController。`runtime.start()` 必须同步接受所有权：同步抛出表示没有接管，由 Run 关闭 program 并结算；成功返回 Promise 后，无论其后成功或失败，都由 Runtime 清理。

取消未交接 Run 会中止它的 controller，并记录 `cancelling`。取消已交接 Run 使用 Runtime 的 `user-requested` 原因。`waitRun` 先等待正在进行的持久接受交接，避免在记录刚提交但 Runtime 尚未读取时过早返回。

Effect 清理先关闭新准入、中止正在准备的 execution，取消已接管的 Run，再等待全部准入和所有已接受 Run 实际结束。harness server 关闭使用 `owner-disposed`；依赖替换使用 `dependency-unavailable`。未接管 program 的清理失败显式结算为 `cleanup-failed`，关闭时会传播清理错误；不会创建成功节点。

## 边界与故障

项目不可用、模型不可用、协议不匹配、历史不兼容或准备失败发生在接受前时，不生成新 Run。接受后即使同步交接被拒绝，Run 和幂等键仍保留并结算为失败。一次接受固定的模型快照和协议代不能在 Runtime 启动时被替换。Run 只消费已准备的程序，不解释 stop reason，不缓存凭据。

## 验证

[harness server 核心测试](../../../tests/harness-server-core.test.mjs) 验证幂等、未知模型、同步交接拒绝、快照不匹配、依赖替换与关闭；[会话树测试](../../../tests/conversation-tree.test.mjs) 验证同父并发、启动窗口取消、等待者中止与分支隔离；[原生 Session 测试](../../../tests/native-session.test.mjs) 验证父引用二次检查和首次初始化竞争。统一执行 `npm run check`。

项目文件只接受已准备的 snapshotId，幂等比较包含 ID 及顺序。新 Run 经 session-runs.readFileSnapshots 获取并校验有界文本，取消使用准入 AbortController，读取后等待 done；协议绑定在模板处理之后附加用户文件资料。已接受幂等请求不重新查草稿期限或源路径，详见[文件引用设计](../../project-file-references-design.md)。

## 归档准入

已接受幂等结果优先于 Session 归档、模型和 Prompt 校验。新 Run 在准备前检查 archivedAt，Session 接受事务再复核，归档先提交时返回 `session-archived`。已准备 program 仍必须关闭、等待实际退出并释放绑定租约；Run 先接受时，Session 归档返回 `session-has-active-runs`，直到取消/完成及资源清理后的终态提交。详见 [Session 组件](../sessions/session.md) 与 [并发行为测试](../../../tests/conversation-tree.test.mjs)。

整根关闭窗口：组合根同步标记 closing 并广播仅用于准入的 AbortSignal。Run 直接入口检查 closing；信号取消尚未完成的 program 准备，使 HTTP 等依赖消费者能够等待请求真实退出，随后 Nya 才卸载 Run 与其依赖。已接受运行的取消、退出和结算仍由 Run/Runtime 清理负责，不在组合根复制依赖图。测试见 `tests/harness-server-core.test.mjs` 的 request-owner 关闭场景。

## 产品运行期准入

`harness.run-admission` 与 Run 属于同一个 Nya 组件，向宿主提供同步 `busy()`、`pauseIfIdle()` 和 `closeAdmission()`。`busy()` 同时检查准备、接受交接、未转移 program 与已接受执行所有权，不只查询 SQLite 的 running 状态。`pauseIfIdle()` 在无异步间隙的检查中，忙时返回 undefined，空闲时冻结新 Run 并返回幂等释放函数；允许多个冻结持有者，直到最后一个释放才恢复准入。

产品活动服务在保存停用目标前调用该冻结端口，覆盖 HTTP 请求已经返回但实际执行仍在继续的 Run。宿主运行期装配器在撤销 Agent 能力前再次取得冻结；忙碌拒绝不取消任务。停用仅在最后一个产品不再引用 Agent 能力时卸载该组件。应用总关闭使用 `closeAdmission()` 中止准备，然后由原有 Run/Runtime Effect 取消并等待在途执行。

[产品运行期测试](../../../tests/harness-server-runtime.test.mjs) 覆盖首次异步读取前的准备窗口、结果早于实际退出、嵌套冻结、恢复准入和 harness server 独立清理。
