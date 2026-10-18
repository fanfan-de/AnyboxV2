# 单元附着组件

[返回可组合单元模块](README.md) · [Session](../sessions/session.md) · [Run](../execution/run.md)

`createUnitAttachmentsComponent(inputs, { localUnits? })` 在 harness server 根安装 `harness-unit-attachments`，提供 `harness.unit-attachments: UnitAttachmentsPort`。inject `local-storage`，在 `apply` 中登记 `unit-attachments` v1 迁移域。源码：[组件](../../../packages/app-harness/src/core/unit/component.ts)、[纯规则](../../../packages/app-harness/src/core/unit/domain.ts)、[端口](../../../packages/app-harness/src/core/unit/port.ts)。

## 配置与接口

`inputs` 提供 `now()` 与 `newId()`；`localUnits` 是组合根声明的本机单元列表，每种 `unitKind`（`models`、`computer`）至多一个，生产组合固定传入 `models-local` 与 `computer-local`。

| 方法 | 行为 |
| --- | --- |
| `list()` / `get(id)` / `listEvents(id)` | 读取附着记录与审计事件；记录不含附着码和凭证 |
| `createAttachCode({ unitKind, scope, ttlMs? })` | 记录 `pending` 附着并返回一次性附着码；有效期默认 10 分钟，允许 1 分钟到 24 小时 |
| `attach({ code, unitKind, unitId, contractVersion, capabilities?, ceiling })` | 消费附着码：校验未过期、种类一致、同种类同 `unitId` 没有其他 `approved` 附着，并要求请求作用域落在单元上限内；成功后返回一次性单元凭证 |
| `revoke(id)` | 远端附着幂等撤销并递增 epoch；本机附着返回 `unit-attachment-local` |
| `authenticate(id, credential)` | 以常量时间比较凭证的 SHA-256 摘要；记录缺失或摘要不符返回 `unit-credential-invalid`，非 `approved` 返回 `unit-attachment-state`。[单元传输](unit-transport.md)用它认证拨出的单元 |
| `local(unitKind)` | 返回该种类的本机附着及其 Run 绑定引用；Models 引用带本次装配 bootId；组合没有声明该种类的本机单元时返回 `unit-attachment-missing` |
| `binding(id)` | 任意 approved 附着的 Run 绑定引用，供项目绑定到远端附着的 Run 准入使用；非 approved 返回 `unit-attachment-state` |
| `getIn(reader, id)` | 调用方事务内的同步读取，不检查状态；Computer Operations 用它取远端附着声明的平台/架构作为放置事实 |
| `requireApprovedIn(tx, binding)` | 同步参加业务事务：引用的附着必须仍为 `approved`、种类与 `unitId` 一致且 epoch 相同，否则 `unit-attachment-mismatch` |
| `verify(bindings)` | 异步执行同样的校验，供 Run 恢复接管前使用 |

作用域按种类定义：Computer 为允许的项目目录与工具契约集合，Models 为 `manage` 或 `execute` 加允许的模型配置；`all` 表示不限制。纯函数 `scopeWithin` 判定请求作用域是否落在上限内，`manage` 只能落在 `manage` 之下。

## 数据与资源归属

组件拥有 `harness_unit_attachments` 与 `harness_unit_attachment_events` 两张表。附着记录保存种类、来源（`local`/`remote`）、状态（`pending`/`approved`/`revoked`，单调不可逆）、单元身份、契约版本、能力、请求作用域、单元上限、生效作用域、epoch 与时间；附着码与单元凭证只保存 SHA-256 摘要，消费后清除附着码摘要。审计事件记录创建、批准与撤销及其 epoch。

本机附着在启动事务中幂等创建：按种类、`unitId`、来源与 `approved` 状态查找，缺失时插入附着 ID 为 `local:<kind>` 的记录并写入两条事件。同一启动事务新建的附着及其创建、批准事件使用同一个时间戳；`list()` 按创建时间、附着 ID 排序，时钟跨毫秒不会改变这批本机附着的顺序。Models 本机单元的 bootId 由 `inputs.newId()` 在每次 `apply` 生成，只进入 Run 的绑定引用，不持久保存；Computer 本机单元没有启动期 bootId，实际 workerId/bootId 仍由 Operations 在操作绑定时固定，打开 Authority 不触碰 worker 目录。

## 执行、取消与清理

没有长期任务或网络连接。所有异步入口经本组件的 pending 集合跟踪；Effect 先停止新准入（后续调用返回 `unit-attachments-closed`），再等待已接受的读写实际退出。`requireApprovedIn` 不拥有事务，随调用方事务提交或回滚。

## 失败与兼容边界

本机附着不能经 API 撤销或收紧作用域；直接改写账本使引用失效时，Run 在接受或恢复阶段按 `unit-attachment-mismatch` 拒绝，不自动改绑。附着码过期返回 `unit-code-expired` 并保留 `pending` 记录，可显式撤销。`attach` 校验失败不改变记录状态。组件不持有网络：单元侧消费附着码、长轮询与回执经 harness server HTTP 的单元路由到达 `attach`、`authenticate` 与[单元传输](unit-transport.md)；远端代理组件随 U1 第 2 步、远端 Models 随 U3 加入。

## 验证

[附着账本与 Session 接受事务测试](../../../tests/unit-attachments.test.mjs)包含每次读取递增一毫秒的时钟回归，验证同批本机附着及审计事件的时间一致且列表顺序稳定；[harness server 核心测试](../../../tests/harness-server-core.test.mjs)覆盖本机附着固定与恢复栅栏场景，[HTTP 测试](../../../tests/harness-server-http.test.mjs)覆盖附着路由。完整入口为 `npm run check`。
