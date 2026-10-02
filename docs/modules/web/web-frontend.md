# Application HTTP 监听组件

[宿主模块](README.md) · [Harness 业务适配器](harness-http.md)

`src/host/component.ts` 的 `createApplicationApiComponent(root,catalog,port,{authenticated,host})` 创建 `host-application-api`，提供 `host.http: ApplicationHttpServer`（url、幂等 close）。注入 app.products、app.activity，以及认证模式的 host.access。它不导入 Harness/Models 类型，应用失败或缺依赖时仍提供目录和控制。

内部 `startApplicationHttpServer` 是客户端和执行端共用的监听器实现。执行端使用 `/api/v1`；客户端 Shell 使用 `/api/client/v1`。组件持有监听 socket、请求集合、监听器生命周期信号及撤销订阅。注册目录拥有精确静态地址与业务前缀；静态文件只从映射读取，不遍历任意路径。

生产执行端认证 Bearer 和 instanceId；无认证客户端校验 Host、Origin 和 Sec-Fetch-Site。设置 CSP/no-store。产品控制保持既有接口，已接受控制不因断连取消。业务归属由目录路由固定，身份头仅能与归属一致。授权、Activity 登记、根上当前适配器捕获均在首次异步业务工作前完成。

ApplicationHttpContext 提供 appId、actorId、signal 和 retainUntil。handle Promise 代表请求/流实际退出，finally 释放租约；retainUntil 将租约延续到业务任务退出但不阻止监听器关闭。GET 是可取消观察，写入默认为阻塞活动。资源或 SSE 应响应 signal 并等待实际退出。接口说明见 src/host/applications/registration.ts。

close 同步停止 HTTP 准入、发送关闭信号并取消未完成请求体，等待已接受处理完成和 socket 释放；已接受普通写入可完成响应。令牌撤销关闭其活动响应。应用业务取消、DTO 和通知属于应用适配器。Effect 调用同一 close 并报告故障；宿主聚合 HTTP 与 Nya 清理错误。

浏览器入口归各应用静态资源。Harness 只挂载项目与会话工作区，侧栏提供一次设备选择和连接管理，模型与 Prompt 在工作区设置中管理；设备的“启动 Agent”“停止 Agent”位于连接管理。此布局不改变宿主监听器、HTTP 分派和应用启停契约，具体展示与恢复见[Web 客户端设计](../../web-client-design.md)和[宿主设计](../../products-v1.md)。

验证：tests/products-api.test.mjs、tests/application-host.test.mjs、tests/remote-harness.test.mjs、tests/deployment-boundaries.test.mjs；npm run check。
