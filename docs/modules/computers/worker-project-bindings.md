# Worker 固定项目绑定组件

[返回 Computer 模块](README.md) · [Worker 执行器](worker-executor.md)

独立 worker 的 `computer-worker-project-bindings` 在 worker 根提供 `harness.projects`，满足既有工具的声明依赖。它是服务端入口中的受信适配器，源码见 [worker-server.ts](../../../src/applications/harness/core/computer/worker-server.ts)，不创建第二个 Projects 数据库或跨进程 Context。

该组件无 inject、无迁移域、无文件/网络资源，因此没有虚构 Effect。它不查询或修改项目，拒绝目录浏览、创建和 requireAvailable，getIn 不提供项目元数据。工具执行必须携带 Authority 已固定且 worker 校验过的 workspacePath；没有精确 binding 的调用失败。所有 Session/project 身份和准备仍归 Authority 的 Projects/Workspaces。

固定路径只是受信执行位置，不是文件系统沙箱。pinned-local 延续已有相对路径、绝对路径和宿主权限语义，不自动为 Windows 翻译 Unix 工具。远端目录浏览、文件快照捕获与 portable-managed 准备属于后续工作，不能由此适配器冒充实现。

验证入口为 [Worker 行为](../../../tests/computer-worker.test.mjs)、[真实 Runtime 恢复](../../../tests/computer-worker-resume.test.mjs)和 `npm run check`。
