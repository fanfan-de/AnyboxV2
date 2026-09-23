# Agent Harness 首批实现

状态：已实现内存中的受控多步执行与串行工具循环。2026-09-22。

这是完整内核计划的一项增量，不代表 G0—G5 整体验收。真实模型协议、实时订阅、模型 token 流、审批/提问和自动上下文裁剪仍未实现。后续已经增加 SQLite 持久状态与 interrupted 恢复，见[持久 Agent 应用](agent-application-v1.md)；本文其余部分记录 Harness 的内存基线。

## 装配与运行

```sh
npm run check
npm run demo:harness
```

[`examples/agent-harness-demo.mjs`](../examples/agent-harness-demo.mjs)在 application 的同一 Root Context 安装：

| 组件 | 服务 | 归属 |
| --- | --- | --- |
| MemoryStateComponent | agent.state | 内存记录与原子事务 |
| createMockModelComponent(factory) | agent.model | 模型调用及清理 |
| createToolComponent(factory) | agent.tools | 固定版本工具目录与调用资源 |
| HarnessComponent / createHarnessComponent(factories) | agent.kernel | Run 接受、调度、Runtime 与终态 |

工具组件可以使用 `createLocalTools([{ definition, execute }])`，也可以替换为遵守同一个 ToolService 的提供方。Harness 声明依赖三个服务，从 apply 的 deps 获取本轮快照。提供方撤销时先取消并等待消费者完成，再释放提供方。不要在同一个根上同时安装 HarnessComponent 和同样提供 agent.kernel 的 RunCoordinatorComponent。

组件启动只完成装配。所有 Fiber ACTIVE 后调用 initialize；AgentDefinition.tools 显式选择 `{ id, revision }`。没有选择的工具不能执行。定义、工具元数据和限制在接受 Run 时保存到 Run.basis。工具目录在提供方这一代内不可变，目录更新通过停止旧组件、等待清理、替换组件后显式初始化完成。

原 RunCoordinatorComponent 继续只依赖 state/model，支持原文本用法。新 Harness 使用相同的 KernelApi，不要求更换宿主的 start/get/cancel/wait 代码。

## 核心边界

- RunCoordinator 是 Run 状态的唯一修改者，串行命令队列处理检查、读取和事务；不在队列内等待模型、工具、策略或资源清理。
- RunRuntime 每个 Run 一个。管理步骤、调用句柄、预算、动作顺序和所有在途动作。通过协调器提交步骤变更，不直接提交 Run 终态。
- RunExecutionStrategy 每个 Run 创建一次，使用 ExecutionContext.modelStep() 和 executeTools({ stepId })。默认 createAgentLoop 循环直到模型返回纯文本最终结果。
- ContextBuilder 和 ToolPolicy 是可替换的同步受信策略。默认上下文按 history → input → continuation 排列，不自动裁剪。工具定义列在 tools 中；限制仍由 Runtime 检查。
- 模型与工具提供方只执行一次操作。result 表示业务结果，done 表示实际操作及清理结束，cancel 只请求停止。

执行策略必须 await 每个动作，不得自行调用 SDK 或 handler，不得遗留后台工作。Runtime 拒绝并发动作、未处理工具时再次调用模型、重复工具执行、伪造 finalStepId 和结束后继续使用保留的接口。动作错误为粘性错误，策略捕获它也不能继续发起动作。策略提前返回时，Runtime 仍会停止并等待已经登记的调用。

`CoordinatorFactories.executionStrategy` 选择多步策略；`contextBuilder` 和 `toolPolicy` 选择纯策略。旧 `strategy` 工厂及 ExecutionStrategy 保留为单次模型兼容路径，不能启用工具，也不能与 executionStrategy 同时配置。旧模式的策略工厂现在也每个 Run 调用一次。

## 记录、提交和查询

### 函数式结算边界

正常终态由 `domain/settlement.ts` 的 `planRunSettlement(snapshot, input)` 计算。时间、停止原因、清理/执行错误、最终模型结果和消息 ID 显式输入；返回隔离的新状态与 RunResult，不修改输入，不调用时钟、随机数、模型、工具或存储。重复结算已有终态不会新增消息、事件或 Session.version。

Coordinator 等待资源清理后，在终态事务实际执行时采集时间与所需消息 ID，并对事务内最新草稿计算、应用计划。期限包含清理与进入事务前的等待；清理失败优先于停止原因，已接受的取消优先于执行失败和后续期限到达。模型最终消息与 Run 终态仍在同一事务提交，提交失败不会对外发布计划中的结果。

正常结算与 `planRecovery` 共用未完成工具、模型步骤和事件的确定性草稿操作：pending 工具结算为 cancelled，running 工具结算为 uncertain，已确认结果保持不变。正常结算的不确定工具使用 SETTLEMENT_FAILED，异常恢复使用 INTERRUPTED；恢复保留原有 recovered 消息 ID 命名空间，不重放工具。一次结算生成的消息、事件与终态使用同一时间。

领域计划内部可以修改自己克隆的草稿；`records.ts` 的草稿操作本身不是纯函数，不应直接作用于调用方快照。

### 函数式执行转换与只读快照

`domain/model.ts` 负责模型步骤开始、结果接受、失败结算、上下文大小校验；`domain/tools.ts` 负责工具批次校验、执行开始、结果记录、步骤完成与结果归一化。转换输入包含明确的时间、ID、调用结果与取消事实，返回 `{ state, value }`，不修改输入快照。模型步骤数、累计输出字节、工具数及协议调用 ID 从已提交记录推导，Runtime 不另存业务计数或工具待处理标志。

Runtime 在串行事务回调中，基于最新状态计算、应用计划，提交成功后才返回动作结果或调用提供方。工具开始必须按步骤顺序进行；重复调用、跨 Run 使用步骤、未处理工具时再次调用模型、最终模型结果之后再次调用模型均被拒绝。取消期间允许保存已开始工具的真实结果，但不能开始下一个工具。已提交模型成功不会被迟到失败覆盖。

运行时仍负责 Promise、AbortSignal、EffectScope、动作并发保护、粘性错误、时钟及 ID 分配。可替换 ToolPolicy 在整批预检和每个工具开始前重新调用，其决定作为数据校验；当前权限重新检查语义保持不变。RunExecutionStrategy 仍使用异步受控入口，尚未迁移为声明式动作策略；Run 准入和调度也保留在 Coordinator。

`StateService.readSnapshot()`、会话策略和上下文构建器使用 `StateSnapshot`（ReadonlyMap、只读记录和事件数组）；事务使用 `StateDraft`，`StateData` 是兼容名称。类型只读不提供运行时冻结，存储和策略调用边界继续隔离引用。旧 SPI 消费者若修改读取快照或把策略参数标注为可变 StateData，需要改为只读输入。当前计划仍采用完整快照克隆，尚未引入增量变更集或持久数据结构。

### 执行记录

新增 Step、ModelAttempt、ToolCall、RunEvent，存入 StateData.steps/attempts/toolCalls/events。工具协议 call ID 在同一 Run 内唯一，ToolCall.id 由内核生成并用于内部记录和事件引用。领域数据不含 Promise、AbortSignal、Context 或 SDK 对象。

一次步骤：读取上下文 → 保存 model.started → 调用模型并等待清理 → 校验并保存模型结果 → 整批校验工具 → 逐个保存 tool.started、调用与清理、保存 tool.finished → step.finished。

模型返回工具请求时，模型结果、助手工具消息、ToolCall 记录和对应事件原子提交后才允许执行。纯文本最终助手消息继续与 Run completed 原子提交，以保持旧文本用法的结算语义。失败或取消的模型迟到结果不发布为最终助手消息。

新增调用入口：

```ts
const inspection = await api.runs.inspect({ runId })
// { run, steps, attempts, toolCalls }，来自同一份快照

const page = await api.runs.events({ runId, afterSeq: 0, limit: 100 })
// { events, lastEventSeq, hasMore }
```

RunSnapshot.lastEventSeq 是该 Run 已提交事件的最新序号，seq 从 1 单调递增。afterSeq 不含自身，limit 默认 100，允许 1—1000。下一页使用最后实际返回事件的 seq；不能用 page.lastEventSeq 跳过尚未读到的页面。也可以从 inspection.run.lastEventSeq 查询快照之后的事件。

事件是对已保存记录的类型、状态和 ID 引用，不是历史完整快照；完整当前记录通过 inspect/messages 查询。状态与对应事件同事务提交，回滚不留下事件或序号缺口。本版只提供分页查询，不是实时订阅；capabilities.events=true，streaming=false。事件在内存提供方关闭前不淘汰，每 Run 记录数量受步骤与工具数限制，因此没有过期游标。超前游标或非法参数明确拒绝。

Session.version 仍只在接受和终态提交各增加一次；步骤变化使用 Run.lastEventSeq 观察。

## 工具与副作用规则

- 工具接收有限、无环 JSON。ToolSchema 是明确的子集：string（可带 enum）、number、integer、boolean、null、array/items、object/properties/required。对象不允许额外属性；不支持的 schema 关键字在注册时拒绝，不能宣称支持完整 JSON Schema。
- 整批工具先检查名称、版本、参数和权限，任一个不合法则整批零执行。每个工具实际开始前再次检查权限、取消和期限。
- 默认工具策略允许 Agent 显式选中的工具；ToolPolicy 可以返回 deny 或 ask。deny 拒绝执行，ask 返回 INTERACTION_UNAVAILABLE，均没有工具副作用。
- 调度严格串行。执行意图先保存为 running，随后才调用 handler。成功结果和工具消息原子保存。可判定的 failed 结果可以作为模型的下一步输入；uncertain 或 cancelled 结果停止当前循环。
- createLocalTools 的 handler 返回 JSON 表示成功。未处理异常、无法验证/保存的结果或清理失败按保守规则处理为结果不确定，不自动重试。提供方原始异常不写入领域错误。
- 取消 Run 不等于撤销工具副作用。已经开始的工具仍须等实际退出；如果最终得到成功结果，会保存 succeeded，而 Run 可以为 cancelled。未开始的剩余调用保存 cancelled，避免留下无法配对的工具消息。
- tool.finish 提交失败时关闭接收门、停止后续执行；若终态事务仍可提交，running 调用结算为 uncertain。若终态也无法保存，wait 拒绝 SETTLEMENT_FAILED，get/inspect 保留最后真实记录，不伪造持久化成功。
- 默认历史保留 completed Run，以及任何已经提交工具请求的失败/取消 Run 的消息，包括结果和不确定状态。失败的纯文本 Run 仍不进入后续上下文。

这些都是进程内、内存生命周期保证。外部副作用与内存事务不是原子事务；进程崩溃后没有恢复保证，也不提供 exactly-once 承诺。

## 预算与资源

沿用原 Run 限制，增加：

| 限制 | 默认值 | 范围 |
| --- | --- | --- |
| maxSteps | 16 | 每 Run 的模型步骤；本版无自动重试 |
| maxToolCalls | 32 | 每 Run 所有已接受的工具请求，包括尚未开始的请求 |
| maxToolResultBytes | 32 KiB | 单个成功工具结果的 UTF-8 JSON 大小 |
| maxOutputBytes | 32 KiB | 改为每 Run 累计模型输出，文本按 UTF-8、工具请求按 JSON 计量 |

maxContextBytes 计算指令、历史、当前输入、步骤续接和工具定义。预算不足明确失败，不隐式丢消息。工具目录/选择最多 128 项，每个定义最多 32 KiB，schema 嵌套最多 16 层，工具 JSON 嵌套最多 32 层。

Run EffectScope 拥有 Runtime；Runtime EffectScope 拥有模型/工具清理句柄并追踪动作 Promise。期限包含排队、执行和清理。关闭先关接收门、请求取消所有 Run，再等待策略与调用退出、结算和作用域释放。清理失败聚合报告，其他清理继续。受信策略或 handler 必须合作退出，框架不强制终止 JavaScript。

## 验证与兼容边界

`tests/harness.test.mjs`覆盖完整闭环、事件分页与回滚、整批参数/权限拒绝、重复调用、预算、模型清理前取消、工具实际副作用、工具提供方撤销、开始与结果提交失败、清理失败、策略快照隔离、替代策略/上下文及提前返回时的资源所有权。`tests/execution-plans.test.mjs` 独立验证转换的确定性、输入隔离、累计预算、跨步骤协议 ID、非法顺序及取消后的结果保存；结算与恢复计划另有纯函数测试。原 Run 与 application 生命周期测试继续运行。contracts 独立消费测试验证新 SPI 不依赖 Nya、内核或 Node 类型，并以编译期反例验证只读契约。

公共命令保留，新增查询和工具内容变体。实现替换方需要更新新增 StateData Map、RunBasis.tools、RunSnapshot.lastEventSeq、有效限制及 Message 联合类型；本包仍为 0.0.0，不把扩展 SPI 宣称为无需修改的旧实现兼容。当前 StateService 继续是同步 Map 草稿契约。

后续增量：实时事件订阅及保留策略；审批与提问；真实模型协议与续接信息；数据库事务与恢复。完整要求仍见[内核计划](agent-kernel-plan.md)。
