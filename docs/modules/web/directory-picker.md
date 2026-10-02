# Directory Picker 组件

[Web 模块](README.md) · [模块导航](../README.md)

## 职责与入口

Directory Picker 为已确认本机身份且平台支持的“添加项目”流程提供系统目录窗口。远程设备、本机身份未确认或原生能力检查未确认可用时使用应用内目录选择器，其浏览由 Projects 负责；应用内视图及协议见[项目目录选择](../../project-directory-picker.md)，不新增 Nya 组件。它独占对话框进程，返回绝对路径；浏览器启动器在用户确认后调用固定目标登记路径，项目身份及可用性校验归 [Projects](../sessions/projects.md)，不是选择器职责。

| 项目 | 定义 |
| --- | --- |
| 源码 | [directory-picker.ts](../../../src/applications/harness/client/directory-picker.ts) |
| 工厂 / Nya 名称 | `createDirectoryPickerComponent(options?)` / `host-directory-picker` |
| 服务 | `host.directory-picker: DirectoryPickerPort` |
| `inject` | 无 |
| 原生适配函数 | `runMacOSDirectoryDialog(signal)` |
| 消费方 | [Client Gateway](client-gateway.md) |

## 配置与接口

| 选项 | 默认值 | 含义 |
| --- | --- | --- |
| `platform` | `process.platform` | 决定 `supported`；只有 `darwin` 为 true，主要供生命周期测试 |
| `runDialog` | `runMacOSDirectoryDialog` | 接收 `AbortSignal`，返回路径或 `undefined` 的 Promise；可以替换原生调用 |

服务有只读 `supported: boolean` 与 `pick(signal?): Promise<string | undefined>`。`undefined` 表示用户在对话框点取消；显式 signal 取消则拒绝 `DirectoryPickerFailure('cancelled')`。两者含义不同。

每次调用先检查组件准入、平台支持、是否已有活动对话框和上游取消状态。只允许一个活动调用，没有等待队列；占用期间的第二次调用立即以 `busy` 拒绝。组件安装在非 macOS 仍然成功并提供 `supported: false`，使路径输入与远程连接继续可用。

## 原生流程与所有权

默认实现启动 `/usr/bin/osascript`，以固定 AppleScript 片段调用 `choose folder`，提示语为“选择项目目录”。请求数据不拼接到脚本，stdin 忽略，stdout 用于结果，stderr 被消费但不回传底层错误文本。

输出协议为 `SELECTED:<absolute path>` 或 `CANCELLED`。原生调用等待 child `close`，移除 abort 监听器，检查退出码、输出前缀和绝对路径后才完成。stdout 超过 65536 个字符会标记失败并终止进程；组件层对替换 `runDialog` 的返回值也再次校验绝对路径。

组件同步登记活动 controller 和 Promise，再异步启动对话框，因此在启动前取消或卸载也不会漏掉待执行任务。Promise 的 finally 释放占用和上游 abort 监听器；用户选择完成之前不会接纳第二个对话框。

## 与客户端网关、Projects 的协作

仅安装在客户端根。组合启动器通过子进程就绪消息确认 localInstanceId；网关 `/api/client/v1/local` 返回身份和支持状态，`POST /api/client/v1/connections/:id/pick {}` 必须匹配此身份。点击“添加项目”时，浏览器固定连接身份和版本；确认本机且平台支持时直接调用目录窗口。窗口只返回路径，用户确认后浏览器立即通过该固定目标的 `POST /api/v1/projects {path}` 登记，不再打开应用内对话框二次确认；网关同时核对预期连接版本。用户取消则结束流程。窗口启动或登记失败显示工作区通知，不自动回退或换设备登记。

远程实例、本机身份未确认或原生能力检查未确认可用时使用应用内浏览，不按 hostname 推断本机。缺少 projects.browse 的旧 Harness 使用应用内手动绝对路径入口，不再使用 window.prompt。应用内目录对话框不再提供原生窗口快捷按钮。

## 取消、实际退出与失败

显式取消转发至内部 controller。macOS 实现调用 `child.kill()`，但仍等 `close` 才拒绝；不会把已发送终止信号当作退出完成。这个适配器没有 Bash 的 SIGKILL 宽限升级或独立超时，替换 `runDialog` 时也必须响应取消并最终结束，否则清理会继续等待。

卸载 Effect 先关闭准入，再 abort 活动对话框并以 `Promise.allSettled` 等待实际结束；预期取消/对话框失败不会作为组件清理错误重新抛出。已关闭服务的新调用以 `unavailable` 拒绝。

| 失败码 | 含义 | HTTP 映射 |
| --- | --- | --- |
| `busy` | 对话框已占用 | 409 `picker-busy` |
| `unsupported` | 当前平台未提供实现 | 503 `picker-unsupported` |
| `cancelled` | 调用 signal 或所有者取消 | 503 `picker-unavailable`（若响应仍可写） |
| `unavailable` | 已关闭、进程错误、非零退出、非法结果或替换适配器异常 | 503 `picker-unavailable` |

异常文本固定，不将 osascript stderr 或任意原始错误传给浏览器。扩展其他平台需要提供对应本机适配器及支持判断；不能只把 `platform` 改成 `darwin` 就声称平台已支持。

## 验证依据

[web-server.test.mjs](../../../tests/web-server.test.mjs) 覆盖项目登记、并发对话框拒绝、失败映射、不支持平台仍可使用 Web、关闭等待、HTTP 断开取消且不创建项目。这些生命周期测试通过替换 `runDialog` 控制退出时机，不等同于每个平台的真实 GUI 验收。完整验收运行 `npm run check`。

浏览器启动器在界面停用或关闭时取消并等待本轮原生选择或登记操作退出，不发布迟到结果。原生窗口属于 Harness 的本机连接功能，组件仅在客户端 Harness 打开时安装，关闭等待窗口操作退出。通用应用外壳不管理执行目标或目录窗口。
