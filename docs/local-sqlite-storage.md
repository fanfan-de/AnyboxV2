# 本地 SQLite 存储组件

状态：基础提供方已实现，安装在应用唯一的 Nya 根上，Prompt 与 Agent Prompt 组件各自登记表迁移。Session/Run 仍使用内存状态；旧 JSON 读取逻辑仅供显式迁入。

## 公开接口

`src/storage/port.ts` 定义项目自有的 `LocalStoragePort`，并以 `localStorageServiceKey` 供 Nya 消费组件注入。消费者拿到 `read(work, signal?)`、`transaction(work, signal?)` 和 `migrate(domain, migrations)`：回调中的 `StorageReader` 提供参数化 `get`、`all`，`StorageTransaction` 额外提供 `execute`。一笔事务可同时修改不同领域的表；返回或异步完成后，回调中的操作句柄失效。SQL 文本由可信的领域实现提供，值通过参数绑定传入；不能把外部输入当 SQL 文本拼接。

回调可异步执行，同一连接上的操作按接受顺序串行运行。事务回调抛错、拒绝或在提交前收到 `AbortSignal`，均执行回滚。取消不会假装异步回调已经退出：回调须自行响应信号，关闭会等待它实际结束。`read` 期间连接开启 SQLite 的只读模式，回调结束后恢复。驱动对象、驱动错误和连接生命周期留在 `src/storage/sqlite.ts` 内；占用、关闭、迁移和 SQL 失败由项目自有的 `LocalStorageError.code` 标识。业务回调主动抛出的错误在回滚成功后原样返回。

## 初始化、迁移与所有权

`createLocalSqliteComponent(file)` 返回一个 Nya 组件，由应用安装在唯一的根 Context 上。`apply` 中规范化路径，创建父目录，独占同路径的 `.lock` 目录，打开一个 SQLite 连接，初始化提供方自己的布局，然后提供服务。`harness.close()` 卸载根上的全部组件，因此也等待 SQLite 操作结束、关闭连接并释放锁。提供方只用 `PRAGMA user_version` 标记布局版本，并在 `schema_migrations(domain, version)` 表中记录各领域已应用的迁移版本；无法识别的已有数据库拒绝启动。

表结构由领域所有者定义。领域组件在 `apply` 中调用 `migrate(domain, migrations)`，版本在该领域内从 1 连续编号；不同领域互不占用版本号，存储组件和组合根都不需要知道领域表。迁移与其他操作在同一队列中串行执行；每个迁移及其版本记录处于同一事务，失败回滚并使调用方的启动失败，已提交的其他领域不受影响。领域记录的版本高于当前迁移列表时拒绝，以免旧代码误读新结构。跨领域的先后依赖由 Nya `inject` 保证，例如 Agent Prompt 依赖 Prompt，因此在 Prompt 迁移与导入完成后才建立绑定表。

锁由 Effect 持有。第二个提供方占用同一数据库文件时启动失败，错误码为 `occupied`。关闭时先拒绝新操作，等待所有已接受的读、事务与迁移结束，再关闭连接并释放锁。应用根卸载时，Nya 先撤回存储服务并等待消费组件退出，再执行上述清理。异常退出后若遗留 `.lock`，须在确认原进程已退出后手动清理。数据库文件和目录不会在正常卸载时删除。

## 后续接入

Prompt 领域（`prompt`）持有文档、版本和旧 JSON 导入记录表；Agent Prompt 领域（`agent-prompt`）持有绑定表和自己的导入记录。绑定写入先提交 SQLite 事务，再更新该投影；两类写入成功返回时均已提交。可选的旧 JSON 导入由两个组件各自在一个事务内完成并记录来源：Prompt 先导入文档与版本，Agent Prompt 随后导入绑定并校验所引用的版本。若后者失败，重启时只补做未完成的一方，不会重复导入。

State 领域下一步可以 `run-state` 等领域名登记 Session、Run、幂等键及快照表与恢复规则。各领域共用同一数据库，需要时在同一 `transaction` 回调中共同提交。接入 State 时仍需专门处理异常退出的在途 Run：明确结算为 `interrupted`，不能自动重放外部副作用。届时也应重新评估当前 Prompt 读缓存与 Run 接受的共同事务边界。
