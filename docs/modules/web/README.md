# 执行宿主与客户端接入

[模块导航](../README.md) · [部署说明](../../harness-deployment.md)

每个进程独立一个 Nya 根。`src/host/` 的通用层拥有访问管理、监听器、HTTP 分派和浏览器外壳；`src/applications/harness/` 的应用层拥有业务 HTTP、连接、网关、目录窗口和 Harness 界面。客户端常驻应用外壳，Harness 打开后才安装其客户端组件。浏览器代码、静态映射和路由函数没有单独组件身份。

| 组件 | 职责 |
| --- | --- |
| [Application HTTP](web-frontend.md) | 常驻认证、应用控制与按目录分派 |
| [Harness HTTP](harness-http.md) | Harness 业务路由、安全 DTO、Models 管理、通知 SSE |
| [Host Access](host-access.md) | 业务库实例身份、设备令牌摘要、撤销 |
| [Client Connections](client-connections.md) | 客户端连接库、系统凭据、身份校验 |
| [Client Shell](client-shell.md) | 常驻静态页面、应用目录与控制 HTTP |
| [Client Gateway](client-gateway.md) | Harness 内部连接与白名单转发、网络生命周期 |
| [Directory Picker](directory-picker.md) | 应用内目录选择的本机原生窗口快捷入口 |

默认[应用内项目目录选择](../../project-directory-picker.md)由客户端视图、网关、Harness API 与既有 Projects 协作，不新增组件。

执行入口 `src/entrypoints/harness-main.ts` 和客户端入口 `src/entrypoints/client-main.ts` 负责默认 Harness 组合；通用装配在 `src/host/execution.ts` 与 `src/host/client.ts`。执行进程不安装浏览器静态服务和目录窗口，客户端不安装 Models、Session 或 Run。`src/entrypoints/serve.ts` 只启动并管理两个独立进程，关闭策略见部署说明。
