# Web Frontend 组件

[Web 模块](README.md) · [模块导航](../README.md)

## 职责与入口

Web Frontend 拥有静态客户端、本地 HTTP 监听、API 映射和 SSE 订阅。它把业务服务结果投影为浏览器 DTO，不持有模型 execution、不存储会话历史，也不替代各领域的校验与资源清理。

| 项目 | 定义 |
| --- | --- |
| 组件入口 | [component.ts](../../../src/web/component.ts) |
| HTTP 适配器 | [server.ts](../../../src/web/server.ts)：`startWebServer(commands, port?)` |
| 工厂 / Nya 名称 | `createWebFrontendComponent(agents, port = 0)` / `web-frontend` |
| 服务 | `web.frontend: WebFrontendPort`，只读 `url` |
| 内部服务契约 | `WebCommands` 适配领域方法；`WebServer` 提供 `url`、两种通知方法和 `close()` |

`agents` 是只读 `{ id }` 列表，工厂冻结 ID 投影；Agent 的运行定义仍由 Harness 持有。`port` 默认 0，由操作系统分配。启动后保存实际端口，同一组件工厂因依赖重启时再次使用该端口。

## 依赖与领域边界

`inject` 声明以下服务，`apply` 仅使用本轮 `deps` 快照：

| 服务 | 用途 |
| --- | --- |
| `harness.sessions` | 会话、节点、Run 状态/事件/原生记录查询以及会话创建和选模 |
| `harness.runs` | 启动、取消、等待 Run 与临时原生视图 |
| `models` | 可执行配置列表、配置存在性校验 |
| `models.settings` | Provider/Model 定义、连接、Key、执行配置管理 |
| `models.catalog` | 目录状态与刷新 |
| `harness.projects` | 项目列表、所选路径登记和项目下会话查询的协作 |
| `host.directory-picker` | 原生目录选择 |
| `harness.prompts` | Prompt 草稿、版本、发布 |
| `harness.agent-prompts` | Agent 与已发布 Prompt 版本绑定 |

Prompt 操作始终使用宿主固定身份 `local-web-user`，浏览器不能提供 actor ID。创建会话或选模先确认配置存在；选择模型把协议 ID 交给 Session 校验已固定的会话协议。组件不绕过 Models Key 管理或 Session 的历史兼容约束。

## HTTP 约束与展示投影

监听固定为 `127.0.0.1`，返回 origin 为 `http://127.0.0.1:<port>`。每个请求必须匹配实际 `Host` 和 URL origin；所有 POST 还要求 `Origin` 精确等于监听 origin。SSE GET 另外拒绝外部 Origin 和不属于 `same-origin` / `none` 的 `Sec-Fetch-Site`。

这是单用户本机宿主，没有提供远程监听、登录或多用户认证。POST 要求 `Content-Type: application/json`、非数组 JSON 对象和字段白名单。普通请求体上限 65536 字节，Prompt 创建/编辑上限 1048576 字节。未知字段、非法路径编码或数值查询被拒绝；空对象操作也必须发送 `{}`。

响应统一设置 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff` 和限制到同源的 CSP。静态文件通过固定映射读取，包括 `/`、`/style.css` 及已编译浏览器模块；没有任意路径文件读取接口。

浏览器得到 Session、Run、Prompt 和模型管理 DTO，不提供凭据读取、可变原生 execution 或原始受信原生记录端点。Run 视图使用协议白名单投影。事件中的 Bash stdout/stderr 和补丁文本预览分别限 2048 UTF-8 字节，并保留截断标志；Apply Patch 的已完成变更、pending 和诊断保持为结构化结果。

## API：项目、会话与 Run

以下路径统一以 `/api/v1` 为前缀，动态 ID 经 URL 编解码。

| 方法 / 路径 | 输入或行为 |
| --- | --- |
| `GET /agents` | 可选 Agent ID 列表 |
| `GET /projects` | 项目列表 |
| `GET /projects/picker` | `{ supported }` |
| `POST /projects/pick` | `{}`；选择目录并登记项目，用户取消返回 `null` |
| `GET /projects/:id/sessions` | 项目下会话 |
| `POST /sessions` | `{ projectId, agentId, modelId? }` |
| `GET /sessions/:id` | 会话 DTO |
| `POST /sessions/:id/model` | `{ modelId }`，持久选择配置并校验协议 |
| `GET /sessions/:id/nodes` | 必填 `parentNodeId`，根用 `root`；可选 `cursor`、`limit`（1..100，默认领域值 50） |
| `GET /sessions/:id/nodes/:nodeId` | 查询一个完整节点 |
| `GET /sessions/:id/nodes/:nodeId/path` | 查询该节点成功祖先路径，`nodeId=root` 表示空路径 |
| `GET /sessions/:id/runs` | 可选 `status=active`、`parentNodeId`（根用 `root`） |
| `GET /sessions/:id/runs/by-key/:key` | 按已接受幂等键只读查询 |
| `POST /sessions/:id/runs` | `{ parentNodeId, input, idempotencyKey, modelId? }`；`parentNodeId` 必须显式为节点 ID 或 `null` |
| `GET /runs/:id` | 已提交 Run 状态 DTO |
| `GET /runs/:id/view` | 原生白名单视图；运行中可为 provisional，结束后为 committed |
| `GET /runs/:id/events` | 可选非负安全整数 `afterSeq`，默认 0 |
| `GET /runs/:id/wait` | 可选 `timeoutMs`（0..25000，默认 25000）；返回 `{ done, timedOut, run }` |
| `POST /runs/:id/cancel` | `{}`；请求取消并返回当前状态，实际结束由 wait/查询确认 |
| `GET /changes` | 重复 `sessionId` 参数，订阅 1..4 个不同会话的 SSE |

等待超时只取消本次 waiter，不取消 Run；HTTP 断开也是如此。兄弟 Run 可以并发，浏览器必须选择明确父节点，服务端不推断 head。幂等恢复、成功节点创建条件及旧 Session 只读规则见 [Session](../sessions/session.md) 与 [Run](../execution/run.md)。

## API：Models 与目录

| 方法 / 路径 | 输入或行为 |
| --- | --- |
| `GET /models` | 执行配置及可用状态 |
| `GET /models/templates`、`GET /models/protocols` | 宿主连接模板、注册协议与字段说明 |
| `GET /models/catalog` | 目录刷新状态 |
| `POST /models/catalog/refresh` | `{}`；可取消并等待的目录刷新 |
| `GET /models/providers`、`GET /models/definitions` | 统一 Provider/Model 定义及显式协议映射产生的连接建议 |
| `POST /models/providers`、`POST /models/definitions` | 分别创建 `ProviderInput`、`ModelInput` 用户定义 |
| `POST /models/providers/:id`、`POST /models/definitions/:id` | `{ patch, expectedRevision }` |
| `GET /models/providers/:id/history`、`GET /models/definitions/:id/history` | 定义历史 |
| `GET /models/connections`、`POST /models/connections` | 列表 / 用 `ProviderConnectionInput` 创建连接，可带 `apiKey` |
| `POST /models/connections/:id` | `{ patch, expectedRevision }` |
| `GET /models/connections/:id/history`、`GET /models/connections/:id/models` | 连接历史 / 该连接全部模型的可用与不可用原因 |
| `POST /models/connections/:id/key` | `{ apiKey, expectedRevision }` |
| `POST /models/connections/:id/key/delete`、`POST /models/connections/:id/delete` | `{ expectedRevision }`；删 Key / 删连接 |
| `POST /models/connections/:id/retry` | `{}`；重试基础配置同步 |
| `POST /models/connections/:id/discover`、`POST /models/connections/:id/check` | `{}`；可取消的远端模型发现 / 连通性检查 |
| `GET /models/configurations` | 可选 `connectionId` 过滤 |
| `POST /models/configurations` | `ModelConfigurationInput`，可指定原生 `parameters`、能力和 `baseline` |
| `POST /models/configurations/:id` | `{ patch, expectedRevision }` |
| `GET /models/configurations/:id/history` | 执行配置历史 |

定义查询接受 `sourceId`、`providerId`、`search` 和字符串布尔值 `includeDeprecated`、`includeMissing`、`textOnly`。写操作的主字段白名单与完整类型以 [server.ts](../../../src/web/server.ts) 及 [Models 模块](../models/README.md) 为准。`expectedRevision` 必须为大于零的安全整数，并交由领域服务执行版本冲突检查。

Key 写入直接交给 Models Settings，查询仅返回配置状态；没有返回 Key 内容的 GET 接口。目录建议来自定义与显式 sourceMappings，不按 hostname 猜协议。保存连接/Key 后适用模型的基础配置补齐、失败重试和来源删除保留既有配置均由 Models 负责。

## API：Prompt 与 Agent 绑定

| 方法 / 路径 | 输入或行为 |
| --- | --- |
| `GET /prompts`、`GET /prompts/:id` | Prompt 列表 / 文档 |
| `POST /prompts` | `{ name, description?, kind, role, content }`，用途与角色组合由领域校验 |
| `POST /prompts/:id` | 可编辑字段及 `expectedRevision` |
| `GET /prompts/:id/versions` | 已发布版本 |
| `POST /prompts/:id/publish` | `{ expectedRevision }` |
| `GET /agents/:id/prompts` | 已绑定 Prompt 快照 |
| `POST /agents/:id/prompts` | `{ versionId }`，绑定已发布版本 |

发布前校验浏览器所见草稿 revision；权限由宿主固定身份对应的领域访问规则执行。Prompt 内容展开与首次 Run 固定 instruction/context 的行为分别由 [Prompts](../prompts/prompts.md)、[Agent Prompts](../prompts/agent-prompts.md)、Session 和 Run 决定。浏览器发送原始本次文本，不提前扩展 task-template。

## SSE 与原生视图

组件监听 Nya `runChangedEvent` 和 `runViewEvent`，转发到当前 HTTP 服务。每条流先发 `ready`，随后发 `run-changed` 刷新提示和 `protocol-view` 完整替换视图；每 15 秒空闲心跳。没有持久重放游标，初次连接/重连必须通过查询校准。

一条流订阅 1..4 个不同 Session，服务最多同时 64 条流。背压时每个 Session 仅保留最新变更提示，原生视图按 Session/Run 替换；最多缓存 128 个视图、262144 字节，超过上限或 15 秒未 drain 就关闭该流。慢浏览器不会阻塞模型回调。

运行中 `getRunView` 先使用 Run 的有效临时视图，核对会话、Run 和协议；否则从 Session 的原生记录生成投影。结束后读取持久记录生成 committed 视图。浏览器协议模块只接纳支持的协议与 `viewSchemaVersion=1`，白名单解析 text/reasoning/tool/status 和安全 HTTP(S) 引用，不用未知协议的通用降级来解释原生内容。临时帧可能合并或丢失，不能作为恢复事实或成功终态证据。

## 关闭、依赖重启与故障

`apply` 在启动监听后返回。它预先登记 server 清理 Effect，并用 `ctx.on` 注册本轮事件监听；Nya 停止本轮组件时取消监听并等待 HTTP 关闭。整个应用根关闭时，依赖提供方在 Web 等消费者退出后再清理；单独卸载 Web 不负责关闭其依赖组件。同一组件依赖重启后在原端口重新监听，不复用旧服务引用。

`WebServer.close()` 幂等：先停止准入，中止目录选择和正在等待远端的 Models 请求，释放所有 Run waiters，关闭 SSE，然后等待 SSE 退出、已登记 Models 任务实际结束和 HTTP listener 的在途请求排空。普通已接受的 Prompt/配置写入由所属服务完成，HTTP 关闭等待对应请求结束。

单独替换/卸载 Web 不取消已经接受的 Run；完整宿主通过 `harness.close()` 关闭时，Run 组件才关闭准入并取消/等待执行。模型发现、连通性检查和目录刷新因请求断开而取消；普通等待断开只释放 waiter。目录选择的具体退出保证见 [Directory Picker](directory-picker.md)。

HTTP 只返回安全 `{ error: { code } }`：非法输入 400，JSON 类型 415，体积上限 413，不存在 404，revision/幂等/协议/历史冲突通常 409，超时 504，不可用 503，未知异常 500 `internal-error`。已发头后的异常直接关闭响应，避免追加不匹配的 JSON。原始内部异常不直接发送到浏览器。

## 测试与替换边界

- [web-server.test.mjs](../../../tests/web-server.test.mjs)：HTTP 约束、Prompt 固定身份、秘密过滤、会话树、等待与取消、SSE、依赖重启、前端替换和关闭等待。
- [run-change-stream.test.mjs](../../../tests/run-change-stream.test.mjs)、[run-change-client.test.mjs](../../../tests/run-change-client.test.mjs)：背压、有界帧、断开、重连和计时器清理。
- [models-directory-web.test.mjs](../../../tests/models-directory-web.test.mjs)：目录建议、自动基础配置、多协议执行、刷新断开及真实读流退出等待。
- [protocol-web-modules.test.mjs](../../../tests/protocol-web-modules.test.mjs)、[protocol-view-client.test.mjs](../../../tests/protocol-view-client.test.mjs)：协议隔离、白名单、替换视图顺序与不兼容拒绝。

`startWebServer` 可通过 `WebCommands` 测试替身独立验证；替换浏览器或 HTTP 实现时保持显式父节点、幂等键、临时/持久状态区分和清理语义。完整验收运行 `npm run check`。
