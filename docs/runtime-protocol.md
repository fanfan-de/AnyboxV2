# Runtime 协议草案 v1

状态：待实现的产品协议，2026-09-06。这里的路由、类型和 SDK 用法均为设计，不是当前可调用 API。架构和范围见 [architecture.md](architecture.md)，SDK 的分层与生命周期见 [client-sdk.md](client-sdk.md)。

内部组件、事务和实施批次见 [Runtime v1 制作计划](runtime-implementation-plan.md)。其中的 Agent/Inbox/Turn/Step 划分不改变本文 Run 接受与取消契约。

## 1. 协议边界

本地与云端实现同一份 HTTP JSON 命令/查询协议，并用可补读的服务端事件流（SSE）传输 Run 输出。普通命令不依赖一条永久连接；审批、取消和后续输入使用独立请求。

TUI、Desktop、VS Code 扩展和手机客户端共用该协议。VS Code 的 Extension Host 调用同一 SDK，Webview 通过扩展内部的受校验消息桥交互；该桥仅封装客户端操作，不是另一套 Agent 协议，公共包不包含 `vscode` 类型。

本地使用受保护的回环端点，云端使用经过认证的 HTTPS 端点。客户端连接信息至少包含 `runtimeId`、endpoint 和 Runtime 登录凭证引用；模型密钥由执行端的凭据服务管理。

线上数据只包含 JSON、ID、时间、序号和明确的产物引用，不传输 Nya Context、Fiber、函数、Promise、AbortSignal、文件句柄或原始 Error。大文件通过独立上传/下载接口传输，不塞进事件流。

`protocol` 包同时提供静态类型、运行时校验与兼容规则。`client` 包实现 Transport 和事件投影，业务界面通过 SDK 使用这些能力。

## 2. 握手与工作区

`GET /v1/runtime` 返回当前登录主体可见的运行信息，例如：

```json
{
  "protocolVersion": "1.0",
  "runtimeId": "rt_local_01",
  "instanceId": "boot_01",
  "kind": "local",
  "capabilities": {
    "runStreaming": true,
    "eventReplay": true,
    "toolApproval": true,
    "artifacts": false
  },
  "limits": { "maxConcurrentRuns": 4, "maxActiveRunsPerSession": 1 }
}
```

该示例是目标响应。实现必须按已启用的组件报告能力。`runtimeId` 在该 Runtime 数据集生命周期内稳定，`instanceId` 每次进程启动改变；另建独立实例/克隆数据时分配新的 Runtime 身份。工作区通过 `GET /v1/workspaces` 列举。

`kind` 标识 Runtime 宿主类型，不证明它位于用户屏幕所在的电脑。在 VS Code 远程工作区中，客户端应结合连接来源、已验证的 Runtime 身份和工作区映射展示执行位置，不能仅凭 `kind: local` 或 `localhost` 选择用户电脑的文件或凭据。

Gateway 从认证结果生成受信执行上下文，再校验路径中的工作区和对象归属。`workspaceId` 只是资源选择，不能用它或请求体的 userId 冒充用户。以下以 `W` 表示 `/v1/workspaces/{workspaceId}`。

## 3. API 范围

| SDK 操作 | HTTP 映射 | 返回与职责 |
| --- | --- | --- |
| `runtime.describe` | `GET /v1/runtime` | 版本、Runtime 身份、能力和限制 |
| `workspaces.list` | `GET /v1/workspaces` | 当前主体可以访问的工作区 |
| `profiles.list/get/save` | `GET/POST W/profiles`、`GET/PUT W/profiles/{id}` | Profile 与 revision，更新需校验旧版本 |
| `models.list` / `tools.list` | `GET W/models`、`GET W/tools` | 可选能力、可用性、权限要求，无密钥 |
| `sessions.create/list/get` | `POST/GET W/sessions`、`GET W/sessions/{id}` | 会话及版本，列表使用游标分页 |
| `messages.list` | `GET W/sessions/{id}/messages` | 持久消息，分页读取，大结果使用产物引用 |
| `runs.start` | `POST W/sessions/{sessionId}/runs` | 接受后返回 202 与 runId，不等待模型完成 |
| `runs.get` | `GET W/runs/{runId}` | 状态、输出/工具/审批投影及原子读取的 lastEventSeq |
| `runs.cancel` | `POST W/runs/{runId}/cancel` | 当前状态，重复请求不重复启动取消流程 |
| `runs.events` | `GET W/runs/{runId}/events?after={seq}` | 指定序号之后的 SSE 事件 |
| `approvals.decide` | `POST W/runs/{runId}/approvals/{approvalId}/decision` | 一次性审批决定，绑定版本与参数摘要 |
| `credentials.list/create/rotate/delete` | `GET/POST W/credentials`、`PUT/DELETE W/credentials/{id}` | 专用受保护操作；所有响应只返回元数据 |
| `artifacts.upload/download` | `POST W/artifacts`、`GET W/artifacts/{id}/content` | 仅在能力启用时提供，检查工作区权限 |

首个里程碑只实现握手、工作区读取、会话基础操作、Run 开始/查询/取消/事件。其他路由随功能增加，不返回虚假的成功响应。

所有接受可变对象的入口校验结构、大小、归属及允许字段。客户端不能指定服务器绝对路径、待导入模块或内部组件控制器。部署配置与组件安装属于宿主管理面，不混入普通会话协议。

编辑器选区、未保存文档等上下文使用普通文本快照或经授权上传的产物引用，来源标签、文档版本/摘要是可选的平台中立元数据；其结构随编辑器阶段补充 schema 与能力协商。编辑器 URI 只用于来源说明和客户端映射，不授予 Runtime 读取该 URI 的能力。差异结果也使用内容/产物表达，用户接受修改由扩展校验当前文档基线后处理；Runtime API 不接收任意 VS Code 命令执行请求。

## 4. 开始 Run：版本和幂等

请求示例：

```json
{
  "clientRequestId": "req_01",
  "expectedSessionVersion": 3,
  "profileRevision": 2,
  "input": [
    { "type": "text", "text": "帮我整理这个工作区的待办事项" }
  ]
}
```

接受响应包含稳定的关联信息：

```json
{
  "runId": "run_01",
  "sessionId": "session_01",
  "acceptedSessionVersion": 4,
  "acceptedAt": "2026-09-06T08:00:00.000Z"
}
```

接受命令的步骤：

1. 校验登录身份、工作区、会话权限和输入结构。
2. 读取作用域为 `principal + workspace + session + clientRequestId` 的幂等记录。相同语义请求返回原接受结果；同键不同输入返回 `IDEMPOTENCY_CONFLICT`。
3. 对新请求检查会话版本、Profile 版本、模型/工具可用性和 Session 是否已有非终态 Run。
4. 在一个事务中写入用户消息、冻结的运行请求、`queued` 状态、首个事件、会话新版本及幂等记录。
5. 事务提交后返回响应；Runtime 调度器独立启动执行。若通知丢失，调度器应能从已持久化的 queued 记录发现待执行任务。

重复命令的幂等检查先于会话版本检查，避免一个成功请求的重试被自身造成的版本变化拒绝。幂等保证范围是“一个被接受的 Run”，不保证模型网络请求或外部工具副作用恰好执行一次。

没有收到接受响应时，客户端保留原 `clientRequestId` 和原请求重试，不生成新 key。若同一会话已有 Run，返回 `SESSION_BUSY` 与有权查看的 activeRunId；首版不隐式把第二条输入插入在途上下文。

请求发出后的超时或客户端中止等待可能产生“接受结果未知”，不能视为服务器未创建 Run。用户已中止等待时停止自动重试；再次发送原请求可能是恢复原接受结果，也可能首次创建任务。首版没有基于请求键的取消意图 API，不能保证尚未拿到 runId 的取消提交会阻止执行。

首版保留已接受请求的幂等映射，不自动清理过期记录。后续引入清理前必须定义重放窗口及旧键拒绝契约，避免客户端恢复较旧命令时重新创建已执行的任务。

## 5. 事件、投影与补读

基础事件封装：

```json
{
  "version": 1,
  "runId": "run_01",
  "seq": 12,
  "time": "2026-09-06T08:00:01.000Z",
  "type": "message.delta",
  "data": { "messageId": "msg_02", "partId": "part_01", "text": "已找到" }
}
```

事件类别包括 `run.accepted`、`run.state_changed`、`message.started`、`message.delta`、`message.completed`、`tool.started`、`tool.completed`、`approval.requested`、`approval.resolved`、`artifact.created` 和 `usage.updated`。终态由 `run.state_changed` 的终态值表达，同时携带结构化结束原因。

事件规则：

- `seq` 在每个 Run 内从 1 开始递增，状态变更和对应事件原子提交；输出事件提交时同步更新可重建的消息投影。
- 内部 SessionLog 可另设跨 Run 的 `sessionSeq`；线上 `seq` 等于内部 `runSeq`，`after`、SSE id、`lastEventSeq` 和客户端 `lastAppliedSeq` 均属于该 Run 的序号域。`Session.version` 是命令的乐观版本，与两种日志序号分开。
- 输出可合并成小批次后落盘，已向客户端发送的事件必须可补读。进程内通知仅用于唤醒订阅读取数据库。
- SSE 的 `id` 使用 seq。订阅读取持久记录并在实时通知后继续从最后发送的 seq 读取；查询和切换实时阶段不能产生空隙，必要时用定期补查兜底。
- 网络层允许重复交付；客户端在当前认证分区和工作区内用 `runtimeId + runId + seq` 去重并按顺序归并，缓存不可跨账号或工作区混用。检测到缺口时从上一个连续序号补读，不直接拼接后面的文本。
- 慢客户端受到缓冲上限约束，超限可以断开，让它按游标补读，不能无限积压内存或阻塞执行中的 Run。
- 心跳仅维持传输，不是业务事件，不消耗 seq。权限撤销/凭证失效时结束订阅，重新认证后再授权补读。

首次打开已有 Run 时，客户端读取 `runs.get` 的一致性快照（状态、当前内容/工具/审批、lastEventSeq），然后订阅 `after=lastEventSeq`。重新连接时从最后已应用的连续 seq 继续。页面恢复只剩游标而没有对应投影时，重新读取快照，不能拿空白 UI 从旧游标接着拼接。

同样的规则用于 VS Code Webview 重建、Reload Window 和远程扩展重连。消息桥按视图与请求标识路由，沿用事件 seq 与缓冲上限；视图销毁时清理该视图订阅，不能让另一个仍打开的视图丢失连接或取消 Run。

超出事件保留范围返回 `CURSOR_EXPIRED` 和最早可用序号；客户端重新读取快照后订阅。游标超过当前尾部返回 `INVALID_CURSOR`。保留策略必须有产品配置，不能承诺无限期保留每个 token；完整消息与终态保留策略独立定义。

`runs.get` 在状态、投影和游标间提供一致性；大输出由产物引用表达。首版客户端在重连、切回页面或手动刷新时重新读取会话列表，Run 事件流不承担发现所有其他会话变化的职责。

## 6. 取消与审批

客户端 Transport 的 `AbortSignal` 只取消本次请求或订阅。SDK 提供单独的 `runs.cancel` 操作，不能把流关闭映射成任务取消。

VS Code 的 Webview 关闭和扩展停用同样只释放客户端资源。停止独立 Runtime 是单独的宿主管理动作，不绑定扩展的 `deactivate`。

取消接受后返回 `cancelling`，执行器退出并完成相关清理与状态落盘后才产生 `cancelled`。尚未开始的 queued Run 可直接转为 cancelled；已经终止的 Run 返回当前终态。取消和自然完成采用 Run 版本条件更新，谁先提交决定有效路径。

审批请求包含 approvalId、toolCallId、参数摘要、作用域、到期时间和版本。决定接口校验权限及该审批仍有效；同一决定的重复提交返回原结果，改变已经提交的决定返回冲突。过期、参数变化、Run 已取消时不能继续执行工具。不同客户端对同一审批只能有一个有效决定。

## 7. 错误与兼容

错误格式：

```json
{
  "error": {
    "code": "SESSION_BUSY",
    "message": "这个会话已有运行中的任务",
    "retryable": false,
    "requestId": "http_req_01",
    "details": { "activeRunId": "run_01" }
  }
}
```

| HTTP 状态 | 典型错误 |
| --- | --- |
| 400 | `INVALID_REQUEST`、`INVALID_CURSOR` |
| 401 / 403 | `UNAUTHENTICATED` / `FORBIDDEN` |
| 404 | `NOT_FOUND`，包含不应向当前主体披露的对象 |
| 409 | `SESSION_BUSY`、`VERSION_CONFLICT`、`IDEMPOTENCY_CONFLICT`、`APPROVAL_CONFLICT` |
| 410 | `CURSOR_EXPIRED` |
| 429 | `RATE_LIMITED` |
| 503 | `RUNTIME_NOT_READY`、`RUNTIME_CLOSING`、`DEPENDENCY_UNAVAILABLE` |

校验失败或未接受的请求使用 HTTP 错误；已接受 Run 的模型/工具失败记录为 Run 结果。不能将普通业务失败变成整个 Runtime 的退出信号。服务端保留内部错误用于受控诊断，对外不直接序列化异常堆栈、密钥或模型 SDK 的原始请求。

路径 `/v1` 是协议大版本，握手返回具体版本。可选字段可以增加；客户端忽略未知字段。改变已有字段含义、终态语义或要求旧客户端理解的新核心事件，需要新大版本或显式能力协商。未知扩展事件可以跳过并推进游标，不能承载旧客户端必须处理的状态变更。

`retryable` 只描述重试是否可能有意义，不允许 SDK 无条件重启任务。非幂等写入禁止隐式重试；`runs.start` 只以原请求键重试。模型内部重试必须区分尚未输出、已经输出和可能已执行工具的阶段。

## 8. SDK 使用形态

以下为面向高级调用者的低层事件用法，尚未实现。常规界面使用 [Client SDK 的 observeRun](client-sdk.md)，由 SDK 将快照和事件归并为可展示状态；低层事件消费者自行维护其投影，SDK 不替它静默跳过过期历史。

```ts
const client = createClient({ endpoint, auth: runtimeLogin })
await client.connect()
const runtime = await client.runtime.describe()
const session = await client.sessions.create({ workspaceId, profileId })
const accepted = await client.runs.start({
  workspaceId,
  sessionId: session.id,
  clientRequestId,
  expectedSessionVersion: session.version,
  profileRevision,
  input: [{ type: 'text', text: '你好' }],
})

// 绑定到用户主动取消动作，独立于订阅生命周期。
const cancelRun = () => client.runs.cancel({
  workspaceId, runId: accepted.runId,
})

// signal 仅管理订阅；关闭窗口后 Run 仍归 Runtime 所有。
for await (const event of client.runs.events({
  workspaceId, runId: accepted.runId, after: 0, signal: viewSignal,
})) {
  render(event)
}
```

SDK 负责请求键复用、版本协商、流解析、重连和事件投影；不包含 Agent 循环、模型密钥解析或工具执行。各客户端只实现展示与交互，直接嵌入 Runtime 的程序则使用另一套宿主 API。
