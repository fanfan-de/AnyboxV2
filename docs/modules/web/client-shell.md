# Client Shell HTTP 组件

[宿主模块](README.md) · [应用宿主](../../products-v1.md)

`src/host/client-http.ts` 的 `createClientShellComponent(root,catalog,port?,{transportSecret}?)` 创建 `app-client-http`，提供 `app.client-http: ClientShell`（url 与 close），注入 app.products 和 app.activity。它调用与执行端相同的 startApplicationHttpServer，使用 `/api/client/v1`。通用 `createClientHost` 可选接收 `transportSecret`，供桌面主进程到客户端监听器的私有桥接使用；全部静态资源、产品控制与业务请求都在分派前校验 `X-Anybox-Desktop-Transport`，缺失或不匹配返回 `forbidden-transport`。此凭证不进入页面或持久化；普通 Web 不传该选项，仍使用原 Host/Origin 校验。

组件独占客户端回环监听器与请求。外壳资源仅含 HTML、CSS、HTTP 与应用工作区路由模块；应用资源合并自目录。注册冲突在启动监听前拒绝。连接身份、凭据、代理和 Anybox Harness 路由都由应用适配器处理；Shell 只按注册服务键从根取得本次端口。

Host/Origin/CSP、租约、断连与 Effect 退出见[通用监听器](web-frontend.md)。停止客户端只关闭本机资源，不取消远端 Run。客户端与执行宿主均提供幂等 `prepareClose(): Promise<void>`：调用时同步停止产品控制、活动、应用运行时及监听器准入，返回等待已接收控制和装配退出的 Promise；此阶段不卸载根组件，也不等待由 Nya 清理取消的 Run/HTTP 保留租约。`close()` 复用该阶段，随后同时等待 Nya 根清理与 HTTP 排空，使已受理写入和保留操作实际退出；即使准备阶段失败也继续清理并聚合错误。准备关闭不可撤销，宿主 API 随后不可复用。桌面可先准备两个进程，再按客户端和执行端的顺序完成资源关闭。

浏览器左侧窄条按注册目录顺序呈现全部应用入口；右侧只提供无装饰的挂载容器，全部界面由当前应用内部组件从顶边开始呈现，没有 Anybox 标题栏、顶部应用标签栏或宿主操作栏。切换已有挂载使用 select，保留后台 hidden/inert 界面；上/下方向键、Home/End 移动焦点，Enter/Space 打开或切换应用。

Anybox Harness 的文件阅读区、文件标签、全宽路径顶栏与目录树均在该应用挂载容器内部实现，由当前活动会话固定项目与设备。工作区两侧及阅读区与目录树之间仅显示与宿主应用导航栏一致的 1px 单线，透明命中区向两侧各扩展 4px，保留拖拽与键盘调宽；停靠状态不叠加面板边框，抽屉保留边框与阴影。路径顶栏始终说明会话所属设备与项目，有文件时呈现完整相对路径面包屑，并集中提供目录刷新与折叠入口。左阅读区与右目录树的内部调宽、按会话保存的目录请求宽度、窄布局适配、已加载快照筛选和文件类型图标均属于 Anybox Harness 浏览器资源；Shell 不拥有文件状态、目录请求或预览生命周期。Codicons SVG 本地副本由 Anybox Harness 显式注册到精确静态资源图，来源与许可见[图标说明](../../../web/apps/agent/icons/README.md)；具体布局、恢复与浏览器验收入口见[三栏工作区](../../harness-three-column-workspace.md)。

Anybox Harness 的侧栏底部将紧凑执行设备选择器与设置图标放在同一行；“设置”打开应用内部模态弹窗，“管理连接”和“已归档会话”均是其中的分类。连接分类管理全部设备，归档分类提供跨设备、跨项目的归档列表与查看、恢复操作；这两个分类隐藏当前执行设备提示。设置导航、连接与归档请求及列表生命周期由 Anybox Harness 管理。

窄条底部的“关闭界面”和“停止应用”图标按钮用 title 与 aria-label 说明动作及当前应用。“关闭界面”仅等待前端清理，显式停止仍独立控制后台，成功后才关闭界面。“我的应用”打开窄条管理浮层，显示应用列表、状态、控制及宿主通知；加载状态、界面失败和重载入口也在浮层中呈现。打开管理浮层保留当前应用界面，没有活动界面时右侧留空。

应用目录读取失败时，已缓存的应用显示“暂时无法确认状态”，打开、停止和重试控制暂停，并提示检查客户端宿主是否仍在运行；保留已挂载界面与草稿，不把失联推断为成功停止。目录恢复后重新显示实际状态。停止响应丢失时只读取状态进行核对，不重放停止请求；核对必须等待早于控制请求的目录读取退出，再发起新的读取。确认 disabled 后关闭对应界面，applying 时继续观察，仍运行或清理失败时给出终态说明；存储提交失败与忙碌保留各自提示。

目录已成功读取后的界面清理异常只提示刷新页面，保留已确认的应用状态与宿主可用性，不把本地 dispose 失败当作网络失联。

工作区继续使用 anybox.apps.workspace.v1 和原有 tabs 字段兼容已保存位置。局部路由、恢复与 mount 契约见[宿主设计](../../products-v1.md)。验证 tests/desktop-host-boundaries.test.mjs、application-shell.test.mjs、application-host.test.mjs、application-workspace.test.mjs、products-host.test.mjs；npm run check。
