# Models 系统凭据

[返回 Models 模块](README.md)

## 定位与装配

源码：[vault.ts](../../../packages/models/src/vault.ts)。工厂 `createModelsVaultComponent({ namespace, openEntry? })`，组件名 `models-vault`，提供 `models.vault: ModelsVault`，无注入依赖。它拥有一个系统凭据命名空间内的槽操作，Key 关联到哪个账户以及如何进行崩溃恢复由 [Models 协调服务](models.md)管理。

`namespace` 和每个 `slotId` 必须非空且不能包含 NUL。`openEntry(namespace, slotId)` 是测试或宿主系统安全存储适配的替换点，返回 `getPassword(signal)`、`setPassword(value, signal)`、`deleteCredential(signal)`；它不是明文文件后备入口。

默认后端为 `@napi-rs/keyring` 的 `AsyncEntry`，使用 macOS Keychain、Windows Credential Manager 或 Linux Secret Service，Linux 显式选 `secret-service`。系统存储不可用就报告错误，不回退到内核 keyring、SQLite 或明文文件。

## 服务接口与流程

| 接口 | 行为 |
| --- | --- |
| `read(slotId, signal?)` | 返回字符串或 `undefined` |
| `write(slotId, value, signal?)` | 校验非空 Key，再保存到该槽 |
| `delete(slotId, signal?)` | 删除槽；不存在也按完成处理 |

同一槽按准入顺序串行，前一操作失败不阻塞后一操作；不同槽可以并发。每次准入建立私有 `AbortController`，连接调用者信号并立即登记到 active 集合，因此调用者不再等待也不会丢失资源所有权。排队任务开始前再次检查取消，已取消任务不会打开系统凭据条目。

Vault 不理解连接、配置版本、凭据引用和清理日志。协调服务在 [Store](store.md)登记意图后调用 Vault，成功后事务提交引用；Vault 本身不在数据库中补写或恢复业务状态。

## 取消与生命周期

原生凭据操作的 JavaScript 取消可能早于 OS 实际完成。默认适配器因此不把 signal 直接交给原生调用，而是等待原生 promise 完成后再报告取消；避免过早释放槽或让后续写入越过尚未退出的操作。替代 `openEntry` 接收私有信号，也必须满足实际退出语义。

取消发生在原生调用期间时，OS 写入可能已经完成，但对调用者返回 `cancelled`；协调层的持久意图处理这种不确定结果。读取取消也不会向调用者泄露迟到的已读值。

Effect 关闭先停止准入，取消所有已登记控制器，等待在途与排队任务全部结束，然后释放服务。服务关闭后返回 `closed`，不复用旧门面。

## 错误与信息边界

无效参数返回 `invalid-config`，系统后端异常统一为 `credential-unavailable`，取消统一为 `cancelled`，不暴露平台原生错误或秘密值。命名空间内槽值不进入快照和日志；公共 Settings 查询只能知道 Key 是否已配置。JavaScript 字符串无法保证安全擦除，execution 关闭通过释放引用缩短存活时间。

## 测试与关联文档

[vault.test.mjs](../../../packages/models/tests/vault.test.mjs) 使用 `openEntry` 替身验证按槽串行、跨槽并行、取消后等待真实退出、跳过排队写入和错误脱敏；[integration.test.mjs](../../../packages/models/tests/integration.test.mjs) 结合真实 Nya/SQLite 与测试 Vault 验证使用链路。这些测试不等于真实系统凭据存储已完成跨平台验收。

参见 [Models 协调服务的 Key 事务](models.md) 和 [包使用说明](../../../packages/models/README.md)。旧 `packages/api-key-manager` 只承担独立包与宿主读取旧凭据的兼容用途，不替代本组件。
