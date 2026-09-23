# Agent Kernel

内核通过项目自有契约提供可替换的状态、模型、工具和执行协调。公共调用从 `@anybox/agent-kernel` 导入；领域数据与服务接口从 `@anybox/agent-contracts` 及其 `api`、`spi` 子入口导入。

## 组件目录

每个组件以 `component.ts` 声明 Nya 服务、注入依赖和 Effect 清理；具体实现与组件放在一起。`components/index.ts` 只汇总导出。

| 目录 | 提供服务 | 注入服务 | 实现文件 |
| --- | --- | --- | --- |
| `components/state/` | `agent.state` | 无 | `memory.ts`、`sqlite.ts`、`codec.ts`；支持异步提供方初始化 |
| `components/memory-state/` | `agent.state` | 无 | 同步替代入口，复用 `state/memory.ts` |
| `components/mock-model/` | `agent.model` | 无 | `mock.ts`；工厂可注入其他模型实现 |
| `components/tools/` | `agent.tools` | 无 | `local.ts`，工具注册与执行资源管理 |
| `components/harness/` | `agent.kernel` | state、model、tools | `coordinator.ts`、`runtime.ts`、`events.ts` |
| `compat/run-coordinator/` | `agent.kernel` | state、model | 旧版文本组件入口，复用 Harness 的协调器 |

State 与 MemoryState 是同一服务的替代组件；Harness 与旧 RunCoordinator 也是替代入口，不应同时装配。持久应用选择 State、MockModel、Tools、Harness，再由应用包安装 AgentApplication 组件。

`createRunCoordinator` 是当前 Harness 使用的协调器工厂，仍属于有效实现；只有旧版文本组件的装配入口放在 `compat/`。

## 函数模块

- `domain/`：内容校验、模型与工具执行转换、Run 结算和恢复计划；计划函数接收只读快照，不执行 I/O、不读取时钟或生成随机 ID、不修改输入。`state.ts` 将快照克隆为自有草稿；`records.ts` 提供确定性草稿操作。模型预算、工具调用数和执行顺序从已提交记录推导。
- `strategies/`：执行循环、会话策略和上下文构建，通过 SPI 替换。
- `shared/`：内核内部错误、校验和异步辅助函数，不依赖具体组件。
- `testing/`：可控 Mock 测试辅助，从 `@anybox/agent-kernel/testing` 使用。
- `tests/`：按行为验证执行、状态、取消、恢复及资源清理。

组件从注入快照使用其他服务，不导入其他组件的默认实现。存储、模型、工具适配器依赖契约和内部辅助函数；协调器通过 SPI 调用它们。组件入口与副作用实现保持函数式组织，不引入业务类。

`index.ts`、`contracts.ts`、`spi.ts`、`api.ts`、`testing.ts` 是导出入口；旧契约导入方式继续兼容。目录移动不改变公共 API，未导出的源码或 `dist` 内部路径不作为兼容接口。

完整执行语义见 [Harness 说明](../../docs/agent-harness-v1.md)，持久状态与崩溃恢复见 [Agent 应用说明](../../docs/agent-application-v1.md)。
