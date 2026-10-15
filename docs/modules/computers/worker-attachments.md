# Worker 附着账本组件

[返回 Computer 模块](README.md) · [worker 执行器](worker-executor.md) · [worker 拨出](worker-dialout.md) · [单元附着](../units/unit-attachments.md)

`createWorkerAttachmentsComponent({ namespace?, openEntry?, now? })` 在独立 worker 根安装 `computer-worker-attachments`，提供 `computer.worker-attachments: WorkerAttachmentsPort`。inject worker 独占的 `local-storage`。它是 Computer 单元自己的附着记录：这台 worker 为哪些 harness server 服务、设备拥有者为每个附着设定的作用域上限，以及保存在系统凭据命名空间中的单元凭证。源码：[组件](../../../src/applications/harness/core/computer/worker-attachments.ts)、[纯规则](../../../src/applications/harness/core/computer/worker-attachments-domain.ts)。

## 配置与接口

`namespace` 是系统凭据命名空间，默认 `anybox.computer-worker`，独立 worker 入口由 `ANYBOX_COMPUTER_WORKER_NAMESPACE` 指定；`openEntry` 仅供测试用内存替身替换 `@napi-rs/keyring` 条目，生产使用 macOS Keychain、Windows Credential Manager 或 Linux Secret Service。凭证 ID 为 `unit-attachment/<attachmentId>`。没有系统凭据服务的宿主不能记录附着：凭据操作失败返回固定 `worker-credential-unavailable`，不回退到文件或 SQLite。

| 方法 | 行为 |
| --- | --- |
| `list()` | 全部记录，不含凭证 |
| `record(attachment, credential)` | 保存一条 `approved` 附着：先登记 `store` 意图，再写凭据条目，最后在同一事务写入记录并删除意图；同 ID 已存在返回 `worker-attachment-conflict` |
| `revoke(attachmentId)` | 先在事务中置为 `revoked` 并登记 `delete` 意图，等监听器处理完（拨出循环停止、执行器排空该附着的 Run），再删除凭据条目和意图；幂等。`local:computer` 返回 `worker-attachment-local` |
| `credential(attachmentId)` | 读取 approved 附着的凭证，供拨出循环使用 |
| `requireApprovedIn(reader, attachmentId)` | 执行器接纳事务内的同步参与：`local:computer` 固定返回全量作用域的回环附着；其余必须存在且 `approved`，否则 `worker-attachment-rejected` |
| `onChanged(listener)` | 记录或撤销后依次 await 每个监听器 |

记录保存 `attachmentId`、规范化的 `harnessUrl`、目标 instanceId、状态、设备拥有者的 `ceiling`、harness server 批准的 `scope`、附着 epoch 与时间。纯函数 `validateHarnessUrl` 只接受 HTTPS，或回环主机上的 HTTP；`ceilingPermits(ceiling, { path, toolId })` 判定固定工作区路径落在允许目录内且工具契约被允许，执行器在每次工具接纳事务里调用它。

## 数据与资源归属

组件独占 `computer-worker-attachments` v1 迁移域：`computer_worker_attachments` 保存记录 JSON，`computer_worker_credential_intents` 保存凭据写入/删除意图。启动时先对账：有 `store` 意图却没有 approved 记录、或有 `delete` 意图的条目，删除凭据后清除意图；失败留待下次启动。凭证只在系统凭据库，记录和 API 都不返回它。

## 执行、取消与清理

没有网络和长期任务。所有入口经 pending 集合跟踪；Effect 先停止新调用（返回 `worker-closing`），再等待已接受的账本与凭据操作退出并关闭凭据存储。记录与撤销顺序保证"先停止接纳再删除凭证"：撤销后执行器立即拒绝该附着的新声明，拨出循环停止后凭证才消失。

## 失败与兼容边界

本组件不发起网络请求，不消费附着码；这些在 [worker 拨出](worker-dialout.md)。它不知道 harness server 侧的附着状态，远端撤销由拨出循环在轮询被拒后转成本地 `revoke`。回环附着 `local:computer` 不入表，也不能撤销。本组件不持有 Run 账本，按附着拒绝与排空由执行器执行。

## 验证

[worker 附着测试](../../../tests/computer-worker-attachments.test.mjs)覆盖纯规则、记录/撤销与凭据意图、执行器按附着授权与 ceiling 拒绝、worker 重启后的凭证读取；真实系统凭据用例由 `ANYBOX_KEYRING_TESTS=1` 门控。完整入口为 `npm run check`。
