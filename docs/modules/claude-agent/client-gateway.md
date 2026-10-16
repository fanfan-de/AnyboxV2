# Claude Agent Client Gateway 组件

[Claude Agent 模块](README.md) · [宿主连接库](../web/client-connections.md)

## 职责与入口

客户端应用唯一的 Nya 组件：读取宿主常驻的连接库，向浏览器提供设备列表与本机身份，并把白名单内的请求转发到所选执行设备。浏览器入口、资源清单与样式由 `client/registration.ts` 与 `client/assets.ts` 登记，不是组件。

| 项目 | 定义 |
| --- | --- |
| 源码 | [client/gateway.ts](../../../src/applications/claude-agent/client/gateway.ts) |
| 工厂 / Nya 名称 | `createClaudeAgentGatewayComponent({ localInstanceId? })` / `claude-agent-client-gateway` |
| 服务 | `claude-agent.gateway`（handle、幂等 close） |
| `inject` | `client.connections`（宿主连接库）、`host.directory-picker`（宿主本机目录窗口）、`app.activity` |

## 接口

路径相对 `/api/client/v1/apps/claude-agent`：`GET /connections` 返回 `{ connections, localInstanceId }`（不含凭据）；`GET /local` 返回 `{ instanceId, picker, status? }`，`picker` 为真表示宿主目录窗口在本机可用；`POST /connections/:id/pick {}` 只在该连接的 instanceId 等于受信本机身份（桌面配对或启动器 `localInstanceId`）且平台支持时打开宿主的系统目录窗口，返回 `{ path }`（取消为 null），先校验浏览器头中的预期实例与连接版本，窗口关闭后再次核对连接未变；远端设备或不支持的平台返回 403 `picker-unavailable`，窗口占用 409 `picker-busy`，其余失败 503 `picker-unsupported` / `picker-unavailable`。`/connections/:id/v1/<path>` 经宿主 `forwardConnectionRequest` 转发。白名单仅 `GET /instance`、`GET /products/claude-agent`、`POST /products/claude-agent/(open|stop|retry)` 和 `/apps/claude-agent/` 下的 `environment`、`threads`、`events`、`projects/recent`、`models/recent`、`directories`（`path`/`showHidden` 为正常查询参数）、线程、Run 与审批路由；保留查询参数绑定一律拒绝，`.`/`..` 段拒绝。每个请求登记本应用的 Activity 租约（POST 阻止停止）。

## 执行、取消与清理

转发等待双向管道实际退出，断开不取消执行设备上的 Run；Effect 中止并等待在途转发，包括正在打开的目录窗口请求（窗口进程本身归宿主组件等待）。设备身份与版本由浏览器头固定，变化返回 409。

## 失败与兼容

连接不存在 404，实例不匹配/版本变化 409，上游不可达 502 `connection-unavailable`，应用未打开 503。本应用不提供连接管理路由；添加或修改设备仍在 Anybox Harness 的“管理连接”。

## 测试

[claude-agent-client.test.mjs](../../../tests/claude-agent-client.test.mjs)：白名单、转发头与 SSE 透传、两个客户端应用共享宿主连接库并到达远端执行设备、目录窗口只对本机连接开放及其失败映射。
