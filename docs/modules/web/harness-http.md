# Harness HTTP 适配组件

[宿主模块](README.md) · [通用监听器](web-frontend.md)

`src/applications/harness/http/harness-http.ts` 的 `createHarnessHttpComponent(root,agents,{authenticated?})` 创建 `harness-http`，提供 `harness.http: HarnessHttpHandler`。它是执行端 Harness 安装的一部分，不持有监听端口。注入 app.activity 及认证模式下的 host.access；受信请求入口同步从根捕获当前 Session、Run、Projects、Models 和 Prompt 服务快照，缺失服务只影响对应业务。Agent 列表为只读配置。

内部 `createHarnessHttpHandler`、`models-api.ts` 负责业务路由、DTO、图片/文件、Models 管理和通知 SSE，`validation.ts` 保留 Prompt revision 等业务输入转换；不创建额外组件。每次调用固定该代服务；重启不重放旧请求。Run 通知订阅由此组件持有，通用监听器不导入任何 Harness 服务。

请求按注册归属获得 Activity 租约。已接受 Run 使用 retainUntil(waitRun) 延续租约到实际退出；关闭监听器不取消 Run。SSE/等待/目录/资源请求响应监听器 signal，OwnedCall 等待 result/done。目录浏览保留自己的观察租约，绑定认证令牌和创建它的服务代；新建目录使用该会话捕获的创建端口，不跨组件重启转交写入。创建请求同样响应断开、令牌撤销和关闭，并等待文件系统操作及清理实际退出。业务 DTO 不暴露恢复句柄、凭据或 execution。

Effect 停止新业务，取消并等待受管资源请求和 SSE、释放目录浏览句柄及通知订阅。普通已接受写入完成真实提交；整根退出仍由宿主先关闭准入与 HTTP，再交由 Nya 卸载领域资源。关闭失败保留诊断。

验证：`web-server.test.mjs`、`remote-harness.test.mjs`、`products-api.test.mjs`、`products-host.test.mjs`，根入口 npm run check。

## API：项目、会话与 Run

以下路径统一以 `/api/v1/apps/agent` 为前缀（旧 `/api/v1` 为兼容别名），动态 ID 经 URL 编解码。

| 方法 / 路径 | 输入或行为 |
| --- | --- |
| `GET /agents` | 可选 Agent ID 列表 |
| `GET /projects` | 项目列表 |
| `POST /projects` | `{path}`，目标端绝对目录，经 Projects 校验、规范化和登记 |
| `POST /projects/directories/browse` | `{action:"open",path?,query?,showHidden?}` 预留会话；`{action:"page",browseId,page}` 分页浏览 |
| `POST /projects/directories/close` | `{browseId}`，幂等关闭并等待清理 |
| `POST /projects/directories/create` | `{browseId,name}`，在已读取且属于当前认证调用方的目录下创建一个子目录，返回 201 与 `{path}`；不登记项目 |
| `GET /projects/:id/sessions` | 项目下未归档会话 |
| `POST /sessions` | `{ projectId, agentId, modelId? }` |
| `GET /sessions/archived` | 跨项目归档列表，按归档时间倒序 |
| `GET /sessions/:id` | 会话 DTO |
| `POST /sessions/:id/archive`、`POST /sessions/:id/restore` | `{}`；幂等归档 / 恢复，归档要求没有活动 Run |
| `POST /sessions/:id/model` | `{ modelId }`，持久选择配置并校验协议 |
| `GET /sessions/:id/nodes` | 必填 `parentNodeId`，根用 `root`；可选 `cursor`、`limit`（1..100，默认领域值 50） |
| `GET /sessions/:id/nodes/:nodeId` | 查询一个完整节点 |
| `GET /sessions/:id/nodes/:nodeId/path` | 查询该节点成功祖先路径，`nodeId=root` 表示空路径 |
| `GET /sessions/:id/runs` | 可选 `status=active`、`parentNodeId`（根用 `root`） |
| `GET /sessions/:id/runs/by-key/:key` | 按已接受幂等键只读查询 |
| `POST /sessions/:id/runs` | `{ parentNodeId, input, images?: [{ assetId }], files?: [{ snapshotId }], idempotencyKey, modelId? }`；显式父节点 ID 或 `null`；文本/图片/文件至少一项非空，附件由 Session 校验和原子保留 |
| `POST /sessions/:id/images` | 单图二进制流；返回 201 与受信 `ImageRef`，不接受远端 URL 或本地路径 |
| `GET /sessions/:id/images/:assetId/content` | 核对会话归属后读取原字节，返回真实 MIME，拒绝跨 origin / cross-site 请求 |
| `POST /sessions/:id/images/renew` | `{ assetIds }`（最多 8 项）；返回 `{ valid, invalid }`，不复活已过期图片 |
| `GET /runs/:id` | 已提交 Run 状态 DTO |
| `GET /runs/:id/view` | 原生白名单视图；运行中可为 provisional，结束后为 committed |
| `GET /runs/:id/events` | 可选非负安全整数 `afterSeq`，默认 0 |
| `GET /runs/:id/wait` | 可选 `timeoutMs`（0..25000，默认 25000）；返回 `{ done, timedOut, run }` |
| `POST /runs/:id/cancel` | `{}`；请求取消并返回当前状态，实际结束由 wait/查询确认 |
| `GET /changes` | 重复 `sessionId` 参数，订阅 1..4 个不同会话的 SSE |

目录浏览公开 DTO、分页上限、错误码与生命周期见[项目目录选择](../../project-directory-picker.md)。API v1 的 projects.browse 能力由实际 Projects 配置决定；浏览会话绑定认证令牌，目录操作不写项目表。旧无认证测试宿主保留的原生 pick 路由不属于生产浏览流程。

等待超时只取消本次 waiter，不取消 Run；HTTP 断开也是如此。兄弟 Run 可以并发，浏览器必须选择明确父节点，服务端不推断 head。幂等恢复、成功节点创建条件及旧 Session 只读规则见 [Session](../sessions/session.md) 与 [Run](../execution/run.md)。

## API：项目文件快照

以下路径也使用 `/api/v1/apps/agent` 前缀。所有读取与准备均经 Session 验证归属，GET 也检查 Origin 与 Sec-Fetch-Site；浏览器不能提供绝对路径。

| 方法 / 路径 | 输入或行为 |
| --- | --- |
| `POST /sessions/:id/project-files/tree/open` | `{ path }`；空路径为项目根，返回目录第一页 |
| `POST /sessions/:id/project-files/tree/page` | `{ cursorId, page }`；游标绑定会话及受信 actor |
| `POST /sessions/:id/project-files/tree/close` | `{ cursorId }`；取消并等待游标退出 |
| `GET /sessions/:id/project-files/search` | 可选 `q`，返回相对 paths 和 incomplete |
| `POST /sessions/:id/project-files/preview` | `{ path, range?: { start, end } }`，有界当前内容预览；不保存快照 |
| `POST /sessions/:id/project-files/prepare` | `{ preparationKey, selections }`，原子准备最多 8 个有序快照，返回 FileRef 数组 |
| `GET /sessions/:id/project-files/snapshots/:snapshotId` | 返回 `{ file, text }`，只读取保存内容 |
| `POST /sessions/:id/project-files/renew` | `{ snapshotIds }`（最多 8 项），返回 `{ valid, invalid }` |

selection 为 `{ kind: 'project-file', path, range? }` 或 `{ kind: 'snapshot', snapshotId }`；后者复用原内容。归档会话拒绝新的 prepare，历史读取和续期保留。单源 10 MiB、单引用 64 KiB、每轮合计 256 KiB，编码资料 1 MiB；完整限制、幂等批次、过期和退出语义见 [Project Files](../sessions/project-files.md)。

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

定义查询接受 `sourceId`、`providerId`、`search` 和字符串布尔值 `includeDeprecated`、`includeMissing`、`textOnly`。写操作的主字段白名单与完整类型以 [server.ts](../../../src/applications/harness/http/server.ts) 及 [Models 模块](../models/README.md) 为准。`expectedRevision` 必须为大于零的安全整数，并交由领域服务执行版本冲突检查。

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

发布前校验浏览器所见草稿 revision；权限由宿主固定身份对应的领域访问规则执行。Prompt 内容展开与首次 Run 固定 instruction/context 的行为分别由 [Prompts](../prompts/prompts.md)、[Agent Prompts](../prompts/agent-prompts.md)、Session 和 Run 决定。浏览器发送原始本次文本、有序图片及文件快照引用，不提前扩展 task-template。模板仅对文本替换 `{{input}}` 一次，随后附加用户文件资料，最后依次排列图片，不支持任意文本图片交错。五种协议均允许纯文件或纯图片消息；有图片时所选模型必须具备有效图片能力，无图片时沿用原文本编码。

## 图片草稿与保留

图片字节归根上的 `harness.image-assets` 组件，Web 仅经 `harness.sessions` 导入、读取和续期，不直接操作图片目录或资源表。宿主按 Agent 能力装配，在业务存储之后、Session 之前安装图片组件；`ANYBOX_IMAGE_ASSETS_DIRECTORY` 默认是 `${ANYBOX_HARNESS_DATABASE}.images`。应用关闭由宿主统一卸载根组件，应用停用卸载整个 Harness 安装。Web 不提供通用文件管理、远端 URL 抓取、格式转换、缩略图持久缓存或删除已接受历史的入口。

`image-client.ts` 统一处理文件选择、粘贴文件与拖入文件，最多同时上传两张，先分配槽位再上传以固定顺序。图片限制与宿主共享 `image/limits.ts`：静态 JPEG/PNG/WebP，每张 10 MiB、宽高各不超过 4096 像素；一条消息最多 8 张、合计 20 MiB。真正格式和完整解码由图片组件验证，不能相信扩展名、浏览器 MIME 或客户端尺寸。预览使用同源内容 URL，CSP 不开放远端图片或 data/blob URL。

草稿按 Session 与显式父节点保存文本、图片引用、文件选择和状态到 `sessionStorage`，没有图片字节/base64或文件正文；未完成上传刷新后保留失败占位，不能静默丢图后发送。当前 `PendingSubmission` v3 保存完整图片引用与文件准备状态，发往 Run 的附件 JSON 仅含 assetId/snapshotId；旧 v1 文本及 v2 图片记录仍可读取，未知或破损附件格式只恢复为待确认草稿。幂等恢复先查询已接受键，再检查当前模型与附件有效性。编辑重发与重新生成保留原图和顺序；图片未就绪、过期或模型不支持时禁止发送，纯图片可以发送。

幂等键确认未接受后，若当前能力或协议校验失败，pending 恢复到原父节点草稿并解除提交锁定。原位置已有新草稿时保留双方文字及有序图片并明确提示确认；合并草稿即使超过图片上限也可刷新恢复，但发送前必须删减到数量和字节限制以内。

未接受图片有 24 小时 TTL；工作区每 5 分钟及页面重新可见时续期所有父节点草稿和 pending 图片，每批最多 8 个，不依赖面板是否挂载或可见。提交前再续期；失效图片保留明确占位，要求用户重新添加。关闭面板只移除视图；整个工作区销毁才取消上传与保活。已接受 Run 的永久引用由 Session 事务固定，Web 移除草稿图片只停止续期，不能删掉历史资源。

## SSE 与原生视图

组件监听 Nya `runChangedEvent` 和 `runViewEvent`，转发到当前 HTTP 服务。每条流先发 `ready`，随后发 `run-changed` 刷新提示和 `protocol-view` 完整替换视图；每 15 秒空闲心跳。没有持久重放游标，初次连接/重连必须通过查询校准。

一条流订阅 1..4 个不同 Session，服务最多同时 64 条流。背压时每个 Session 仅保留最新变更提示，原生视图按 Session/Run 替换；最多缓存 128 个视图、262144 字节，超过上限或 15 秒未 drain 就关闭该流。慢浏览器不会阻塞模型回调。

运行中 `getRunView` 先使用 Run 的有效临时视图，核对会话、Run 和协议；否则从 Session 的原生记录生成投影。结束后读取持久记录生成 committed 视图。浏览器协议模块只接纳支持的协议与 `viewSchemaVersion=1`，白名单解析 text/reasoning/tool/status 和安全 HTTP(S) 引用，不用未知协议的通用降级来解释原生内容。临时帧可能合并或丢失，不能作为恢复事实或成功终态证据。

## 关闭、依赖重启与故障

`apply` 创建业务 handler、登记清理 Effect 和本轮事件订阅后返回，不创建监听端口。Nya 停止本轮组件时撤销事件订阅并等待 handler 清理；稳定控制依赖恢复后创建新 handler。业务组件不构成 handler 的注入依赖，其卸载由应用活动屏障或整根关闭顺序保护。每个请求同步捕获当前服务，旧请求不转交给重启后的服务。

应用宿主先调用 `host.http.close()` 停止 HTTP 准入并排空已接受写入，再卸载可选业务组件和整个根；关闭监听器不等待已交接的 Run。

`HarnessHttpHandler.close()` 幂等：先停止业务准入，中止未完成请求体、目录选择、图片上传/读取、项目文件操作和正在等待远端的 Models 请求，释放 Run waiters，关闭 SSE，再等待已登记 handler、流、Models/附件任务和目录浏览清理实际退出。监听 socket 和通用 HTTP 请求集合由宿主监听器关闭。普通已接受的 Prompt/配置写入、归档/恢复及附件续期由所属服务完成，handler 等待对应请求结束。附件请求断开会显式取消 `OwnedCall`；HTTP 成功响应和关闭都等待 `result` 与 `done`，不能以结果已就绪代替真实退出。

单独替换/卸载 Web 不取消已经接受的 Run；完整应用宿主 `close()` 先同步关闭控制与 Run 准入并取消准备，再等待 API 请求和装配操作结束，最后由 Nya 卸载 Run 组件、取消并等待执行。模型发现、连通性检查和目录刷新因请求断开而取消；普通等待断开只释放 waiter。目录选择的具体退出保证见 [Directory Picker](directory-picker.md)。

HTTP 只返回安全 `{ error: { code, fileIndex? } }`，fileIndex 仅在有效文件位置错误时返回：非法输入 400，JSON 类型 415，体积上限 413，不存在 404，revision/幂等/协议/历史冲突及归档限制通常 409，超时 504，不可用 503，未知异常 500 `internal-error`。已发头后的异常直接关闭响应，避免追加不匹配的 JSON。原始内部异常不直接发送到浏览器。

## 测试与替换边界

- [image-client.test.mjs](../../../tests/image-client.test.mjs)：上传保序、并发、取消、草稿恢复、跨父节点续期与批量上限。
- [session-client.test.mjs](../../../tests/session-client.test.mjs)：纯图片/文件提交、pending v3 与旧记录恢复、编辑/重新生成、过期引用、归档只读及已接受幂等键恢复。
- [archive-client.test.mjs](../../../tests/archive-client.test.mjs)：归档列表、恢复、读请求取消和过期响应隔离。
- [products-api.test.mjs](../../../tests/products-api.test.mjs)：空工作台常驻 API、可选服务重装、写入与 Run 活动归属、SSE 停用、产品操作断连和网关身份绑定。
- [products-host.test.mjs](../../../tests/products-host.test.mjs)：真实客户端与两个执行端、远程打开不启动本地执行、连接归属、数据保留、重启恢复与停止。
- [web-server.test.mjs](../../../tests/web-server.test.mjs)：HTTP 约束、Prompt 固定身份、秘密过滤、会话树、等待与取消、SSE、依赖重启、前端替换和关闭等待。
- [run-change-stream.test.mjs](../../../tests/run-change-stream.test.mjs)、[run-change-client.test.mjs](../../../tests/run-change-client.test.mjs)：背压、有界帧、断开、重连和计时器清理。
- [models-directory-web.test.mjs](../../../tests/models-directory-web.test.mjs)：目录建议、自动基础配置、多协议执行、刷新断开及真实读流退出等待。
- [protocol-web-modules.test.mjs](../../../tests/protocol-web-modules.test.mjs)、[protocol-view-client.test.mjs](../../../tests/protocol-view-client.test.mjs)：协议隔离、白名单、替换视图顺序与不兼容拒绝。

`createHarnessHttpHandler` 可通过 `HarnessApiCommands` 测试替身和通用监听器独立验证；替换浏览器或 HTTP 实现时保持显式父节点、幂等键、临时/持久状态区分和清理语义。完整验收运行 `npm run check`。

## 项目文件引用

输入框支持 @ 搜索或“引用项目文件”，默认整文件，预览可选择闭区间行范围。搜索包含点文件及 ignore 文件，仅排除元数据和依赖目录。发送时通过 Session 准备不可变快照，再以 ID 提交 Run。pending v3 先保存准备键，取得快照后先保存 ID，再发送；重试和重新生成默认复用快照。历史预览读取快照，编辑可显式更新为当前文件。

HTTP 路由见上方接口表，跨组件恢复规则见[文件引用设计](../../project-file-references-design.md)。文件操作使用既有请求取消/实际退出包装，错误只暴露固定 code 及可选 fileIndex。[draft-client](../../../src/applications/harness/web/draft-client.ts) 是通用草稿存储，[file-client](../../../src/applications/harness/web/file-client.ts) 管理文件待提交和 5 分钟租期，[file-view](../../../src/applications/harness/web/file-view.ts) 拥有各面板的候选查询与附件卡片；右栏文件标签拥有预览，内部树客户端拥有分页和游标关闭。组件关闭/面板卸载取消对应展示操作，不取消 Run。三栏状态、抽屉和文件引用规则见[工作区设计](../../harness-three-column-workspace.md)。

## 会话归档

公开 `GET /api/v1/sessions/archived`、`POST /api/v1/sessions/:id/archive` 和 `POST /api/v1/sessions/:id/restore`；静态归档路由先于 ID 路由，投影包含可空 archivedAt。不存在返回 404，`session-archived` / `session-has-active-runs` 返回 409。通过本次请求获取的 Session 服务执行，不新增组件或数据库。

项目菜单提供归档；侧栏统一对话框跨项目查看和恢复。成功归档关闭对应分屏并保存布局，保留草稿与位置；归档历史可显式打开或通过直达链接只读查看。恢复刷新列表及已打开面板，不自动打开未显示会话。控制器和视图共同禁止输入、附件添加、选模和重跑；附件历史仍可读取。会话轮询发现未归档→已归档时关闭面板，页面重新可见刷新列表；不新增 SSE 事件。未知提交先查幂等结果，未接受输入合并回原位置草稿，不自动重发。

内部 `archive-client.ts` 管理归档列表读请求、过期响应隔离及对话框，归 Workspace 关闭，不是 Nya 组件。[HTTP 测试](../../../tests/web-server.test.mjs)、[控制器测试](../../../tests/session-client.test.mjs) 和 [归档列表测试](../../../tests/archive-client.test.mjs) 覆盖入口、只读、草稿恢复和请求乱序。
