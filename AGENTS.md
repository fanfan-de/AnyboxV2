# AnyboxV2 协作说明

- `packages/application/src/`：统一装配 Core、Loader、Include 和 ConsoleLogger，提供配置控制与应用生命周期。
- `packages/application/tests/`：配置、应用与宿主行为测试。
- `examples/demo.mjs`：基于空 JSON 配置的应用启动与关闭示例，不访问网络。
- `examples/host.mjs`：终端输入、进程信号和关闭期限。
- `docs/agent-kernel-plan.md`：当前通用 Agent 内核的组件、LLM 适配、实施与验收计划；当前没有内核实现。
- `docs/runtime-implementation-plan.md`：旧的较大范围 Runtime 设计参考，固定 48 类组件不作为当前首版要求。
- NyaCore 是相邻的 `../NyaCore` 仓库，通过本地包目录依赖接入。

从 `@nya/core` 公共入口导入；修改框架应在 NyaCore 仓库完成。保留 TypeScript strict。组件入口完成初始化后返回；不要让永久 agent loop 阻塞组件启动。资源须通过 Effect 登记清理，在途任务须支持显式取消和等待结束。

框架设施与业务组件共用应用 Context。组件在 `inject` 中声明服务，从 `apply(ctx, config, deps)` 的 `deps` 使用本轮依赖快照；受信根控制面在每次外部请求中通过 `context.get()` 取当前服务。不缓存跨组件重启的服务引用，不使用 Context 属性代理、`isolate()` 或 `intercept`。文件受管声明通过 Include 修改。

NyaCore 当前发布集为五个包；HMR 已移到 NyaCore `experimental/`，不是 application 稳定能力。当前仓库没有自动 watcher：开发期代码变更后关闭并等待清理，再重启宿主进程。Timer 不是组件或服务；需要时向 `timeout(ctx, ...)` / `interval(ctx, ...)` 传入资源所有者 Context，并单独取消、等待在途任务。`FAILED` 为粘性状态，必须通过明确的 update、restart、resolve/recover 或 dispose 处理，不依赖依赖变化自动恢复。库不注册进程信号或强制退出，宿主负责这些策略。

内核所有组件通过项目自有契约保持可替换，由 Nya 组合根选择实现。允许阶段性使用第三方开源方案，须封装其类型、状态与生命周期，保留迁移和自研替代路径；不能仅把模型适配器做成可替换。替换必须通过相同的行为与资源清理合约测试，首版可用和最终自研分别验收。

修改生命周期、取消或资源归属时同步更新行为测试。完成变更运行 `npm run check`；修改示例后运行 `npm run demo`。框架变更后先运行 `npm run nya:build`，等待构建成功再验证本项目。运行完整框架构建或检查前先停止 `nya:watch`。
