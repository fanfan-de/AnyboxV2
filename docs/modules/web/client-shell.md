# Client Shell HTTP 组件

[宿主模块](README.md) · [应用宿主](../../products-v1.md)

`src/host/client-http.ts` 的 `createClientShellComponent(root,catalog,port?)` 创建 `app-client-http`，提供 `app.client-http: ClientShell`（url 与 close），注入 app.products 和 app.activity。它调用与执行端相同的 startApplicationHttpServer，使用 `/api/client/v1`。

组件独占客户端回环监听器与请求。外壳资源仅含 HTML、CSS、HTTP 与应用工作区路由模块；应用资源合并自目录。注册冲突在启动监听前拒绝。连接身份、凭据、代理和 Harness 路由都由应用适配器处理；Shell 只按注册服务键从根取得本次端口。

Host/Origin/CSP、租约、断连与 Effect 退出见[通用监听器](web-frontend.md)。停止客户端只关闭本机资源，不取消远端 Run。根关闭按控制准入、HTTP 实际退出、Nya 根清理顺序执行并聚合错误。

浏览器左侧窄条按注册目录顺序呈现全部应用入口；右侧只提供无装饰的挂载容器，全部界面由当前应用内部组件从顶边开始呈现，没有 Anybox 标题栏、顶部应用标签栏或宿主操作栏。切换已有挂载使用 select，保留后台 hidden/inert 界面；上/下方向键、Home/End 移动焦点，Enter/Space 打开或切换应用。

窄条底部的“关闭界面”和“停止应用”图标按钮用 title 与 aria-label 说明动作及当前应用。“关闭界面”仅等待前端清理，显式停止仍独立控制后台，成功后才关闭界面。“我的应用”打开窄条管理浮层，显示应用列表、状态、控制及宿主通知；加载状态、界面失败和重载入口也在浮层中呈现。打开管理浮层保留当前应用界面，没有活动界面时右侧留空。

工作区继续使用 anybox.apps.workspace.v1 和原有 tabs 字段兼容已保存位置。局部路由、恢复与 mount 契约见[宿主设计](../../products-v1.md)。验证 tests/application-host.test.mjs、application-workspace.test.mjs、products-host.test.mjs；npm run check。
