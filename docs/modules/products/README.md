# 应用目录与生命周期

[组件清单](../README.md) · [Harness 应用设计](../../products-v1.md)

应用目录由受信代码声明，正式目录目前提供 Harness，支持注册任意数量的应用。功能页面、连接目标与内部组件不成为独立应用。每个进程一个根 Context，打开目标与领域数据分别保存。

| 组件 | 职责 |
| --- | --- |
| [Products](products.md) | 注入应用目录、持久打开目标、受管打开与停止 |
| [Activity](activity.md) | 操作登记、停止准入、观察实际退出 |

`src/host/applications/registration.ts` 校验目录、路由和资源，`runtime.ts` 管理每代安装归属与清理，均为普通函数。通用宿主工厂显式接收目录；`src/entrypoints/` 选择正式应用。Harness 注册位于 `src/applications/harness/registration.ts`，执行端 `runtime.ts`、客户端 `client/runtime.ts` 同属该应用目录。依赖启动及清理由 Nya 管理。接入示例见[开发者说明](../../application-development.md)。
