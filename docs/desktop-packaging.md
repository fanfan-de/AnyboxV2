# Anybox 桌面构建与安装

发行目标见[统一发行与独立运行角色](runtime-roles-and-distribution.md)：Windows、macOS、Linux 各自一个完整 Anybox 产品包，包含桌面和可独立启动的后台角色。构建入口现在按本机平台及 x64/arm64 架构选择依赖和原生适配；本轮真实验收范围仅 Windows，macOS/Linux 保留实现与 CI，实际通过情况见[原生平台支持](native-platform-support.md)。

桌面版与 Web 使用同一份前端源码和 `npm run build` 产物：宿主浏览器外壳、应用 ESM 入口、样式、模板和 Markdown vendor 都继续由现有登记资源图提供。Electron 仅增加桌面窗口、固定 `anybox-app://app/` origin、原生能力适配和后台进程管理。修改前端后，两种交付方式都使用新的构建；已安装桌面版需要更换安装包获取修改。

Electron 固定为 44.5.1，使用 Electron Forge 8.0.1。三个平台均输出完整 ZIP，macOS 额外输出 `.app` 和 DMG。用户无需安装 Node、npm、编译器、相邻 NyaCore 或项目源码。构建机需要 Node、Rust/MSVC 或对应 Unix 链接工具；macOS 的 Cocoa 适配还需要 Xcode 命令行工具。当前不配置公开发行签名、公证和自动更新。macOS 仍在 ASAR/fuse 修改后执行 ad hoc 签名与验证，不能替代 Developer ID 公证。

macOS 后续成品验收还需确认深层签名是否改变内嵌 Node 的 Mach-O 字节，并协调 `runtime.json` 的最终哈希与外层资源签名顺序；当前 Windows 验收没有覆盖此步骤，不据此宣称 macOS 成品通过。

包内 `resources/runtime/`（macOS 为 `Contents/Resources/runtime/`）含独立 Node、`app/` 中的服务代码及原生依赖、`anybox.cmd` 或 `anybox` 无头入口。Node 来自构建机的目标平台 runtime，版本、架构与 SHA-256 记录在 `runtime.json`，并携带 Node LICENSE。后台 worker 使用此可执行文件及 ASAR 外代码，不再借助 Electron 的 `ELECTRON_RUN_AS_NODE`。Windows 还从官方固定版本归档携带 PowerShell 7.6.6 和 Portable Git 2.56.0（Git Bash），下载时验证 `scripts/runtime-artifacts.json` 的 SHA-256；仅打包下载，普通构建/测试不下载 shell，成品运行不联网安装依赖。

开发和打包命令在三平台相同。`npm run build` 编译本机进程监督器及原生目录取消适配：macOS 编译 Cocoa 模块，Windows 编译 SCM service host 和目录对话框 helper；Linux 没有桌面原生编译步骤。Windows/Linux 不需要 Xcode。服务安装与账户边界见[后台服务](platform-services.md)。

## 开发与验证

```sh
npm ci
npm run desktop:dev
```

`desktop:dev` 先运行共享构建，再启动 Electron。macOS 构建机需要 Xcode Command Line Tools 和本地 Node C API 头文件；适配器使用 Node-API 和系统 Cocoa，不下载编译依赖。Windows helper 使用 Rust 与系统 Win32 API，不下载 Rust crate。共享构建和 `npm run check` 同时验证当前平台原生适配，运行用户不需要这些构建工具。

```sh
npm run check
ANYBOX_KEYRING_TESTS=1 npm run desktop:smoke
```

`desktop:smoke` 需要显式设置 `ANYBOX_KEYRING_TESTS=1`，否则启动前退出。完整 smoke 的本机自动配对和测试模型配置会使用系统 Vault；测试使用独立 userData 和测试 namespace，原生凭据探针使用随机 namespace，不读取用户已有 Key。它在真实 Electron utility process 中覆盖 SQLite、JPEG/PNG/WebP、共享页面、本机配对以及凭据写入、读取、删除，并通过离线模型验证原图字节上传、文件引用快照、SSE 与取消、Bash/Apply Patch、本机任务隐藏后继续、退出时取消与实际 worker 退出、远端任务继续以及数据库/图片锁释放。重复相同 userData 的 smoke 还验证本机连接身份复用和端口变更修订。普通 Node 测试通过不能替代 Electron 和成品包验证。

安装到“应用程序”后，从仓库根目录执行以下成品验收。`open` 通过 LaunchServices 启动 `.app`，向应用显式提供只含 macOS 系统命令的 PATH；运行用户无需外部 Node。报告位于指定目录的 `smoke-report.json`，必须同时为 `passed: true` 和 `installed: true`。再次执行同一命令验证连接复用。

```sh
/usr/bin/open -n -W --env PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  /Applications/Anybox.app --args --desktop-smoke --desktop-smoke-keyring \
  --desktop-smoke-directory "$PWD/artifacts/desktop-smoke/installed"
```

Windows 成品可以通过 PowerShell 运行相同 smoke，使用独立测试目录和随机凭据命名空间：

```powershell
$smokeDirectory = Join-Path $PWD ('artifacts/desktop-smoke-installed-' + [guid]::NewGuid().ToString('N'))
$env:ANYBOX_KEYRING_TESTS = '1'
$env:ANYBOX_DESKTOP_SMOKE_DIRECTORY = $smokeDirectory
Start-Process '.\artifacts\desktop\out\Anybox-win32-x64\Anybox.exe' -ArgumentList '--desktop-smoke' -Wait
Get-Content (Join-Path $smokeDirectory 'smoke-report.json')
node scripts/cleanup-desktop-smoke.mjs $smokeDirectory
```

报告的 `passed` 与 `installed` 必须都为 true。测试模型 Key 与原生 Vault 探针在 smoke 内清理；最后一条命令在应用退出后清理测试本机配对凭据及遗留 idle worker，保留报告与截图。`node scripts/packaged-runtime-smoke.mjs` 另外把子进程 PATH 限制为系统目录，使用随包 Node、PowerShell、Git Bash、ripgrep 验证真实 worker、文件与命令；它无需访问 Vault。

原生“退出”确认对话框需要人工交互，单独追加 `--desktop-smoke-native-quit` 执行：本机任务运行时，第一次选择“继续运行”，验证任务继续；最后一次选择“退出并取消本机任务”，验证明确退出与实际清理。默认 smoke 仅验证退出 guard 与清理，不把这项人工对话框行为计为自动通过。原生目录选择器的默认自动 smoke 验证可见、与主窗口对齐且不创建额外 renderer 的原生子窗口，并检查请求取消后面板返回真正的取消结果、父窗口销毁与操作实际退出；安装后的窗口层级仍需实际打开面板确认。

## 本机安装包

```sh
npm run desktop:package
npm run desktop:make
```

上述命令在目标 Windows、macOS 或 Linux 设备上执行。`desktop:package` 输出 `artifacts/desktop/out/Anybox-<platform>-<arch>/`；macOS 目录内是 `Anybox.app`。`desktop:make` 在 `artifacts/desktop/out/make/` 输出 ZIP，macOS 同时输出 DMG。Windows/Linux 解压完整目录后启动 Anybox 可执行文件；macOS 将 `.app` 放入“应用程序”。不能仅复制桌面 exe 或只复制 runtime/node；相邻资源和原生依赖是发行物的一部分。

后台客户端与本机执行端由 Electron 的 utility processes 承载，分别持有自己的 Nya 根和持久资源。客户端端口与执行端端口由系统分配；桌面窗口使用稳定的 custom origin，以保留浏览器 localStorage。关闭窗口仅隐藏窗口并继续已开始任务；退出应用等待后台组件和在途操作清理。已有独立 Web 服务可以继续运行，桌面数据独立保存到 Electron 用户数据目录的 `data/`，不会自动迁移或共享仓库 `./data/`。

默认启动只创建客户端 utility process；在连接管理或原生窗口菜单中点击“启动本机服务”后才创建执行端。`npm run desktop:dev -- --local` 或成品应用的 `--local` 参数显式选择本机组合；完整 desktop smoke 同样显式启用本机服务。两种角色分别使用 `desktop-client.js`、`desktop-execution.js`，普通客户端启动不加载执行端或原生图片 QA 模块。无头角色经包内 `runtime/anybox` 或 `runtime/anybox.cmd` 分派，不需要打开桌面。

退出会先确认当前页面的未保存修改，再检查并确认本机活动；拒绝任何一项都保留可用的页面与后台资源。全部检查通过后才关闭服务并等待实际退出，最后由已批准的退出许可处理 Electron 页面的 unload 阻止。普通红色关闭按钮仍只隐藏窗口。共享构建后可运行 `node tests/helpers/desktop-quit-electron.mjs`，通过不含真实业务服务或凭据的隔离 Electron 进程复验未保存修改拒绝、确认放弃与最终退出；该入口不替代系统 Vault 和成品包 smoke。

## 产物与原生依赖边界

Node release 和桌面打包共同调用 `scripts/stage-application.mjs`。它构建一次、将本地 Models、API-key-manager、NyaCore `npm pack` 为固定 tarball、复制 `dist/` 与 `web/`、验证同一登记资源图与各浏览器资产内容 SHA-256，并记录本地包完整性及锁文件 SHA-256。桌面随后在临时 staging 目录用 `npm ci --omit=dev --include=optional` 安装目标平台依赖；不复制开发目录的 node_modules 或相邻仓库链接。临时目录在成功与失败后都清理，最终安装包独立运行。`node scripts/verify-staged-application.mjs <release-directory>` 可重新核对某次 Node/桌面 staging 产物与当前构建；构建已改变时内容检查会失败。

Sharp、libvips、Keyring 与 ripgrep 原生依赖解包到 `app.asar.unpacked`，并在独立 runtime/app 保留完整目标平台依赖。打包后校验 Node、进程监督器、Windows service host、目录 helper 和 rg 的 PE/ELF/Mach-O 架构，使用随包 Node 实际加载 Sharp/Keyring/ripgrep 并执行角色 help；该加载验证不写用户 Vault。Cocoa `.node` 只在 macOS 编译、解包和签名；Windows 目录 helper 从 `app.asar.unpacked/dist/desktop/native/` 执行并校验协议版本。发行继续关闭 Electron `RunAsNode`、`NODE_OPTIONS` 和 Node inspector fuses。离线 Models 目录快照不因普通构建或打包刷新。

Windows 自有 Rust helper 静态链接 VC runtime，发行检查读取 PE 导入表拒绝遗漏的动态 VC 依赖。Keyring 的固定原生预编译包仍依赖 `vcruntime140.dll`；staging 从构建机 Visual Studio 官方 `VC/Redist` 选择匹配架构、带有效 Microsoft 签名的 DLL，复制到两份 Keyring `.node` 同目录，随包保留来源、版本、SHA-256 和[官方 Runtime 许可](https://visualstudio.microsoft.com/license-terms/vs2022-cruntime/)原文。成品验证实际导入表、DLL 架构/完整性和依赖闭合，不从开发机 System32 复制或要求用户另装 VC Redistributable。

文件工具的 `@vscode/ripgrep` 和 `picomatch` 保持固定版本；发行验证全部目标可选包的版本、完整性与平台声明，由构建机 staging 的 `npm ci` 安装对应平台包。wrapper 和目标 `rg`/`rg.exe` 均随包，archive 解析路径转换为 `app.asar.unpacked` 的真实路径。成品拒绝缺失、符号链接、无执行权限或错误架构的二进制，直接运行随包 `rg --version`，不依赖用户 PATH。目标设备不执行 npm。

安装验收包括从 Finder 启动、没有外部 Node 时使用本机与远端连接、流式消息、图片原字节上传、Bash/Apply Patch、窗口隐藏后任务继续、退出后数据库和文件锁释放、重开读取桌面数据，以及同一构建的 Web/桌面资源一致。
