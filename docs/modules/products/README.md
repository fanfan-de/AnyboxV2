# 应用目录与生命周期

[组件清单](../README.md) · [通用宿主与目标生命周期](../../products-v1.md) · [能力差距与实施顺序](../../application-packages-design.md)

应用运行目录当前由受信代码静态声明，正式目录提供 Anybox Harness 与 Claude Agent，支持注册任意数量的应用。Products 管理查询、打开、停止和重试；D1.3 的[包管理](../package-management/README.md)另行提供本地文件安装、取消和恢复，完成后保持待生效，尚不加载安装版本。在线下载、版本生效和卸载继续由后续阶段实现。功能页面、连接目标与内部组件不成为独立应用。每个进程一个根 Context，宿主保存具有后台入口的应用启停目标，协调所声明的基础能力按消费者装配，领域数据由应用自己管理；纯界面应用没有模拟后台或持久后台目标。

| 组件 | 职责 |
| --- | --- |
| [Products](products.md) | 注入应用目录、持久启停目标、受管打开与停止 |
| [Activity](activity.md) | 按应用登记活动、调用通用停止保护、冻结准入并观察实际退出 |

`packages/host/src/applications/registration.ts` 校验目录、路由和资源，`packages/application-api/src/nya.ts` 管理每代装配归属与清理，`packages/host/src/applications/providers.ts` 选择能力版本并管理消费者租约，均为普通函数。能力缺失门禁在业务工厂前执行，可选能力由应用自行降级，最后消费者退出后才等待非 resident 提供方释放；宿主自用 SQL 随根退出。通用宿主工厂显式接收目录；`packages/distribution/src/entrypoints/` 选择正式应用。Anybox Harness 注册位于 `packages/app-harness/src/registration.ts`，服务端 `server-runtime.ts`、客户端 `client/runtime.ts` 同属该应用目录。依赖启动及清理由 Nya 管理。桌面退出只通过 Activity 对当前全部应用取得通用保护，不读取应用业务服务。接入示例见[开发者说明](../../application-development.md)。

目标宿主管理下载、安装、版本生效、打开运行、关闭和卸载。上述“每代安装”是现有进程内组件装配，不是磁盘应用包安装；包管理职责按实施阶段增加，不在本模块清单虚构尚不存在的组件。宿主通过通用契约协调就绪、关闭保护和实际退出；业务初始化、取消、数据迁移和资源清理由应用完成，宿主不直接操作 Session、Run、Models、设备连接或其他应用业务。卸载默认保留业务数据，清理或删除未完成时不能报告已关闭或已卸载。
