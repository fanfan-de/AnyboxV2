# Computer 工具图片适配

[返回工具模块](README.md)

## 职责与入口

实际 Nya 组件名为 `computer-worker-tool-images`，由 [`openComputerWorker`](../../../packages/app-harness/src/core/computer/worker-server.ts) 的 worker 根装配代码建立。它注入 `harness.image-assets` 并提供 `tools.images`，将独立工具包需要的 `ToolImagesPort.importImage` 绑定到本轮图片资源服务。

适配仅暴露图片导入及不可变引用，不向工具包传递带 SQL 事务、Session 查询或原生模型对象的完整图片端口。服务名称不构成权限沙箱。

## 资源与退出

适配不另开存储、进程、计时器或执行循环。原字节、图片验证、草稿生命周期与本地存储由 [Image Assets](../images/image-assets.md) 组件持有；worker 和 Session 继续负责同事务固定图片引用及传输回执。

每次导入沿原 `result/cancel/done` 句柄返回，取消和退出错误原样传播。Files 组件等待嵌套导入实际退出后才释放操作；其依赖撤销由 Nya 沿真实注入关系协调，重装配从本轮 `deps` 获取图片服务。

## 验证

[`computer-worker.test.mjs`](../../../tests/computer-worker.test.mjs) 验证真实 worker 图片回执；[`native-tool-library.test.mjs`](../../../tests/native-tool-library.test.mjs) 验证四协议工具图片与文本模型边界；[`independent-tools.test.mjs`](../../../packages/computer-tools/tests/independent-tools.test.mjs) 验证独立工具通过窄图片能力运行。
