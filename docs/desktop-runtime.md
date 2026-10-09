# Anybox 桌面运行边界

桌面版完整复用 Web 宿主外壳、Anybox Harness ESM 入口、模板、样式和 HTTP/SSE API。`src/desktop/` 仅持有桌面适配；`src/entrypoints/desktop-main.ts` 与 `desktop-worker.ts` 是受信组合入口。通用宿主不导入 Electron 或具体应用，桌面层不解释 Session、模型协议或工具执行。构建、安装和验收命令见 [桌面打包](desktop-packaging.md)。

## 进程与资源

Electron 主进程持有窗口、原生菜单、目录对话框、固定页面协议及两个 UtilityProcess 的私有控制端口。客户端 worker 与执行端 worker 分别调用现有宿主工厂，各自持有一个 Nya 根。Models、SQLite、Vault、图片、Session、Run 与工具资源仍由原有组件持有；不建立桌面 Nya 组件、应用子 Context 或额外业务库。

每个 worker 使用真实可写目录作为 cwd，配置从主进程的私有启动消息提供，不继承 CLI 数据库路径。正式版数据位于 `app.getPath('userData')/data`，开发版位于独立的 `Anybox Development` 用户目录；客户端、业务、Models JSON、旧库导入位置、目录缓存与图片路径彼此独立。正式凭据 namespace 为 `anybox.desktop.client` 和 `anybox.desktop.models`，开发版增加 `.dev`，测试使用独立 namespace。桌面不读取仓库 `data/` 或旧 `anybox` 凭据。

## 共享页面协议

窗口使用 `persist:anybox-desktop` session 和 `anybox-app://app/`。注册 standard、secure、Fetch 与 streaming 支持，保持 CSP，不开放 Service Worker。窗口使用 sandbox、contextIsolation、webSecurity，关闭 Node 集成；没有面向 renderer 的业务 IPC 或 preload。剪贴板写入只允许本窗口的受信页面，其他权限默认拒绝。

协议桥精确检查 scheme、hostname、port、userinfo 与浏览器控制的 initiator，然后仅转发到当前 client worker 的 `127.0.0.1` 随机端口。路径或重定向不能选择其他上游。主进程归一化 Host、Origin 和 Fetch 元数据，并保留内容类型及现有连接绑定头。请求和响应流保留原字节、MIME、状态码与 CSP；取消和关闭等待上传及响应实际退出。

Electron 44.5.1 不把 renderer 取消传给自定义协议的 `Request.signal`。`session-protocol.ts` 通过 `webRequest` 的真实请求 ID 关联操作，覆盖调用方提供的关联头，并校验窗口代、路径和方法。`onErrorOccurred` 只取消对应请求；同一地址的其他请求不受影响。关联头不转发给 worker，也不构成公开业务 API。

`ClientHostOptions.transportSecret` 是可选的通用监听器保护：桌面每次启动随机生成，监听器在资源及 API 分派前校验 `X-Anybox-Desktop-Transport`。值只存在私有 IPC 和内存，不进入 renderer、HTML、日志、环境变量或文件；Web/CLI 未设置时保持现有同源校验。

固定页面 origin 保持 localStorage 身份，随机端口不改变偏好设置的归属。窗口隐藏保留当前 document 与 sessionStorage；完全退出后的 sessionStorage 仍沿用现有 Web 会话语义。

## 本机配对与原生目录

Connections 组件每次 `apply` 拥有本代配对任务、取消控制与非秘密状态。初始化不等待配对；失败仍可使用远端连接。主进程转发固定的本机描述、managed token 发行及对账请求到当前执行端；worker 每次通过根的 `get()` 捕获当前服务，单次操作不跨服务代重试。

客户端 `client-connections` v2 记录本机连接 ID 和 instanceId 的归属。首次配对保存连接及 Vault 引用，重启复用 ID、名称与密钥，仅地址变化时更新 revision；身份变化拒绝静默替换。执行端 `host-access` v2 保存 managed owner，回收异常配对的孤立 token，只修改本 owner 的条目。Vault 不可用时不撤销旧有效凭据。模型密钥继续使用既有 Models Vault。

现有 `/local` 返回白名单状态；桌面启用精确 `/local/retry`，不接受任意地址或 token。共享连接管理界面展示 pending、失败和显式重试，并在活动时低频观察状态；未保存表单或忙碌工作区会延迟刷新。只读取状态、恢复页面或选择设备不会启动执行目标。

原生目录选择复用 picker 的 `runDialog` 注入，经私有 worker 端口调用 Electron 对话框。对话框由可销毁的透明、无边框 BaseWindow 持有，不创建额外 renderer。临时窗口采用主窗口的 bounds，作为原生子窗口先显示再挂接目录面板，确保原生层级在主窗口上方；不使用隐藏的 1×1 窗口或嵌套 modal sheet。Dock 激活和单实例恢复保持原生面板的 key window，不聚焦透明所有者或主窗口以免抢走响应链。

macOS 取消由主进程私有 Node-API/Cocoa 适配器处理：只接收本次自有 BaseWindow 的 native handle，在主线程查找其附着的 NSOpenPanel 并发送真实 Cancel；不使用全局 first responder，也不操作其他窗口。关闭所有者的隐式 Stop 返回码会被 Electron 当作接受并读取书签，因此不能作为取消。面板尚未附着时短暂重试，结果完成后清除重试计时器，等待原生对话框实际结束，再销毁临时窗口、恢复主窗口焦点。构建适配器仅属于桌面命令，普通 Web 构建不依赖 Xcode；安装包解包并签名该 `.node` 文件，运行时无需编译器。浏览器只获得选中的路径，仍执行原有 instanceId/revision 检查。

## 隐藏、退出与恢复

单实例锁保证同一数据目录仅由一个桌面应用持有。窗口关闭隐藏，Dock 激活或再次启动恢复原窗口；本机与远端任务继续运行。

退出前先检查当前页面的 `beforeunload` 意图；模型设置等存在未保存修改时，原生确认让用户选择保留页面或放弃修改。拒绝退出时窗口和后台资源继续可用，页面代理及 worker 不进入清理。确认放弃修改后，再在执行端尝试 Activity 的空闲冻结，包含 Run 准入 guard；闲置检查与停止准入之间不能接受新的 Run。忙碌时确认是否取消本机任务，选择继续运行释放冻结。只有全部退出检查通过后，主进程才停止页面代理准入，两个 worker 同步停止宿主控制与 HTTP，等待有限启动/控制工作退出，再关闭客户端、执行端。

后台清理成功后设置最终退出许可，再执行 Electron `app.quit()`；此时才允许忽略窗口的 `will-prevent-unload` 阻止，避免用户已确认放弃修改后，旧页面再次拦截退出而留下已停止后台服务的空壳窗口。普通红色关闭按钮继续只隐藏窗口，不放弃草稿、不清理后台资源。

宿主 `prepareClose()` 不等待需要根卸载才能退出的 Run/HTTP 租约。`close()` 在准备完成后同时开始根清理并等待 HTTP 排空，避免 Run 等待自己的取消入口。组件继续取消并等待实际模型、工具、文件和数据库操作退出；主进程最后等待 worker exit。远端 Run 不因客户端断开而取消。

启动期间退出会冻结新启动并等待已经开始的装配完成后清理。启动失败回收 worker；异常退出由原生提示及显式重启恢复，本机重启后重新配对新端口。renderer 崩溃只重新加载共享页面，后台服务保留。清理失败明确报告，正常模式不自动超时强杀；异常中止的 Run 下次启动记为 interrupted，不重放副作用。

## 验证入口

`tests/desktop-host-boundaries.test.mjs` 验证 managed token、监听器保护和根关闭；`desktop-local-pairing*.test.mjs` 验证配对恢复、Vault 失败与共享 UI；`desktop-protocol.test.mjs`、`desktop-session-protocol.test.mjs`、`desktop-rpc.test.mjs` 验证流、精确请求取消、窗口归属和私有控制边界。`npm run check` 包含这些行为测试。

共享构建后运行 `node tests/helpers/desktop-quit-electron.mjs`，可在独立临时 userData 和隔离窗口中验证真实 Electron 的 dirty-page 退出阻止：拒绝放弃草稿保留窗口与模拟资源；确认放弃后拒绝取消本机任务则释放活动冻结并保留资源；全部确认后先关闭模拟资源，再允许真实 `app.quit()`。重复退出请求不叠加确认。该测试只加载本地静态页，不安装业务宿主、不访问凭据或用户正在运行的桌面实例。

`npm run desktop:smoke` 使用真实 Electron、隔离测试目录和离线模型 fixture；`ANYBOX_KEYRING_TESTS=1` 才执行随机测试 namespace 的系统 Keychain 写读删。安装包也支持 `--desktop-smoke --desktop-smoke-keyring --desktop-smoke-directory <绝对目录>`，报告与截图保存在该目录。此模式不读取正式数据或调用外部模型。
