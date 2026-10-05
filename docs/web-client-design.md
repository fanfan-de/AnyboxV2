# 薄 Web 客户端第一版

> Anybox Harness 浏览器与客户端网关分别位于 `src/applications/harness/web/` 和 `src/applications/harness/client/`；Anybox 外壳位于 `src/host/web/`。所有正式业务请求经连接 ID 路由。以下原有业务 API、对话树和展示语义沿用；旧本机直连与单进程启动描述已由[模块边界](harness-module-boundary.md)、[部署说明](harness-server-deployment.md)取代。

状态：本机单用户参考实现，2026-10-02。已接入公共模型目录、四种原生协议、原生参数配置、按会话绑定协议与安全 Turn 视图，以及项目导航、会话、项目文件的三栏工作区；保留最多四个跨项目会话面板、拖拽分屏、标签页内布局恢复、会话树显式查看位置、多 Run 状态和 Nya Event → SSE 变更通知。旧文本会话仅供查看。验证使用临时数据库与受控模型，不访问真实凭据或工作区数据库。

## 边界

浏览器通过同源连接网关转发到宿主 `/api/v1`。应用宿主在同一个 Nya 根上常驻业务存储、访问认证、产品管理、活动准入及 `host-application-api`；打开 harness server 时安装 `packages/models` 的配置存储、系统凭据、模型服务、公开目录来源/缓存/服务、Responses、标准 Chat Completions、Anthropic Messages 和 Gemini Interactions，同时装配 harness server 的执行组件。客户端外壳常驻 app.client-http，打开 Anybox Harness 后才在客户端根安装连接管理、目录选择器和代理；本地/远程目标选择属于 Anybox Harness。统一 Provider/Model 定义带 user/external 来源，多个 ProviderConnection 同时可用，实际执行使用 ModelConfiguration；这些都是数据记录，不为每条连接创建 Context 或组件。Models 配置直接使用独立的 `data/models.json`，公开目录使用 `data/models-catalog.sqlite`，业务会话保留在 `data/harness.sqlite`；JSON、旧 SQLite 导入源和各数据库不能共用文件或文件别名。路径和凭据命名空间可由启动配置指定。JSON 配置只保存凭据引用，密钥值仅存入系统凭据库。

`ANYBOX_LLM_*` 保留为新 Models 数据库的初次迁入参数；已有连接/配置不会被环境变量覆盖。Models 能力首次启用时建立显式用户定义、迁入连接和稳定 `default` 配置，将旧参数转换为对应协议的 `parameters`，并尝试把旧凭据复制到 Models 管理的系统凭据条目；旧密钥缺失或系统凭据库暂不可访问时仍允许进入设置。后续连接、模型、生成参数及 Key 可通过 `models.settings` 修改并原子保存 JSON，不需要重启应用。能力在界面只读展示，人工修正需停止所属执行设备的 Agent，编辑 `configurations[].capabilities` 后重新启动；文件是实际配置存储，无运行期监听，运行中改文件使后续保存返回冲突。文件结构与兼容导入见 [JSON 配置存储](modules/models/json-store.md)。变量详情见 [README](../README.md#本机-web-界面)。执行宿主拥有稳定业务 HTTP 监听器，客户端应用外壳提供静态页面；进程信号由入口处理，经应用宿主 `close()` 关闭整个根。harness server 负责项目、Session、Run 准入、幂等、工具执行、取消和结算；协议 Driver/Loop 通过 Runtime 执行并生成安全视图，Models 提供原生 execution、凭据和传输边界。

页面使用原生 TypeScript、HTML 和 CSS。`src/host/web/client.ts` 只负责应用目录、打开和关闭，`harness-page-client.ts` 在 Anybox Harness 内管理连接、设备目标和工作区生命周期，`agent-client.ts` 挂载工作区及设置分类，`models-client.ts` 管理连接/模型配置表单及跨面板共享的已保存模型列表，`models-directory-client.ts` 独立管理公共目录状态、查询、刷新和短暂轮询；`workspace-layout.ts` 提供纯布局函数，`workspace-client.ts` 管理工作区，`session-client.ts` 管理各会话请求与 Run 视图快照，`session-view.ts` 管理面板和稳定的 Turn 挂载点，`protocols/view.ts` 管理共享 Turn 容器，四协议内容模块分别实现块渲染并使用服务端公共展示白名单与 reducer，`tool-trace.ts` 归并统一工具库及旧 Bash/Apply Patch 的展示状态，`prompt-client.ts` 保留 Prompt 设置，`tools-client.ts` 管理固定执行设备上的 Agent 工具选择。浏览器运行时代码只使用浏览器 API；Models 类型导入仅用于编译检查，不向浏览器加载 Nya 或 Models 的服务端代码。

模型服务主页面展示“我的连接”；添加连接流程以可搜索、可滚动的列表同时展示多个 Provider 定义，按定义 ID 显示来源、已有连接数量及当前选中项。点击提供方后在右侧填写连接配置，连接方案、模型目录预览和自定义连接入口沿用原流程。列表选择仅填写草稿，不创建连接或修改会话选模；目录状态更新保留列表按钮焦点。

`src/host/component.ts` 只注入常驻的产品、活动及访问服务，接收通用应用目录；`http-server.ts` 根据已注册路由确定应用并登记活动。harness server 自己的 `harness-http.ts` 在首次异步工作前从受信根捕获本次服务快照，`http/handler.ts` 处理业务路由。业务查询取自 `harness.sessions`，执行控制取自 `harness.runs`，已保存模型查询取自 `models`，配置和 Key 操作取自 `models.settings`，统一目录定义也取自 `models.settings`；`models.catalog` 仅提供来源状态和刷新。Web 不依赖旧 `credentials.settings`，也不向前端提供凭据读取服务或协议注册服务。

公开 Session 包含选定的 `modelId`、`historyMode` 和首次原生 Run 固定的 `protocolId`；公开 Run 包含实际 `modelId`、调用者显式指定的 `requestedModelId`、`protocolBinding` 和不含秘密的 `modelSnapshot`（新写入 schemaVersion 3，含原生参数；旧快照只读且不重写）。Agent 指令、Prompt 内容快照、execution 句柄、原生续轮记录与密钥不进入普通 Session/Run DTO。Bash 命令和输出摘要、Apply Patch 预览和结果仍可展示；Prompt 管理单独返回可管理文档和版本。模型管理接口仅返回 Key 是否已配置，绝不回传密钥值或内部凭据引用。

工作区设置增加“Agent 工具”，按所选执行设备和 Agent 查询统一工具目录及独立修订。用户按功能分类、名称/描述与来源过滤后自由勾选单个工具，来源不绑定模型或其他工具；明确依赖由用户补选后才可保存。保存仅影响新会话，空选择明确关闭工具。每个 Agent 保留独立草稿，设备请求目标固定，冲突保留当前选择并要求显式重新加载；未保存或进行中的保存参与离开检查，关闭取消读取并等待已提交写入。toolId 和固定声明不添加 instanceId，会话等业务资源仍归原设备。

Session 创建事务复制工具 ID、版本和完整声明，输入区只读显示原始工具名称与来源。首次 Run 保存 initialization v2，此后同会话所有分支和重新生成使用固定声明；已有 v1 历史保留原 Bash/Apply Patch 读取兼容。工具卡显示真实命令、进程状态/退出码/信号、输出、文件事实及搜索结果，原始 JSON 可展开。图片只按本会话已保留引用生成认证缩略图 URL；每个 Run 的轨迹组展示最新已观察计划或 todo 列表。通用进程关闭事件仅白名单公开退出字段，并补充对应 exec/stdin 卡的最终状态；取消、清理失败仍展示已发生的退出、部分文件变更和图片事实。验证见 `tests/agent-tools.test.mjs`、`tests/tools-client.test.mjs`、`tests/tool-call-view.test.mjs` 和 `tests/tool-trace.test.mjs`。

停止 harness server 时同步冻结准入：有用户任务或写入则拒绝；空闲时结束观察并等待只读请求退出，再释放执行组件。关闭 Anybox Harness 客户端只释放连接、目录选择和代理，不停止远程 Run。稳定 HTTP 监听器保持运行。应用整体关闭先关闭准入并等待控制与装配退出，再同时进行 Nya 根清理与 HTTP 排空；HTTP 的 Run 保留租约需要根清理取消后实际退出，不能在根清理前等待这些租约。目录刷新请求断连会取消其来源操作并等待 reader 实际退出。Web 单独关闭不取消已交给 harness server 的 Run，应用根关闭则按依赖顺序取消并等待所有执行。前端不保存权威业务状态，不直接连接 Provider、SQLite 或系统凭据库。

## 本机协议

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/v1/agents` | 返回全局 Agent `{id}` 列表 |
| `GET /api/v1/tools` | 返回统一工具目录，含稳定 toolId、版本、原始名称、分类、可选来源与明确依赖 |
| `GET /api/v1/agents/:id/tools` | 该设备 Agent 的新会话工具 ID 选择与独立 revision；未保存时返回默认选择 |
| `POST /api/v1/agents/:id/tools` | 用 `{toolIds,expectedRevision}` CAS 保存；空数组关闭工具，拒绝未知项或缺少依赖；仅影响新会话 |
| `GET /api/v1/projects` | 返回项目 ID、名称、规范化目录路径和可用状态 |
| `POST /api/v1/projects/directories/browse` | open 预留浏览会话；page 读取有界当前层目录 |
| `POST /api/v1/projects/directories/close` | 关闭浏览会话并等待句柄清理 |
| `POST /api/v1/projects` | 确认后的绝对路径登记，realpath 后复用已有项目 |
| `GET /api/v1/projects/:id/sessions` | 列出项目下的 Session |
| `GET /api/v1/agents/:id/session-defaults` | 返回该设备上指定 Agent 的新会话默认模型覆盖、启动后备值、有效值和 revision |
| `POST /api/v1/agents/:id/session-defaults` | 用 `{modelId: string \| null,expectedRevision}` CAS 保存可用配置覆盖；null 恢复启动后备值，初始 revision 为 0 |
| `POST /api/v1/sessions` | 用 `{projectId,agentId,modelId?}` 创建 Session；创建事务按显式模型、已保存 Agent 覆盖、启动后备值复制 modelId，无默认时为 `null` |
| `POST /api/v1/sessions/:id/model` | 用 `{modelId}` 保存会话选择；只影响后续 Run |
| `POST /api/v1/sessions/:id/project-files/tree/open` | 用 `{path}` 打开相对目录并返回第一页，空路径表示项目根 |
| `POST /api/v1/sessions/:id/project-files/tree/page` | 用 `{cursorId,page}` 读取下一页，校验会话及受信 actor |
| `POST /api/v1/sessions/:id/project-files/tree/close` | 用 `{cursorId}` 幂等关闭并等待目录句柄退出 |
| `GET /api/v1/sessions/:id` | 读取 Session 元数据、`projectId`、`modelId`、不可变 `toolSelection`、`historyMode` 与 `protocolId`，不返回 turns |
| `GET /api/v1/sessions/:id/runs` | 列出会话的 Run，支持 `status=active` 和 `parentNodeId` 过滤（`root` 表示虚拟根） |
| `POST /api/v1/sessions/:id/runs` | 用 `{parentNodeId: string|null,input,images?: {assetId}[],idempotencyKey,modelId?}` 接受 Run；父节点必填，显式模型与有序图片引用参与幂等比较 |
| `GET /api/v1/runs/:id` | 读取公开 Run 的 `history`、`revision`、状态、模型 ID/快照与 `resultNodeId`/结果 |
| `GET /api/v1/runs/:id/view` | 读取安全、可替换的完整协议视图；运行中取 Runtime 快照，终态从原生记录重建；旧 Run 返回 null |
| `GET /api/v1/runs/:id/events` | 支持 `afterSeq` 增量读取 Run 的过程事件；按工具名返回 `tool-*` 事件；Bash 的 stdout、stderr 和 Apply Patch 补丁预览分别最多 2048 UTF-8 字节；补丁结果保留变更、未完成项和诊断，不返回内部快照 |
| `POST /api/v1/runs/:id/cancel` | 请求取消，返回当前 Run 状态 |
| `GET /api/v1/sessions/:id/nodes/:nodeId` | 完整节点 |
| `GET /api/v1/sessions/:id/nodes/:nodeId/path` | 根到节点的路径，`root/path` 为空 |
| `GET /api/v1/sessions/:id/nodes?parentNodeId=…` | 直接子节点分页，父节点必填；root 为根；支持 cursor、limit，返回 nodes、nextCursor |
| `GET /api/v1/sessions/:id/runs/by-key/:key` | 只读查回已接受请求，包括旧 Run |
| `GET /api/v1/runs/:id/wait?timeoutMs=…` | 0..25000 毫秒，默认 25000；返回 done、timedOut 与 run |
| `GET /api/v1/changes?sessionId=…&sessionId=…` | SSE；订阅 1..4 个不同且存在的会话，先发送 `ready`，再发送 `run-changed` 提示和 `protocol-view` 完整替换快照 |
| `GET /api/v1/models` | 模型列表、可用状态与有效能力；供所有会话选择器使用 |
| `GET /api/v1/models/protocols` | 已安装协议、表单字段描述、发现和检查能力 |
| `GET /api/v1/models/templates` | 宿主提供的连接模板；模板只预填配置 |
| `GET /api/v1/models/catalog` | 独立目录状态：快照、最近检查、陈旧/刷新中、持久化及固定错误码 |
| `POST /api/v1/models/catalog/refresh` | 用 `{}` 手动后台来源检查；断连取消，等待实际退出与已接纳缓存提交 |
| `GET /api/v1/models/providers?search=…` | 统一 Provider 定义、来源/状态和根据已安装协议生成的连接方案 |
| `POST /api/v1/models/providers` | 用名称、文档地址、connectionHints 创建用户 Provider 定义 |
| `POST /api/v1/models/providers/:id`、`GET …/:id/history` | 用户定义 CAS 编辑与不可变历史；外部来源定义不可直接编辑 |
| `GET /api/v1/models/definitions?providerId=…&search=…&includeDeprecated=…` | 统一 Model 定义、来源/状态、能力/价格/模态/限制和模型连接方案 |
| `POST /api/v1/models/definitions`、`POST …/:id`、`GET …/:id/history` | 用户模型定义创建、CAS 编辑和历史 |
| `GET /api/v1/models/connections` | 账号连接、版本、credentialConfigured 和 pending/ready/failed 同步状态 |
| `POST /api/v1/models/connections` | 关联内部 providerDefinitionId，保存连接与可选 API Key，自动准备适用基础模型 |
| `POST /api/v1/models/connections/:id` | CAS 修改连接，协议和所属 Provider 定义固定 |
| `POST /api/v1/models/connections/:id/delete` | 用 expectedRevision 删除当前连接及全部配置；清理 Key，保留定义、历史与已打开 execution |
| `POST /api/v1/models/connections/:id/key`、`POST …/:id/key/delete` | 设置/替换/删除 Key，仅影响新 execution |
| `GET /api/v1/models/connections/:id/history` | 不含旧 Key 的连接历史 |
| `GET /api/v1/models/connections/:id/models` | 全部模型及其可用状态/原因与已有基础配置 ID |
| `POST /api/v1/models/connections/:id/retry` | 显式重试缺失基础模型同步，幂等且保留已有参数 |
| `POST /api/v1/models/connections/:id/discover`、`POST …/:id/check` | 获取候选或检查连接；不自动覆盖定义/配置，无生成调用 |
| `GET /api/v1/models/configurations` | 可编辑的本地模型记录 |
| `POST /api/v1/models/configurations` | 关联 modelDefinitionId 和 connectionId 创建配置，参数使用 `{protocolId,formatVersion:1,value}`；额外预设 baseline:false |
| `POST /api/v1/models/configurations/:id` | CAS 修改参数、名称、能力或启停；所属模型定义/连接固定 |
| `GET /api/v1/models/configurations/:id/history` | 模型不可变版本历史 |
| `GET /api/v1/prompts` | 列出本机用户的 Prompt 文档和草稿 |
| `POST /api/v1/prompts` | 用 `{name,description?,kind,role,content}` 创建草稿 |
| `GET /api/v1/prompts/:id` | 读取可管理文档及草稿修订号 |
| `POST /api/v1/prompts/:id` | 用 `{expectedRevision,...patch}` 修改草稿；允许字段同创建接口 |
| `GET /api/v1/prompts/:id/versions` | 按发布顺序读取不可变版本 |
| `POST /api/v1/prompts/:id/publish` | 用 `{expectedRevision}` 发布当前已保存草稿 |
| `GET /api/v1/agents/:id/prompts` | 读取 Agent 各用途的当前内容，包括内置默认指令 |
| `POST /api/v1/agents/:id/prompts` | 用 `{versionId}` 将已发布版本应用到 Agent 的对应用途 |

除 SSE 外，成功响应是 JSON。失败响应是 `{ "error": { "code": "..." } }`；已知输入错误、对象不存在、准入冲突或项目不可用、服务不可用分别使用 400、404、409、503，未知错误统一为 500，不传出内部异常。Models 配置冲突返回 `409 conflict`，无效配置/能力组合返回 400，网络超时返回 504；凭据、协议或远端服务不可用使用固定错误类别和 503。写请求要求同源 `Origin` 和 JSON；所有请求要求本机地址的 `Host`，宿主只监听 `127.0.0.1`，不开放 CORS。本机单用户版本没有账号或远程访问能力。

连接详情顶部提供“删除连接”，先显示账号名、模型配置数量和影响说明，确认后才提交 CAS 删除。成功后清除该账号的草稿并刷新共享模型列表，选择剩余账号或进入添加流程；历史对话与已接受 Run 保持原快照，原会话保留模型 ID 并提示重新选模。刷新也会处理被其他页面删除的当前连接。删除最后一个连接后，启动不会重新迁入旧默认连接。

## 新会话默认模型

“设置 → 会话设置”在 Agent 选择器下提供“新会话默认模型”，只管理当前执行设备的 Agent 默认值。用户明确选定可用执行配置后点击“保存默认模型”；选项“使用 Agent 默认模型”清除持久覆盖，没有启动后备值时显示“未设置默认模型”。刷新仅更新状态，草稿不同于已保存值时操作改为“放弃修改并重新加载”，不自动覆盖未保存选择。草稿按 Agent 保留，未保存修改参与设备切换及界面重建检查。

权威值由已有 Session 组件保存到执行端业务 SQLite，`run-state` v8 增加按 Agent 的默认模型记录；客户端只展示和提交，不将其当作 sessionStorage 查看偏好。响应包含 agentId、可空 modelId 覆盖、可空 fallbackModelId、可空 effectiveModelId 与 revision。保存非空覆盖必须是当前可用的 Models 执行配置 ID；浏览器与网关在请求和响应间转换 instanceId 作用域，不能将一个设备的默认保存到另一设备。

点击新建会话仍只提交项目及 Agent，Session 在创建事务中按显式模型、持久覆盖、只读 Agent 启动默认、null 的顺序复制模型 ID。保存默认只影响之后创建的会话；当前会话切换模型不修改默认，打开历史、目录刷新、模型列表排序及其他面板选模也不更新它。已有 Run 保持显式输入、Session 选择、Agent 启动默认的优先级，协议仍由第一次接受 Run 固定。

已保存模型随后停用、删除 Key 或删除连接时，保留默认 ID 并显示不可用原因，新会话也保留该选择，不静默改用其他账号或协议。没有可用默认时会话可创建，但发送前仍需选定可用模型。保存使用非负安全整数 expectedRevision；过期写入返回 `409 session-defaults-conflict`，保留草稿，由用户明确重新加载后处理；未知写入结果不自动重试。组件关闭停止新默认调用并等待已接受写入实际提交。

`tests/session-defaults.test.mjs` 验证初始化继承、显式优先、Agent 隔离、CAS、创建事务时机、已有会话保持、无效引用、重启与关闭等待；HTTP、代理与浏览器 API 测试覆盖输入边界、同源限制及设备归属。没有新增 Nya 组件、Models 默认属性、数据库连接或项目级继承。

## Run 变更通知与协议视图

Session 组件在接受 Run、记录过程、请求取消和结算的事务成功后，通过 Nya `harness.run.changed` 发布冻结的 `{sessionId, runId, revision}`。只通知实际变化；幂等重复、无变化调用和回滚不发布。版本取自对应事务，通知不携带消息、Prompt、凭据或原生错误。持久化的 RunEvent 与查询接口仍是事实来源，完成通知包含的 revision 对应终态及成功节点已一起提交的状态。

Web 组件用 `ctx.on()` 订阅，监听器只向 SSE 发送队列入队。监听注册由 Nya Effect 管理，HTTP 层拥有连接、心跳、待发送队列和清理等待。发布方使用 `ctx.parallel()` 等待分发并隔离错误，记录固定日志，不将已提交操作返回成失败；监听器不得等待客户端网络或启动 Run 工作。模型/工具的执行、取消、`waitRun` 和资源 `done` 仍走原服务契约。

每个工作区共用一个 EventSource，分屏订阅集合变化时替换连接。SSE 拒绝未知参数、重复会话、超过四个会话、缺失会话及跨源浏览器请求；会话 ID 最多 1024 字符，单个 Web 实例最多 64 条连接。会话校验结束后再次检查关闭与断开状态。连接建立后发送 `ready`，每次 ready（包括自动重连）都触发查询补齐；不提供独立事件回放游标。`run-changed` 只用于标记会话需要刷新，允许合并和重复，客户端按 Run revision 合并状态、按 afterSeq 补齐过程记录。

每条连接最多保留四条待发送提示，每个会话只留最近一条；背压期间暂停写入，15 秒未排空则关闭连接，由客户端重连并补查。空闲时每 15 秒发送注释心跳。连接断开清除发送任务、心跳和监听；Web 关闭主动销毁流并等待实际关闭，避免长连接阻塞 HTTP 退出。组件重启重新订阅，旧连接由浏览器重连恢复。

协议 Loop 通过 Runtime 发布 `harness.run-view`，载荷为 `{sessionId,runId,sequence,frame:{protocolId,schemaVersion,exchangeId,payload}}`；`payload` 是安全投影的完整 `ProtocolViewSnapshot`。Runtime 持有最新快照，Web 组件重启不会丢失运行期展示。Web 解码后在同一 SSE 连接发送 `protocol-view`，数据为 `{sessionId,runId,snapshot}`。它不进入持久 RunEvent，也不递增 Run revision。每连接最多积压 128 个不同 Run 的快照或 256 KiB，同一 Run 未发送的旧帧由新帧替换；超限只关闭展示订阅。模型调用不等待网络消费者，`run-changed` 仍优先用于事实同步。

快照明确携带 `envelopeVersion:1`、`viewSchemaVersion:2`、`protocolId`、Session/Run 身份、独立的 `viewRevision`、`provisional/committed` 状态和有序 exchange/block。内容以带协议前缀的 `type` 判别，各协议分别定义原生类型、纯投影、流式归约和 Web 组件：Responses message/output_text/refusal、reasoning、function_call、web_search_call；Anthropic text、thinking、redacted_thinking、tool_use、server_tool_use、web_search_tool_result；Chat content、reasoning_content、refusal、tool_call；Gemini model_output/text、thought、function_call。消息阶段和原生停止状态附着在所属消息或 exchange，不代替 Run 结算状态。

应用投影限制单快照最多 48 KiB，裁剪保留唯一提示并移除无法定位的引用。Web 按协议白名单解码，拒绝无效身份、结构、版本及引用范围；不显示任意 raw response、签名、redacted 正文、原生续轮对象或密钥。失败诊断只展示已保存的白名单部分内容与状态，明确标记而不推断缺失信息。引用仅允许不带用户名/密码的 HTTP(S) URL；Markdown 使用固定 DOM 标签与文本节点构建，链接使用 `noopener noreferrer`。客户端、执行设备与 Web 资源同步升级，旧或未知展示版本明确不兼容；旧原生记录 v1/v2 查询时重新投影为展示 v2，旧 binding 和历史 JSON 保留，展示版本不构成原生恢复的新门槛，无需数据库迁移。

每次 `ready`、恢复可见或校准读取后，控制器为活动 Run、当前路径及展开对象查询 `/view`。运行中查询优先读 Runtime；终态查询从 Session 原生记录投影，并使用 `committed` 状态。reducer 按 Session/Run/协议隔离，忽略同状态下重复或倒退的 `viewRevision`，允许终态覆盖临时态，拒绝终态之后的迟到临时帧。完整替换使漏帧、乱序和断线重连不会拼接错误文本；终态仍以持久 Run 与成功节点为准。控制器缓存按 Run 隔离并回收非可见历史，最多保留 64 个非当前视图缓存项。

共享线程通过 `protocols/modules.ts` 的静态 `getProtocolWebModule` 选择协议模块，不解释原生语义。Responses、标准 Chat Completions、Anthropic 与 Gemini 各自绑定 `encodeInput/decode/reduce/mount` 和内容类型分派，共用文本编码器与 Turn 容器；模块解码与挂载拒绝其他协议或未知版本，未知协议没有通用回退，输入也不能提交。文本编码保留原文，模板只在服务端处理一次。Turn 按 Run 固定挂载，内部按 exchange/block 和嵌套内容身份更新，保留交互容器。Responses/Gemini 显示“推理摘要”，Anthropic thinking 显示“思考内容”，Chat reasoning_content 显示“推理内容”，redacted_thinking 显示隐藏占位；默认折叠，标题显示生成状态，当前面板手动展开在流式、引用更新与终态替换中保留，刷新后恢复默认。对话区和轨迹明细共用协议组件、分别保存交互选择。composer 支持一段文本加有序图片：文件选择、粘贴和拖入共用保序上传队列；四种协议在配置具备有效图片能力时均可提交图片。图片使用 Session 归属的不可变引用，浏览器不生成原生 image_url，也不执行工具。运行退出和清理全部完成后才结算，最终历史展示由持久记录重建。

对话与轨迹明细的模型正文、可公开推理文本，以及没有原生视图时的已保存助手回答，通过 `markdown.ts` 按 CommonMark 与 GFM 解析并创建 DOM。支持标题、粗体/斜体、删除线、引用、列表、禁用交互的任务勾选框、行内代码、带复制按钮的代码块和可横向滚动的表格。用户输入、协议状态及工具命令/输出/补丁继续按原文显示。流式帧每次以当前完整文本重新解析对应内容，未闭合的代码围栏也可阅读；更新只替换已变化内容，保留协议 Turn、原生组件和折叠容器的挂载身份。此处理仅改变浏览器展示，不修改原生记录、历史正文或恢复语义。

Markdown 内嵌 HTML 保留为字面文本；链接仅接受不含账号信息的绝对 HTTP(S) URL，并使用 `noopener noreferrer` 打开新窗口。模型输出中的远程图片只展示替代文字与安全链接，不加载图片资源；用户上传的同源附件仍走既有图片预览。原生引用按原始 Markdown 的源位置添加编号，并保留协议视图的来源列表；无位置的安全引用作为块级来源，不以渲染后的 HTML 或字符数解释引用偏移。当前不执行数学公式或 Mermaid，相关围栏仍作为可复制代码显示。

渲染设置 1,048,576 字符、20,000 个语法节点及 64 层嵌套的展示边界；解析或渲染异常、超出总长度/节点预算时完整回退原文，深层子树局部回退源文本。引用结束点落在实体、代码或链接中时放在对应语义节点之后，避免插入原文破坏 Markdown 或生成嵌套链接。来源列表仍保留原文片段说明。

Prompt 操作者由 Web 宿主固定为持久身份 `local-web-user`，浏览器不能提交 `actorId` 或所有者字段。组件仍检查文档所有权和 Agent 管理权限；其他宿主身份创建的文档不会自动归属本机用户。修订冲突返回 `409 prompt-conflict`，发布冲突返回 `409 prompt-publication-conflict`，权限拒绝返回 `403 prompt-forbidden`。创建和编辑请求允许最多 1 MiB JSON，随后由 Prompt 领域校验 100000 字符的内容限制；其他请求继续采用 64 KiB 上限。

HTTP 等待超时、断开或 Web 单独关闭只释放等待者，不取消 Run。详细合约、迁移与客户端语义见[对话树实施记录](./session-conversation-tree.md)。

顶部“分支”打开当前会话面板内的覆盖式树总览，不挤占线性阅读列。总览展示虚拟起点、轮次短摘要及分叉连接线，高亮当前祖先路径与选定节点；点击成功节点切换查看和发送起点，展开按钮独立折叠后续子树，“定位当前”展开并定位当前祖先。各轮操作旁显示同父成功分支的序号与前后切换，序号本身可在总览中定位。running/cancelling 以独立状态行挂到其父位置，点击进入轨迹，不构成可续接节点。树索引只消费已查询的真实节点和原生会话明确的成功 Run 关系，旧会话不补造分支；不新增 HTTP 或持久字段。总览开关、折叠、焦点及滚动由每个面板独立持有，切换轨迹临时隐藏；关闭、Esc 或点击面板内的外部区域收起，关闭按钮和 Esc 返回开关焦点。行为验证见 `tests/conversation-tree-view.test.mjs` 与 `tests/session-view.test.mjs`；`tests/helpers/conversation-tree-browser-host.mjs` 提供常规、320px 和四分屏的内存样本。

工具过程按 `name` 区分 `bash` 与 `apply_patch`，事件使用 `tool-started`、`tool-observed`、`tool-failed`；旧 Bash 事件由状态读取边界归一化后再发布。对话与轨迹共用工具事实组件，按 Run、来源模型 exchange、请求 ID、工具名和事件位置关联持久记录，同一 ID 在后续模型批次重新使用时仍保留两条记录。不生成 `tools-N` 临时结果，也不把模型请求或服务端搜索状态当作本地工具完成；事件尚未读取、读取失败和结果缺失分别提示。Apply Patch 卡片显示 `applied/rejected/partial/cancelled`，保留已完成的文件变更、未完成操作和诊断；部分提交或移动未删源不会显示成完整成功。清理失败仍显示已知变更事实，状态显示失败。补丁预览单独标注截断，不影响持久记录或模型收到的工具结果。

对话显式选择协议 Turn 的 `presentation:'compact'`；轨迹模型明细显式选择 `detail`（默认模式），工具行直接打开完整详情。紧凑工具默认使用约 32px 摘要行，显示名称、动作、真实状态及可取得的已结束耗时；长动作单行省略，窄面板优先隐藏耗时。Bash 动作优先取持久事实中的命令，无事实时只读取完整合法参数的已知字段，不完整参数显示“参数生成中”。Apply Patch 执行前只显示“补丁请求”，执行后文件数取实际 `changes`、未完成数取 `pending`。失败、拒绝、部分完成、取消、中断、未执行和记录不可用保留可见状态及一行原因；原因来自诊断、失败类别、信号或退出码，不从输出猜测。待同步独立显示，不表示失败。进行中、未知或倒退的时间不补造耗时。

活动 Run 即使当前事件已读取，尚未取得匹配的工具事实时仍显示中性的“执行事实待同步”，不把模型请求领先于事件同步的正常时差标成结果缺失；只有 Run 已结束且事件读取完成后才提示“执行结果未记录”。读取失败继续明确提示，不因 Run 活动而隐藏。

同一 exchange 内相邻的两个及以上本地工具请求折为工具组；正文、思考、拒绝、服务端工具和展示截断提示均打断组，不跨 exchange 或 Run 合并。组标题显示调用数、执行中数和需关注数；只有全部成功才显示“已完成”，收起组仍显示首个需关注工具的原因。组从第一个工具起稳定挂载；单工具增长为组时，已有详情展开或组内有焦点则保持打开，否则默认收起。之后状态或终态更新始终保留手动选择。网页搜索等服务端工具使用独立紧凑折叠，协议模块自行解释查询、原生状态、来源数和错误码；请求和结果保持原顺序，不参与本地分组。

工具详情原地展开，使用最大 320px 的单一纵向滚动区域，展示命令、原始 stdout/stderr、补丁预览、实际变更、未完成操作和诊断；原始 JSON 位于默认收起的“原始参数”披露项。命令、补丁及输出的复制使用浏览器已取得的原文，失败明确提示，输出/补丁截断提示继续保留。外层摘要按钮和详情节点在事实同步时原地更新，保留展开状态、键盘焦点和详情滚动；收起包含焦点的详情时把焦点移回摘要。按钮使用 `aria-expanded/aria-controls`，收起内容设 `hidden/inert`。同一面板内切换对话/轨迹或重访分支保留独立选择，关闭面板或刷新恢复默认，各分屏互不影响；监听和子挂载点由对应 `dispose()` 清理。本次仅改变展示，不改 HTTP/SSE、协议记录、数据库或 Nya 组件。

协议工具卡只保留请求层的一处“原始参数”，优先展示和复制模型原始 JSON；请求展示不完整且已有库工具执行事实时，使用执行记录中的参数并标注来源。嵌入的执行详情省略重复参数并保留原始结果。独立轨迹工具详情继续展示执行记录中的参数。

工具摘要与边界验证见 `tests/tool-call-view.test.mjs`、`tests/protocol-web-modules.test.mjs` 和 `tests/session-view.test.mjs`。隔离浏览器验收宿主 `tests/helpers/native-view-browser-host.mjs` 提供四协议工具 1→2→3 流式增长、失败、长且截断的输出、部分补丁与约 320px/四分屏切换，不访问真实服务或业务数据。

## 页面流程

页面按浏览器可视高度布局，采用旧版 Anybox 桌面端经典主题的中性灰形态。桌面由宿主 54px 应用窄条、Anybox Harness 的 236px 项目与会话侧栏、剩余宽度的会话工作区组成；工作区顶栏与各面板标签式标题栏均为 40px。主画布为 `#f2f2f2`，侧栏为 `#e8e8e8`，应用窄条为 `#ededed`，使用细分割线、小圆角和低对比度选中背景。应用窄条呈现目录入口和宿主控制，工作区工具栏控制侧栏显隐；侧栏顶部仅保留右侧添加项目按钮，不显示应用名称文字；下方直接呈现项目与会话树，不重复显示设备名称标题。底部一行呈现紧凑执行设备选择器与设置图标，连接管理移入设置分类。选择器保留屏幕阅读器标签，完整设备名称通过 title 提示。项目树仅展示所选 instanceId 的项目，各项目的会话缩进显示在对应项目下，首次默认展开，可通过项目行左侧箭头独立折叠；折叠状态按完整项目 ID 保存在当前标签页的边栏偏好中，刷新网页或重建工作区后恢复，恢复选中项目不会自动展开，用户点击项目或新建会话时才展开该项目。整棵项目树使用剩余空间统一滚动，子会话列表不单独滚动；项目树与对话记录独立滚动，消息增长不会撑高整页。收起侧栏释放水平空间，已有面板、草稿与查看位置保持不变。来源和迁移边界见[桌面界面迁移记录](./anybox-desktop-ui-migration.md)。

对话和输入框以不超过 880px 的阅读列居中。已保存回答、原生流式回答、消息操作和生成提示共用该列；分屏和窄窗口按各自面板的可用宽度收缩。用户消息靠右显示为浅灰小气泡，助手正文直接置于画布；面板顶部保留起点、上一级和后续分支导航。输入框为细边框、6px 圆角，显示当前 Agent、会话模型选择器、发送起点、发送和取消按钮，文本区按内容增高；Enter 发送，Shift + Enter 换行。新会话与空工作区复用页面内嵌的 `anybox-mark` SVG symbol，点阵猫盒来自旧版静止帧，不请求外部品牌图片。根节点有已有分支时，空状态说明当前查看位置并显示最多三个快捷分支按钮，完整后续分支仍由顶部选择器分页访问；不会自动把最后完成节点当作查看位置。图标操作提供 `title` 悬停提示与 `aria-label` 或屏幕阅读器文本，键盘焦点使用可见描边。

不超过 760px 时，功能轨缩为 44px，侧栏默认收起，通过功能轨按钮打开覆盖式抽屉，不再挤占对话区高度。抽屉打开时主区域不可交互，键盘焦点留在侧栏；关闭按钮、遮罩或 Esc 收起抽屉并将焦点返回开关。点击可用的会话或新建会话按钮后收起抽屉，切换项目仍留在导航中。跨越断点时关闭抽屉，恢复页面内存中的桌面折叠偏好。侧栏显隐由 `client.ts` 管理，不持久化为服务端状态，也不重建会话控制器。

侧栏底部的设置图标打开原生模态弹窗，统一提供“会话设置”“模型管理”“Prompt 管理”“已归档会话”“管理连接”五个分类；连接管理直接呈现在同一弹窗的分类面板。分类切换或关闭设置保留已挂载表单和未保存的非秘密草稿；用户关闭或按 Esc 时清空连接的未保存访问令牌和已发行令牌的临时展示，临时停用应用保留已有草稿。未保存修改会阻止设备切换及界面重建。模型与 Prompt 分类按弹窗内展示的设备管理，连接分类展示全部设备，归档分类展示跨设备、跨项目的列表；连接和归档分类隐藏当前执行设备提示。模型与 Prompt 不再独立占用功能页面或顶部导航。模型服务默认展示“我的连接”和所选连接的模型列表；连接状态区分未配置 Key、协议未安装、准备失败和停用。列表可以按模型名称/远端 ID 搜索，筛选全部、可用或不可用项，并逐行展示来源、不可用原因和参数预设标记。点击“参数设置”打开对应模型的参数编辑器；连接设置默认折叠，需要补 Key 或处理失败时展开。

浏览器只在 `localStorage` 记住模型设置中选中的连接 ID；再次打开时按该 ID 恢复，即使连接当前不可用也保留选择，方便补 Key 或修复。没有有效偏好时，优先选择包含可用模型的启用连接，其次是已启用且有 Key 或无需认证的连接，最后回退到第一个；空列表进入添加流程。此偏好不包含凭据，也不改变会话的模型选择。首次状态读取失败仍可点击“刷新状态”重试。

“添加提供方”打开独立流程：目录侧栏选择统一 Provider 定义与连接方案，表单确认账号连接名称、代理地址和 API Key，保存后自动准备适用模型并返回模型列表。目录只在添加流程中展示；模型详情、弃用开关、模态、价格、限制和完整快照来源放在折叠预览区。选择已有提供方仍可创建另一账号连接，公共定义与实际账号保持独立身份；未知映射可以在表单中手动选择协议。目录搜索保留可见的已选提供方，连接方案按自身身份匹配，不沿用其他提供方的选项序号。关闭或离开添加流程取消目录读取，释放搜索/轮询 timer；不同读取和刷新错误独立保留，已有连接仍可管理。

连接名称、地址、认证、超时、启停与新 Key 使用同一保存操作；所属 Provider 与协议创建后固定，Key 留空保留现有凭据。删除 Key 需在表单内确认，随后模型列表更新可用状态。高级连接设置提供模板、认证方式、超时、连接检查与版本历史。模型参数编辑器提供可编辑的原生生成参数、自定义模型和“另存为参数预设”，远端发现收进单独折叠区。工具、流式、图片输入、服务端搜索、推理能力及推理档位、模式和预算范围只读展示，界面不提供能力修改控件。能力说明模型支持什么，原生生成参数决定本次执行如何使用该能力。用户自定义 Provider/Model 明确 source:user；参数预设 baseline:false，与基础配置共享模型定义但拥有独立稳定配置 ID。参数以 `{protocolId,formatVersion:1,value}` 保存，表单的原生 dotted path（如 `reasoning.effort`、`thinking.type`）构建嵌套 JSON，拒绝原型键和路径冲突。初始化保存 descriptor 默认值，读取已有配置保留省略；Anthropic `max_tokens` 默认 4096，来源限制较小则取较小值。Responses/Anthropic 的搜索开关仅在能力明确声明 `webSearch.support=supported` 时启用，目录不按协议猜测模型支持；表单只生成相应原生服务端搜索工具配置，本地 Bash/Apply Patch 声明由 Driver 提供。保存使用 expectedRevision，冲突保留表单；历史不返回秘密。非秘密草稿只在当前页面按连接/配置身份保留，Key 在切换账号、关闭或 Esc 时清空。窄屏先关闭导航抽屉，弹窗仅内部滚动。

连接和 Key 分别提交：先保存连接配置，再使用返回的修订号更新新 Key。Key 写入失败时明确报告已保存的连接，并可在该连接上重试；保存成功后的状态刷新失败也保留已接纳的身份和修订号。刷新、重试或保存连接保留当前模型编辑器与非秘密草稿；每个账号分别记住已保存配置或新草稿这一编辑目标，以及编辑器是否可见和展开。新自定义模型和新参数预设即使收起、刷新或切换账号再返回，也可继续编辑；再次点击新建入口恢复已有的新草稿，仅显式“放弃修改”才清除它。草稿沿用开始修改时的修订号，服务器已有新修改时仍由 CAS 返回冲突。“另存为参数预设”使用当前表单参数并继承原配置能力，与原配置共享模型定义但保存为独立配置，原模型配置继续保留。新自定义模型采用所选定义的能力，未得到声明时保持未知，不从协议类型推断支持。

用户点击“添加项目”先固定目标设备名称、实例身份和连接版本。组合启动器确认本机身份匹配且平台支持时，直接打开系统目录窗口；用户确认后立即向该固定目标登记，取消则结束流程，不再打开应用内对话框。原生能力未确认可用时采用应用内流程；窗口启动或登记失败显示工作区通知，不自动回退或换设备重试。界面停用或关闭会取消启动器并等待本轮操作退出，忽略迟到结果。

远程设备、本机身份未确认或原生能力未确认可用时，打开应用内目录对话框，默认从目标 harness server 的主目录开始，可浏览真实目录、编辑路径、筛选、切换隐藏项和分页。失败保留输入和位置，只有确认当前文件夹后才登记，取消不改变项目列表。有效目录链接进入后显示规范路径。旧版 harness server 缺少浏览能力时在同一对话框手动输入路径并显示升级说明，不使用 window.prompt；对话框不再提供原生窗口快捷按钮。目录启动器、状态控制器和 DOM 视图位于 src/applications/harness/web，HarnessClient 只负责固定目标请求；接口、键盘与焦点、分页清理及升级边界见[项目目录选择](project-directory-picker.md)。列表常驻显示当前设备的项目名称，完整路径通过悬停提示查看，目录不可访问时额外显示状态。页面路由记录项目与可选 Session ID。无需切换项目即可浏览当前设备各项目展开的会话；项目行从文件夹图标开始，不显示独立折叠箭头；点击项目名称选择空工作区“新建会话”的所属项目并切换该项目的会话展开状态，项目行右侧的新建按钮直接在该项目中创建会话，均使用设置中选定的全局 Agent。空工作区新建入口使用该设备项目，原选择属于另一设备时重新选择当前设备的项目；无项目或所选项目不可用时禁用，不沿用另一设备的隐藏项目。行内新建按钮在悬停或键盘聚焦项目行时显示，触屏始终显示。会话行的三个点打开带图标、圆角和阴影的悬浮操作菜单，提供右侧打开、下方打开和归档；菜单不改变列表布局，按窗口边缘向上或向下展开。点击外部、Esc 或执行操作后关闭，Esc 返回触发按钮；方向键与 Home/End 可选择可用操作，停用应用或重绘所属项目列表时清理菜单。已加载会话从首条可用输入在页面内派生标题，依次取祖先路径、直接子节点或已读 Run；未打开、尚无已知输入的列表项回退为 Session ID 摘要，不新增标题接口或持久字段。项目目录后来不可访问时，项目、Session 和 Run 历史数据仍保留，创建会话与新 Run 返回 `project-unavailable`。

面板持有明确的 `viewNodeId` 和 `focusedRunId`，起点默认为虚拟根，不推断最后完成节点。分支导航行右侧提供“对话 / 轨迹”切换，默认对话只显示选中节点的祖先路径和实时回答，保留消息内的思考、工具及引用；后续分支通过直接子节点选择器分页浏览。原生完整节点提供继续、编辑重发和重新生成。轨迹视图按开始时间和 ID 排列整个会话所有分支的 Run，各组标明运行序号、起点及状态，以紧凑角色行展示系统、上下文、用户、助手与工具；记录视图隐藏分支控件并显示“本会话全部运行”，无记录时显示空态。入口显示 `running` 与 `cancelling` 总数，零时隐藏，窄面板缩为数字并保持两项入口可见。失败、取消、中断不会伪装成成功助手回复，主动跟随的 Run 在对话显示简短提示及对应记录入口；旧版 Run 的起点未知标记也保留。“查看回答”切回对话并定位结果节点，“查看步骤”关注并定位对应运行首行和明细。`dialogue-v1` Session 与归档会话均可切换浏览，旧格式输入、选模、编辑重发与重新生成全部禁用，并提示新建会话；不自动导入或拼接为原生历史。

对话、运行记录与输入框保持挂载，通过 `hidden/inert` 切换；记录模式隐藏输入框但保留草稿，不 detach 控制器或销毁协议 Turn。每次发送固定可空父节点、当前选择的 `modelId` 与新幂等键，写入当前标签页的待提交存储后才 POST；确认接受即可继续提交，正在执行的 Run 不阻止新键提交。草稿按 Session/父节点保存在页面内存，过程缓存按 Run 隔离。只有用户仍在原位置且没有开始新输入时，当前标签页主动提交的 Run 才在成功后导航到结果。切换查看位置、关注其他 Run、输入新草稿或关闭面板都会停止自动跟随；仅切换查看模式不改变分支、草稿、关注对象、自动跟随或在途请求。记录视图中的后台完成可按原规则更新对话位置，同时保留记录模式。

主动跟随的 Run 成功后，读取结果路径及直接子节点期间保留当前路径、回答与协议 Turn，不进入空白加载页；读取成功后一次性更新查看位置、路径及子节点。终态展示覆盖临时帧，迟到临时帧仍拒绝；最终展示读取失败时，切换后的成功节点使用已保存回答，不继续显示部分临时文本。结果路径读取失败保留当前回答及跟随意图，并在下次刷新重试。等待期间修改文本或附件、显式导航、关注其他 Run 或关闭面板会阻止迟到结果自动切换；仅切换对话/轨迹视图保留跟随并沿用最新模式。验证入口为 `tests/session-client.test.mjs` 与 `tests/session-view.test.mjs`。

刷新或重新打开会话时，先按键只读查询已接受 Run，再恢复未确认提交。已有 `anybox.web.v2.pending` 存储继续读取，新记录明确携带 `schemaVersion:1`；旧记录缺少该版本、父节点或固定模型且查不到已接受 Run 时，仅恢复输入供用户选定位置和模型后确认，不自动转换后重发。旧只读 Session 的未接受输入保留为草稿并提示新建会话。已发出的写请求即使面板关闭也按原 Session 和幂等键结算；关闭面板只停止读取和轮询，不调用取消接口。Key 仅在 Provider 表单中提交；响应不返回原值，也不把 Key 写入 sessionStorage。

每个会话的模型选择由服务端 `Session.modelId` 持久化，模型选择器按 ProviderConnection 分组并显示不可用原因。首次接受原生 Run 后 Session 固定 `protocolId`，前端禁选其他协议并提示新建会话；选模接口和 Run 显式模型覆盖均再次校验，不靠 UI 维持约束。同协议配置仍由后端检查历史和能力兼容性。有效工具能力未知或不支持时，harness server 不提供 Bash/Apply Patch，按纯文本方式调用，只有明确可用工具能力才提供这两项工具。Composer 保留会话模型选择器，模型配置统一从“设置 → 模型管理”进入。没有选定可用模型时禁止新提交；没有可用模型时提示前往设置配置。历史仍可阅读，已接受 Run 保持原快照。配置写入后刷新共享模型列表并更新所有面板，不自动替换会话选择。切换模型只影响后续 Run，重试未确认请求继续携带原 `modelId`，不会因另一个页面修改 Session 选择而改用其他模型。

“设置 → Prompt 管理”直接提供文档列表、草稿编辑、版本预览和 Agent 绑定。首次可点击“编辑当前指令”，将内置指令复制为本机用户的草稿；已有可管理绑定则直接打开对应文档。保存、发布、应用是三个独立步骤：保存不改变已发布内容，发布不自动切换绑定，应用只影响后续 Run，所有项目共享该 Agent 的绑定。用户可选择旧版本重新应用。编辑与发布都校验页面读取的修订号；冲突保留输入供复制，并提供显式放弃修改及重新读取操作。未保存时阻止切换文档或重建工作区；关闭设置保留编辑器及输入，再次打开可继续编辑。

第一版没有项目删除、目录迁移、项目专属 Agent/Prompt 或工具审批。对话分支共用项目目录，不提供文件快照、修改回滚或环境可复现性；未来工作区绑定单独设计。


## 分屏布局与资源归属

- 一个工作区最多四个面板，可跨项目与设备；同一 Session 仅一份面板与控制器。点击已打开会话聚焦它，点击其他会话替换活动面板。侧栏选择、折叠项目或切换设备保留已有会话面板；空工作区新建会话使用当前设备的侧栏选中项目，项目行的新建按钮使用所在项目。全量项目资源继续服务于已打开面板的标题、模型与附件归属；侧栏筛选不移除另一设备的面板或改变其请求目标。
- 从会话列表或面板标题拖到目标四边创建/移动分屏，中央无落点；Pointer Events 在移动超过 6px 后显示落点预览，Esc 或取消手势不改变布局。菜单另提供右侧/下方打开。达到数量上限仍可移动或替换。
- 布局是二叉树，叶节点绑定会话；分割节点记录水平/垂直方向、比例和两个子节点。关闭叶节点收拢兄弟节点。每叶最小 320×260px，分隔条 8px，嵌套区域递归计算尺寸；分隔条支持指针拖动和方向键每次 5% 调整。
- 窗口不超过 760px 或当前树无法满足最小尺寸时，保留布局并显示切换条及活动面板。恢复足够空间后还原。移动和响应式切换复用面板 DOM/控制器，保留输入、滚动和过程展开；后台更新只渲染对应面板，阅读历史时不强制滚到底部。
- 布局、活动面板、侧栏项目保存在 `anybox.web.workspace.v1`，查看位置、关注对象和可选 `viewMode: 'dialogue' | 'runs'` 保存在 `anybox.web.positions.v1`，均属于 sessionStorage。每个 Thread 恢复自己的模式，缺失、旧格式及无效模式默认对话；普通节点导航保留模式。普通未发送草稿仅在当前页面内保留。对话和运行记录分别保存 `{ dialogue, runs }` 滚动位置，首次进入记录定位最近 Run，之后恢复独立位置；记录刷新不强制滚动，隐藏或零尺寸面板不覆盖位置。恢复会话后重新读取服务端数据；无效叶节点移除，网络故障保留视图重试，布局存储失败提示但不禁止操作。刷新不恢复隐式自动跟随。
- 原项目/会话 hash 继续有效，URL 表示活动会话。恢复布局后按 URL 聚焦已有会话或替换活动面板；前进/后退使用相同规则，不回放布局树。侧栏浏览项目与活动会话独立。
- 每个打开会话只有一个串行刷新任务，由共享 SSE 通知触发；连接健康时每 30 秒校准，连接未就绪或断线时每 5 秒兜底查询，恢复可见后立即刷新。隐藏页面收到通知只标记待刷新。读取、提交/取消或节点导航中收到通知会合并并在完成后补查，不等待下一次定时校准。按会话列出所有 Run，按 revision 合并，按 afterSeq 增量读取活动/展开对象的事件。请求代次和 AbortController 防止已关闭视图的旧响应发布。
- 关闭/替换释放读取、定时器及 DOM 监听器，并更新共享 SSE 的订阅集合；最后一个面板关闭时释放连接。控制器仍可完成原已发出写入，草稿留在页面内存供重开使用。所有面板共享现有 HTTP 与 Nya 服务，增加面板不创建额外 Context、组件、数据库表或运行生命周期。

## 验收

`tests/workspace-layout.test.mjs` 覆盖四方向分割、跨项目移动、上限、关闭收拢、尺寸约束、损坏记录恢复和 URL；`tests/session-client.test.mjs` 覆盖独立运行/取消、关闭和延迟响应、丢响应查键、旧 pending、存储拒绝、revision 合并、显式节点与乱序完成。HTTP 测试验证新增浏览器模块白名单，继续阻止访问宿主模块。

Thread 对话与记录的验收应覆盖模式默认及恢复、全会话记录、活动数量、草稿和两套滚动位置保留、失败/取消/中断提示、查看回答与查看步骤，以及切换时协议 Turn 和自动跟随不丢失。隔离浏览器宿主需检查 1440px、1024px、390px、四分屏、键盘切换、横向溢出、流式输出、应用切换与关闭重开；后端 API、数据库和协议记录格式不因展示切换改变。

`tests/session-view.test.mjs` 复用本地 DOM 替身验证 Markdown 的语义结构、任务勾选框与表格、复制原始代码、未闭合围栏的流式更新、Turn/块身份、原生引用与列表组合，以及助手回退和用户原文的区别；恶意链接、字面 HTML 和远程图片均不得创建可执行或自动加载的节点。原有工具展示测试继续核对原始输出、取消后的实际退出与部分补丁事实。

2026-10-03 使用隔离浏览器宿主验证 Markdown 标题、强调、列表、引用、表格、代码及刷新后的历史回答；1440px 三栏与 390px 窄屏均保持对话宽度，长代码在块内滚动。示例来自一次性测试模型与项目，截图见[Thread Markdown](ui/anybox-thread-markdown.png)。根 `npm run check` 为 940 项通过、13 项门控跳过、0 失败。

轨迹采用 DeepSeek Harness 的连续紧凑表、三通道概览与选中行明细，沿用 Anybox 灰色主题。默认展示本会话全部 Run，每组标明起点，序号表示运行排序而非父链轮次；组内根据操作事件排列。用户摘要保留原文与附件数量，实际模型输入放在明细。系统与上下文来自真实初始请求和历史 Prompt 种类，继承后的增量请求不重复生成初始输入；同一 Run 内相同初始化展示内容合并，不因历史延迟加载将已选中行移到另一 Run。模型调用行携带结构化协议内容，列表及搜索使用派生文本，选中明细挂载与对话区相同的原生组件，保持内容顺序、分组、阶段、引用和原生停止状态。每次模型调用只有一个真实计时行，不给内容块虚构耗时。Bash、Apply Patch 合并请求与实际结果，重复 requestId 由来源 exchange 与事件位置隔离。纯展示函数位于 `trajectory.ts`，`run-trace.ts`、`tool-trace.ts` 继续归纳真实步骤和工具事实；不新增 Nya 组件或持久格式。

工具栏的“时长”切换等宽与真实时间概览；真实时间保留并发重叠、压缩所有通道均空闲的区间，未观察实际退出不推断耗时。“轮次”折叠运行组保留用户摘要与计数，“调用”折叠助手后的工具行；点击时间块揭开相应折叠并定位同一行。选中行打开桌面右侧明细，640px 以下面板改为下方明细；支持方向键、Home/End 和 Escape，查看回答与运行取消位于明细。工具输出、补丁实际变更及未完成部分保留原截断标志。选中、折叠和明细位置在刷新及流式更新中保留。

`session-client.ts` 的 events/view 共用两个读取槽，优先活动、聚焦及可见运行；事件按 afterSeq 增量读取，终态事件按 revision 缓存，committed view 避免重复读取。`setTraceViewport` 更新可见对象，`setTraceSearch` 在查询非空时逐步补读其余 Run，`retryTrace` 重试失败对象，snapshot 的 traceLoading 提供逐 Run 未加载/加载中/已加载/失败状态及总进度。清空搜索停止不再需要且尚未开始的读取并保留缓存；关闭面板取消读取但不取消 Run。搜索忽略大小写、多个词按 AND 匹配已加载安全展示正文；进度未完成不能宣称全部历史无结果。

`/view` 仍是约 48KiB 的有界安全替换帧，额外的可选 exchange.inputs 与响应 blocks 共用预算，协议记录不改变。轨迹只读已解码的展示字段和工具事件；签名、continuation、认证头及图片 base64 不向浏览器暴露。展示截断、工具摘要截断、读取失败、尚未加载和旧记录缺失分别提示；provisional 明确标为临时。取消、失败及 interrupted 保留真实观察和部分文件事实，恢复发现中断的时间不能伪装为执行结束。没有事件只展示已知输入、已存输出/可用安全展示和状态，不伪造调用与耗时。完整长历史分页和全历史搜索属于后续范围。

`tests/trajectory.test.mjs`、`tests/run-trace.test.mjs`、`tests/tool-trace.test.mjs`、会话控制器/视图、协议投影及 Web HTTP 测试使用本地受控事实验证顺序、设备作用域、四协议输入、工具重复 ID、取消与部分补丁、真实时间重叠、截断、读取并发与缓存、搜索和键盘操作；此验证不访问真实模型或工作区数据库。

`tests/run-notifications.test.mjs` 验证提交时序、准确版本、回滚/幂等不通知、监听器故障隔离和分发清理；`tests/run-change-stream.test.mjs` 验证按会话合并、背压、超时和断开清理；`tests/run-change-client.test.mjs` 验证四会话共享连接、重连补查、订阅替换与旧回调失效。会话控制器测试覆盖刷新/写请求/节点导航中的通知；HTTP 测试覆盖真实 Nya→SSE 路径、资源退出后才发布成功、订阅校验、关闭准入竞态及组件重启。

浏览器验收使用 `npm run build` 后运行 `node tests/helpers/workspace-browser-host.mjs`，输出临时测试站点地址；Ctrl+C 关闭并清理临时库。2026-09-26 已验证会话拖入四面板、移动保留草稿、指针与键盘调整尺寸、跨项目导航、刷新恢复、窄屏切换、跨会话提交、关闭后运行继续、显式取消、双标签页发现其他 Run 且保持各自查看位置、设置和 Prompt 编辑器入口。此工具使用受控模型与内存凭据，不能作为真实模型或系统凭据库验收。

同日的布局调整另验证了侧栏折叠后保留草稿、800px 阅读列、跨项目四分屏及键盘调宽、390px 窄屏面板切换、抽屉 Tab 循环与 Esc 关闭、设置关闭后的焦点返回、抽屉打开时转回桌面、新建会话与消息提交，以及刷新恢复分屏。`npm run check` 通过（223 项通过，2 项系统凭据库测试按默认门控跳过）。

2026-09-27 的 Event/SSE 浏览器验收使用同一受控宿主，验证跨项目四面板、两个项目中提交后的完成状态及回答自动展示、运行取消、页面刷新后四面板与终态恢复，控制台无错误。`npm run check` 通过（236 项通过，2 项真实凭据库测试按默认门控跳过）。

### 桌面形态迁移验收（2026-09-27）

沿用旧版 Classic 主题与桌面比例，分析与范围见[迁移说明](./anybox-desktop-ui-migration.md)，截图与逐项核对见[视觉验收](../design-qa.md)。本轮仅修改 Web 页面、客户端展示和样式，没有新增后端组件、迁移或模型功能。

`npm run check` 完成：240 项通过，2 项真实凭据库测试按默认门控跳过，0 失败。隔离数据库和本地模型预览验证了发送与回答保存、已有分支选择、跨项目四分屏、390px 窄屏会话切换、五行草稿高度保留、导航抽屉及设置/Prompt 弹窗焦点。两个验证标签页控制台无 error/warn。测试未向真实模型发送请求、未写入真实 Key 或现有工作区数据库。


### 项目分组侧栏验收（2026-09-27）

侧栏将每个项目与其会话作为独立组显示。展开/折叠只改变本组可见性；点击项目内会话仍支持打开和跨项目分屏，行内新建明确使用该行项目。各项目会话独立读取，加载/失败状态留在所属组，失败可单独重试。读取刷新不会让另一项目的结果覆盖当前组，页面关闭取消全部未完成读取。

`tests/project-navigation.test.mjs` 覆盖不同项目并行读取、同项目刷新后的迟到响应、关闭取消以及失败保留旧数据和重试。`npm run check`：244 项通过，2 项默认门控跳过，0 失败。浏览器验证项目下会话归属、独立折叠、行内新建以及跨项目分屏，无控制台 error/warn；[分组侧栏截图](./ui/anybox-grouped-sidebar.png)使用隔离测试数据。


### 连接删除验收（2026-09-28）

连接详情顶部新增“删除连接”和确认区。临时浏览器宿主验证取消不会改变账号列表；删除后切换到剩余账号并保留其未保存草稿；删除最后一个账号进入添加流程，目录定义仍在。控制台无 warning/error。使用临时 SQLite、内存凭据和 HTTP 替身，未删除工作区连接或使用真实 Key。

`packages/models/tests/connection-deletion.test.mjs` 验证多账号隔离、配置/预设删除、不可变历史、在途执行与续轮继续、凭据读取的准入顺序、存储失败原样保留、Vault 失败日志恢复，以及来源接纳与删除的队列协调。SQLite 测试验证事务/CAS、重启持久化和禁止复用已删除 ID；宿主测试验证不会重迁旧默认连接；Web HTTP 测试验证同源保护、错误状态、会话选模保留和在途 Run 成功结算。`npm run check`：433 项通过，2 项系统凭据测试按门控跳过，0 失败。

### Models 接入验收（2026-09-28）

`tests/models-client.test.mjs` 验证协议描述生成原生参数时省略空值、保留零/false、构建嵌套路径、拒绝无效枚举、范围与原型键，以及共享目录忽略过期读取；可用文本模型不因缺少工具能力而被禁选。`tests/model-selection-client.test.mjs` 验证按会话持久化选择、重试固定原模型、旧 pending 恢复确认、只读历史、协议绑定与视图重连。`tests/run-change-client.test.mjs` 验证视图帧订阅范围、代次和数据校验。服务端和模块的配置、版本冲突、凭据隔离及执行生命周期由各自行为测试覆盖。

Chrome 验收使用真正的 Models/Anybox Harness/Web 与临时 SQLite，凭据库和 HTTP 传输注入测试替身：创建无需认证的 Responses 连接、获取候选列表、确认能力并保存模型、会话选模、观察临时流文本切换为最终节点、取消第二次运行，以及修改参数后查询两个历史版本。390px 宽度验证表单内部滚动和模型选择器；测试没有访问真实远端模型、真实 Key 或工作区数据库。

### 公共目录与原生协议验收（2026-09-28）

`tests/models-directory-web.test.mjs` 使用真实 Nya、三套临时 SQLite、本地 HTTP 和原生 JSON/SSE mock，验证 Anthropic 与 Gemini 的文本、Bash 工具续轮、最终答案，以及代理地址、4096 默认参数、目录移除保留配置、双账号自动基础配置、参数预设、幂等同步重试、失败保旧、断连和关闭等待实际 reader 退出。`tests/models-client.test.mjs` 补充新表单默认值、模态与协议匹配、独立目录读取代次、刷新/查询乱序、分通道错误保留、预先取消不发请求以及关闭后过期成功/失败响应不发布。模块内测试覆盖缓存/ETag/退避、实际退出、旧配置、参数校验、签名私有化和分页发现。

2026-09-28 统一定义接入阶段的 Chrome 验收（此次布局整理前）使用临时 Models/Anybox Harness/Web 宿主和内存凭据、HTTP 替身：在目录选择 Anthropic、调整代理地址并保存一次测试 Key 后，兼容模型自动加入可用列表，基础配置持久保存 4096 输出默认值，弃用模型显示原因。高级模型设置默认折叠；新增 8192 输出的参数预设后基础配置仍在。会话选择自动模型后完成流式文本和 Bash 续轮至最终答案；手动刷新保留未保存的名称/地址，页面重载后会话选择与答案仍在，控制台无 error/warn。复现入口为 `node tests/helpers/catalog-browser-host.mjs`；测试标签页和临时宿主已关闭并清理，完整范围见[验收记录](models-catalog-validation.md)。

同日的模型服务整理使用 Codex 内置浏览器验证独立添加流程、账号连接列表、模型搜索/状态筛选、统一保存连接与 Key、删除 Key 后整组不可用、参数预设保留原基础配置，以及保存/刷新/切换账号后保留非秘密草稿。新增模型与预设收起后仍能恢复，明确放弃才清除；受控外部修改后保存旧草稿返回冲突，表单内容保留，放弃修改可载入最新参数。窄屏验证单列布局和操作可达性，浏览器无 warning/error。截图与具体步骤见[界面验收](models-catalog-validation.md#模型服务排布与交互整理)。最终 `npm run check`：426 项通过，2 项系统凭据测试按门控跳过，0 失败。

### 原生 Turn 视图与只读历史验收（2026-09-28）

Web 相关 115 项测试通过，覆盖原生参数与启动转换、Session 选模与旧 pending、协议视图解码和 reducer、四面板布局、SSE 完整快照合并及背压、目录 HTTP、工具卡片和组件关闭。新增服务端测试验证运行中快照在 Web 组件替换后仍可查询，终态投影在整个应用重启后恢复；同一会话跨协议选模和显式 Run 覆盖均被拒绝。`tests/protocol-view-client.test.mjs` 验证私有字段过滤、稳定块身份、重复/漏帧/乱序与终态拒绝迟到临时帧、引用偏移和安全 URL。

实际 Chrome 验收运行 `CATALOG_BROWSER_SEED=1 node tests/helpers/catalog-browser-host.mjs`，使用真实 Models/Anybox Harness/Web、临时 SQLite、内存凭据与模拟原生 HTTP：发送 Anthropic 文本并刷新恢复答案及选模；运行本地 Bash 并查看完成卡片和 stdout；编辑已完成节点生成同父兄弟分支，确认仅渲染选中路径；提交含 `<script>` 的普通消息后确认 DOM 没有注入脚本，原文按文本显示。模型表单保留 `max_tokens:4096` 与原生嵌套字段；搜索能力未知时开关禁用，显式改为支持后启用。

另以 `CATALOG_BROWSER_LEGACY=1` 在测试库插入旧文本历史，验证原始输入和答案仍可读、分支导航可用，模型选择、发送、编辑和重新生成禁用，并显示“只读历史”。浏览器验收发现并修复首次绑定后模型选择缓存未刷新，以及旧会话输入禁用状态被覆盖的问题。测试标签页和两个临时宿主均已关闭并等待退出；没有使用真实凭据、外部模型或现有工作区数据库。

### 图片输入的客户端状态

`image-client.ts` 持有可测试的草稿存储、两路上传队列和工作区续期器；这些是 Web Frontend 的内部函数，不注册额外组件。图片字节由 Session/图片组件导入和保管。`session-client.ts` 仍负责选定父节点、幂等提交和导航，草稿包含原文及有序图片。pending v2 把引用持久保存后才发送，丢失响应先按幂等键校准；v1 文本兼容，未知图片记录只恢复为显式待确认草稿。图片-only、编辑重发和重新生成均复用同一引用，不从预览反推输入。

图片上传中或失败会阻止发送；移除取消该上传，排队并发槽位在请求实际退出后才释放。刷新页面不保留 File/base64，未完成上传显示为失败占位。预览使用同源图片 URL，不放宽 CSP。草稿每 5 分钟续期，覆盖所有 Session/父节点和已关闭面板的 pending；页面重新可见及提交前再校准。未接受图片 24 小时后过期不能复活，已接受 Run 的保留不依赖浏览器。协议/能力不支持时保留草稿并提示切换模型或移除图片。限制与接口见 [Web Frontend](modules/web/web-frontend.md)。

2026-09-29 使用 `ANYBOX_TEST_IMAGE_INPUT=1 node tests/helpers/workspace-browser-host.mjs`、临时数据库、内存凭据、原生 Chat HTTP 替身和生成的 320×180 PNG，在原生 Chrome 中验证文件选择上传、同源预览、刷新保留纯图片草稿、纯图片运行成功、编辑重发保留原图、刷新保留修改后的文本与图片、重新生成创建另一成功分支且图片引用不变。截图已在验收时目视检查；临时宿主和新建标签页随后关闭。此验收不调用真实远端模型，后端重启恢复和图片分支隔离由原生协议集成测试覆盖。

项目文件引用已接入现有 textarea、按节点草稿、多分屏及历史编辑/重新生成。发送固定快照，历史预览保持原内容；交互、HTTP 和 pending v3 的详细规则见[项目文件引用设计](project-file-references-design.md)。

## 会话归档与恢复

项目会话菜单提供“归档”，“设置 → 已归档会话”分类展示跨项目与设备的全局列表，包含项目、会话标识与归档时间；该列表不受侧栏设备筛选限制，支持查看、恢复、加载、空态与失败重试。查看时关闭设置并打开只读历史。请求期间禁止同会话重复写入，旧列表响应不能覆盖新查询结果。

归档成功关闭对应面板，更新布局与路由但保留草稿和查看位置。归档历史打开后只读，输入/附件/选模/编辑重发/重新生成均锁定，历史分支和附件读取可用；恢复按钮解锁原生会话，旧文本会话继续只读。恢复不自动打开未显示会话。轮询检测其他标签页的归档转换，首次加载归档会话则留在只读视图；重新可见刷新项目与归档列表。未知提交继续先查询幂等结果，只有确认未接受才合并回原父节点草稿。

验收使用 `tests/helpers/workspace-browser-host.mjs` 的临时库和受控模型，覆盖设置内归档入口、跨项目归档、四分屏移除、草稿保留、历史只读、恢复、窄屏设置分类和键盘焦点。后端与前端行为测试通过根 `npm run check` 执行。

## 通用应用工作区

根 HTML 仅包含外壳、应用入口与无装饰挂载容器；Anybox Harness 模板和专属样式位于 `web/apps/agent`，入口为 `src/applications/harness/web/harness-app.ts`。外壳动态加载注册 Web 入口，保持后台应用挂载；全局路由、应用切换与恢复见[通用宿主设计](products-v1.md)。Anybox Harness 直接呈现一个工作区，不再添加功能页顶栏。侧栏底部将一处紧凑“执行设备”选择器和设置图标放在同一行，项目列表在其上方独立滚动。选择器控制侧栏项目与会话树、新增项目及模型、Prompt 设置的设备范围；离线或未启动的目标不会回退展示其他设备项目，其所属的不可用占位项目可以保留。已有会话与跨设备分屏保持各自归属，全量资源继续用于面板及全局归档查询；设置内的“管理连接”分类管理设备连接、状态及显式 Agent 启停。设备选择不会自动启动 Agent。设置中的模型与 Prompt 使用所选设备的接口，保存后刷新工作区的模型列表；“已归档会话”分类使用全局查询并提供查看与恢复。连接和归档分类隐藏当前执行设备提示。

Anybox Harness 组件只订阅 `context.route`，连接变更在应用内刷新；关闭界面不改变后台目标。执行设备切换先更新路由中的 host，再重建界面；重建前的工作区更新查看位置时读取当前 host，保留最近的设备选择，只在路由没有 host 时使用装配时的设备。旧模型、Prompt 页面地址只读兼容为统一工作区位置，保留设备归属但丢弃已移除页面的内部位置，不自动打开设置；历史项目与会话位置继续兼容。宿主窄条的应用启停与连接管理内的设备 Agent 启停保持独立，切换已有应用、刷新和恢复位置均不自动启动设备。

## Anybox Harness 三栏与文件侧栏

工作区由左侧项目导航、中栏最多四个会话分屏和右侧目录树/文件标签组成，具体宽度、响应式抽屉、状态恢复、接口与退出规则见[三栏工作区](harness-three-column-workspace.md)。右栏跟随活动 thread，保存独立于中栏布局的 `${layoutKey}.sidebars.v1` 描述；不保存正文和游标。目录按展开分页，树文件、@ 候选、草稿附件和历史引用统一进入右侧预览，关闭或切换仅释放展示读取，不取消 Run。
