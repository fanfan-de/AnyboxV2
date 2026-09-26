# 薄 Web 客户端第一版

状态：本机单用户参考实现，2026-09-26。

## 边界

浏览器只通过同源 `/api/v1` 与本机 Web 组件交互。应用宿主在同一个 Nya 根上装配自包含 API Key 服务、DeepSeek、SQLite、Harness、目录选择器和 `web-frontend` 组件；Web 组件拥有 HTTP 监听器与静态页面，应用入口处理进程信号并通过 `harness.close()` 卸载整个根。Harness 负责项目、Session、Run 准入、幂等、执行、取消与结算。浏览器不导入 Nya 或 Harness，不直接访问模型、SQLite 或凭据，也不保存权威业务状态。

页面使用原生 TypeScript、HTML 和 CSS。`src/web/client.ts` 只依赖浏览器 API；`src/web/component.ts` 接收 Harness 校验后的 Agent ID 列表，通过 Nya 注入 Projects、Session、Run、目录选择器和通用凭据设置服务，`src/web/server.ts` 把服务映射为 HTTP 接口。公开的 Session、Run 和 Run 事件视图不暴露 Agent 指令、Prompt 内容快照、模型调用计划、密钥或 Nya 服务；Bash 命令与输出摘要会显示给本机页面。依赖撤销时 Web 先取消在途目录选择，关闭监听器并等待请求退出；依赖恢复后组件在原端口重启。

## 本机协议

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/v1/agents` | 返回全局 Agent `{id}` 列表 |
| `GET /api/v1/projects` | 返回项目 ID、名称、规范化目录路径和可用状态 |
| `GET /api/v1/projects/picker` | 返回原生目录选择器的 `{supported}` 状态 |
| `POST /api/v1/projects/pick` | 用 `{}` 打开原生目录选择窗口；选中后登记并返回项目，取消返回 `null` |
| `GET /api/v1/projects/:id/sessions` | 列出项目下的 Session |
| `POST /api/v1/sessions` | 用 `{projectId,agentId}` 创建 Session |
| `GET /api/v1/sessions/:id` | 读取 Session、`projectId` 和已完成轮次 |
| `GET /api/v1/sessions/:id/runs` | 列出会话的 Run 历史 |
| `POST /api/v1/sessions/:id/runs` | 用 `{input,idempotencyKey}` 接受 Run |
| `GET /api/v1/runs/:id` | 读取公开 Run 状态与结果 |
| `GET /api/v1/runs/:id/events` | 读取 Run 的过程事件；Bash 观察的 stdout、stderr 各截为最多 2048 UTF-8 字节，不返回内部快照 |
| `POST /api/v1/runs/:id/cancel` | 请求取消，返回当前 Run 状态 |
| `GET /api/v1/credentials` | 列出已注册凭据的公开元数据和配置状态 |
| `POST /api/v1/credentials/:id` | 用 `{key}` 保存已注册服务的 Key，返回该项状态 |
| `POST /api/v1/credentials/:id/delete` | 用 `{}` 删除已注册服务的 Key，返回该项状态 |

成功响应是 JSON。失败响应是 `{ "error": { "code": "..." } }`；已知输入错误、对象不存在、准入冲突或项目不可用、服务不可用分别使用 400、404、409、503，未知错误统一为 500，不传出内部异常。写请求要求同源 `Origin` 和 JSON；所有请求要求本机地址的 `Host`，宿主只监听 `127.0.0.1`，不开放 CORS。本机单用户版本没有账号或远程访问能力。

## 页面流程

用户点击“添加项目”打开 macOS 原生文件夹选择窗口；选中后登记项目并显示名称和完整路径，取消不改变项目列表。浏览器不提供路径输入，也不能用旧的按路径 HTTP 接口登记项目。目录选择器在其他系统上报告不支持，Web 仍可启动。页面路由记录项目与可选 Session ID。选中项目后可浏览该项目的会话，选择全局 Agent 创建新会话。项目目录后来不可访问时，项目、Session 和 Run 历史仍可查看，创建会话与新 Run 返回 `project-unavailable`。

输入消息时，客户端先生成幂等键，按 Session 将待提交内容保存在当前标签页的 `sessionStorage`，再提交。若响应丢失，刷新或返回该会话时复用原键，Harness 返回原 Run。页面从服务端重新加载 Session 和 Run 历史；活动 Run 约每 1.2 秒查询一次，页面隐藏时放慢。页面还查询 Run 事件，在每个 Run 下展示 Bash 命令、执行状态、退出码和有界输出摘要；刷新后可以恢复过程记录。异常退出后的 Run 显示为 `interrupted`，不会自动重放。切换或关闭项目视图只改变显示，后台 Run 继续执行；回到会话时重新取服务端状态。侧栏 API Key 管理只操作宿主注册的服务，响应不返回 Key 原值。

第一版没有项目删除、目录迁移、项目专属 Agent/Prompt、流式输出、工具审批或 Prompt 管理。工作区写入隔离随文件修改工具设计。
