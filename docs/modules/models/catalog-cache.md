# Models 目录缓存

[返回 Models 模块](README.md)

## 定位与装配

源码：[catalog-cache.ts](../../../packages/models/src/catalog-cache.ts)，契约：[catalog-types.ts](../../../packages/models/src/catalog-types.ts)。工厂 `createModelsCatalogCacheComponent(options)`，组件名 `models-catalog-cache`，提供 `models.catalog-cache: ModelsCatalogCache`，无注入依赖。

它只保存公共来源快照及 ETag/check 时间，不保存执行配置或 Key。独立数据库不与 [Models Store](store.md) 或业务 SQLite 共用连接/文件；缓存是性能和离线辅助，已接纳的统一来源账本仍由 Models Store 持有。

## 配置与接口

| 配置 | 行为 |
| --- | --- |
| `path` | 必填、非空、不可为 `:memory:`；规范化真实文件路径 |
| `fallbackToMemory` | 默认允许初始化失败后使用内存，`false` 时直接失败 |
| `reservedPaths` | 禁止作为缓存的宿主数据库路径，检查规范路径及符号/硬链接别名 |

`status()` 返回 `{ persistence: 'sqlite' | 'memory', error?: 'storage-unavailable' }`；`read(cacheKey)` 返回可选不可变记录；`write(record)` 原子替换一条记录。记录为 `{ cacheKey, snapshot, checkedAt, etag? }`，包含 schema 2 来源快照；验证时间、ETag、快照结构、身份和内容版本。

另有 `createMemoryModelsCatalogCache()`，返回没有组件 close 接口的独立内存服务，适用于受控测试/装配。需要系统生命周期管理时使用组件。

## 存储与读写流程

SQLite 使用 `catalog_cache(cache_key, record)` 和自身 `user_version=1`，在 `locking_mode=EXCLUSIVE`、`busy_timeout=0` 下初始化。非空但未识别的数据库拒绝接管。缓存表 schema 版本和记录中来源快照 schema 版本是不同概念。

`write()` 在准入时校验并冻结输入，再按组件写队列进入 `BEGIN IMMEDIATE`，通过 upsert 原子替换，成功清除本次运行的存储错误；失败回滚并记录 `storage-unavailable`。已提交缓存不会因稍后的取消而回滚。读取验证存储记录的 `cacheKey` 与查询一致，不允许跨源重用。

旧 schema 1 来源快照只在读取时校验原始 checksum 并转换；不就地改写旧缓存，所有后续写入使用当前 schema 2。异常记录返回固定存储错误，目录服务仍可尝试已接纳来源/随包快照。

## 后备、资源与生命周期

初始化无法创建目录、打开库、获得独占所有权或识别库结构时，先释放已开的连接；除非 `fallbackToMemory: false`，再建立内存 Map，并通过 `status()` 明确返回 `persistence: 'memory'` 与 `storage-unavailable`。命中 `reservedPaths` 是配置错误，会在打开 SQLite 或后备之前拒绝。运行中读写失败只记录错误，不自动把已有 SQLite 切换为内存。

内存与 SQLite 都返回不可变数据。Effect 关闭先拒绝新调用，SQLite 等待已准入写队列后关闭连接，内存则清空条目。关闭库失败是 `cleanup-failure`，关闭后的查询/写入是 `closed`。缓存允许内存后备不改变 Vault 必须使用系统安全存储的要求。

## 测试与关联文档

[catalog.test.mjs](../../../packages/models/tests/catalog.test.mjs) 覆盖持久化重开、来源隔离、排他释放、初始化后备、保留路径及链接别名、旧记录转换与损坏缓存启动。当前宿主的 [installWebModels](../../../src/web/models-startup.ts) 将 Models 配置和业务数据库传入 `reservedPaths`。

替换缓存只需实现 `ModelsCatalogCache`，保持原子替换和可观察存储状态。参见 [目录调度](catalog.md) 与 [配置存储](store.md)。
