# Models 配置存储

[返回 Models 模块](README.md)

## 定位与装配

源码：[store.ts](../../../packages/models/src/store.ts)，契约：[types.ts](../../../packages/models/src/types.ts)。工厂 `createModelsStoreComponent(options)`，组件名 `models-store`，提供 `models.store: ModelsStore`，无注入依赖。它独占 Models 配置 SQLite，供 [协调服务](models.md)使用，不承担业务 Session 数据和公共目录缓存。

`ModelsStoreOptions` 包含必填文件 `path`，以及可选 `legacyParameterConverters: Record<protocolId, converter>`。路径必须非空且不能为 `:memory:`；组件规范化真实路径，创建权限为 `0700` 的父目录。数据库采用 `busy_timeout=0`、外键约束和 `locking_mode=EXCLUSIVE`，并在独占事务中迁移。

## 接口与保存内容

| 接口组 | 内容 |
| --- | --- |
| `providers/provider/providerHistory` | Provider 当前定义与不可变版本 |
| `models/model/modelHistory` | Model 当前定义与不可变版本 |
| `connections/connection/connectionHistory` | 账户连接、私有槽引用与 epoch |
| `configurations/configuration/configurationHistory` | 可执行配置及固定定义版本 |
| `sources`、`syncState`、`intents` | 来源接纳账本、连接补齐状态、凭据清理日志 |
| `commit(change)` | 一次原子批次写入或删除当前连接 |

四类主体分别有当前表和版本表。另有 `sources`、`connection_sync_states` 与 `credential_intents`。配置库只保存 Key 引用与操作日志，不保存 Key 值、认证头或 execution 句柄。来源定义元数据按字段白名单写入，嵌套能力、成本、连接提示也经过校验。

## 原子提交与约束

`commit()` 在准入时校验并复制输入，进入组件独占串行队列后执行 `BEGIN IMMEDIATE`。批次可同时修改定义、连接、配置、来源账本、同步状态与凭据意图；任一约束失败回滚整个批次。

- `expectedRevision: null` 表示创建，数字表示更新；当前版本不匹配返回 `conflict`，新 revision 必须恰好递增一次，`createdAt` 保持不变。
- 外部身份按来源命名空间和原始 Provider/Model ID 唯一，已有来源身份、Model 的父 Provider、连接协议和关联定义不得更换。
- 配置固定连接、模型定义、定义版本、远端 ID 和 baseline 身份；所固定定义版本必须存在，且与远端 ID 一致。
- `(connectionId, modelDefinitionId)` 只能有一个 baseline，额外预设不占该唯一位置。
- `syncGuards` 在写入前复核目标来源版本，避免旧补齐覆盖较新目标。
- 删除连接原子移除当前连接、其当前配置和同步状态，保留版本历史。连接和配置的历史 ID 不能被新对象复用。

此层保证数据事务与完整性，补齐策略、Key 写入顺序和来源接纳策略由协调服务决定；调用存储不能代替上层业务验证。

## 迁移与历史兼容

当前 SQLite schema 为 3。v1 先迁入统一 Provider/Model、连接与配置结构，再对旧原生参数完成 v2→v3 转换。迁移维持稳定 ID、版本身份、baseline、启停状态、固定定义与凭据引用；没有读取或复制任何 Key。

v3 当前配置保存 `{ protocolId, formatVersion, value }`，连接具有非秘密 `historyScopeEpoch`。内置纯转换器将旧 `maxOutputTokens` / `protocol.*` 转为原生字段，不补运行时默认。扩展可在启动传入转换器；未知或不可转换参数保留 `formatVersion: 0` 可读状态，之后可在提供转换器的启动中再迁移。它们不能原生执行，不存在旧执行后备路径。

迁移处于一个独占事务，失败回滚表结构、记录和 schema 版本。历史 JSON 不被重写；历史配置查询可在读取边界投影旧字段为参数对象，即使连接已删除也可从历史获取协议。历史连接由上层转为非秘密公共视图。

## 生命周期与失败

初始化失败会尝试关闭已打开连接，并抛固定 `storage-unavailable`，没有内存后备。已准入写入全部串行；某个批次失败不会使后续队列永久卡住。Effect 关闭先拒绝新查询/提交，再等待已准入尾任务，最后关闭 SQLite；关闭失败报告 `cleanup-failure`。

另一个持有者不能并发打开同一配置库。进程异常退出后由 SQLite 释放排他锁；已提交凭据意图保留，由协调服务下次启动清理。宿主必须保证此路径与目录缓存、业务库独立。

## 验证与扩展

[storage.test.mjs](../../../packages/models/tests/storage.test.mjs) 覆盖事务回滚、关联不可变、baseline、同步守卫、连接删除、排他与进程退出；[storage-migration.test.mjs](../../../packages/models/tests/storage-migration.test.mjs) 覆盖 v1 兼容；[native-migration.test.mjs](../../../packages/models/tests/native-migration.test.mjs) 覆盖 v3 与扩展延迟转换。

替换提供方需实现 `ModelsStore` 的读写契约和相同原子、版本、所有权语义，不把 SQLite 类型带过边界。参见 [Vault](vault.md)、[目录缓存](catalog-cache.md) 和 [Models 架构](../../architecture/models-module.md)。
