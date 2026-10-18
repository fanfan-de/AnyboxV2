# 应用目录、可选归档与独立产物

[包管理模块](README.md) · [应用包设计](../../application-packages-design.md)

D1.2 的归档验证器和准备工具属于宿主生命周期边界，不创建 Nya 组件、根或应用业务服务。D1.1 的注册库继续独占安装事实；本阶段的验证成功不会写入 installed、selected 或 ready，也不会安装、打开或卸载应用。

## 入口与资源归属

| 入口 | 职责与资源 |
| --- | --- |
| `@anybox/host/main` | `createMinimumHost` 与 `anybox-host` CLI，选择空应用目录，保留宿主控制、注册库和外壳 |
| `@anybox/host/desktop/main` | 固定 Electron 主入口，只持有窗口、协议桥和客户端 utility process；不选择业务应用或本机执行服务 |
| `@anybox/host/package-management/archive` | 目录快照与受限 ZIP、静态清单、显式本地信任或发布者签名、摘要与运行条件；返回不可变验证结果，不写磁盘 |
| `@anybox/host/package-management/directory` | 有界读取本地应用文件夹，拒绝链接、特殊文件和读取中变化，返回固定的无压缩内容快照 |
| `@anybox/host/package-management/preparation` | 静态 Web 闭包及所选 Node 注册工厂检查，独占临时目录、准备子进程和退出清理 |
| `@anybox/host/package-management/verify-command` | 有界文件读取、外部信任策略和只读 CLI 编排 |
| `scripts/application-artifacts.mjs` | 构建时复制实际生产依赖闭包、原生载荷、许可证及归档签名；不属于宿主运行时 |

通用宿主不导入具体应用、连接、Models、Vault 或目录提供方。两个应用各自在 `src/package/` 导出纯 `createRegistration(context, config?)` 工厂，复用已有业务注册实现；准备阶段不调用 `createRuntime`、`open`、业务迁移或凭据接口。工作进程的原始 main 入口只检查文件及运行条件，不在准备时执行。

## 应用目录与受限归档 v1

应用包是一套目录结构，可直接从文件夹安装。显式受信的本地目录可以省略 `files.json` 和 `signature.json`，安装器根据快照计算完整文件索引。签名目录包含以下全部元数据；无后台的纯界面应用可以省略生产依赖和不适用的许可证目录：

```text
manifest.json
files.json
signature.json
payload/<已构建代码、静态资源及完整生产依赖>
licenses/<许可证和归属记录>
```

本地目录通过 CLI 的 `--trust-local` 或管理界面的显式本地信任声明授权，不依赖发布私钥。安装先复制并固定内容，运行不跟随开发目录；同版本、平台、架构的内容变更仍拒绝覆盖。目录读取拒绝符号链接、多硬链接、特殊文件、额外内容及读取中变化，不执行代码、npm 或编译。开发者或 Agent 创建纯界面目录的完整示例见[应用开发](../../application-development.md#agent-直接创建并安装应用文件夹)。

无 `files.json` 的本地目录将载荷模式统一为 0644，使 CLI 与浏览器文件夹导入得到相同内容身份；需要可执行资源时须显式提供索引，声明相应模式并与磁盘文件一致。

`.anybox-app` 是同一签名目录的可选 ZIP 分发形式，使用固定子集：UTF-8 文件名、普通文件、Store 或 Deflate；不接受 ZIP64、加密、数据描述符、额外字段、注释、前后附加数据、链接或设备。归档目录由文件路径推导，不接受目录条目。ZIP 仍须发布者签名，不能使用本地目录信任跳过。

`manifest.json` 固定 `schemaVersion: 1`、`appId`、SemVer `version`、`publisher`、`displayName`、`applicationApi` 范围和 `target: { os, arch }`。`entries` 的 `client`、`execution`、`computerWorker` 均可选；`web` 可独立存在，包含归档内的 `entry`、可选 `styles` 文件列表和 `assets` 索引路径。纯界面包无需 Node、Nya、SQL、HTTP、数据兼容或后台入口。

D1.4 增加可选 `lifecycleVersion: 1` 声明；其他值拒绝。声明 `computerWorker` 的新完整应用产物必须带该字段，表示应用使用受管的同包角色启动契约。旧未声明的签名包仍可只读验证或保留安装，但正式加载要求更新，不能回退无使用账本的旧 spawn。运行期可选 `startRole`、独立所有权及实际使用锁见[正式加载与生效](activation.md)；声明不改变发布者信任或授予应用业务权限。正式受管客户端还可通过 runtime-only 的 `channel.request` 与同包 execution 的 `channel.handle` 交换有界 JSON，准备阶段不提供通道，工厂只构造声明；协议、业务打开与资源清理由应用拥有，见[同包角色私有通道](activation.md#同包角色私有通道)。

升级旧包时由发布者使用新的应用版本号重新发布；同一应用、版本与目标的不同摘要继续拒绝覆盖，不能用重建同版本绕过身份冲突。

`web.assets` 指向 `{ schemaVersion: 1, assets: [{ path, file, type }] }`：`path` 是规范化后的精确 HTTP 路径，`file` 是归档文件路径。默认资源归属为 `/apps/<appId>/<version>/`；既有应用的资产前缀、HTTP 兼容路由及 Web 旧路由由外部受信策略逐应用授权，归档不能自行扩大它们。资源 MIME、入口、重复路径和目录冲突通过已有 `createApplicationCatalog` 规则检查。JavaScript 使用 Acorn 解析静态 import/export、字面量动态 import 与 `new URL(..., import.meta.url)`；CSS、HTML 和 SVG 的资源引用也必须闭合。浏览器仅共享 `@anybox/application-api/web`，不允许 Node 导入、原生调用或无法证明的动态模块路径。

每个 Node 入口单独声明 `runtimeRequirements`：`profile`、可选 `sharedRuntime`、Node 范围、`nodeApi` 下限、`modules` ABI、`sqlite`、Linux `libc` 及 `platforms` 系统列表。宿主使用实际运行条件比较，不能把包的要求当作当前能力。不支持的入口单独报告原因，不阻止同包其他入口的静态验证。`capabilityRequirements` 按入口声明 required/optional 范围，准备工厂返回的声明必须与清单一致；基础提供方的实际就绪仍在打开入口时检查。

`files.json` 为 `{ schemaVersion: 1, files: [{ path, size, sha256, mode }] }`，覆盖全部 payload 与 licenses，执行位只允许 0644 或 0755。固定元数据只允许 0644。目录和归档共同校验内容摘要和模式，拒绝穿越、绝对路径、链接、重复、父文件冲突、大小写/Unicode 目录别名及 Windows 保留名；ZIP 额外检查本地头、中央目录、CRC 与大小。JSON 拒绝重复成员、未知元数据字段和超出限制的结构。

默认上限：归档 256 MiB、展开总量 512 MiB、单文件 128 MiB、单个固定元数据 4 MiB、载荷 30000 文件、压缩比 200。校验调用可显式收紧限制；无签名的载荷不进行解压，固定元数据在独立大小限制内读取。

## 签名与信任

`signature.json` 为 `{ schemaVersion: 1, keyId, signature }`，signature 是 Ed25519 的 Base64 签名。签名消息为 UTF-8 的 `Anybox Application Package v1`、一个 NUL 字节、原始 manifest 字节的 32 字节 SHA-256、原始 files 字节的 32 字节 SHA-256。验证不重新序列化 JSON。`PackageIdentity.digest` 是此消息的 SHA-256；签名目录和等价 ZIP 的内容身份相同，传输快照或整个 ZIP 的 `archiveDigest` 和大小另行报告，二者不能互换。显式受信无签名目录采用由宿主计算的索引固定自己的内容身份，不能冒充发布者签名。

发布签名信任来自宿主的 `trustedPublishers`：发布者、key ID、公钥和允许的 appId 必须唯一匹配。包内公钥、目录缓存和相邻的示例策略都不自动获得信任。发布签名构建要求显式提供私钥和 key ID，不附带开发私钥；无签名的本地目录通过单次安装的显式本地信任授权，不能改变宿主的发布者信任列表。

`verifyApplicationPackage(bytes, options)` 自动识别目录快照或 ZIP；`verifyApplicationArchive` 保留 ZIP 专用兼容入口，`verifyApplicationDirectory` 校验目录文件集合，`createApplicationDirectory` 构建签名目录元数据。它们返回冻结的身份、清单、文件索引、运行条件结果和 `readFile(path)`。无签名目录需要受信调用者显式传入 `allowUnsignedLocal: true`。内部品牌拒绝伪造验证对象，文件读取每次返回副本；没有应用代码导入、业务初始化或注册库提交。

## 独立准备与实际退出

`prepareApplicationArchive(verified, options?)` 先检查静态图和目录冲突，再将已验证字节写入专用临时目录。支持的 client/execution 工厂在固定宿主脚本启动的独立 Node 进程执行，返回的只含安全注册描述，不返回服务或运行句柄。临时目录不是安装目录；没有 npm、编译或包内脚本。

使用 `nya-runtime-1` 的托管入口将 `@nya/core`、`@anybox/application-api` 和 `@anybox/storage-sqlite` 的公共导入固定到宿主认可的模块。归档内的独立进程依赖副本仍完整保留；准备时不能通过相对路径、私有路径或归档外解析绕过固定运行时。宿主自身的可信依赖正常解析。该绑定保证模块身份和闭包，不构成对受信代码的操作系统沙箱。

准备端支持显式取消、超时及输出上限。成功、失败和取消均等待子进程实际退出，再终止并核对所属进程组；进程组探测或发信号遇到 `EPERM` 时仍视为退出未确认，继续核对；包括初始探测在内的清理观察失败或超时，均保留临时目录并报告清理失败，不伪造成功清理。调用者取消不允许提前返回并删除仍被使用的载荷。Node 准备当前要求独立 Node >=22.15，实际进程组适配为 Unix；Windows 和 Electron 中缺少合适准备进程时报告 unsupported，纯界面静态验证不依赖它们。Electron 不以 `RunAsNode` 绕过现有 fuse。

## 构建与使用

构建机器先准备当前目标系统、架构和 libc 对应的生产依赖。工具只复制已构建的公开文件，保留物理版本冲突的嵌套依赖，检查声明范围，排除开发依赖、工作区链接和不使用的 Claude SDK 平台可执行包。宿主仅携带自身七个生产包；应用各自携带完整依赖、目标原生模块和许可证，不借用仓库根 `node_modules`。第三方包的非默认源代码条件不属于本阶段 JS 运行配置。

```sh
# 无应用、无签名私钥的最小宿主
npm run artifacts:build -- --out /absolute/empty-output --host-only

# 最小宿主与两个可直接安装的本地应用目录，无需签名或压缩
npm run artifacts:build -- --out /absolute/empty-output

# 选择签名并额外输出用于分发的 .anybox-app ZIP
npm run artifacts:build -- --out /absolute/empty-output \
  --signing-key /absolute/release-private.pem --key-id anybox-release-1 --archive

# 确认示例中的应用兼容别名策略后，配置给宿主；目标机器不执行 npm 安装
ANYBOX_APPLICATION_TRUST=/absolute/empty-output/publisher-policy.example.json \
  node /absolute/empty-output/host/anybox.mjs serve
node /absolute/empty-output/host/anybox.mjs verify \
  /absolute/empty-output/app-harness-darwin-arm64 --trust-local \
  --trust /absolute/empty-output/publisher-policy.example.json

# 离线安装，不会打开应用或初始化业务
node /absolute/empty-output/host/anybox.mjs install \
  /absolute/empty-output/app-harness-darwin-arm64 --trust-local \
  --trust /absolute/empty-output/publisher-policy.example.json \
  --directory /absolute/managed-applications --request-id harness-local-1
```

构建器直接生成目录，不先创建 ZIP 再解压。完整生产目录始终生成 `files.json`，无签名时也保留生产依赖的执行模式；最小 Agent 目录仍可以省略索引。`--signing-key` 与 `--key-id` 成对可选；提供时给目录补入签名元数据，`--archive` 要求它们并额外生成同内容身份的 ZIP。`artifacts.json` 分别记录目录快照和可选归档的摘要与长度。两个现有应用沿用历史资源和路由别名，生成的 `publisher-policy.example.json` 显式列出它们；无签名构建的 `publishers` 为空。部署者需检查后通过 `--trust` 提供别名策略、并在运行时使用 `ANYBOX_APPLICATION_TRUST`；`--trust-local` 只授权本地内容，不让包自行申请兼容别名。新应用使用默认 `/apps/<appId>/<version>/` 资源前缀即可，无需此策略。

Node 和 Electron 运行时在 D1.2 外部提供，自包含无头运行时与正式平台成品属于 D4。`host/desktop.mjs` 是空宿主 Electron 主入口；其客户端 utility process、协议桥、窗口和退出保护均不依赖具体应用。`--host-smoke` 需要显式独立 `ANYBOX_DESKTOP_USER_DATA`，只创建隐藏窗口验证空外壳和协议，再等待客户端退出；不会读写业务凭据。

`anybox-host verify <folder|file> --trust <policy>` 的策略文件为 `{ schemaVersion: 1, publishers: [...], applications?: { [appId]: { assetPrefixes?, routePrefixes?, webLegacyRoutes? } } }`；`verify <folder> --trust-local [--trust <policy>]` 只读检查显式受信的本地目录，可同时提供外部兼容别名策略。命令只打印校验身份、来源形式、摘要、文件数和准备结果，不保存 installed 或改变当前应用。

## 验证与后续边界

行为入口：[目录快照与本地信任](../../../packages/host/tests/package-directory.test.mjs)、[归档](../../../packages/host/tests/package-archive.test.mjs)、[准备进程与资源图](../../../packages/host/tests/package-preparation.test.mjs)、[最小宿主](../../../packages/host/tests/minimum-host.test.mjs)、[生产闭包](../../../tests/application-artifacts.test.mjs)。[受管宿主集成](../../../packages/host/tests/package-managed-process.test.mjs)覆盖 Agent 创建无签名目录、在线安装、生效、删除源目录后重启及卸载；[安装故障进程](../../../packages/host/tests/package-installer-process.test.mjs)覆盖目录快照的 SIGKILL 恢复边界。全量运行 `npm run check`，真实仓库外 Node/Electron 及原生实验另记[阶段验收](../../harness-server-plan.md)。

D1.3 已由独立[文件安装器](installation.md)接入真实本地文件安装、不可变目录提交及中断恢复，复用本页的验证与准备工具；`verify` 继续只读。安装器把准备载荷放在任务私有暂存下，并通过独立监护进程及实际工作锚等待准备进程组退出；未知退出保留载荷，之后显式恢复。D1.4 已接入正式角色快照、版本激活和启闭，D1.5 已由[卸载协调](activation.md#d15-本机卸载与代码回收)接入代码回收与本机卸载；verify 自身仍不修改安装事实。现有默认 `distribution`、CLI 和桌面命令仍保留完整静态组合，旧发行迁入留在 D3。宿主不读取应用业务库，不执行数据迁移、不使用应用凭据，也不代替应用判断业务就绪；内容签名、平台签名、公证和第三方隔离分别验收。

格式和运行时依据：[PKWARE APPNOTE](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT)、[Node 模块定制钩子](https://nodejs.org/download/release/v22.15.0/docs/api/module.html#customization-hooks)。
