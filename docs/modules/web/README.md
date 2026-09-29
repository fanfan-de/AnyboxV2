# 执行宿主与客户端接入

[模块导航](../README.md) · [部署说明](../../harness-deployment.md)

每个进程独立一个 Nya 根。执行进程安装访问管理和执行 API；本机客户端安装连接管理、同源网关和原生目录窗口。浏览器代码、静态映射和路由函数没有单独组件身份。

| 组件 | 职责 |
| --- | --- |
| [Harness API](web-frontend.md) | 执行端 HTTP/SSE 与安全 DTO、Models 管理路由 |
| [Host Access](host-access.md) | 业务库实例身份、设备令牌摘要、撤销 |
| [Client Connections](client-connections.md) | 客户端连接库、系统凭据、身份校验 |
| [Client Gateway](client-gateway.md) | 同源页面与白名单转发、网络生命周期 |
| [Directory Picker](directory-picker.md) | 应用内目录选择的本机原生窗口快捷入口 |

默认[应用内项目目录选择](../../project-directory-picker.md)由客户端视图、网关、Harness API 与既有 Projects 协作，不新增组件。

执行入口 `src/host/harness-main.ts` 不安装浏览器静态服务和目录窗口。客户端入口 `src/host/client-main.ts` 不安装 Models、Session 或 Run。`src/host/serve.ts` 只启动并管理两个独立进程，关闭策略见部署说明。
