# 可组合单元模块

[返回组件手册](../README.md) · [可组合部署单元设计](../../composable-units-design.md)

本模块承载 harness server 与可独立部署单元（Models、Computer）之间的附着事实和拨出传输。U0 完成附着账本、本机单元的自动附着和 Run 接受事务固定的附着引用；U1 完成单元凭证认证、拨出传输，以及 [Computer 模块](../computers/README.md)中的附着账本、拨出循环、按附着区分的授权、远端路由、字节通道和只读查询面。拥有者侧 Web 提供附着管理入口；Models 远端执行仍属于后续阶段。

| 组件 | Nya 名称 | 服务 |
| --- | --- | --- |
| [单元附着](unit-attachments.md) | `harness-unit-attachments` | `harness.unit-attachments` |
| [单元传输](unit-transport.md) | `harness-unit-transport` | `harness.unit-transport` |

## 依赖与职责

单元附着只注入[本地 SQLite](../infrastructure/local-sqlite.md)，独占 `unit-attachments` 迁移域。[Session](../sessions/session.md) 注入它，在 Run 接受事务内复核固定的附着引用；[Run](../execution/run.md) 注入它，在准入时解析项目所绑定的附着，并在恢复接管前校验引用仍然有效；[Computer Operations](../computers/computer-operations.md) 注入它，在每次新工具声明进入 starting 前复核 Run 固定的 Computer 附着仍为 approved、epoch 相同，且工具契约位于批准 scope 内。worker 在新工具接受事务与只读查询中按本机真实目录身份校验批准 scope 和设备上限，避免跨系统路径或目录别名被 Authority 的字符串判断误拒。单元传输只注入单元附着，用凭证摘要认证拨出的单元并持有内存邮箱。Models 与 Computer 单元互不感知，也不依赖本模块；本机同进程 Models 组件和本机 worker 客户端不读取附着记录，它们由组合根以固定身份登记为本机单元。

## 数据路径

1. 组合根启动时把 `models-local` 与 `computer-local` 登记为本机单元；组件在迁移后幂等创建两条 `approved` 本机附着，附着 ID 固定为 `local:models` 与 `local:computer`，并为 Models 本机单元生成本次装配的 bootId。
2. Run 准入解析本机 Models 与项目所绑定 Computer 的附着引用，随 `registerRun` 进入 Session 接受事务；Session 复核引用仍为 `approved` 且 epoch 相同，再把引用写入 `harness_runs.unit_bindings_json`。
3. harness server 拥有者可以生成一次性附着码，记录 `pending` 附着；附着码与单元凭证只以 SHA-256 摘要保存，只在生成或消费时返回一次。远端 Computer 单元经 `POST /units/unit/attach` 消费附着码，拿到一次性凭证和本实例 instanceId，之后以 `Unit <attachmentId>:<credential>` 长轮询 `GET /units/unit/poll` 领取请求、`POST /units/unit/replies` 回传，这些路由由通用宿主按应用声明跳过设备令牌认证、由应用自行认证。
4. 撤销远端附着递增 epoch，可由 harness server 拥有者或单元侧（`POST /units/unit/revoke`）发起；本机附着拒绝撤销。Run 恢复接管前校验固定引用，不匹配时结算失败，不改绑当前单元；撤销后该 Run 的新工具声明在 Computer Operations 被拒绝，单元侧取消并排空该附着的 Run，harness server 侧已置位的操作记为 outcome-unknown、scope 清理报告失败。
5. 故障注入行为（[单元故障测试](../../../tests/computer-unit-faults.test.mjs)）：网络中断只延迟事实，命令不重复；单元重启把在途命令变成一次性的 cancelled 事实并以新代次服务后续 Run；harness server 进程被 SIGKILL 后，替代进程在同一端口与实例身份下由单元重连，查回原 receipt 并只消费一次结果；撤销后新声明被拒绝、在途命令在单元侧取消。

## 测试

`tests/unit-attachments.test.mjs` 验证附着账本与凭证状态；`tests/harness-server-core.test.mjs` 验证接受事务固定本机引用、过期引用拒绝写入及恢复时失败结算，并覆盖断言失败时释放受控模型的 result/done、关闭组件根与存储。恢复用例中的临时账本连接与重新打开的宿主均在失败路径等待清理。
