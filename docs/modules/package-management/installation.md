# 本地目录与文件安装组件

[包管理模块](README.md) · [安装账本](registry.md) · [归档与产物](archives.md) · [应用包设计](../../application-packages-design.md)

## 工厂、服务与依赖

[installer.ts](../../../packages/host/src/package-management/installer.ts) 的 `createPackageInstallerComponent(config)` 创建 `host-package-installer`，注入同一 Nya 根上的 `host.package-registry: PackageRegistryPort`，提供 `host.package-installer: PackageInstallerPort`。注册库继续独占自己的 SQL 连接；安装器不另建 Context，也不注入 Products、Models、Session、Run、Computer 或应用连接服务。

安装器负责接收应用包字节、验证、独立准备、暂存、不可变目录提交，以及安装与恢复回执。它不创建应用运行时，不设置后台打开目标，不迁移应用业务数据，也不访问应用凭据。安装成功记录 `installed` 与 `pending`，保留 `selected` 和角色实际版本；受控生效与正式角色加载由 [D1.4 生效组件](activation.md)处理，卸载与代码回收由 [D1.5 协调](activation.md#d15-本机卸载与代码回收)处理。

`config.directory` 是本机包管理根；`verification` 固定受信发布者、公钥授权、目标平台、API 版本及归档限额；`preparation` 配置独立注册准备进程的运行条件。配置在工厂入口捕获，文件提供方在装配时固定真实目录身份。`onBoundary` 是受信测试或诊断回调，没有可通过环境变量启用的故障注入开关。

安装输入支持应用文件夹与可选 `.anybox-app` ZIP。Agent 可以直接生成可运行目录，通过显式本地信任安装，无需签名或压缩，最小示例见[应用开发](../../application-development.md#agent-直接创建并安装应用文件夹)。目录在客户端读取并固定为无压缩内容快照，再复用同一安装、恢复、生效与卸载链路；宿主不会跟随可变源码目录。

发布者公钥和 appId 授权来自宿主配置的外部策略。上传文件不能自带公钥取得信任，示例策略也不会自动安装到信任列表。`sourceFormat: 'directory', localTrust: true` 表达用户对本次本地目录的显式信任，可省略发布签名，不能用于 ZIP 或下载绕过验签。独立准备沿用 D1.2 的纯 `createRegistration` 边界、公共依赖解析和运行条件；不调用应用的业务装配、数据库迁移或运行入口。

## 安装端口

| 方法 | 含义 |
| --- | --- |
| `accept(intent)` | 耐久接收请求 ID、显示名称、来源形式、显式本地信任、原始输入 SHA-256、长度及可选预期应用修订；此时身份为空，不读取上传流 |
| `receive(installId, source, { signal? })` | 消费已接收任务的受管字节流，验证并提交安装；同一任务不能并发执行 |
| `get` / `list` | 查询持久任务，不重放文件操作 |
| `cancel(installId)` | 取消本代在途操作并等待源、文件句柄与准备进程实际退出；未知提交转入恢复状态 |
| `recover(installId, { action })` | 默认只检查记录；显式 `resume` 或 `discard` 必须先证明旧工作退出 |
| `inspectOrphans()` | 列出没有对应任务的暂存目录名称；不自动删除未知目录 |
| `closeAdmission` / `awaitIdle` | 停止新请求、取消已接收工作，并等待本代资源实际退出 |

`receive` 接受 Node `Readable`，或 `{ chunks, cancel, done }` 受管来源。`cancel` 必须中断生产者，`done` 必须等待其真实退出，包括尚未完成的迭代读取。观察结束、请求断开或仅设置 AbortSignal 不构成源退出证明。

界面和 HTTP 控制面只调用生命周期管理端口。Web 上传用户选择的文件字节或目录快照，不接受服务端磁盘路径、任意 URL、执行命令或应用业务参数。签名来源须通过发布者校验；显式本地信任目录仍须通过清单、完整文件索引、目标和资源闭包校验。用户提供的名称和传输摘要仅是接收意图与完整性约束。

## 本机管理入口与 CLI

客户端 `/api/client/v1/app-packages` 在已有宿主 transport、Host 和 Origin 检查之后处理请求；它不位于应用路由，不通过远端 Computer 单元认证开放。

| 请求 | 作用 |
| --- | --- |
| `GET /api/client/v1/app-packages` | 安装器可用性、受信发布者数量、安装事实与文件任务；可用 `requestId` 查询已经接受的任务 |
| `POST /api/client/v1/app-packages/operations` | 接收 `{ requestId, filename, archiveDigest, archiveSize, sourceFormat?, localTrust?, expectedAppRevision? }`，返回耐久任务；来源缺省 `archive`，本地信任缺省 false |
| `GET /api/client/v1/app-packages/operations/:id` | 查询单个文件任务 |
| `PUT /api/client/v1/app-packages/operations/:id/archive` | `application/octet-stream` 原始字节；大小与已接受意图一致，不接受压缩传输编码 |
| `POST /api/client/v1/app-packages/operations/:id/cancel` | 空对象，取消并等待实际退出 |
| `POST /api/client/v1/app-packages/operations/:id/recover` | `{ action: 'inspect' | 'resume' | 'discard' }`，显式恢复控制 |

响应只投影阶段、来源、显式本地信任、修订、身份、时间及规范化错误码，不返回内部回执、绝对路径、工作锚、准备进程输出或秘密。`ANYBOX_APPLICATION_TRUST` 指向启动器读取的外部发布者信任策略文件；未配置时默认无可信发布者。本地目录授权只固定到本次任务，不向全局发布者策略添加任何公钥。

离线 CLI 在没有现有管理者持有注册库时使用同一根和同一文件安装端口：

```text
anybox-host install <folder> --directory <root> --trust-local --request-id <id>
anybox-host install <folder> --endpoint http://127.0.0.1:3000 --trust-local --request-id <id>
anybox-host install <signed-folder|file> --directory <root> --trust <policy> --request-id <id>
anybox-host installations --directory <root>
anybox-host operations --directory <root>
anybox-host cancel <id> --directory <root>
anybox-host recover <id> --action inspect|resume|discard --directory <root> [--trust <policy>]
```

resume 重用任务已持久保存的本地信任；其他签名来源仍须明确提供发布者策略，不能在恢复时把未知旧任务改为受信目录。inspect/discard 不临时授信。CLI 自动识别目录或文件，不执行 npm、编译或包内脚本，不建立业务或 HTTP 监听，不能抢占运行中客户端的注册库；占用时停止该命令并引导使用现有管理入口。`anybox-host verify <folder> --trust-local` 与签名验证命令仍是独立只读工具，不登记安装。

在线目录安装使用 `--endpoint` 指定明确的 HTTP 回环 origin，与 `--directory` 互斥。CLI 在本机读取并快照目录，POST 意图后经原字节端口 PUT；服务端不接受文件系统路径，发布者信任仍由服务端外部策略持有。请求结果不明时仅查询原 requestId 或任务，不自动重放未知 POST/PUT。安装成功后仍需独立 apply，且遵守全部角色与页面保护；Agent 在自身忙碌期间生成应用不意味着允许提前切换该角色。

## 账本与阶段

注册库迁移域 `host-package-registry` v2 新增 `package_registry_file_installs`，原 v1 的安装、操作、快照、使用凭证及 owner epoch 原地保留。文件任务独立于已经具备可信身份的 `PackageOperation`。

| 阶段 | 耐久含义 |
| --- | --- |
| `accepted` | 只接受意图；`identity` 和 `operationId` 为 null |
| `receiving` | 接收字节，尚未确认完整原始归档 |
| `verifying` | 完整原始字节已保存；静态验证通过后绑定身份，创建应用级 preparing 操作，再进入独立注册准备 |
| `prepared` | 独立准备成功；新建配对操作同事务进入 prepared |
| `committing` | 提交不可变目录的意图已耐久保存；未知结果不能直接记为失败或取消 |
| `installed` | 版本目录复核成功；文件任务、安装事实及 awaiting-activation 操作同事务提交 |
| `failed` / `cancelled` | 提交前失败或取消，且任务资源和私有暂存清理已确认 |
| `recovery-required` | 原阶段与现场保留，需显式核对，不能自动重复副作用 |

同一 `requestId` 必须对应同一名称、摘要、长度、来源形式、本地信任及预期应用修订；重复接收返回原任务。旧任务缺省归档来源且无本地信任。不同意图冲突，重试不能重新消费上传流。每次写入要求任务修订 CAS；身份绑定后才检查应用修订，并在独立准备前取得同应用包操作的串行所有权，不阻塞其他应用的准备。

`bindFileInstall` 保持文件任务 verifying，同时原子创建 preparing 安装操作。`advanceFileInstall` 推进新操作的 prepared/committing；`recordInstalled` 把文件任务 installed、安装事实及操作 awaiting-activation 放在一个事务中。控制面不能用直接改阶段代替这些事实。回执是限大小、限深度的非秘密 JSON，错误只记录规范化错误码。

重复导入已经安装的相同身份仍须验证新输入和既有版本目录。任务的 `existingInstallation` 明确表示复用既有安装；复核成功后结束该导入任务，不改原安装来源、指针或运行目标。同应用版本、平台、架构对应不同内容摘要时拒绝覆盖。

管理者重启后，非终态文件任务保存原阶段并进入 recovery-required，配对包操作同样进入恢复状态，不自动恢复字节读取或文件提交。已经 installed 的文件任务保持终态；它的生效操作可以独立处于待恢复，不能把文件安装成功混同于应用生效成功。

## 文件与资源归属

```text
<packageDirectory>/
  registry.sqlite
  usage-locks/<guardId>.sqlite
  staging/<installId>/
    archive.anybox-app            归档来源
    directory.snapshot            目录来源（二选一）
    receive.json
    preparation/<temporaryId>/
    candidate/
  packages/<appId>/<version>/<digest>/
    archive.anybox-app            归档来源
    directory.snapshot            目录来源（二选一）
    receipt.json
    application/
```

[installer-files.ts](../../../packages/host/src/package-management/installer-files.ts) 是安装组件的文件提供方，不是独立组件。根目录真实身份固定；目录遍历拒绝符号链接，文件读取要求普通单链接文件，使用独占创建与 `O_NOFOLLOW`，读取后复核身份、尺寸和修改事实。只操作包管理根内的已知路径，不触及客户端控制库、业务库、Vault、项目、图片或远端服务。

接收时对长度和原始来源摘要进行流式核对，关闭并同步文件后保存接收完成回执。目录的无压缩快照保存在 `directory.snapshot`，ZIP 来源保存在 `archive.anybox-app`；目录提交回执固定 `sourceFormat: 'directory'`，归档回执保留旧布局并按缺省 `archive` 兼容。不先生成 ZIP，也不伪造发布者签名。候选目录保存原始来源快照、全部索引载荷与适用的签名元数据、宿主提交回执；无签名本地目录补入宿主计算的 `files.json`。按顺序同步文件及目录后才允许 rename 到版本目录。提交前后均按持久信任模式复核来源、身份、索引、模式与完整目录集合，拒绝缺失、额外内容、链接和同版本冲突。既有版本目录经复核后复用，不用 rename 覆盖它。

注册准备工具通过 `temporaryRoot` 把解出的临时工厂、依赖、请求和结果放在 `staging/<installId>/preparation/<temporaryId>` 内，安装器不让它散落到无法关联任务的全局临时目录。管理者异常退出后，这些字节继续受该任务的历史工作锚保护；恢复先证明并永久栅栏旧工作实际退出，再由文件提供方回收任务私有准备目录。准备子进程仍持锁或退出未知时保留全部临时字节。

安装目录的 immutable 指宿主不原地更新既有版本；目录内容改变后会被复核拒绝，不表示应用包可以自行获得系统级不可变权限。真正的代码删除不在本组件实现。

## 工作退出证明与取消

每次受管工作先把新锚 ID 追加到任务的 `workGuardIds`，随后才创建锚、取得 SHARED 锁并开始字节读取或准备进程。历史 ID 不能通过替换阶段回执、失败记录或恢复记录抹去。秘密只用于受信进程间传递，任务与锚只保留 ID 或摘要。

独立准备进程及其监护进程也持有该工作锚的实际锁。Unix 组退出观察遇到短暂 EPERM 时保留实际 SHARED 锁并继续重查，只有真实进程组退出才释放；错误和超时都不是退出证明。管理者死亡或注册库写锁释放，不代表该子进程及其资源已经退出。新管理者在清理、恢复或重试前逐个尝试历史锚的 EXCLUSIVE 证明并持久撤销旧凭证。占用、缺失、损坏或清理未确认均保留待恢复，不按 PID、超时或客户端断开猜测退出。

工作锚与角色使用锚共用格式 v2，创建时固定原物理文件 dev/ino，恢复与撤销前均复核；复制替换、符号链接、多硬链接以及缺少原身份的旧 v1 锚都不能提供退出证明，也不能通过新一次 prepare 自动收养或改写。任务保留全部历史工作 ID 和待恢复字节，恢复不会因备份字节相同而跳过原进程的占用。详见[使用锚兼容边界](registry.md#配置与资源归属)。

`closeAdmission` 关闭安装准入并取消在途控制。组件 Effect 等待流生产者、文件句柄、准备进程及受管清理实际完成，再由 Nya 依赖顺序关闭注册库。准备进程或锚释放未知会关闭本代安装准入，并在根清理时报错，不能返回假成功后继续执行下一次安装。

## 中断恢复与边界

`recover(..., { action: 'inspect' })` 只查回事实。显式 resume 先证明全部旧工作退出，然后重读完整原始来源快照，重新验证摘要、身份、兼容性及发布签名或已持久保存的本地信任；不续接半个上传流，不信任遗留候选目录。任务私有候选只能在旧工作永久栅栏后清理并重建。目录已经提交但注册事实尚未写入时，复核既有目录再补齐安装登记，不再次覆盖目录。

discard 只有在已证明全部旧工作退出、且确认尚未提交时才清理任务私有暂存。已有版本目录或提交事实无法确认时保留现场供恢复；原阶段是 committing 本身不替代真实目录核对，也不因为“取消”删除可能已经提交的代码。清理失败、文件事实与账本不一致或提交回执写入失败均保留恢复记录；恢复记录也无法持久化时停止本代准入，避免在状态不明时重试。

安装成功不代表新角色已经加载代码。当前默认静态组合、既有应用业务入口及运行进程保持各自边界；本组件不通过关闭其他应用或更改业务状态绕过独立的 D1.4/D1.5 生效和卸载协调。

## 测试入口

- [package-install-ledger.test.mjs](../../../packages/host/tests/package-install-ledger.test.mjs)：预身份接收、请求幂等、修订 CAS、v1→v2 迁移、身份绑定、原子安装事实、重启恢复、重复导入及锚历史。
- [package-installer.test.mjs](../../../packages/host/tests/package-installer.test.mjs)：文件安装、归档验证接入、取消、目录提交与显式恢复。
- [package-installer-process.test.mjs](../../../packages/host/tests/package-installer-process.test.mjs)：归档 accepted、received、after-rename、before-ledger 及无签名目录快照的真实 SIGKILL 边界、显式恢复，以及同步准备工厂阻塞时的任务私有临时字节保留。
- [package-install-command.test.mjs](../../../packages/host/tests/package-install-command.test.mjs)：目录/归档 CLI 安装、内容身份复用、源目录修改隔离、显式本地信任、只读 verify、恢复、查询和单写拒绝。
- [package-managed-process.test.mjs](../../../packages/host/tests/package-managed-process.test.mjs)：Agent 生成无签名目录，在线安装、生效后移除源目录，重启正式角色仍可加载，最后通过真实管理者卸载。
- [package-preparation-lifetime.test.mjs](../../../packages/host/tests/package-preparation-lifetime.test.mjs)：准备进程的实际锁、管理者退出后的资源归属与旧凭证栅栏。
- [package-management-web.test.mjs](../../../packages/host/tests/package-management-web.test.mjs)：本地管理界面的查询、文件上传、恢复期间取消、迟到 list/PUT 的修订单调性，以及变更后完整安装事实刷新。

统一构建与行为验收入口为 `npm run check`。平台、运行时与签名归档限制沿用[归档手册](archives.md)，不把本机测试扩大为所有平台成品验收。
