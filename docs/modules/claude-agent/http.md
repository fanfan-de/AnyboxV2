# Claude Agent HTTP 组件

[Claude Agent 模块](README.md) · [通用监听器](../web/web-frontend.md)

## 职责与入口

执行端业务路由与 SSE。Anybox 的通用监听器负责认证、应用归属与 Activity 租约，本组件只提供 `ApplicationHttpPort`。

| 项目 | 定义 |
| --- | --- |
| 源码 | [http/component.ts](../../../src/applications/claude-agent/http/component.ts)、[handler.ts](../../../src/applications/claude-agent/http/handler.ts)、[event-stream.ts](../../../src/applications/claude-agent/http/event-stream.ts) |
| 工厂 / Nya 名称 | `createClaudeAgentHttpComponent(root)` / `claude-agent-http` |
| 服务 | `claude-agent.http: ApplicationHttpPort & { close() }` |
| `inject` | 无；每个请求在首次异步步骤前从根同步捕获 `claude-agent.runs` 与 `claude-agent.sdk`，缺失返回 503 |
| 事件 | `ctx.on` 订阅 `claude-agent.run.changed` / `claude-agent.run.event` 转发到 SSE |

## 接口

路径相对 `/api/v1/apps/claude-agent`；完整表见[设计文档](../../claude-agent-design.md#http--sse-契约)。除 `GET /directories`（只接受 `path` 与 `showHidden`，`path` 必填）、`GET /runs/:id/wait`（`timeoutMs`）和 `GET /events`（`threadId`）外，其余路由拒绝任何查询参数；`GET /projects/recent` 与 `GET /models/recent` 直接转交 Runs。POST 体为 JSON 且字段白名单；提示词体上限 512 KiB，其余 64 KiB。错误 `{ error: { code, message? } }`：`ClaudeAgentError` 按自身状态码与安全文案输出，URI/类型错误 400，未知异常 500 `internal-error`。`POST /threads/:id/runs` 接受后调用 `context.retainUntil(waitRun)`，应用租约延续到进程退出。`GET /runs/:id/wait` 的 `timeoutMs` 为 0..10000（默认 10000），低于客户端代理 15 秒的握手上限。`GET /events` 订阅 1..4 个线程，最多 64 条流。

## SSE

每条流先发 `ready`，之后按发生顺序发 `run-changed` 与 `run-event`（含 seq），15 秒空闲心跳。队列上限 1024 帧或 1 MiB，背压 15 秒未 drain 即关闭该流；慢浏览器只失去订阅，不影响 Run。没有重放游标，浏览器每次收到 `ready` 都重新查询当前线程、转录、Run 列表与待审批请求；Run 仍活动时再用 `/runs/:id/view` 校准实时投影。切换线程或设备会取消旧线程的补读，迟到的响应和较旧的投影不能覆盖当前界面。

## 执行、取消与清理

请求绑定监听器关闭信号与响应关闭：转录读取、最近项目、目录浏览与 `wait` 随之取消，SSE 随之关闭；断开不取消 Run。`close()` 停止准入、中止在途请求、关闭全部流并等待处理退出；Effect 调用它。

## 失败与兼容

旧请求不转交给重启后的服务。重启后实时视图不存在，`/runs/:id/view` 返回 404 `view-unavailable`，历史改由转录提供。

## 测试

[claude-agent-http.test.mjs](../../../tests/claude-agent-http.test.mjs)：路由与 DTO、SSE 顺序、审批 API、wait 超时、二进制缺失文案、最近项目与目录浏览的查询参数边界、最近模型、注册应用的停止保护、能力宣告与整根关闭排空。

[claude-agent-reconnect.test.mjs](../../../tests/claude-agent-reconnect.test.mjs)：挂载实际浏览器入口，断流后通过 `ready` 恢复终态、转录与审批，并验证切换线程后旧查询不能覆盖新界面。
