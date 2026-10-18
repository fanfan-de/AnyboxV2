# Claude Agent HTTP 组件

[Claude Agent 模块](README.md) · [通用监听器](../web/web-frontend.md)

## 职责与入口

执行端业务路由与 SSE，本组件只提供 `ApplicationHttpPort`。Anybox 集成由通用监听器负责认证、应用归属与 Activity 租约；独立服务由应用包内 `server-http.ts` 自己处理监听、拥有者认证、实例校验、令牌管理与请求退出，不要求 `app.activity`。

| 项目 | 定义 |
| --- | --- |
| 源码 | [http/component.ts](../../../packages/app-claude-agent/src/http/component.ts)、[handler.ts](../../../packages/app-claude-agent/src/http/handler.ts)、[event-stream.ts](../../../packages/app-claude-agent/src/http/event-stream.ts) |
| 工厂 / Nya 名称 | `createClaudeAgentHttpComponent(root)` / `claude-agent-http` |
| 服务 | `claude-agent.http: ApplicationHttpPort & { close() }` |
| `inject` | 无；每个请求在首次异步步骤前从根同步捕获 `claude-agent.runs` 与 `claude-agent.sdk`，缺失返回 503 |
| 事件 | `ctx.on` 订阅 `claude-agent.run.changed` / `claude-agent.run.event` 转发到 SSE |

同一组件由 `installClaudeAgentBusiness` 同时用于独立服务和 Anybox 注册。正式安装的本机角色由[本机执行组件](local-execution.md)通过内存 Node request/response 适配调用同一 handler，不打开额外监听器，也不借用设备令牌认证。独立模式只提供本应用业务，不提供宿主页面和产品管理；两种方式都用相同 DTO、SSE 与 Run 取消语义，见[独立业务服务](../../application-standalone-services.md)。

## 接口

0.1.10 新增 `GET /account`，只接受互斥的单个 `threadId` 或 `cwd`（绝对目录），也可均省略。返回自有 `AccountUsageView`，账号和额度允许独立失败，缺失信息为 null，响应 `Cache-Control: no-store`。未知/重复参数及两者同时传入返回 400，非 GET 不开放。客户端本机私有通道与远端网关均仅放行此 GET 路径；不新增宿主业务接口。跨角色与参数验证由 `tests/claude-agent-local-client.test.mjs` 覆盖。

路径相对 `/api/v1/apps/claude-agent`；完整表见[设计文档](../../claude-agent-design.md#http--sse-契约)。除 `GET /capabilities`（单个可选 cwd，初始化读取技能、MCP 与子 Agent 目录）、`GET /models`（只接受单个可选 `cwd` 绝对项目路径，由 SDK 返回当前设备/项目环境的可选模型）、`GET /directories`（只接受 `path` 与 `showHidden`，`path` 必填）、`GET /runs/:id/wait`（`timeoutMs`）和 `GET /events`（`threadId`）外，其余路由拒绝任何查询参数；`GET /projects/recent` 与 `GET /models/recent` 直接转交 Runs。POST 体为 JSON 且字段白名单；提示词体上限 512 KiB，其余 64 KiB。错误 `{ error: { code, message? } }`：`ClaudeAgentError` 按自身状态码与安全文案输出，URI/类型错误 400，未知异常 500 `internal-error`。`POST /threads/:id/runs` 接受后调用 `context.retainUntil(waitRun)`，应用租约延续到进程退出。`GET /runs/:id/wait` 的 `timeoutMs` 为 0..10000（默认 10000），低于客户端代理 15 秒的握手上限。`GET /events` 订阅 1..4 个线程，最多 64 条流。

## SSE

每条流先发 `ready`，之后按发生顺序发 `run-changed` 与 `run-event`（含 seq），15 秒空闲心跳。队列上限 1024 帧或 1 MiB，背压 15 秒未 drain 即关闭该流；慢浏览器只失去订阅，不影响 Run。没有重放游标，浏览器每次收到 `ready` 都重新查询当前线程、转录、Run 列表与待审批请求；Run 仍活动时再用 `/runs/:id/view` 校准实时投影。切换线程或设备会取消旧线程的补读，迟到的响应和较旧的投影不能覆盖当前界面。

## 执行、取消与清理

请求绑定监听器关闭信号与响应关闭：模型目录、转录读取、最近项目、目录浏览与 `wait` 随之取消，SSE 随之关闭；断开不取消 Run。`close()` 停止准入、中止在途请求、关闭全部流并等待处理退出；Effect 调用它。

## 失败与兼容

旧请求不转交给重启后的服务。重启后实时视图不存在，`/runs/:id/view` 返回 404 `view-unavailable`，历史改由转录提供。

## 测试

[claude-agent-http.test.mjs](../../../tests/claude-agent-http.test.mjs)：路由与 DTO、SSE 顺序、审批 API、wait 超时、二进制缺失文案、最近项目与目录浏览的查询参数边界、当前模型目录与其取消/查询白名单、旧客户端最近模型兼容、注册应用的停止保护、能力宣告与整根关闭排空。

[claude-agent-reconnect.test.mjs](../../../tests/claude-agent-reconnect.test.mjs)：挂载实际浏览器入口，断流后通过 `ready` 恢复终态、转录与审批，并验证切换线程后旧查询不能覆盖新界面。

## 0.1.5 能力 API

- `GET /capabilities?cwd=…`：执行设备项目目录的白名单能力；随请求取消，查询进程退出后返回。
- `GET /threads/:id/capabilities`：活动任务的实际能力或项目目录能力，source 明确为 run/project。
- `POST /runs/:id/control`：action 为 permission-mode(mode)、reload-skills、mcp-toggle(name,enabled)、mcp-reconnect(name)、stop-task(taskId)。字段、模式、名称及任务归属均校验；只在 SDK 确认后返回 `{ok:true}`，不自动重试未知结果。
- `POST /threads/:id/runs` 追加可选 permissionMode；其余幂等、租约与取消语义不变。

远端网关与正式本机通道使用相同应用私有路由白名单，未修改宿主通用路由。运行中能力读取由句柄拥有；浏览器关闭不会取消已有 Run 或已接受的控制。

## 0.1.6 会话授权查询与撤销

GET /threads/:id/permissions 返回 SessionPermissionsView（有效授权的 ID、可读规则、时间与 canRevoke）。POST /threads/:id/permissions/:grantId/revoke 接受空 JSON，线程忙碌返回 409 permissions-active；未知或其他线程授权返回 404。路由拒绝额外查询/体字段，客户端网关与正式本机通道仍固定设备身份/修订。不增加浏览器提交任意权限规则的入口；授权只能来自原生待审批请求与用户明确选择。

## 0.1.7 工作区路由

均相对 `/api/v1/apps/claude-agent`，客户端同包通道及远端网关有对应精确白名单。

| 路由 | 契约 |
| --- | --- |
| GET /threads/:id/context | 当前会话上下文估算 |
| POST /threads/:id/options | 完整替换会话预算/检查点/MCP 配置，必须提供 revision；只影响后续 Run |
| GET /threads/:id/agents | 原生子 Agent ID |
| GET /threads/:id/agents/:agentId/messages?offset=N | 100 条一页，含 hasMore；offset 为 0..1000000 |
| POST /threads/:id/manage | action rename/tag/archive/restore/fork，必须 idempotencyKey；fork 可含 messageId |
| GET /threads/:id/file?path=... | 原生权限下的受限文本预览 |
| GET /threads/:id/checkpoints | 本应用记录的原生检查点 |
| POST /threads/:id/rewind | checkpointId + dryRun；真实恢复另需 idempotencyKey |
| POST /threads/:id/mcp/connect | 202 连接任务，保留租约直到实际退出 |
| GET /threads/:id/mcp/jobs、/mcp/jobs/:jobId | 本线程连接任务状态 |
| POST /threads/:id/mcp/jobs/:jobId/cancel | 显式取消，等待状态以实际退出为准 |
| GET /threads/:id/interactions | 本线程尚待回答的原生 MCP 请求 |
| POST /threads/:id/interactions/:requestId | action accept/decline/cancel，表单可含 content；只可回答一次 |

除上述 file/path 和子 Agent offset 外，新增路由不接受查询参数；所有请求字段白名单。配置最大 128 KiB（配置本体有更小上限），认证回答最大 256 KiB。SDK 类型、完整初始化对象和原生凭据均不透出。行为验证追加至 `tests/claude-agent-http.test.mjs`。

## 0.1.8 增量接口

- `POST /attachments` 创建有界上传，`POST /attachments/:id/chunks` 提交 offset/base64 块，`POST /attachments/:id/discard` 移除未引用资产。每个请求保持在应用私有通道原有大小上限内，不扩大宿主通道权限。
- Run 输入可带 attachmentIds；`GET/POST /runs/:id/messages` 观察/追加消息，`POST /runs/:id/messages/:messageId/cancel` 移除队列项。
- `POST /runs/:id/control` 增加 mcp-set、mcp-permission、background-tasks；不自动重试控制。
- `GET /threads/:id/context?detail=full` 显式请求详细计数；messages 支持 offset，默认最新页并返回 previousOffset/nextOffset。
- `GET/POST /threads/:id/native-sessions` 发现/打开同项目原生会话；manage 的 delete 由用户二次确认后提交。

所有请求仍经所属应用的 Products 活动准入、连接身份检查及关闭等待，不在宿主建立业务接口。

### 0.1.9 客户端白名单补丁

客户端网关显式允许附件创建/分块/丢弃、Run 追加输入查询/提交/移除，以及项目原生会话发现/打开。这些路由同时用于本机私有通道和远端连接，仍拒绝其他应用、非公开管理路径及不支持的方法。`tests/claude-agent-local-client.test.mjs` 通过真实客户端 HTTP 网关和执行适配器验证超过一个通道帧的附件、追加消息、取消、原生会话，以及不打开 Vault 的归属；不能只用执行端 HTTP 或界面夹具代替此验证。
