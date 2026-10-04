# Project Files 组件

[项目与会话模块](README.md) · [跨组件设计](../../project-file-references-design.md)

## 工厂、服务与依赖

`createProjectFilesComponent({ now?, newId?, collectionIntervalMs?, treeBrowser? })` 创建根上的 `harness-project-files`，提供 `harness.project-files: ProjectFilesPort`。组件注入 `local-storage` 和 `harness.projects`，从本轮 deps 使用服务；harness server 在 Projects 之后安装，Session 依赖它。没有项目 Context、额外 SQLite 连接、文件目录或工具注册。

源码：[组件](../../../src/applications/harness/core/project-files/component.ts)、[端口](../../../src/applications/harness/core/project-files/port.ts)、[文件系统提供方](../../../src/applications/harness/core/project-files/filesystem.ts)、[纯规则与浏览器共享类型](../../../src/applications/harness/core/project-files/domain.ts)。文件系统提供方、内部树浏览器和规则不是独立组件。树浏览器由该组件独占，`treeBrowser` 仅提供受控测试的目录访问及时间替身。

## 功能与边界

服务搜索当前项目的普通文件并读取 UTF-8 文本，支持整文件和闭区间行范围。候选包含点文件及被 `.gitignore` 忽略的文件；不解释 ignore 规则，不依赖 Git/ripgrep。目录排除 `.git/.hg/.svn/node_modules/.pnpm-store/.venv/venv` 和 `.yarn/cache/.yarn/unplugged`。路径必须为项目内规范相对路径，拒绝符号链接、绝对路径、越界和控制字符；搜索不能作为直接引用校验的替代。

源文件最多 10 MiB，选定内容每个最多 64 KiB，每轮最多 8 个且合计 256 KiB，编码资料最多 1 MiB。仅接受严格 UTF-8，拒绝 NUL 及非文本控制字符；保留 BOM 和换行，空文件合法。范围从 1 开始，包含首尾；末尾换行不产生虚构空行。预览超限时明确标记 `canReference:false`，有界预览不作为发送内容。超过源文件上限不能通过范围绕过。

文件句柄读取前后检查 dev/ino/size/mtime/ctime，复核路径及符号链接；发生变化报 `file-changed`。这是普通本机文件引用的校验，不是面对敌对进程的文件系统沙箱，也不提供跨文件原子仓库快照。Bash 权限语义不受影响。

搜索匹配路径和文件名，按文件名精确、文件名前缀、路径包含及路径字典序排序。单次扫描最多 20,000 项、时间预算 2 秒、返回 50 项；达到限制或部分目录不可读时返回 `incomplete:true`。正在等待的文件系统调用仍须实际退出，预算不代表能强制终止系统 I/O。

## 接口

| 方法 | 行为 |
| --- | --- |
| `openTree(scopeId, projectId, path, owner, signal?)` | 返回第一页；根路径为空，游标绑定 Session、项目及 HTTP actor |
| `readTreePage(scopeId, owner, cursorId, page, signal?)` | 返回当前层下一页，拒绝错序、其他作用域及过期游标 |
| `closeTree(scopeId, owner, cursorId)` | 幂等关闭，取消并等待页操作与句柄实际退出 |
| `onTreeRetired(listener)` | 通知 HTTP 释放游标观察租约；不是持久事实 |
| `search(projectId, query, signal?)` | 返回 `OwnedCall<FileSearch>`，只有相对路径及 incomplete |
| `preview(projectId, selection, signal?)` | 返回当前文件有界预览、实际范围、总行数和是否可引用；不持久化 |
| `prepare(scopeId, projectId, key, selections, signal?)` | 对项目路径读取当前内容，对 snapshot 选择复用原内容；全批校验后原子保存，返回有序 FileRef |
| `read(scopeId, ids, signal?)` | 返回有界内容副本；复核作用域、期限、字节数和 SHA-256，不回源文件补取 |
| `renew(scopeId, ids)` | 未过期草稿续至当前时刻后 24 小时；已保留引用没有有效期；不复活过期内容 |
| `retainIn(tx, scopeId, ownerKey, refs)` | 在调用方同一个业务库事务中同步验证引用并保存永久凭证；不得另开事务或执行文件 I/O |

Session 传入经验证的 sessionId 作为 scopeId，ownerKey 对本组件不透明。FileRef 保存 snapshotId、projectId、相对 path、可选 range、actualRange、byteLength、sha256、createdAt 和草稿 expiresAt。正文只经受管 read 获取，不向浏览器提供源绝对路径。服务名与随机 ID 本身不是权限边界。

会话归档限制由 Session 包装入口负责：归档后拒绝新的 prepare，历史快照读取和草稿续期继续可用；已开始的准备按原生命周期完成或取消。Project Files 不读取 archivedAt，也不复制会话状态机。

Session 允许旧 `dialogue-v1` 和归档会话浏览目录、搜索及预览当前项目文件。这些读取不解释旧历史、不保存引用；旧会话仍不能准备文件快照或继续执行。快照与图片读取保留原生会话边界。

## 持久归属、幂等与回收

组件在 apply 登记 `project-files` v1，拥有 `harness_file_snapshots`、`harness_file_retentions` 和 `harness_file_preparations`。字节为业务库 BLOB，快照元数据不变。Session 只拥有 Run 引用和顺序，不能直接写这些表。

准备批次按 scopeId/key 唯一，指纹包含项目和有序选择。同键请求串行等待前次退出；提交后重试返回原批次，同键不同内容报冲突。失败批次不留下部分快照。快照被回收后仍保留批次行作为轻量墓碑，旧键报过期，不能悄悄重新读取源文件。

接受 Run 时 Session 调用 retainIn，与图片保留和 Run 注册一起提交或回滚。已接受 Run 不论成功、失败、取消或 interrupted 都保留附件；永久引用目前没有删除接口。未保留快照 24 小时过期，启动及默认每小时清理；Web 每 5 分钟续期活动草稿和待提交内容。回收与保留使用同一数据库事务队列；读取在库的读取回调内复制字节，离开后不再依赖表行。

## 执行、取消和退出

目录树打开/翻页和文件搜索/预览/准备/读取返回 OwnedCall。目录树采用按层分页：每页 100 项、扫描 1,000 项或 200ms，最多 16 个存活游标、空闲 60 秒回收。树只公开相对路径，包括隐藏和 ignore 文件，沿用排除及无符号链接规则；不借用 Projects 的全盘目录选择器。游标由内部树提供方拥有，结束、取消、关闭或过期均等待句柄关闭；关闭失败停止树浏览准入并使组件清理失败。

树扫描与文件搜索、预览、准备读取共享并发 2 队列；排队取消不能提前占用或释放在途槽位。文件读取的 result 等待文件句柄关闭后才结算，done 表示实际退出。目录页 result/done 等待本页操作退出；有 nextPage 时保留游标句柄，结束、取消或 closeTree 才等待其退休。闲置游标关闭不占扫描槽位。关闭失败拒绝相应 done 或 closeTree，并使组件清理失败。

Effect 停止新调用和计时器，取消全部受管调用，等待树游标退休、文件读取、已开始提交及回收实际退出。组件 apply 在迁移和首次回收后返回，长期计时器不阻塞启动。Session/Run 消费者由 Nya 先退出，最后才释放 Projects 与业务存储。

失败使用 `ProjectFileError` 固定 code：invalid、missing、unavailable、unsupported、too-large、range-invalid、changed、expired、corrupt、cancelled、cleanup-failed、preparation-conflict、tree-busy、tree-expired、tree-conflict，均加 `file-` 前缀。准备失败可携带安全的 fileIndex 标识附件位置；系统路径及底层错误不向 HTTP 暴露。

## 验证

[组件行为测试](../../../tests/project-files.test.mjs) 覆盖路径、UTF-8、大小与行范围、原子批次、重启重试、保留回滚、过期墓碑、损坏、取消及实际关闭。[目录树行为测试](../../../tests/project-file-tree.test.mjs) 覆盖分页、作用域、预算、过期与实际退出，[目录树 HTTP 测试](../../../tests/project-file-tree-http.test.mjs) 覆盖认证撤销等待、代绑定与清理租约。[协议测试](../../../tests/native-protocol-agents.test.mjs) 覆盖四种协议、分支与重启，[浏览器控制器测试](../../../tests/session-client.test.mjs) 覆盖提交恢复，[HTTP 测试](../../../tests/harness-server-http.test.mjs) 验证宿主边界。完整入口 `npm run check`。
