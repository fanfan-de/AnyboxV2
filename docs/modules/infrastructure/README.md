# 基础设施模块

[返回模块导航](../README.md)

基础设施模块提供项目自有的通用存储端口与本地 SQLite 实现。当前只有一个实际 Nya 组件；没有为尚未实现的数据库或其他宿主预建组件。

| 组件 | Nya 名称 | 服务 | 职责 |
| --- | --- | --- | --- |
| [Local SQLite](local-sqlite.md) | `local-sqlite` | `local-storage` | 独占业务数据库连接、串行读写、事务及按领域登记迁移 |

[Session](../sessions/session.md)、[Projects](../sessions/projects.md)、[Prompts](../prompts/prompts.md) 和 [Agent Prompts](../prompts/agent-prompts.md) 通过 `LocalStoragePort` 使用此连接，各自持有领域表与迁移。通用存储只管理 `schema_migrations` 账本及其布局版本，不接收预先拼装的领域迁移列表，也不解释会话、模型或 Prompt 语义。

Models 的 JSON 配置文件与 SQLite 目录缓存由 [Models 模块](../models/README.md) 中的组件分别独占，不借用 `local-storage` 连接。JSON、旧配置导入源、目录缓存与业务库路径必须分离。系统凭据由 Models Vault 保管，不能以业务 SQLite 或 JSON 作为密钥后备。

全部组件安装在应用唯一 Nya 根 Context 上。资源关闭顺序由真实依赖和 Effect 决定；应用宿主 `close()` 是整根关闭入口，产品停用保留常驻业务库。具体业务存储逻辑、迁移兼容与领域恢复见各消费者文档。
