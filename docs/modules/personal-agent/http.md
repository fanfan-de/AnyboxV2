# HTTP、模型设置与界面

[返回模块](README.md)

[`createPersonalAgentHttpComponent()`](../../../packages/app-personal-agent/src/http.ts) 安装 `personal-agent-http`，提供 `personal-agent.http`，注入 `personal-agent.workspace`、`models`、`models.settings`、`app.activity`。应用注册位于 [`registration.ts`](../../../packages/app-personal-agent/src/registration.ts)，通过 `createApplicationRuntime` 记录组件资源归属，宿主不理解其业务表或 Agent 配置。

该应用只声明 client 角色。注册只构造描述，打开应用时才动态加载 Models 运行模块并安装独立 Models JSON/Vault、四种协议及工作区和 HTTP 组件；未打开时沿用原客户端角色导入防护。当前客户端的其他正式应用没有装 Models。Personal Agent 没有把自身注册到与 Harness Models 同处的 execution 根，因此不共享其配置或服务。Model JSON 路径由应用配置 `modelsPath` 或 `ANYBOX_PERSONAL_AGENT_MODELS_CONFIG` 决定；默认位于其客户端数据位置附近。Vault 默认命名空间独立于 Harness，不读取旧 Harness 凭据。应用可注入 `openEntry` 和 `fetch` 做测试，不存在生产明文凭据后备。

静态资源使用 `/apps/personal-agent/0.1.0/` 下的版本专属地址，保持默认安装授权即可解析，无须额外别名信任。用户工作区路由仍为 `#/apps/personal-agent`；升级应同步提升应用版本与资源地址。

HTTP 接入由宿主提供 `/api/client/v1/apps/personal-agent` 和同源访问控制；界面使用 `ApplicationWebContext.apiBase`，不硬编码宿主端口。应用拒绝未知字段、查询参数及错误 JSON 类型。返回值为原始业务 DTO，错误为 `{error:{code}}`，只包含固定错误码，不返回模型请求认证或内部异常文本。

| 方法与相对路径 | 用法 |
| --- | --- |
| `GET /state` | Agents、工作项摘要和默认打开偏好 |
| `POST /agents` | 创建/更新完整 Agent 配置；更新须 id 和 expectedRevision |
| `POST /preferences` | `{agentId}` 设置默认打开偏好 |
| `POST /works` | `{agentId,kind,title,goal}` 创建独立对话或 task |
| `GET /works/:id` | 工作项、Run 历史、成果及下游任务 |
| `POST /works/:id` | expectedRevision 和显式 status/waitReason/progress |
| `POST /works/:id/runs` | `{input,expectedRevision}` 保存并开始一次推进，返回 running Run |
| `POST /works/:id/runs/:runId/cancel` | `{}`，等待实际退出后返回事实 |
| `POST /works/:id/context` | `{expectedRevision}` 显式建立新上下文段 |
| `POST /works/:id/delegate` | `{agentId,title,goal}` 创建独立下游任务，不自动执行 |
| `POST /works/:id/artifacts` | `{title,content,runId?}` 保存文本成果 |
| `GET /models` | 应用独立模型选择和无秘密连接摘要 |
| `POST /models` | 手动添加 name/protocolId/baseUrl/remoteModelId/auth 与可选 apiKey |
| `POST /models/connections/:id/key` | expectedRevision 和 apiKey，仅写入 Models Vault |

支持 `responses`、`chat-completions`、`anthropic-messages`、`gemini-interactions` 四种协议。基础 URL 不含具体生成 endpoint、凭据、query 或 fragment；远端模型 ID 必须由用户明确填写。模型设置调用公共 Models API 建立用户定义、连接和基础执行配置，不引入目录缓存或偷偷联网下载。先保存非秘密元数据，再尝试 Vault 写入；Vault 不可用时元数据可查看并补 Key，凭据不落 JSON/SQL。查看连接仅返回 credentialConfigured。

HTTP 变更请求持有 blocking Activity 租约；请求实际结束后释放。HTTP 组件关闭先停止准入，打断未完成的请求体读取，并等待已接受的业务/配置操作，不因浏览器断连自动重发或撤销已接受的 Run。Run 的生命周期仍归工作区组件。

浏览器 [`web/app.ts`](../../../packages/app-personal-agent/src/web/app.ts) 实现正式 mount/setActive/canClose/dispose。Agent 列表、对话与任务列表、执行详情和成果属于应用；配置由应用内界面编辑，模型输出作为文本显示。页面草稿阻止关闭；切换应用保留草稿，dispose 取消并等待本页请求和轮询，不取消业务 Run。页面为中文，当前不消费宿主 locale 建议。

验证入口包括包级业务/API测试、资源图验证和真实浏览器主流程；具体本轮范围与未验证项见[变更记录](../../../.agents/notes/implemented/feature/2026-11-13-personal-agent-mvp.md)。
