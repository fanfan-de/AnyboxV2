# 可组合单元模块

[返回组件手册](../README.md) · [可组合部署单元设计](../../composable-units-design.md)

本模块承载 harness server 与可独立部署单元（Models、Computer）之间的附着事实。当前只实现 U0：附着账本、本机单元的自动附着和 Run 接受事务固定的附着引用。远端单元拨出、单元侧消费附着码、按附着区分的 worker 授权和远端代理组件属于后续阶段，不在本模块预建。

| 组件 | Nya 名称 | 服务 |
| --- | --- | --- |
| [单元附着](unit-attachments.md) | `harness-unit-attachments` | `harness.unit-attachments` |

## 依赖与职责

单元附着只注入[本地 SQLite](../infrastructure/local-sqlite.md)，独占 `unit-attachments` 迁移域。[Session](../sessions/session.md) 注入它，在 Run 接受事务内复核固定的附着引用；[Run](../execution/run.md) 注入它，在准入时解析本机附着，并在恢复接管前校验引用仍然有效。Models 与 Computer 单元互不感知，也不依赖本模块；本机同进程 Models 组件和本机 worker 客户端不读取附着记录，它们由组合根以固定身份登记为本机单元。

## 数据路径

1. 组合根启动时把 `models-local` 与 `computer-local` 登记为本机单元；组件在迁移后幂等创建两条 `approved` 本机附着，附着 ID 固定为 `local:models` 与 `local:computer`，并为 Models 本机单元生成本次装配的 bootId。
2. Run 准入解析两个本机附着的绑定引用，随 `registerRun` 进入 Session 接受事务；Session 复核引用仍为 `approved` 且 epoch 相同，再把引用写入 `harness_runs.unit_bindings_json`。
3. harness server 拥有者可以生成一次性附着码，记录 `pending` 附着；附着码与单元凭证只以 SHA-256 摘要保存，只在生成或消费时返回一次。消费附着码的服务入口已存在，远端传输与单元控制面留待 U1。
4. 撤销远端附着递增 epoch；本机附着拒绝撤销。Run 恢复接管前校验固定引用，不匹配时结算失败，不改绑当前单元。

## 测试

`tests/unit-attachments.test.mjs` 验证附着账本与凭证状态；`tests/harness-server-core.test.mjs` 验证接受事务固定本机引用、过期引用拒绝写入及恢复时失败结算，并覆盖断言失败时释放受控模型的 result/done、关闭组件根与存储。恢复用例中的临时账本连接与重新打开的宿主均在失败路径等待清理。
