# Anybox 桌面构建与安装

桌面版与 Web 使用同一份前端源码和 `npm run build` 产物：宿主浏览器外壳、应用 ESM 入口、样式、模板和 Markdown vendor 都继续由现有登记资源图提供。Electron 仅增加桌面窗口、固定 `anybox-app://app/` origin、原生能力适配和后台进程管理。修改前端后，两种交付方式都使用新的构建；已安装桌面版需要更换安装包获取修改。

首版目标是 macOS Apple Silicon（arm64）。Electron 固定为 44.5.1，内置 Node 24.21.0；使用 Electron Forge 8.0.1 生成 `.app`、DMG 和 ZIP。安装用户不需要安装 Node、npm、相邻 NyaCore 或项目源码。此阶段不配置 Developer ID 签名、公证、自动更新、开机启动或 Windows/Linux 桌面发行。打包在重命名、ASAR 和 fuse 修改完成后，以本机 ad hoc 签名修复整个 app 及 helper，并自动运行 `codesign --verify --deep --strict`；保留 Electron 原有 entitlements。这保证本机运行与系统 Keychain 访问，不代表 Developer ID 签名或公证。

## 开发与验证

```sh
npm ci
npm run desktop:dev
```

`desktop:dev` 先运行共享构建，再编译 macOS 目录面板适配器并启动 Electron。桌面构建机需要 Xcode Command Line Tools 和本地 Node C API 头文件；适配器使用 Node-API 和系统 Cocoa，不下载编译依赖。普通 `npm run build`、Web/Node 命令与 `npm run check` 不编译它，不要求 Xcode。

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

原生“退出”确认对话框需要人工交互，单独追加 `--desktop-smoke-native-quit` 执行：本机任务运行时，第一次选择“继续运行”，验证任务继续；最后一次选择“退出并取消本机任务”，验证明确退出与实际清理。默认 smoke 仅验证退出 guard 与清理，不把这项人工对话框行为计为自动通过。原生目录选择器的默认自动 smoke 验证可见、与主窗口对齐且不创建额外 renderer 的原生子窗口，并检查请求取消后面板返回真正的取消结果、父窗口销毁与操作实际退出；安装后的窗口层级仍需实际打开面板确认。

## 本机安装包

```sh
npm run desktop:package
npm run desktop:make
```

上述命令要求在 macOS arm64 上执行。`desktop:package` 输出 `artifacts/desktop/out/Anybox-darwin-arm64/Anybox.app`；`desktop:make` 同时在 `artifacts/desktop/out/make/` 输出 DMG 和 ZIP。打开 DMG，将 `Anybox.app` 拖入“应用程序”。这是本机安装与测试产物，未经过公开发行签名和公证。

后台客户端与本机执行端由 Electron 的 utility processes 承载，分别持有自己的 Nya 根和持久资源。客户端端口与执行端端口由系统分配；桌面窗口使用稳定的 custom origin，以保留浏览器 localStorage。关闭窗口仅隐藏窗口并继续已开始任务；退出应用等待后台组件和在途操作清理。已有独立 Web 服务可以继续运行，桌面数据独立保存到 Electron 用户数据目录的 `data/`，不会自动迁移或共享仓库 `./data/`。

退出会先确认当前页面的未保存修改，再检查并确认本机活动；拒绝任何一项都保留可用的页面与后台资源。全部检查通过后才关闭服务并等待实际退出，最后由已批准的退出许可处理 Electron 页面的 unload 阻止。普通红色关闭按钮仍只隐藏窗口。共享构建后可运行 `node tests/helpers/desktop-quit-electron.mjs`，通过不含真实业务服务或凭据的隔离 Electron 进程复验未保存修改拒绝、确认放弃与最终退出；该入口不替代系统 Vault 和成品包 smoke。

## 产物与原生依赖边界

Node release 和桌面打包共同调用 `scripts/stage-application.mjs`。它构建一次、将本地 Models、API-key-manager、NyaCore `npm pack` 为固定 tarball、复制 `dist/` 与 `web/`、验证同一登记资源图与各浏览器资产内容 SHA-256，并记录本地包完整性及锁文件 SHA-256。桌面随后在临时 staging 目录用 `npm ci --omit=dev --include=optional` 安装目标平台依赖；不复制开发目录的 node_modules 或相邻仓库链接。临时目录在成功与失败后都清理，最终安装包独立运行。`node scripts/verify-staged-application.mjs <release-directory>` 可重新核对某次 Node/桌面 staging 产物与当前构建；构建已改变时内容检查会失败。

Sharp、`@img` 的 libvips 库与 Keyring 平台二进制完整保留在 `app.asar.unpacked`，打包完成后自动检查 `.node`、`.dylib` 与包入口存在。它们保持原生外部包，不混入浏览器代码、不使用系统全局 libvips；同架构 Node-API 预编译包在 Electron 内实际验证。桌面 staging 单独编译 `dist/desktop/native/mac-dialog.node`，同样解包、检查 arm64 Mach-O 与签名，由 Main 对指定窗口所属的原生目录面板执行取消。发行关闭 `RunAsNode`、`NODE_OPTIONS` 和 Node inspector 的 fuses。离线 Models 目录快照随 Models 包携带，普通构建或打包不刷新目录快照。

文件工具的 `@vscode/ripgrep` 和 `picomatch` 保持固定版本；发行验证锁文件中所有 ripgrep 平台可选包的版本、完整性与平台声明，供目标设备 `npm ci` 选择。桌面同时解包 `@vscode` 下的 wrapper 和 arm64 `rg` 可执行文件，执行时把 archive 中的解析路径转换为实际 `app.asar.unpacked` 路径。成品验证拒绝缺失、符号链接、无执行权限或错误架构的二进制，并直接执行随包 `rg --version`；不依赖用户 PATH。`tests/search-release.test.mjs` 用真实 ASAR 打包覆盖解包配置和损坏包拒绝。

安装验收包括从 Finder 启动、没有外部 Node 时使用本机与远端连接、流式消息、图片原字节上传、Bash/Apply Patch、窗口隐藏后任务继续、退出后数据库和文件锁释放、重开读取桌面数据，以及同一构建的 Web/桌面资源一致。
