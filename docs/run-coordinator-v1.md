# 第一版 Run 协调组件

状态：首批最小文本执行版本的基线说明。日期：2026-09-22。后续已实现受控多步执行、串行工具和原子事件查询，见[Harness 当前说明](agent-harness-v1.md)。下文描述原文本子集；消息、步骤、累计输出限制和策略接口的扩展以 Harness 说明为准。真实模型与流式订阅仍未实现，不表示完整 G0/G1 已验收。

## 能力与启动

一个启动时固定的 Agent 可以创建多个会话。每个 Run 接受文本，执行一次 Mock 模型调用，保存完整结果，支持查询、取消、失败和关闭。Mock 不访问网络，也不具有真实模型的推理能力。

```sh
npm run check
npm run demo
npm run demo:agent
```

[完整示例](../examples/agent-kernel-demo.mjs)在现有 application 的 Root Context 上安装三个组件，展示连续两次对话、历史查询、取消和关闭后活动调用归零。原空配置示例保持不变。

| 组件 | 提供服务 | 依赖与归属 |
| --- | --- | --- |
| `MemoryStateComponent` | `agent.state` | 保存内存状态；撤销时等消费者退出后关闭存储 |
| `MockModelComponent` | `agent.model` | 拥有模拟调用及其清理 |
| `RunCoordinatorComponent` | `agent.kernel` | 注入上述服务；拥有 Agent 实例、所有排队和活动 Run |

组件初始化不会启动 Run。安装后须检查 Fiber 为 `ACTIVE`，然后从根 Context 取当前服务，调用 `initialize({ definition })`。每轮协调组件只允许初始化一次；Agent 定义不放入 Include 的部署配置中。

定义包含 `id`、`revision`、`instructions` 和 `model`；模型引用分别包含 `protocolId`、`providerId`、`modelId`、`configRevision`。当前 Mock 仅接受 `protocolId: 'mock'`，不提供凭据或远程连接配置。

## 公共 API

| 入口 | 行为 |
| --- | --- |
| `initialize({ definition })` | 创建唯一 Agent 实例，返回由内核生成的 ID 和 generation |
| `describe()` | 返回 ready、故障、有效限制、`stateDurability: 'memory'`；streaming/tools 均为 false |
| `sessions.create()` | 创建属于该 Agent 的会话，初始 version 为 1 |
| `sessions.get({ sessionId })` | 返回会话只读快照 |
| `sessions.messages({ sessionId })` | 从同一状态快照返回 session 和按提交顺序排列的 messages |
| `runs.start(request)` | 返回 runId、inputMessageId、接受后的 sessionVersion，不等待模型完成 |
| `runs.get({ runId })` | 返回实际已保存的 Run 状态；设施故障另由 describe 报告 |
| `runs.cancel({ runId, reason? })` | 返回 requested 或 already-terminal；重复取消保留首次原因 |
| `runs.wait({ runId, signal? })` | 等待终态；signal 只取消本次等待，不取消 Run |

`start` 参数为 `agentId`、`agentGeneration`、`sessionId`、`expectedSessionVersion`、`requestKey` 和 `input`。input 是非空文本块数组，每块为 `{ type: 'text', text: string }`。实际执行前固定整个定义及有效限制，调用方修改原请求或返回快照不会改变内部状态。

同一 Session 最多一个非终态 Run。同键去重范围为 Agent ID、generation、Session ID 和 requestKey；相同规范请求返回原接受回执，不再执行，即使当前会话版本已变化。不同请求使用同一键返回 CONFLICT。请求键和 Run 记录不自动淘汰，满额后拒绝新任务。

Session.version 在接受和终态提交时各递增一次；只改变 Run 的 running/cancelling 状态不增加会话版本。新任务应先读取最新 Session；重试原请求则使用原参数。

`wait` 对 completed、failed、cancelled 均正常返回终态快照。无记录、取消等待、状态读取失败或终态无法保存时拒绝 `KernelFault`；可通过其 `error.code` 判断，不能解析 message。失败详情不复制供应商原始错误到保存的领域记录。

## 数据和执行规则

- `@anybox/agent-contracts` 导出领域数据，`/api` 导出 `KernelApi` 与统一 `KernelFault`，`/spi` 导出项目自有替换接口；均不启动服务，也不依赖 Nya、供应商 SDK 或具体内核实现。详细边界见[契约包说明](../packages/agent-contracts/README.md)。
- 原内核根入口及 `@anybox/agent-kernel/contracts`、`/spi` 保留兼容转导出；`CoordinatorFactories` 属于内核构造选项，保留在实现包。内核和调用方共享同一个 `KernelFault` 类。
- 本轮使用字符串 ID、UTC ISO 时间、纯文本 user/assistant 消息；助手消息带模型 attemptId。工具内容、waiting 状态及事件游标暂未导出。
- Run.basis 保存 Agent generation、完整不可变定义和有效限制。RunResult 是终态 RunSnapshot，不另建一份互相竞争的结果状态。
- 接受事务原子写入用户输入、queued Run、会话版本及去重记录；提交后登记控制句柄，排队任务同样有明确所有者。
- 一次调用的成功输出与 completed 状态原子保存。失败和取消不生成助手消息。
- 上下文只使用此前 completed Run 的用户／助手消息，以及本次输入。失败、取消的用户输入仍能在历史查询中看到，但不会自动送入下一次模型调用。
- 超出上下文限制明确失败，不自动裁剪、摘要、重试或切换模型。

## 生命周期和替换契约

Run 命令队列只处理有限检查和状态提交，不在队列内等待模型、任务结束或清理。状态存储的事务回调必须同步且无外部副作用；内存实现复制草稿后执行，全部成功才提交，回调抛错时回滚，读写结果均隔离引用。

ModelService.call 返回 `result`、`cancel()` 和 `done`。result 表示业务结果，done 表示实际调用及清理结束。业务失败不必导致 done 拒绝，清理失败会导致 done 拒绝。不能通过取消等待或 Promise.race 假装模型工作已停止。

每个 Run 用独立 EffectScope 管理调用和期限计时器，挂到协调器的所有权树；整个树通过组件 Effect 登记。原生期限计时器属于该 Run Scope，清理时取消。协调器关闭先关接收门，向全部工作发出停止请求，再等待执行策略和模型清理、提交终态，最后释放作用域。

提供方撤销使用 Nya 的消费者先退出规则，状态服务保持到协调器完成必要提交。关闭、取消和依赖变化不会删除历史；内存提供方真正关闭后数据释放，不支持进程重启恢复。

协调组件重新启动后需要显式初始化；只有相同定义且旧 Run 均已结算时，才允许用新 generation 重新连接仍存在的内存会话。旧 facade 拒绝请求，旧 generation 不能启动新 Run，不自动恢复或重放旧工作。FAILED 的恢复仍由显式 restart/update/recover 负责。

状态设施故障会关闭新任务入口并停止已有工作。终态无法提交时，wait 拒绝 SETTLEMENT_FAILED，查询保留最后真实提交的状态。实际工作和其他清理继续退出，close 聚合错误；不无限重试提交，也不强制中断不合作的 JavaScript 任务。

替换实现通过组合根选择：

- `createMemoryStateComponent(factory)` 接收返回 `Owned<StateService>` 的工厂。
- `createMockModelComponent(factory)` 接收返回 `Owned<ModelService>` 的工厂；默认是 Mock，用于本版装配及测试。
- `createRunCoordinatorComponent({ sessionPolicy, strategy })` 接收会话策略与执行策略工厂；返回对象遵守 `SessionPolicy` / `ExecutionStrategy`。
- 执行策略接收只读请求、受控的一次模型调用入口和 AbortSignal；必须等自有工作和清理结束后才 settle。不能改变受控调用的输入或限制，不能后台遗留工作。
- 整个协调器可替换为提供同一个 `KernelApi` 的其他 Nya 组件。新实现必须运行相同的业务与清理行为测试；仅实现类型不算通过。

StateService 当前只约定内存寿命，事务草稿使用项目自有 Map 结构。数据库事务、持久化恢复、模型 Resolver/Lease 和完整多步策略需要后续独立扩展契约，不能直接把这个最小 SPI 宣称为完整 v1。

## 默认限制和验证

| 配置项 | 默认值 |
| --- | --- |
| maxConcurrent | 2 |
| maxQueued | 32 |
| runTimeoutMs | 30,000，包含排队、执行及收尾 |
| maxInputBytes / maxOutputBytes | 各 32 KiB UTF-8 文本 |
| maxContextBytes | 256 KiB，合计指令、有效历史和本次输入 |
| maxSessions / maxRuns | 100 / 1,000 |

安装 RunCoordinatorComponent 时可覆盖限制，除 maxQueued 允许为 0 外均需正安全整数；期限不得超过原生计时器范围。记录容量包含已结束的 Run，不通过删除去重记录腾出容量。

[测试目录](../packages/agent-kernel/tests/)覆盖原子回滚、快照隔离、完整输出、历史、去重、FIFO 和容量、取消竞态、期限、迟到结果、清理失败、状态故障、依赖撤销/替换及同 Root application 关闭。ControlledMock 用显式结果和清理门控制竞态；期限测试等待真实超时事件，其余生命周期测试不依赖固定 sleep。

真实模型、工具执行、流事件订阅和磁盘恢复均未实现或验收。全量内核验收矩阵仍见原计划。
