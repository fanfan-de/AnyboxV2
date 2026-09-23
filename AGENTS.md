# AnyboxV2 协作说明

项目基础约定：以函数式编程思想为指导，基于 NyaCore 框架构建 Agent Harness。后续设计、实现与重构均遵循这一方向：业务逻辑优先使用纯函数与显式数据流，使用函数组合和闭包组织行为，将副作用集中在明确的边界；由 NyaCore 负责组件装配、依赖注入与资源生命周期管理。具体约束见下文。

- `packages/application/src/`：统一装配 Core、Loader、Include 和 ConsoleLogger，提供配置控制与应用生命周期。
- `packages/application/tests/`：配置、应用与宿主行为测试。
- `packages/agent-application/`：函数式 Agent 应用组合、自动初始化、持久任务 facade 与跨进程恢复测试。
- `packages/agent-contracts/`：独立的领域数据、调用 API、首版实现 SPI 与统一 KernelFault；不依赖 Nya 或具体实现。
- `packages/agent-kernel/`：Run 协调、受控 RunRuntime、串行工具、原子事件查询、内存/SQLite 状态、纯函数恢复计划、Mock 模型及行为测试；兼容转导出旧契约入口，未实现真实模型、实时事件订阅或审批。
- `packages/agent-kernel/src/components/<name>/component.ts`：组件注册与 Effect 所有权；具体实现放在所属组件目录，禁止继续向组件汇总入口堆叠实现。
- `packages/agent-kernel/src/domain/`：内容校验与纯函数恢复；`strategies/`：执行、会话与上下文策略；`compat/run-coordinator/`：旧版文本组件入口。
- `packages/agent-application/src/application.ts`：Agent 应用组合根；`src/components/agent/component.ts`：自动初始化与任务 API；`src/index.ts` 仅维护导出。
- `examples/demo.mjs`：基于空 JSON 配置的应用启动与关闭示例，不访问网络。
- `examples/host.mjs`：终端输入、进程信号和关闭期限。
- `examples/agent-kernel-demo.mjs`：无网络的连续对话、历史、取消与关闭示例。
- `examples/agent-harness-demo.mjs`：无网络的模型与工具循环、执行记录和事件示例。
- `examples/agent-application-host.mjs`：常驻本地 HTTP 宿主；信号与退出期限在宿主层。
- `examples/agent-application-demo.mjs`：关闭重开后恢复身份、历史和去重的有限示例。
- `docs/agent-application-v1.md`：当前 Agent 应用、持久化、排他所有权与 interrupted 恢复语义。
- `docs/agent-harness-v1.md`：当前 Harness、工具与事件契约、所有权和限制。
- `docs/run-coordinator-v1.md`：当前已实现的 Run 组件 API、所有权、限制与验证范围。
- `docs/agent-kernel-plan.md`：完整通用 Agent 内核的组件、LLM 适配、实施与验收计划；第一版 Run 只覆盖其中一个子集。
- `docs/runtime-implementation-plan.md`：旧的较大范围 Runtime 设计参考，固定 48 类组件不作为当前首版要求。
- NyaCore 是相邻的 `../NyaCore` 仓库，通过本地包目录依赖接入。

从 `@nya/core` 公共入口导入；修改框架应在 NyaCore 仓库完成。保留 TypeScript strict。组件入口完成初始化后返回；不要让永久 agent loop 阻塞组件启动。资源须通过 Effect 登记清理，在途任务须支持显式取消和等待结束。

框架设施与业务组件共用应用 Context。组件在 `inject` 中声明服务，从 `apply(ctx, config, deps)` 的 `deps` 使用本轮依赖快照；受信根控制面在每次外部请求中通过 `context.get()` 取当前服务。不缓存跨组件重启的服务引用，不使用 Context 属性代理、`isolate()` 或 `intercept`。文件受管声明通过 Include 修改。

NyaCore 当前发布集为五个包；HMR 已移到 NyaCore `experimental/`，不是 application 稳定能力。当前仓库没有自动 watcher：开发期代码变更后关闭并等待清理，再重启宿主进程。Timer 不是组件或服务；需要时向 `timeout(ctx, ...)` / `interval(ctx, ...)` 传入资源所有者 Context，并单独取消、等待在途任务。`FAILED` 为粘性状态，必须通过明确的 update、restart、resolve/recover 或 dispose 处理，不依赖依赖变化自动恢复。库不注册进程信号或强制退出，宿主负责这些策略。

内核所有组件通过项目自有契约保持可替换，由 Nya 组合根选择实现。允许阶段性使用第三方开源方案，须封装其类型、状态与生命周期，保留迁移和自研替代路径；不能仅把模型适配器做成可替换。替换必须通过相同的行为与资源清理合约测试，首版可用和最终自研分别验收。

修改生命周期、取消或资源归属时同步更新行为测试。完成变更运行 `npm run check`；修改示例后运行 `npm run demo`。框架变更后先运行 `npm run nya:build`，等待构建成功再验证本项目。运行完整框架构建或检查前先停止 `nya:watch`。

新增业务实现使用函数式组织：纯函数负责状态转换和恢复计划，副作用集中在存储、模型、工具、组件装配与宿主边界；生命周期以函数组合和闭包管理，不新增业务类。持久状态提供方持有单实例排他所有权；异常退出的 Run 明确结算 interrupted，不自动重放外部副作用。
