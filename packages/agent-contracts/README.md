# @anybox/agent-contracts

项目自有的 Agent 契约，覆盖文本 Run、受控步骤、工具调用和已提交事件查询。无运行时依赖，不引用 Nya、供应商 SDK 或具体内核实现；包含应用 facade 和 interrupted 恢复结果；实时订阅、审批和自动任务续跑尚未提供。

| 入口 | 内容 | 使用方 |
| --- | --- | --- |
| `@anybox/agent-contracts` | 可序列化的领域数据、请求、回执和错误数据；仅类型导出 | 宿主、内核、适配器及未来客户端 |
| `@anybox/agent-contracts/api` | `KernelApi`、`AgentApi` 类型与统一的 `KernelFault` 异常类 | 嵌入调用方及实现 |
| `@anybox/agent-contracts/spi` | 模型、工具、上下文、权限、状态、策略与资源所有权接口；仅类型导出 | 内核及替代实现 |

```ts
import type { RunResult } from '@anybox/agent-contracts'
import { KernelFault, type KernelApi } from '@anybox/agent-contracts/api'
import type { ModelService, Owned } from '@anybox/agent-contracts/spi'
```

领域数据按身份、错误、Agent、消息、Session、Run 和能力描述拆分源文件。公共入口仅为上表三项。API 与 SPI 可以使用标准的 Promise、AbortSignal 和 Map；它们不是网络传输协议。类型检查不依赖 Node 类型声明。

## 行为约定

- 公共快照与提交值须隔离引用；`readonly` 本身不提供运行时隔离或输入校验。
- `runs.start` 返回接受回执；`runs.wait` 对业务失败、取消返回相应终态。操作拒绝使用 `KernelFault`，调用方根据 `error.code` 判断。
- 取消 `runs.wait` 只停止该次观察。`ModelCallHandle.cancel` 只请求停止，必须另等 `done` 确认实际调用与清理结束。业务失败本身不导致 `done` 拒绝，清理失败会拒绝。
- 多步执行策略只能使用 modelStep/executeTools 受控入口，旧单次策略保留；取消后必须退出自有工作并完成清理，不遗留后台任务。
- `Owned.close` 停止接收、取消并等待自有工作；重复调用共享关闭结果，独立清理失败聚合报告。
- Run 进入终态前必须停止相关工作并完成必要收尾；结算失败不能伪造终态，实际资源清理仍须继续。

`StateService.readSnapshot()`、`SessionPolicy` 和 `ContextInput.state` 使用只读 `StateSnapshot`，其集合为 ReadonlyMap，事件列表及领域记录也是只读的。事务回调使用可变 `StateDraft`，`StateData` 保留为兼容名称。事务回调同步修改 Map 草稿，不得执行 I/O 或启动任务；失败全部回滚，返回值和提交数据隔离引用。只读类型不替代提供方的运行时隔离；策略也接收独立快照。旧策略若修改快照或要求可变 Map，需要迁移到只读输入；实际状态修改应放在事务边界。

`durability: 'memory'` 不承诺数据库事务、跨进程持久化或恢复。新增 `durability: persistent` 提供方要求排他所有权及持久事务提交，当前 SQLite 实现及恢复范围见 [Agent 应用说明](../../docs/agent-application-v1.md)。

## 实现与兼容

内核和适配器共同依赖本包。Nya 组件、Effect 注册、具体状态与模型实现、默认策略、运行限制默认值和 `CoordinatorFactories` 构造选项留在 `@anybox/agent-kernel`；application 的配置和框架接口留在 `@anybox/application`。

原 `@anybox/agent-kernel` 根入口的数据类型、`KernelApi` 和 `KernelFault`，以及 `/contracts`、`/spi` 子入口继续兼容转导出。`CoordinatorFactories` 仍可从旧 `/spi` 入口导入。所有入口共享同一个 `KernelFault` 构造器，支持跨入口的 `instanceof`。

替换实现须通过相同的业务及资源清理行为验证，类型兼容不等于行为验收。当前行为测试位于 `packages/agent-kernel/tests/`；本包测试验证独立消费和公共异常语义。当前语义见 [Harness 实现说明](../../docs/agent-harness-v1.md)，文本基线见 [Run 实现说明](../../docs/run-coordinator-v1.md)，未实施内容见[契约草案](../../docs/agent-contracts-draft.md)。

根目录 `npm run check` 执行全部检查；单独运行内核的 build/typecheck 时会先构建本包，避免依赖已有 dist。

新增 SPI 实现须处理 steps/attempts/toolCalls/events 四个 StateData 集合及扩展后的 Message 联合类型；工具内容、预算与事件游标均为项目结构。ToolSchema 为明确子集，非完整 JSON Schema。RunExecutionStrategy、ContextBuilder、ToolPolicy 和 ToolService 均可由组合根选择；运行时替换需要停止并清理旧组件。

AgentApi 自动使用当前代身份提交任务；新 RunTerminalState 包含 interrupted，调用方必须处理该终态。KernelDescription 报告真实 durability、Agent 身份与本次恢复列表；列表 API 提供有界 offset/limit 查询。
