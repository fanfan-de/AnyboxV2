# Activity 准入组件

[应用模块](README.md) · [Run](../execution/run.md)

## 工厂与服务

[activity.ts](../../../src/host/applications/activity.ts) 提供 `createProductActivityComponent()`；组件名 `app-activity`，提供 `app.activity: ProductActivityPort`，没有服务依赖。内部闭包工厂 `createProductActivity()` 也供隔离行为测试使用，不是第二个组件。

## 资源与接口

组件独占内存活动租约、停用冻结和原生服务 guard，不持久化凭据或运行句柄。`enter(productId, options)` 在任何异步工作之前登记应用来源，返回幂等 release。默认租约阻止停用；只读观察使用 blocking:false 和 cancel。

`freeze(productIds)` 同步检查与冻结，整个检查不发生 await。只要选定应用存在阻塞活动就拒绝，且不改变状态。成功后新 enter 被拒绝；drain 关闭匹配观察并等待真实 release。freeze.release 恢复准入并释放原生 guard。

`registerGuard` 将服务内部工作纳入同一临界区。Agent guard 使用当前 `harness.run-admission`，覆盖尚未持久接受的准备和已交给 Runtime 的运行。多个 guard 中任意一个忙碌时释放已经取得的 guard，不留下部分冻结。

## 操作退出语义

HTTP 写入租约持续到真实提交；图片及项目文件 OwnedCall 等待 done；Run 接受返回后租约交给 waitRun，直到实际资源退出。浏览器断连或关闭读取不释放仍运行的任务租约。只读订阅不阻止应用停止，但必须在冻结时关闭并完成 release。

正式 Anybox Harness 使用 agent；其他应用使用其注册 ID，互不影响。执行端 Run 租约覆盖资源实际退出；客户端租约覆盖连接和代理请求，不把远程 Run 当作客户端资源，不因关闭客户端而取消远程执行。

## 关闭与故障

`stop` 同步拒绝新调用并取消观察；`wait` 等待现有租约退出。应用整体关闭先停止准入，再由领域组件取消和结算运行，Activity 的 Effect 最后等待租约清空。Activity 不替代运行资源所有者，不通过租约自行取消模型或工具。

业务失败必须在 finally 释放；release 幂等。组件不使用计时器或超时伪造退出，也不通过数据库的 running 状态判断空闲。

观察取消回调失败不会跳过其余观察的取消和退出等待；失败以 cleanup 阶段上报。全局 stop 关闭准入并收集取消错误，wait 等待活动退出后报告错误。

## 验证入口

[products.test.mjs](../../../tests/products.test.mjs) 覆盖同步冻结、部分 guard 获取恢复、应用停止和观察实际退出。HTTP 与 Run 测试覆盖操作交接、结果与 done 区别及关闭等待。统一执行 `npm run check`。
