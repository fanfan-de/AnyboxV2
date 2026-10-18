# @anybox/directory-picker

可选的系统目录选择适配。应用可以声明需要目录选择，也可以用手工路径输入降级；它不属于最小应用契约，不提供任意文件访问或文件系统沙箱。

根入口导出 `DirectoryPickerPort`、`DirectoryPickerFailure` 与 `createDirectoryPickerComponent(options)`。稳定服务名仍为 `host.directory-picker`，组件名仍为 `host-directory-picker`。默认 macOS 实现使用固定 AppleScript；其他平台报告 `supported: false`，不会启动子进程。`runDialog` 可注入受信桌面适配或测试替身。另导出 `directoryPickerCapabilityId`（`system.directory-picker`）、`directoryPickerCapabilityVersion`（`1.0.0`）与无副作用的 `directoryPickerSupported(platform?)`，供组合声明能力提供方。

默认 distribution 组合只登记惰性能力描述：两个客户端应用将其声明为可选，首个兼容消费者打开才安装，共享同代实例，最后消费者完成自身清理后才卸载。缺少、不兼容或不支持时应用自行降级；默认 Windows/Linux 组合不会调用组件工厂。仅查询能力诊断或打开纯界面应用不会初始化该能力。

组件一次只接纳一个系统对话框。取消只发出退出请求；原生进程或注入适配真正返回前仍占用该槽位。组件清理拒绝新调用，取消并等待活动对话框退出。原生错误转换为固定错误码，不暴露底层实现。

`@anybox/directory-picker/desktop` 提供 macOS Electron 主进程的附着窗口取消适配；`src/native/mac-dialog.mm` 由桌面构建脚本单独编译到 `dist/native/mac-dialog.node`。当前原生构建范围仍是 macOS arm64，拆包不增加平台支持。根入口不会加载 Electron 或原生二进制。

`tests/lifecycle.test.mjs` 验证关闭等待真实退出与不支持平台不启动对话框。运行 `npm test --workspace @anybox/directory-picker`。仓库 `tests/application-optional-capabilities.test.mjs` 与 `packages/host/tests/providers.test.mjs` 验证消费装配及降级，真实窗口取消另由桌面验收验证；这些行为测试不代表新增跨平台 GUI 验收。
