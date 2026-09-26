# 本地 SQLite 存储组件

状态：提供方安装在应用唯一的 Nya 根上，Prompt、Agent Prompt、Projects 与 Run 状态组件各自登记表迁移；旧 JSON 读取逻辑仅供 Prompt 显式迁入。

## 公开接口

`src/storage/port.ts` 定义项目自有的 `LocalStoragePort`，并以 `localStorageServiceKey` 供 Nya 消费组件注入。消费者拿到 `read(work, signal?)`、`transaction(work, signal?)` 和 `migrate(domain, migrations)`：回调中的 `StorageReader` 提供参数化 `get`、`all`，`StorageTransaction` 额外提供 `execute`。一笔事务可同时修改不同领域的表；返回或异步完成后，回调中的操作句柄失效。SQL 文本由可信的领域实现提供，值通过参数绑定传入；不能把外部输入当 SQL 文本拼接。

回调可异步执行，同一连接上的操作按接受顺序串行运行。事务回调抛错、拒绝或在提交前收到 `AbortSignal`，均执行回滚。取消不会假装异步回调已经退出：回调须自行响应信号，关闭会等待它实际结束。`read` 期间连接开启 SQLite 的只读模式，回调结束后恢复。驱动对象、驱动错误和连接生命周期留在 `src/storage/sqlite.ts` 内；占用、关闭、迁移和 SQL 失败由项目自有的 `LocalStorageError.code` 标识。业务回调主动抛出的错误在回滚成功后原样返回。

## 初始化、迁移与所有权

`createLocalSqliteComponent(file)` 返回一个 Nya 组件，由应用安装在唯一的根 Context 上。`apply` 中规范化路径，创建父目录，独占同路径的 `.lock` 目录，打开一个 SQLite 连接，初始化提供方自己的布局，然后提供服务。`harness.close()` 卸载根上的全部组件，因此也等待 SQLite 操作结束、关闭连接并释放锁。提供方只用 `PRAGMA user_version` 标记布局版本，并在 `schema_migrations(domain, version)` 表中记录各领域已应用的迁移版本；无法识别的已有数据库拒绝启动。

表结构由领域所有者定义。领域组件在 `apply` 中调用 `migrate(domain, migrations)`，版本在该领域内从 1 连续编号；不同领域互不占用版本号，存储组件和组合根都不需要知道领域表。迁移与其他操作在同一队列中串行执行；每个迁移及其版本记录处于同一事务，失败回滚并使调用方的启动失败，已提交的其他领域不受影响。领域记录的版本高于当前迁移列表时拒绝，以免旧代码误读新结构。跨领域的先后依赖由 Nya `inject` 保证，例如 Agent Prompt 依赖 Prompt，因此在 Prompt 迁移与导入完成后才建立绑定表。

锁由 Effect 持有。第二个提供方占用同一数据库文件时启动失败，错误码为 `occupied`。关闭时先拒绝新操作，等待所有已接受的读、事务与迁移结束，再关闭连接并释放锁。应用根卸载时，Nya 先撤回存储服务并等待消费组件退出，再执行上述清理。异常退出后若遗留 `.lock`，须在确认原进程已退出后手动清理。数据库文件和目录不会在正常卸载时删除。

## 当前领域

Prompt 领域（`prompt`）持有文档、版本和旧 JSON 导入记录表；Agent Prompt 领域（`agent-prompt`）持有绑定表和自己的导入记录。绑定写入先提交 SQLite 事务，再更新该投影；两类写入成功返回时均已提交。可选的旧 JSON 导入由两个组件各自在一个事务内完成并记录来源：Prompt 先导入文档与版本，Agent Prompt 随后导入绑定并校验所引用的版本。若后者失败，重启时只补做未完成的一方，不会重复导入。

Projects 领域（`projects`）登记规范化目录身份表；Run 状态领域（`run-state`）登记 Session 元数据、完整轮次节点、Run、幂等键、Prompt 内容与模型可见配置快照。各领域共用同一数据库。状态组件在一笔事务内接受 Run，并在另一笔事务内同时提交成功终态、结果节点、Run 结果节点引用、执行阶段与终态事件。启动时在事务中把遗留的 `running`、`cancelling` 结算为 `interrupted`；旧调用计划不会重放。Prompt 和 Agent Prompt 仍保留各自的已提交读投影，新 Run 在接受前解析全局绑定，状态事务内重新校验幂等键、同 Session 父节点与完整祖先链；不再限制同会话或同父节点活动 Run 的数量。数据库连接上的短事务串行不等于整个 Run 串行。


`run-state` v3 将 `turns_json` 数组按原始索引迁为单链，生成带 Session/数组索引的确定性 `legacy:` 节点 ID，`sourceRunId` 留空。所有旧 Run 的起点标记为 `legacy-unknown`，保留输入、输出、失败、配置快照及事件，不按时间或内容猜关联。v3 迁移及版本记录原子提交，格式错误使整个 v3 回滚；迁移后删除 `turns_json` 列，只保留迁移读取代码。再执行正常的活动 Run 中断恢复，不自动重放。

`UNIQUE(session_id, idempotency_key)` 保证请求身份；节点的非空 `source_run_id` 唯一。父节点与来源 Run 使用同 Session 复合外键，Run 起点和结果引用通过触发器校验归属。节点不可更新或删除，Run 起点不可改写；节点插入与成功 Run 的父节点、输入、输出必须一致。节点分页用稳定的插入序号游标，只决定列表顺序，不决定祖先关系。

部署前先停止旧应用、确认排他所有权并备份数据库，再启动新版本执行迁移。异常退出的 `.lock` 不能在旧进程仍持有资源时删除。实际数据库不由测试修改；旧格式样本与回滚验证见 `tests/conversation-migration.test.mjs`。
