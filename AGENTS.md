# AnyboxV2 协作说明

- `packages/application/src/`：统一装配六个 Nya 包、配置控制和应用生命周期。
- `packages/application/tests/`：配置、应用、HMR 与宿主行为测试。
- `examples/demo.mjs`：基于空 JSON 配置的应用启动与关闭示例，不访问网络。
- `examples/host.mjs`：终端输入、进程信号和关闭期限。
- `docs/agent-kernel-plan.md`：当前通用 Agent 内核的组件、LLM 适配、实施与验收计划；当前没有内核实现。
- `docs/runtime-implementation-plan.md`：旧的较大范围 Runtime 设计参考，固定 48 类组件不作为当前首版要求。
- NyaCore 是相邻的 `../NyaCore` 仓库，通过本地包目录依赖接入。

从 `@nya/core` 公共入口导入；修改框架应在 NyaCore 仓库完成。保留 TypeScript strict。组件入口完成初始化后返回；不要让永久 agent loop 阻塞组件启动。资源须通过 Effect 登记清理，在途任务须支持显式取消和等待结束。

框架设施与业务组件共用应用 Context。文件受管声明通过 Include 修改，HMR 仅在显式开发模式启用。服务引用不能跨组件重启缓存；每次外部请求获取当前服务。库不注册进程信号或强制退出，宿主负责这些策略。

修改生命周期、取消或资源归属时同步更新行为测试。完成变更运行 `npm run check`；修改示例后运行 `npm run demo`。框架变更后先运行 `npm run nya:build`，等待构建成功再验证本项目。运行完整框架构建或检查前先停止 `nya:watch`。
