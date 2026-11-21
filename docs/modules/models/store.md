# Models 配置存储

[返回 Models 模块](README.md)

## 定位与装配

源码：[store.ts](../../../packages/models/src/store.ts)，契约：[types.ts](../../../packages/models/src/types.ts)。工厂 `createModelsStoreComponent(options)`，组件名 `models-store`，提供 `models.store: ModelsStore`，无注入依赖。它独占 Models 配置 SQLite，供 [协调服务](models.md)使用，不承担业务 Session 数据和公共目录缓存。该提供方保留给需要 SQLite 的独立宿主，并用于读取旧配置；当前 Anybox Harness 使用同一服务契约的 [JSON 配置存储](json-store.md)。两种提供方按宿主选择安装其一。

`ModelsStoreOptions` 包含必填文件 `path`，以及可选 `legacyParameterConverters: Record<protocolId, converter>`。路径必须非空且不能为 `:memory:`；组件规范化真实路径，创建权限为 `0700` 的父目录。数据库采用 `busy_timeout=0`、外键约束和 `locking_mode=EXCLUSIVE`，并在独占事务中迁移。

## 接口与保存内容

| 接口组 | 内容 |
| --- | --- |
| `providers/provider/providerHistory` | Provider 当前定义与不可变版本 |
| `models/model/modelHistory` | Model 当前定义与不可变版本 |
| `configuredProviders/providerSettings/providerSettingsHistory` | 按提供方定义 ID 保存唯一一套设置、凭据引用与恢复身份 |
| `configuredModels/modelSettings/runtimeModelSettings/modelSettingsHistory` | 每个模型定义的一套设置、固定定义版本与历史运行 ID |
| `sources`、`syncState`、`intents` | 来源接纳账本、模型配置补齐状态、凭据清理日志 |
| `commit(change)` | 一次原子批次写入或移除提供方设置 |

四类主体分别有当前表和版本表。另有 `sources`、`provider_sync_states` 与 `credential_intents`。配置库只保存 Key 引用与操作日志，不保存 Key 值、认证头或 execution 句柄。来源定义元数据按字段白名单写入，嵌套能力、成本、连接提示也经过校验。

## 原子提交与约束

`commit()` 在准入时校验并复制输入，进入组件独占串行队列后执行 `BEGIN IMMEDIATE`。批次可同时修改定义、提供方设置、模型配置、来源账本、同步状态与凭据意图；任一约束失败回滚整个批次。

存储复用内部固定 SQL 的 prepared statements，避免目录批量接纳时为每个模型重复编译语句；关闭连接时清空该缓存。事务内部不让出事件循环，读者只能观察完整批次，不能看见尚未提交的部分来源。

- `expectedRevision: null` 表示创建，数字表示更新；当前版本不匹配返回 `conflict`，新 revision 必须恰好递增一次，`createdAt` 保持不变。
- 外部身份按来源命名空间和原始 Provider/Model ID 唯一，已有来源身份、Model 的父 Provider 和已配置提供方的协议固定。
- 模型设置固定提供方、定义版本、远端 ID 和可执行模型 ID。所固定定义版本须存在并与远端 ID 一致。
- 每个模型定义同时只有一套设置。可执行模型 ID 可以查回活动设置，历史中已退休的 ID 保持退休。
- `syncGuards` 在写入前复核目标来源版本，避免旧补齐覆盖较新目标。
- 移除提供方设置时原子删除当前设置、所属模型配置和同步状态，保留版本历史。同一提供方可以重新添加，此时创建新的设置修订和可执行模型 ID。

此层保证数据事务与完整性，补齐策略、Key 写入顺序和来源接纳策略由协调服务决定；调用存储不能代替上层业务验证。

## 迁移与历史兼容

当前 SQLite schema 为 5。v1 先升级到统一定义和原生参数格式，较早的账户设置随后归并到对应提供方 ID，模型设置归到模型定义 ID。保留可执行模型 ID、定义版本、凭据引用和既有会话恢复身份。历史保留原版本身份，原连接和配置版本表仅用于旧数据留档。内置原生参数转换器以外的参数可保留为 `formatVersion: 0`，随后在启动时提供扩展转换器升级。

迁移在一个独占事务内提交。同一提供方有多套旧账户设置时报告冲突 ID，原表、记录和 schema 版本保持原样。用上一版显式移除多余连接后再升级。同一模型有多套旧设置时采用唯一启用的一套，多套启用或都停用时报告冲突。JSON 从旧 SQLite 导入时执行同样检查，保留原 SQLite。

## 生命周期与失败

初始化失败会尝试关闭已打开连接，并报告迁移冲突或 `storage-unavailable`，没有内存后备。已准入写入全部串行；某个批次失败不会使后续队列永久卡住。Effect 关闭先拒绝新查询/提交，再等待已准入尾任务，最后关闭 SQLite；关闭失败报告 `cleanup-failure`。

另一个持有者不能并发打开同一配置库。进程异常退出后由 SQLite 释放排他锁；已提交凭据意图保留，由协调服务下次启动清理。宿主必须保证此路径与目录缓存、业务库独立。

## 验证与扩展

[storage.test.mjs](../../../packages/models/tests/storage.test.mjs) 覆盖事务回滚、关联不可变、模型设置唯一性、同步守卫、提供方设置删除、排他与进程退出；[storage-migration.test.mjs](../../../packages/models/tests/storage-migration.test.mjs) 覆盖 v1 兼容；[native-migration.test.mjs](../../../packages/models/tests/native-migration.test.mjs) 覆盖 v3 与扩展延迟转换。

测试夹具先等待其创建的全部 Nya 根实际关闭、释放 SQLite 连接和排他所有权，再删除临时目录；Windows 同样验证事务、重开与进程崩溃恢复，不依赖 Unix 允许删除已打开文件的行为。

替换提供方需实现 `ModelsStore` 的读写契约和相同原子、版本、所有权语义，不把 SQLite 类型带过边界。参见 [Vault](vault.md)、[目录缓存](catalog-cache.md) 和 [Models 模块](README.md)。
