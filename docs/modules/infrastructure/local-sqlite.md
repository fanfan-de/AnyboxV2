# Local SQLite 组件

[基础设施模块](README.md) · [模块导航](../README.md)

## 职责与入口

Local SQLite 为业务领域提供独占的文件数据库，集中管理连接、操作准入、串行化、事务和关闭。数据库驱动类型不越过端口，领域表和迁移由调用组件声明。

| 项目 | 定义 |
| --- | --- |
| 实现 / 端口 | [sqlite.ts](../../../src/storage/sqlite.ts) / [port.ts](../../../src/storage/port.ts) |
| 工厂 | `createLocalSqliteComponent(file: string)` |
| Nya 名称 / 服务 | `local-sqlite` / `local-storage: LocalStoragePort` |
| `inject` | 无 |
| 驱动 | Node.js 内置 `node:sqlite` 的 `DatabaseSync`；项目要求 Node.js `>=22.13.0` |

## 配置与独占所有权

`file` 必须是非空文件路径，禁止 `:memory:`。组件解析绝对路径，按需创建父目录（创建时权限 `0700`）；既存文件用 realpath 规范化，新文件用真实父路径与 basename 组合。

组件在规范文件路径旁创建 `<path>.lock` 目录作为排他所有权标记。同一路径已被占用时返回 `occupied`。随后打开一个 SQLite 连接；初始化或后续组件启动失败时由 Nya 已登记的 Effect 负责释放资源。

锁目录不含自动租约续期或陈旧锁恢复逻辑，非正常进程退出后可能残留；不能在未确认原持有者已经退出时移除它。数据库文件、锁目录和连接归本组件，Session 等消费者不自行打开第二条业务连接。Models 配置和目录缓存使用独立组件与文件，见 [Models 模块](../models/README.md)。

## 公开存储接口

| 接口 | 行为 |
| --- | --- |
| `read(work, signal?)` | 串行运行同步或异步回调；期间开启 `PRAGMA query_only = ON`，结束恢复；返回回调结果 |
| `transaction(work, signal?)` | `BEGIN IMMEDIATE` 后运行同步或异步回调；成功提交，拒绝或取消回滚；可跨同一连接的多领域表 |
| `migrate(domain, migrations)` | 对指定领域按版本补齐迁移；每个迁移与账本版本单独事务提交 |

`StorageReader` 只有 `get(sql, values?)` 和 `all(sql, values?)`。`StorageTransaction` 额外提供 `execute(sql, values?)`，返回 `changes` 和 `lastInsertRowid`。参数与行值仅用 `string | number | bigint | Uint8Array | null`，不暴露驱动 statement 或 connection。

reader/transaction 仅在回调生命周期内有效，即使回调异步等待也保持本次操作的串行所有权；回调完成即失效。把它保存到闭包并在之后继续调用会得到 `closed`。单连接队列意味着长时间未结束的回调会阻塞后续操作，回调不应等待一个排在自己之后的同端口操作。

## 迁移与兼容规则

通用提供方使用 SQLite `user_version = 1` 表示自身布局，包含 `schema_migrations(domain PRIMARY KEY, version)`。全新空库从 0 初始化；非空且无法识别的布局拒绝启动，不尝试猜测迁移。

各领域调用 `migrate(domain, migrations)`：domain 非空，迁移版本必须从 1 连续递增，内部会先排序。`up(tx)` 必须同步；返回 Promise 的迁移被拒绝。每个迁移在 `BEGIN IMMEDIATE` 内修改领域结构/数据并更新该领域版本，然后提交。失败回滚本条迁移及版本，已经提交的更早版本保留。

不同领域的版本独立。数据库记录的领域版本高于应用提供的迁移数量时返回 `schema-version`，禁止用旧代码打开更新的领域结构。Session 的 `run-state` 账本、Prompt 和 Projects 表结构由各自组件解释，不写死在本组件工厂中。

当前附件同样复用本连接：[Image Assets](../images/image-assets.md) 登记 `image-assets` v1，保存图片元数据及保留凭证；[Project Files](../sessions/project-files.md) 登记 `project-files` v1，保存文本 BLOB、准备批次及保留凭证。[Session](../sessions/session.md) 的 `run-state` 当前为 v7，归档增加列和索引，不新建存储组件。接受 Run 时，同一事务调用两个资源组件的同步 retainIn，附件引用与 Run 一起提交或回滚；通用存储不解释这些领域规则。

## 准入、取消与关闭

所有操作共享 Promise 队列，失败不会让后续队列永久拒绝。`read` 和 `transaction` 在准入时、取得队列位置时、每次 SQL 调用前及回调结束后检查 `AbortSignal`。事务回调结束时才检测到取消也会回滚。

这是一种合作式取消：它不会强制打断已经开始的同步 SQLite 调用，也不会中断回调自行创建且不结束的 Promise。调用方须让自己的异步工作可退出。迁移没有独立 signal 参数。

三个 Effect 按资源顺序登记，清理时先禁止新操作并等待已接受队列尾完成，再关闭连接，最后移除锁目录。存储关闭不会丢弃已接受操作，也不会提前释放文件所有权；新操作以 `closed` 拒绝。领域消费者应先依 Nya 依赖顺序停止并退出自身操作。

## 错误与替换边界

`LocalStorageError` 使用稳定 `name` 与 `code`：`occupied`、`closed`、`open-failed`、`close-failed`、`operation-failed`、`migration-failed`、`schema-version`、`rollback-failed`。驱动错误归一化，不向业务层暴露数据库驱动类型；事务回调自身抛出的业务错误在回滚成功后仍原样返回。回滚本身失败则报告 `rollback-failed`。

其他提供方可实现 `LocalStoragePort` 并替换 `local-storage`，但必须保留串行读写、事务原子性、迁移账本、作用域失效与关闭等待行为。当前消费者使用 SQL，替换并不自动意味着能直接换成任意非 SQL 存储。

## 验证依据

- [local-sqlite.test.mjs](../../../tests/local-sqlite.test.mjs)：重启恢复、跨表事务、回滚后可用、独占连接、关闭等待、逐领域迁移与布局拒绝。
- [prompt-sqlite-storage.test.mjs](../../../tests/prompt-sqlite-storage.test.mjs)：Prompt 卸载等待已接受写入、关闭后拒绝新写入及重装恢复读取。
- [conversation-migration.test.mjs](../../../tests/conversation-migration.test.mjs)、[native-session.test.mjs](../../../tests/native-session.test.mjs)：Session 对旧数据读取及当前原生记录持久化的集成验证。

完整验收运行 `npm run check`。
