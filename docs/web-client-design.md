# 薄 Web 客户端第一版

状态：本机单用户参考实现，2026-09-25。

## 边界

浏览器只通过同源 `/api/v1` 与本机 Web 组件交互。应用宿主在同一个 Nya 根上装配自包含 API Key 服务、DeepSeek、SQLite、Harness 和 `web-frontend` 组件；Web 组件拥有 HTTP 监听器与静态页面，应用入口处理进程信号并通过 `harness.close()` 卸载整个根。Harness 仍负责 Session、Run 准入、幂等、执行、取消与结算。浏览器不导入 Nya 或 Harness，不直接访问模型或凭据，也不保存权威业务状态。

本次页面使用原生 TypeScript、HTML 和 CSS；HTTP 协议是替换客户端技术栈时保持的边界。`src/web/client.ts` 只依赖浏览器 API；`src/web/component.ts` 通过 Nya 注入 Agent、Session、Run 和通用凭据设置服务，`src/web/server.ts` 把这些服务映射为 HTTP 接口。Web 组件返回显式构造的 Session、Run 视图，不暴露 Agent 指令、Prompt 内容快照、模型调用计划、密钥或 Nya 服务。依赖撤销时 Nya 关闭监听器并等待请求退出；依赖恢复后组件在原端口重启。

## 本机协议

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/v1/agents` | 返回 `{id}` 列表 |
| `POST /api/v1/sessions` | 用 `{agentId}` 创建 Session |
| `GET /api/v1/sessions/:id` | 读取 Session 和已完成轮次 |
| `GET /api/v1/credentials` | 列出已注册的凭据 ID、名称、类别和配置状态 |
| `POST /api/v1/credentials/:id` | 用 `{key}` 保存已注册服务的 Key，返回该项状态 |
| `POST /api/v1/credentials/:id/delete` | 用 `{}` 删除已注册服务的 Key，返回该项状态 |
| `POST /api/v1/sessions/:id/runs` | 用 `{input,idempotencyKey}` 接受 Run |
| `GET /api/v1/runs/:id` | 读取公开 Run 状态与结果 |
| `POST /api/v1/runs/:id/cancel` | 请求取消，返回当前 Run 状态 |

成功响应是 JSON。失败响应是 `{ "error": { "code": "..." } }`；已知输入错误、对象不存在、准入冲突、服务不可用分别使用 400、404、409、503，未知错误统一为 500，不传出内部异常。写请求要求同源 `Origin` 和 JSON；所有请求要求本机地址的 `Host`，宿主只监听 `127.0.0.1`，不开放 CORS。本机单用户版本没有账号或远程访问能力。

## 页面流程

选择 Agent 后创建 Session；输入消息时，客户端先生成幂等键并把本次待提交信息保存到当前标签页的 `sessionStorage`，再提交。若响应丢失，重试复用原键，Harness 返回已接受的 Run。运行中每隔约 1.2 秒查询一次，页面隐藏时放慢；取消后继续查询，直到实际终态。完成时重新读取 Session，以服务端保存的轮次为准。页面刷新后从地址中的 Session ID 和本标签页保存的待提交信息恢复；若服务端已重启，旧会话返回 404，页面提示创建新会话。

Run 和 Session 当前只在内存中；没有历史会话列表、流式输出、工具交互或 Prompt 管理。侧栏 API Key 管理从宿主注册清单中选择服务，可以录入、替换和删除任意已注册服务的 Key。当前宿主只注册 DeepSeek；未来视频模型和其他服务只需向通用设置组件注册 ID、名称和类别。接口只返回公开元数据与配置状态，不返回原值。写入成功后新 Run 使用新值，已取到旧值的 Run 继续执行。未来若增加持久状态或流式事件，仍由 Harness 和宿主提供，客户端只呈现公开结果。
