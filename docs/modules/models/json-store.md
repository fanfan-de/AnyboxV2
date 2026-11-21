# Models JSON 配置存储

[返回 Models 模块](README.md) · [SQLite 替换提供方](store.md)

## 定位与装配

源码：[json-store.ts](../../../packages/models/src/json-store.ts)，契约：[types.ts](../../../packages/models/src/types.ts)。工厂 `createModelsJsonStoreComponent(options)`，组件名 `models-json-store`，提供 `models.store: ModelsStore`，无注入依赖。它独占非秘密 JSON 配置文件、保存队列、临时文件和所有权锁；当前 Anybox Harness 选择该提供方。Models 协调服务仍只注入 `models.store`，不依赖文件格式。SQLite 提供方保留给其他宿主和旧配置导入，二者不能同时提供同一服务。

`ModelsJsonStoreOptions` 包含必填 `path`，可选 `legacyPath`、`reservedPaths` 与 `legacyParameterConverters: Record<protocolId, converter>`。`path` 是当前配置文件，`legacyPath` 只在 JSON 不存在时用于首次读取旧 SQLite；没有旧数据时创建空配置。`reservedPaths` 防止与其他资源共用文件或文件别名。目录缓存和 Session/Run 业务数据继续由各自 SQLite 组件保存，不能与 JSON 或导入源共用路径。

内部 [json-store-domain.ts](../../../packages/models/src/json-store-domain.ts) 负责文件布局、当前记录与历史比较、候选状态和约束校验，[store-domain.ts](../../../packages/models/src/store-domain.ts) 复用记录规范化与版本约束；文件 I/O、锁与保存队列留在组件适配器。旧 SQLite 的读取帮助函数位于 `store.ts`，只用于兼容导入，不注册额外服务或组件。

## 文件与管理契约

读写端口与 [SQLite 配置存储](store.md#接口与保存内容) 相同：统一定义、提供方设置、模型配置、来源账本、同步状态、凭据意图及不可变版本均保存在一个文件。顶层结构为：

```json
{
  "schemaVersion": 3,
  "providers": [],
  "models": [],
  "providerSettings": [],
  "modelSettings": [],
  "sources": [],
  "syncStates": [],
  "credentialIntents": [],
  "tombstones": { "providerSettings": [], "modelSettings": [] },
  "history": {
    "providers": [],
    "models": [],
    "providerSettings": [],
    "retiredConnections": [],
    "modelSettings": []
  }
}
```

每个提供方设置的 ID 等于提供方定义 ID。每个模型设置的 ID 等于模型定义 ID，并保存提供方、固定定义版本、远端模型 ID 和可执行模型的 `runtimeModelId`。`tombstones.modelSettings` 记录已退休的可执行模型 ID。重新添加提供方和模型后，旧会话继续引用原 ID。JSON 保存私有凭据引用、非秘密恢复身份及凭据操作意图，Key 值由 [Vault](vault.md) 保管。

维护清理不再使用的旧迁入 Provider/Model 定义时，先正常停止所属 Agent 并等待实际退出，确认当前提供方设置和模型配置已不再引用这些固定定义，再由受信维护过程独占配置存储，通过公开 `ModelsStore.commit()` 以预期修订提交 `state: "missing"` 的新版本。普通定义查询不再返回这些条目，显式包含缺失条目的查询和历史仍可读取；保留稳定 ID、`runtimeModelId`、关联与不可变版本，不物理删除 JSON 记录或改写历史。该维护方式不新增面向用户的定义删除接口。

Anybox Harness 界面只读展示能力，原生生成参数仍可编辑。需要人工修正能力时，先停止所属执行设备的 Agent，再打开文件，在 `modelSettings` 中按 `id`、`providerId` 和名称找到目标，修改其 `capabilities`。`support` 接受 `supported`、`unsupported`、`unknown`；推理声明可包含 `efforts`、`modes` 和 `budget: {"min": ..., "max": ...}`。修改定义的能力不会代替实际配置的声明，来源拥有的 Provider/Model 仍由目录维护。

人工编辑只修改当前记录的可变输入字段。保留稳定 ID、`runtimeModelId`、关联、来源身份、`revision`、`versionId`、`createdAt`、`updatedAt`、`credentialRef`、`historyScopeEpoch`、`restoreScopeId`、历史、删除账本和来源账本；不手工增加或改写版本。重新装配时，存储将当前记录与最新不可变历史比较，为合法修改自动生成新 revision、版本与时间，提供方地址或认证方式变化时更新 epoch。格式、身份或关联错误拒绝启动并保留文件，既有原生参数与能力不兼容时仍由 Models 协调服务拒绝执行。

保存文件后重新启动该执行设备的 Agent，或重启 harness server；浏览器刷新不重新读取配置文件，没有运行期文件监听器。已打开 execution 和 Session/Run 历史继续使用原快照，后续 execution 才使用新的配置。

## 原子保存、所有权与失败

`commit()` 校验并复制输入，在组件独占串行队列内构造候选完整状态。关联不可变、CAS、每个模型一套设置、来源目标守卫与删除提供方设置保留历史等约束和 SQLite 提供方一致。保存先写入并同步临时文件，再原子替换；替换是提交点，之后才发布内存状态。目录同步在平台支持时尽力完成，其失败不能把已经提交的凭据引用报告为未提交。

每次保存前核对文件内容摘要。组件运行期间外部修改文件会产生冲突，拒绝覆盖外部修改；应停止 Agent、完成修改后重新启动，而不是一边改文件一边在界面保存。初始化及保存故障没有内存后备，配置文件始终是持久权威。

所有权锁位于 `${path}.lock`，记录进程 PID 和本代 token。活进程持有的锁拒绝再次打开；只有确认原进程不存在才回收遗留锁，不能确认的旧锁拒绝自动移除。回收由 `${path}.lock.recovery` 互斥门保护；若在回收期间异常退出留下该门，应停机核实后显式移除，不能猜测并自动删除。锁及临时文件由本组件负责。Effect 关闭先停止新查询和提交，等待初始化、已接纳保存与文件操作退出，再释放本代锁；清理失败向宿主报告，不能提前释放依赖。

## SQLite 导入与兼容

已有 schema 1 或 2 JSON 在独占启动时原子升级到 schema 3。升级保留可执行模型 ID、定义版本、凭据引用和原生会话恢复身份。已移除的账户和模型设置版本保留在账本中。同一提供方仍有两条或以上旧连接记录时，升级报告冲突 ID，原文件保持原样。用上一版应用明确移除多余连接，再重新升级；原会话历史与原模型配置的不可变版本由上一版保留。

同一模型只有一套旧设置时直接沿用，包含已停用的模型。若同一模型有多套旧设置，迁移仅在其中恰好一套启用时采用该套参数，其余版本保留在历史中。若有多套启用或都停用，原文件保持原样。用上一版将希望保留的一套设为启用，再重新升级。原会话绑定已退休的 ID 时可继续查看历史，并可重新选模。

只有 JSON 不存在时才打开 `legacyPath` 读取旧 SQLite。导入使用相同的提供方唯一性检查，并保留原 SQLite。旧参数由纯转换器处理，未知扩展保留可读待迁移状态。已有 JSON 的 `formatVersion: 0` 参数在后续提供转换器时生成新配置版本，保留先前历史。升级和导入均沿用凭据引用，Key 值继续由 Vault 保存。

旧 SQLite 留存，成功创建 JSON 后不再作为当前运行数据源。已有 JSON 优先使用，格式损坏时报告错误，不退回旧库覆盖。升级前先停止旧宿主并备份旧库；回退旧代码需恢复相应备份，不能假定 JSON 后续修改会同步到旧 SQLite。

## 验证与关联文档

[json-storage.test.mjs](../../../packages/models/tests/json-storage.test.mjs) 验证原子提交、手工修改后版本生成、在途文件冲突、所有权与清理等待，以及旧 SQLite 的完整导入；[harness-server-models.test.mjs](../../../tests/harness-server-models.test.mjs) 验证宿主空配置启动、目录添加、已有 JSON 配置与凭据引用保留，以及不会重新补写旧引导的固定迁入连接或默认模型。根 `npm run check` 同时验证替换端口的 Models 和 Anybox Harness 行为。其他存储约束由 [SQLite 存储测试](store.md#验证与扩展)及 Models 协调层测试覆盖。

参见 [Models 协调服务](models.md)、[部署配置](../../harness-server-deployment.md#模型-json-配置)与 [Models 包使用说明](../../../packages/models/README.md)。
