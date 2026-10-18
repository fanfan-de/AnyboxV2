# 安装事实与操作账本组件

[包管理模块](README.md) · [应用包设计](../../application-packages-design.md)

## 工厂、服务与依赖

实现位于 [package-management/](../../../packages/host/src/package-management/)。`createPackageRegistryComponent({ directory, now?, id? })` 创建 `host-package-registry`，注入 `host.package-registry-storage: LocalStoragePort`，提供 `host.package-registry: PackageRegistryPort`。`now` 和 `id` 是测试可替换的时间及 ID 来源。根控制面每次通过 `root.get()` 获取当前服务，不跨组件重启保存旧门面。

包管理是独立的资源所有者；它不注入 Products、Models、Session、Run、Computer 或应用连接服务，不读取应用业务表，也不执行业务数据迁移。后台打开目标仍由 Products 持有；包快照中的 `desiredEnabled` 是所选入口的目标记录，不能反推文件是否安装。纯界面入口省略后台目标。

## 配置与资源归属

通用 `createClientHost` 仅在配置 `packageDirectory` 时安装注册库。组合入口的客户端默认使用 `${clientDatabase}.applications`，可由 `ANYBOX_APPLICATION_DIRECTORY` 覆盖；桌面客户端使用 `<userData>/applications`。执行宿主不自动取得包管理写入所有权。

```text
<packageDirectory>/
  registry.sqlite
  usage-locks/<usageId>.sqlite
```

注册库由同根的通用 SQLite 组件以 `host.package-registry-storage` 服务名提供；默认 `local-storage` 连接继续管理既有宿主目标及应用数据。两者的队列、领域迁移和文件锁独立，注册库不得与控制库使用同一个真实文件或文件别名。连接、排他锁与实际关闭由 [Local SQLite](../infrastructure/local-sqlite.md) 所有，包管理组件只拥有自身表与迁移。

工厂在依赖就绪后固定目录的真实路径。Unix 装配时通过 Effect 持有原根的 O_NOFOLLOW/O_DIRECTORY 目录句柄及 dev/ino 身份，回收准入和进入文件回调前同时复核原真实路径与持有句柄；路径被重命名、替换或改成别名均拒绝 reclamation-root-changed，不让 fresh realpath 重新授权另一个删除根。Effect 在受控工作取消并实际退出后关闭句柄，启动失败也清理已打开句柄。Windows 当前不取得该目录 fd，安装和账本仍可用，破坏性回收固定拒绝 reclamation-root-unavailable；不扩大跨平台验收。后续修改配置对象或改变工作目录不会把退出证明切换到另一个锁目录。

组件拥有 `host-package-registry` v4 迁移域。v1 的 `package_registry_meta`、`package_registry_applications`、`package_registry_operations`、`package_registry_snapshots` 和 `package_registry_usages` 原地保留，v2 增加 `package_registry_file_installs`，v3 增加 `package_registry_activations`，v4 不加新表，规范旧生效 JSON 的 kind 为 activate、ownedUsageIds 为 []，读取仍兼容旧缺省字段。注册库发现其他领域迁移时拒绝装配，避免误用已有业务文件；持久 JSON 在每次读取时重新验证身份、状态、引用和修订，损坏时拒绝继续写入。

一个安装根只允许一个注册库写入所有者。SQLite 连接在整个生命周期持有操作系统排他锁，第二个进程不能另开注册库写入。管理者异常退出后由操作系统释放锁；不依赖 PID、超时或删除锁文件抢占。

`usage-locks` 是独立于将来载荷目录的锁锚点，不能随应用版本删除。每个凭证有自己的锚点；判断某个包版本是否可回收时必须核对包含它的全部快照和使用记录，不能只看 Products 状态或一个进程。凭证秘密只返回给受信角色启动器一次，注册库及锁锚点只保存 SHA-256 摘要。它不是应用业务 Key，也不进入浏览器 DTO。

新建使用锚采用独立的 SQLite 格式 v2，在初始事务内以十进制文本保存原文件 dev/ino。创建只接受本次独占创建的空文件；重复 prepare、SHARED 获取、EXCLUSIVE 退出证明和撤销写入均复核原物理身份，并拒绝符号链接、多硬链接和符号链接形式的 `usage-locks` 目录。重命名后复制回原路径即使字节完全相同也不能取得退出证明；同样适用于安装工作锚和已记为 exited 的历史锚。校验不通过额外打开再关闭原始文件描述符，避免 POSIX 关闭同文件 fd 意外释放其他 SQLite 连接的锁。

注册库 v4 迁移域保持不变；锚格式 v1 缺少原物理身份，不能从当前路径补写为 v2。旧锚、缺失锚及身份变化均保持 unavailable，不自动重建、升级或删除，相关使用和回收意图继续保留。最小受管宿主遇到这类使用时转入空管理客户端，仍可查询原安装和恢复事实，但不会重新导入应用或伪造旧使用 exited。仅重启管理者不能补齐缺失的原始退出证据；修复前升级应保留现场，不将复制备份当作原锚。

## 安装、选择与运行事实

`PackageIdentity` 固定应用 ID、完整 SemVer 版本、小写 SHA-256 内容摘要和目标操作系统/架构。同版本不同摘要不是同一份代码；身份键使用规范化字段顺序，不受对象属性顺序影响。

| 记录 | 表达的事实 |
| --- | --- |
| `installed` | 已登记的确切版本及来源、发布者、登记时间、所属操作；状态包括 installed、quarantined、reclaiming、removed |
| `selected` | 管理者已经选定的版本 |
| `pending` | 已准备但尚未完成生效协调的版本 |
| `PackageCatalogSnapshot` | 某角色固定的应用入口、能力版本及其包身份，附带注册库修订、所有者 epoch 和撤销状态 |
| `actual` | 曾报告就绪且尚未确认退出的角色使用记录及其确切快照；claimed 尚未就绪不伪装为 actual |
| `PackageOperation` | 独立的包操作意图、修订、阶段、回执和恢复原因 |
| `PackageActivation` | activate/remove 批次的目标与原选定版本、精确角色计划、父子使用历史、修订、交接/就绪/恢复事实；详见[生效组件](activation.md) |
| `PackageFileInstall` | 接收字节前的目录/归档意图、来源形式及显式本地信任、可空可信身份、配对操作、任务修订及不可抹去的工作锚历史 |

旧安装、选定版本、待生效版本与某角色实际版本可以不同。安装登记不自动打开应用；选定或待生效也不代表当前进程已经导入新代码。角色名称区分 client、execution、computer-worker、web；共享能力同样固定版本，随包提供的能力还固定所属包身份。

## 幂等、CAS 与恢复

`begin` 接受 `requestId`、操作种类 install/activate/remove、确切身份与预期应用修订，返回耐久 `operationId`。同一请求 ID 的相同意图查回原操作；不同意图返回 request-conflict。已接受的操作不会因调用方重试而再次接受外部副作用。

`advance` 只按允许的状态边更新操作，要求预期操作修订；`recordInstalled` 和 `select` 同时核对操作与应用事实修订。修订不符返回 revision-conflict，事务不部分提交。回执是大小、深度及 JSON 值受限的非秘密数据，不接受函数、访问器或驱动句柄。

`recordInstalled` 是供受信安装适配器提交已验证事实的内部端口，自己不读取来源、不计算载荷摘要，也不导入应用代码。D1.3 的[本地安装组件](installation.md)在发布者签名或显式本地目录信任、准备与不可变目录复核后调用该端口；配对文件任务 installed、安装事实及操作 awaiting-activation 同事务提交。来源 `source.kind: 'directory'` 固定目录导入，归档仍为 `file`；直接调用账本端口不能代替内容与文件验证。

所有者重启后以新 epoch 接管账本；未完成操作保留原意图和原阶段，进入 recovery-required。`reconcile` 要求显式恢复回执及预期修订，只接纳管理者核对出的阶段。组件不会自动重放未知文件操作，不通过删除记录假装回到未安装；终态与已有安装事实继续保留。

`acceptFileInstall` 在任何受管字节读取前持久保存显示名称、原始摘要、大小、`sourceFormat: 'archive' | 'directory'` 与 `localTrust`，不为未验证包猜测 appId。旧记录和缺省输入归一为 `archive`、false，不因新版本读取自动取得本地信任；本地信任仅允许目录来源。相同 requestId 的完整输入必须一致，包括来源与信任模式；`bindFileInstall` 在静态验证后绑定身份及应用级操作，并在独立准备前核对应用修订及同应用串行所有权。任务写入使用独立修订 CAS；`advanceFileInstall` 与 `reconcileFileInstall` 对新配对操作原子推进相应阶段。重复导入相同已安装身份保留原安装记录，仍须由安装器复核真实目录。

每次工作在副作用前通过同阶段 CAS 追加 `workGuardId` 到只增的 `workGuardIds`；替换回执、失败或恢复记录都不删除历史锚。准备子进程实际持锁，新管理者必须通过安装器证明并永久栅栏全部旧锚后才能恢复或清理。非终态任务接管后进入 recovery-required；installed 文件任务保留终态，安装操作的后续生效恢复独立记录。完整流程见[本地安装手册](installation.md)。

## 快照、使用凭证与连续交接

`prepareUse` 在预期注册库修订下创建确切快照和 reserved 使用记录。应用入口必须引用已选定且仍 installed 的包；外部能力提供方必须引用仍 installed 的确切包。`claim` 再核对快照未撤销，注册库修订和所有者 epoch 仍匹配；旧选择不得新启动，快照不跟随可变 current 链接。使用者在导入任何包代码之前，先调用 `acquirePackageUsageLock(directory, credential)` 持有实际 SHARED 锁，再通过 `claim` 核对凭证和快照，进入 claimed；入口真正就绪后才调用 `ready` 登记 actual。已经 claim 的旧代就绪回执仍记录其确切实际版本，不能因为后来选择改变而把真实运行隐去。

角色必须在代码、界面、原生模块及其后台资源的整个使用期间持有锁。SHARED 锁通过独立 SQLite DELETE rollback-journal 读事务实现，由实际连接持有；WAL 或内存状态不能代替这个退出证明。锁释放的 Promise 只有在连接和操作系统锁实际退出后才完成。

`prepareHandoff` 先耐久创建子使用记录和锁锚点，再允许旧使用者结束。父进程持有期间由实际锁保护，子进程尚未 claim 的交接窗口由 durable reserved 记录阻止回收，不留下无人登记的空窗。受信启动器仍须在子进程导入前取得其实际锁并 claim；凭证不等于就绪。子进程独立持有自己的连接，管理者重启不会释放它；新管理者只能查回原事实，不能启动第二个所有者补齐未知就绪。

`revokeSnapshot` 使用快照修订栅栏禁止新的 claim；撤销不会证明已有代码或资源已经退出，也不会提前释放其归属。快照秘密通过常量时间摘要比较认证，不通过持久化明文恢复。

## D1.4 批次与角色接管

`prepareActivation` 在请求幂等及预期修订下保存 kind（旧记录读取为 activate）和目标、原 selected、全部精确角色计划和 superseded usage 历史，以及受信管理者本代 ownedUsageIds，后者也用于证明新计划省略的旧 execution 等角色实际退出。受信管理者通过私有 `ownedUsageIds` 证明它实际拥有的角色，reserved/claimed 也属于使用者，不能只检查 actual ready；未由本管理者拥有且尚未证明退出的独立使用会阻止生效。

`commitActivation` 保存 selected 和父 reservation；remove 会清 selected/pending、取消未完成的旧安装操作，并让 remove 操作进入 prepared；`adoptActivation` 在新写入者代次里保留父子关系并生成新的角色凭证，旧父锁必须在新 reservation 被实际持有后才释放。`recordActivationRoleReady` 核对实际 ready 使用属于精确角色计划，`completeActivation` 需要全部计划角色就绪及旧使用已退出，不用 ProductView 或选定指针替代证明。

`interruptActivation` 保留当前进度进入恢复。postcommit 的显式 `recoverActivation` 先要求旧使用全部 exited，再创建新的 handoff；不能让旧快照重新 claim 或重放未知启动。`validateUse` 只在私有受信角色启动请求中验证已 claimed/ready 的凭证，不推进 ready，也不要求全局 registryRevision 与旧快照仍相同；这不允许旧选择新启动。完整保护、文件加载和父进程交接见[生效组件](activation.md)。

## 退出证明与受控回收

`confirmExit` 先栅栏该使用记录，再取得对应锚点的 EXCLUSIVE 锁。活跃 SHARED 持有者会阻止 EXCLUSIVE；缺失、无法识别或不可访问的锚点是退出未知，不能当作没有使用者。取得 EXCLUSIVE 后先将凭证撤销事实持久写入锚点，再把注册库中的使用记为 exited，最后释放锁，避免旧凭证在两步提交之间重新进入。

超时、客户端断开、Products 已关闭、进程管理者尚未报告或凭证撤销本身都不是退出证明。无法确认退出时保留 exit-unconfirmed 及版本归属；系统服务和独立 worker 也属于实际使用者。

`withReclamation` 是受信本地适配器的受控回调。它先核对原包管理根的固定句柄和身份，再核对 remove 操作/应用修订，拒绝仍 selected/pending 或有未 exited 使用记录的版本，先提交 reclaiming 事实以阻止新使用，再逐个排他复核全部历史 usage 锚并持久撤销，之后才把私有 PackageReclamationRoot（directory/device/inode）传给受信文件回调；适配器与自己捕获的根逐项核对，该值不进入 HTTP。原根重新解析或回调自报路径不能替代原始锚。同一回调未退出前不能重复进入或被其他控制改写；interruptActivation 先检查全部 target 的在途回收，再原子改变批次和操作。锚的撤销提交会结束排他事务，后续由永久凭证栅栏和 reclaiming 事实共同保护。回调成功后登记 removed 并完成该操作；失败或结果未知时保留 reclaiming 与 recovery-required，不伪造回收成功。

如果外部效果已发生但完成和待恢复回执都无法持久化，关闭本代管理准入，保留失败并在根清理时报错，不能重试同一未知副作用。锚连接释放失败也保留错误并停止新控制。

组件不自行删除包目录，不删除业务库、系统凭据、项目、图片或远端数据。D1.5 的卸载协调复用生效批次 kind remove，targets 固定全部未 removed 身份，每个身份持有自己的 remove 操作；角色计划排除该 appId，commit 后清 selected/pending，不靠仍在运行的旧代码推断退出。角色全部 ready 后先进入 reclaiming，不能由 completeActivation 冒充卸载完成。

`reclamation.ts` 是新客户端调用的受信文件适配器，并非新 Nya 组件；它通过 withReclamation 回收固定身份容器，不访问业务目录。`completeRemoval` 要求每个目标 removed 且对应 remove 操作 completed 才结束批次，部分成功后保留其他版本的恢复进度。失败由 interruptActivation 保留原批次，显式 recoverActivation/resume 重新证明旧使用全部退出后继续；GET 不触发删除。用户 HTTP/CLI 管理入口及全页保护见[生效与卸载协调](activation.md)。

## 准入、取消与关闭

`closeAdmission` 立即阻止新包控制，`awaitIdle` 等待已接收的本地账本操作及受控回调实际退出。受控回调收到取消信号后必须停止自己的文件工作并等待实际退出；不能仅结束观察就报告完成。

Effect 停止准入、取消并排空本组件的在途工作，随后由 Nya 依赖顺序关闭注册库连接和释放写锁。不等待尚未接管的外部角色完成激活，也不等待一个必须先关闭自身根才能完成的重启过程。待交接和待恢复记录保留给新管理者。该关闭流程不取消应用业务或远端 Run。

## 错误、兼容与验证

端口只公开稳定 PackageRegistryFailure 错误码，包括 invalid-input、revision-conflict、request-conflict、operation-conflict、transition-invalid、snapshot-stale、snapshot-revoked、use-unavailable、use-lock-required、version-in-use、service-closing 和 registry-corrupt。锁辅助函数的 PackageUsageLockError 只描述 invalid、occupied、unauthorized、unavailable、release-failed，不把 SQLite 驱动错误作为宿主契约。

行为入口为 [package-domain.test.mjs](../../../packages/host/tests/package-domain.test.mjs)、[package-registry.test.mjs](../../../packages/host/tests/package-registry.test.mjs)、[package-registry-process.test.mjs](../../../packages/host/tests/package-registry-process.test.mjs)、[package-usage-locks.test.mjs](../../../packages/host/tests/package-usage-locks.test.mjs) 和 [package-registry-host.test.mjs](../../../packages/host/tests/package-registry-host.test.mjs)。覆盖纯函数校验、幂等/CAS、重启恢复、注册库接入、跨进程所有权、连续交接、快照失效、配置固定与未知退出；锁验证使用真实子进程及异常退出，另覆盖持锁期间复制替换、管理者重启后的原身份校验、历史 exited 锚回收拒绝、撤销前替换、链接别名和旧 v1 样本保持不变。统一验收入口为 `npm run check`。D1.1 的通过不代表签名产物、归档校验、本地安装、版本重启激活或卸载已经完成。

D1.4 的 [package-activation-ledger.test.mjs](../../../packages/host/tests/package-activation-ledger.test.mjs) 覆盖 v3 原地迁移、批次幂等/CAS、全角色计划、交接采用、实际 ready 和恢复栅栏。

D1.3 的 [package-install-ledger.test.mjs](../../../packages/host/tests/package-install-ledger.test.mjs) 另覆盖预身份接收、v1→v2 保留迁移、绑定与原子安装、锚历史、重复导入、应用修订及文件任务恢复；文件效果与准备进程的测试入口见[安装组件](installation.md#测试入口)。

另在真实 macOS Node 与 Electron utility process 间验证同一 usage 的占用：Node 子进程持锁时，Electron 管理者关闭重开后仍不能确认退出；实际释放并退出后才确认，旧凭证不可重新获取。范围与版本见[阶段记录](../../harness-server-plan.md#d11-安装事实与操作账本2026-10-17)，不扩大为签名成品或其他平台验收。
