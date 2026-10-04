# Products 应用控制组件

[应用模块](README.md) · [应用设计](../../products-v1.md)

## 工厂、服务与依赖

`src/host/applications/component.ts` 的 `createProductsComponent({directory,runtime,restoreLegacyAgent?})` 创建 `app-products`，提供 `app.products: ProductsPort`。注入 `local-storage` 和 `app.activity`，不注入受其控制的执行或连接服务。运行端口提供 open、stop、retry、inspect、closeAdmission、awaitIdle。runtime(id) 延迟取得各应用实例。

目录经 registration.ts 校验并注入；Anybox Harness 元数据在 src/applications/harness/registration.ts，稳定 ID 为 agent。没有动态代码、模块选择、组件配置、应用定义修订或用户产品写入。

## 数据与迁移

组件拥有既有业务连接上的 `app-products` v2 迁移域和 `app_product_targets` 表，保存期望打开状态，不新建 SQLite 连接。新执行库默认关闭；首次登记发现 `run-state` 域可保留 Anybox Harness 已打开。客户端传入 restoreLegacyAgent:false，默认关闭。

旧 v1 组合库跳过新 v1 建表，由 v2 创建目标表并迁入旧内置 agent 行的 desired_enabled。自定义组合不再恢复；旧定义 JSON 与领域历史保留，旧 app_products 不再写入。只读应用目录由当前代码提供。

## 接口与执行

`list/get` 提供应用白名单投影；`open/disable/retry` 控制生命周期；`authorize(id)` 在业务准入前核对该应用已运行；`restore` 重建保存目标；`stop` 停止控制准入并等待队列。

同一 ID 控制串行，不同 ID 独立执行。停止与重新安装的重试先同步取得 Activity 冻结，忙碌拒绝不保存目标。冻结成功后提交目标、关闭并等待观察实际退出，再调用装配端口。提交失败释放冻结并保留原目标。打开运行中的 Anybox Harness 幂等，不重复安装；控制请求断连不取消已接受工作。

准入保护获取失败时会释放已取得的保护；若回退或最终释放失败，应用进入 cleanup 失败并要求重启。忙碌或普通存储失败仍不改变保存目标。行为验证见 `tests/product-control-races.test.mjs`。

状态为 disabled、applying、running、blocked、failed，运行取决于实际 Nya 服务状态。依赖恢复自动投影为 running；启动失败可明确重试。清理失败禁止再次打开或覆盖安装，要求新宿主。DTO 仅包含固定名称、状态和安全错误码，不含模块、路径句柄、原生历史或 Key。

## 资源与关闭

实际 Fiber 由同一应用根所有。执行端打开 harness server 装配完整 Agent 能力；客户端打开 harness server 装配连接、目录窗口与代理，客户端不安装执行服务。Effect 停止并等待控制操作；整根关闭由宿主先关闭控制和业务准入，再卸载组件并等待实际退出。

停止和重新打开不删除领域数据、连接或系统凭据。旧应用控制门面在根关闭后不可复用。

初始化事务补齐当前目录缺失行，新应用默认关闭；移出目录的目标记录保留但不装配。运行时使用 src/host/applications/runtime.ts 的安装辅助函数，同步登记 Fiber/Effect，以独立信号保护每代异步工作；它只保存资源归属，不复制依赖图，也不是 Nya 组件。

## 测试

`tests/application-host.test.mjs`、`tests/harness-server-runtime.test.mjs`、`tests/products.test.mjs`、`tests/product-control-races.test.mjs`、`tests/products-host.test.mjs`、`tests/products-api.test.mjs`。统一入口 `npm run check`。
