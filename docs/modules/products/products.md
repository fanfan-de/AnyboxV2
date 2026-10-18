# Products 应用控制组件

[应用模块](README.md) · [应用设计](../../products-v1.md)

## 工厂、服务与依赖

`packages/host/src/applications/component.ts` 的 `createProductsComponent({directory,runtime,capabilities?,restoreLegacyAgent?})` 创建 `app-products`，提供 `app.products: ProductsPort`。注入 `local-storage` 和 `app.activity`，不注入受其控制的执行或连接服务。运行端口提供 open、stop、retry、inspect、closeAdmission、awaitIdle。runtime(id) 延迟取得各应用生命周期适配，capabilities(id) 只查询安全兼容性诊断，不初始化提供方或业务。

目录经 host 的 registration.ts 校验并注入；注册、状态、HTTP 和 Nya 适配契约由独立 application-api 提供；Anybox Harness 元数据在 packages/app-harness/src/registration.ts，稳定 ID 为 agent。没有动态下载代码、应用包安装、组件配置、应用定义修订或用户产品写入；能力提供方由受信组合显式声明，宿主仅按生命周期进行版本选择和资源协调。

D1.4 的正式加载器可以根据已验证安装快照构造该进程的只读目录，包安装和生效账本由独立[包管理组件](../package-management/README.md)拥有；Products 自身仍只保存及执行后台目标，不读取归档或应用业务。

## 数据与迁移

组件拥有注入 `local-storage` 连接上的 `app-products` v2 迁移域和 `app_product_targets` 表，保存期望打开状态，不新建 SQLite 连接。新执行库默认关闭；首次登记发现 `run-state` 域可保留 Anybox Harness 已打开。客户端传入 restoreLegacyAgent:false，默认关闭。

旧 v1 组合库跳过新 v1 建表，由 v2 创建目标表并迁入旧内置 agent 行的 desired_enabled。自定义组合不再恢复；旧定义 JSON 与领域历史保留，旧 app_products 不再写入。只读应用目录由当前代码提供。纯界面应用不写后台目标记录，也不创建模拟后台；其 required 诊断可使目录状态显示 blocked，诊断不会初始化能力。

## 接口与执行

`list/get` 提供应用白名单投影；`open/disable/retry` 控制生命周期；`authorize(id)` 在业务准入前核对该应用已运行；`restore` 重建保存目标；`stop` 停止控制准入并等待队列。

`freezeControls()` 同步暂停新的 open/disable/retry，返回可重入、按租约释放的保护；`drain()` 等待冻结前已接受的全部控制实际结束，`release()` 幂等恢复准入。它不改变后台目标、不调用业务取消，也不等同永久 stop。`applications/lifecycle.ts` 的受信辅助函数先取得并排空控制保护，再同步取得该目录全部 Activity guard；任何检查失败都释放已取得的保护。生效协调与最小桌面退出使用这条通用路径，不自行检查 Run 或连接。多个保护共存时，释放一个不会解除其他保护；整根关闭仍永久停止准入。

D1.5 的受信 `setClosedTargets?(ids)` 只在已持有并排空 freezeControls 的条件下修改宿主已有后台目标为 false，供卸载 commit 使用。它不要求卸载目标还在当前只读目录，不为未知或纯界面应用新建目标，不调用业务 stop，不解释业务状态；旧角色根关闭负责实际资源退出。准备或取消卸载不改目标，其他应用目标保持。stop 同时等待已经接受的目标写入，避免释放控制库时仍有本代写操作。

同一 ID 控制串行，不同 ID 独立执行。停止与重新装配的重试先同步取得 Activity 冻结，忙碌拒绝不保存目标。冻结成功后提交目标、关闭并等待观察实际退出，再调用装配端口。提交失败释放冻结并保留原目标。打开已运行应用幂等，不重复装配；控制请求断连不取消已接受工作。

准入保护获取失败时会释放已取得的保护；若回退或最终释放失败，应用进入 cleanup 失败并要求重启。忙碌或普通存储失败仍不改变保存目标。行为验证见 `tests/product-control-races.test.mjs`。

状态为 disabled、applying、running、blocked、failed，运行取决于实际 Nya 服务状态。依赖恢复自动投影为 running；启动失败可明确重试。清理失败禁止再次打开或覆盖安装，要求新宿主。DTO 包含固定名称、状态、安全错误码及能力诊断，不含模块、路径句柄、原生历史或 Key。能力诊断只含能力 ID、SemVer 范围、是否必需、ready/missing/unsupported/incompatible/conflict/failed 和可选的具体版本。

## 资源与关闭

实际 Fiber 由同一应用根所有。执行端打开 harness server 装配完整 Agent 能力；客户端打开 Anybox Harness 装配自身连接、凭据、代理与 Computer 管理；目录能力由 distribution 声明惰性提供方，首次兼容消费者打开时安装；客户端不安装执行服务。Effect 停止并等待控制操作；整根关闭由宿主先关闭控制和业务准入，再卸载组件并等待实际退出。

停止和重新打开不删除领域数据、连接或系统凭据。旧应用控制门面在根关闭后不可复用。

初始化事务补齐当前目录中具有后台入口的缺失行，新后台应用默认关闭；移出目录的目标记录保留但不装配。运行时使用 packages/application-api/src/nya.ts 的安装辅助函数，同步登记 Fiber/Effect，以独立信号保护每代异步工作；它只保存资源归属，不复制依赖图，也不是 Nya 组件。

## 能力选择与本代装配

`packages/host/src/applications/providers.ts` 的管理器归现有宿主运行时所有，是普通的选择/租约辅助函数，不是新 Nya 组件，不另建 Context，也不手工复制组件依赖图。`ApplicationCapabilityProvider` 由公开 application-api/nya 提供，声明 id、version、services、supported、resident 和惰性 create({ signal })。信号取消初始化时，提供方必须取消并等待实际初始化退出；资源仍经 Effect 清理。

打开先解析 required/optional 的 SemVer 范围。存在不满足的 required 时保留 blocked，且不执行应用工厂或初始化任何新提供方；optional 不可用则降级。能力和服务名上的并发锁保护共享提供方，选兼容最高版本，有消费者后固定版本；不兼容的使用者或服务名冲突报告 conflict，不替换在用资源。应用工厂每个干净运行代重新构造，取得冻结的版本元数据，按该选择声明条件 inject，实际服务从 deps 读取。

停止先等待应用资源退出，再释放能力租约；最后消费者释放才取消、卸载并等待非 resident 提供方。宿主自用 SQL 已由根持有，以 resident storage.sqlite 暴露，最后应用停止不关闭控制数据库。初始化回滚无法证明退出、停止或提供方清理失败时保留归属栅栏，不启动替代实例，整根关闭保留错误。根准备关闭只取消尚未提交的能力初始化，已运行应用的实际取消与清理由根卸载协调。

应用装配代和提供方管理器观察所属 Fiber 的 Registry 失败事件，保留准入冻结后才完成的失败清理事实，避免永久销毁擦除旧失败。观察随所属 Effect 清理，不复制依赖图或更改 Nya 调度。

宿主只消费通用生命周期和能力反馈，不读取 Run、Models、Computer 或连接业务状态；应用自己的准入保护与业务清理由应用实现。

## 测试

`tests/application-host.test.mjs`、`tests/harness-server-runtime.test.mjs`、`tests/products.test.mjs`、`tests/product-control-races.test.mjs`、`tests/products-host.test.mjs`、`tests/products-api.test.mjs`。`tests/application-capabilities.test.mjs`、`tests/application-optional-capabilities.test.mjs`、`packages/host/tests/providers.test.mjs` 和 `packages/application-api/tests/lifecycle.test.mjs` 覆盖按消费者装配、版本/缺失门禁、实际退出、清理失败栅栏与代次隔离。统一入口 `npm run check`。

`packages/host/tests/package-lifecycle-coordination.test.mjs` 验证先排空已接控制、冻结期间拒绝新控制、另一应用工作阻止生效且不被取消、页面保护及实际退出先于提交，以及取消后恢复准入；`package-managed-process.test.mjs` 覆盖跨角色目标与进程代次的实际交接。
