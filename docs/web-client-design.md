# 薄 Web 客户端第一版

> 多实例版本使用 `src/client/` 浏览器与独立 `src/host/client/` 网关，所有正式请求经连接 ID 路由。以下原有业务 API、对话树和展示语义沿用；旧本机直连与单进程启动描述已由[模块边界](harness-module-boundary.md)、[部署说明](harness-deployment.md)取代。

状态：本机单用户参考实现，2026-09-28。已接入公共模型目录、五种原生协议、原生参数配置、按会话绑定协议与安全 Turn 视图；保留最多四个跨项目会话面板、拖拽分屏、标签页内布局恢复、会话树显式查看位置、多 Run 状态和 Nya Event → SSE 变更通知。旧文本会话仅供查看。验证使用临时数据库与受控模型，不访问真实凭据或工作区数据库。

## 边界

浏览器只通过同源 `/api/v1` 与本机 Web 组件交互。应用宿主在同一个 Nya 根上安装 `packages/models` 的配置存储、系统凭据、模型服务、公开目录来源/缓存/服务、Responses、标准 Chat Completions、Anthropic Messages、Gemini Interactions，以及宿主的 DeepSeek 非推理扩展，再装配业务 SQLite、Harness、目录选择器和 `host-harness-api`。统一 Provider/Model 定义带 user/external 来源，多个 ProviderConnection 同时可用，实际执行使用 ModelConfiguration；这些都是数据记录，不为每条连接创建 Context 或组件。Models 配置使用独立的 `data/models.sqlite`，公开目录使用 `data/models-catalog.sqlite`，业务会话保留在 `data/harness.sqlite`；三库不能共用文件或文件别名。路径和凭据命名空间可由启动配置指定。配置数据库只保存凭据引用，密钥值仅存入系统凭据库。

`ANYBOX_LLM_*` 保留为新 Models 数据库的初次迁入参数；已有连接/配置不会被环境变量覆盖。初次启动建立显式用户定义、迁入连接和稳定 `default` 配置，将旧参数转换为对应协议的 `parameters`，并尝试把旧凭据复制到 Models 管理的系统凭据条目；旧密钥缺失或系统凭据库暂不可访问时仍允许进入设置。后续连接、模型、参数及 Key 均通过 `models.settings` 修改，不需要重启应用。变量详情见 [README](../README.md#本机-web-界面)。Web 组件拥有 HTTP 监听器与静态页面；进程信号由入口处理，经 `harness.close()` 关闭整个根。Harness 负责项目、Session、Run 准入、幂等、工具执行、取消和结算；协议 Driver/Loop 通过 Runtime 执行并生成安全视图，Models 提供原生 execution、凭据和传输边界。

页面使用原生 TypeScript、HTML 和 CSS。`client.ts` 负责全局设置与启动，`models-client.ts` 管理连接/模型配置表单及跨面板共享的已保存模型列表，`models-directory-client.ts` 独立管理公共目录状态、查询、刷新和短暂轮询；`workspace-layout.ts` 提供纯布局函数，`workspace-client.ts` 管理工作区，`session-client.ts` 管理各会话请求与 Run 视图快照，`session-view.ts` 管理面板和稳定的 Turn 挂载点，`protocols/view.ts` 负责视图解码、纯 reducer 和块渲染，`tool-trace.ts` 归并两类工具的展示状态，`prompt-client.ts` 保留 Prompt 设置。浏览器运行时代码只使用浏览器 API；Models 类型导入仅用于编译检查，不向浏览器加载 Nya 或 Models 的服务端代码。

模型服务主页面展示“我的连接”；添加连接流程以可搜索、可滚动的列表同时展示多个 Provider 定义，按定义 ID 显示来源、已有连接数量及当前选中项。点击提供方后在右侧填写连接配置，连接方案、模型目录预览和自定义连接入口沿用原流程。列表选择仅填写草稿，不创建连接或修改会话选模；目录状态更新保留列表按钮焦点。

`src/host/component.ts` 接收 Harness 校验后的 Agent ID 列表，通过 Nya 注入 Projects、Session、Run、Prompt、Agent Prompt、目录选择器、`models`、`models.settings` 与 `models.catalog`；`server.ts` 映射同源 HTTP 接口。业务查询取自 `harness.sessions`，执行控制取自 `harness.runs`，已保存模型查询取自 `models`，配置和 Key 操作取自 `models.settings`，统一目录定义也取自 `models.settings`；`models.catalog` 仅提供来源状态和刷新。Web 不依赖旧 `credentials.settings`，也不向前端提供凭据读取服务或协议注册服务。

公开 Session 包含选定的 `modelId`、`historyMode` 和首次原生 Run 固定的 `protocolId`；公开 Run 包含实际 `modelId`、调用者显式指定的 `requestedModelId`、`protocolBinding` 和不含秘密的 `modelSnapshot`（新写入 schemaVersion 3，含原生参数；旧快照只读且不重写）。Agent 指令、Prompt 内容快照、execution 句柄、原生续轮记录与密钥不进入普通 Session/Run DTO。Bash 命令和输出摘要、Apply Patch 预览和结果仍可展示；Prompt 管理单独返回可管理文档和版本。模型管理接口仅返回 Key 是否已配置，绝不回传密钥值或内部凭据引用。

依赖撤销时 Web 停止准入，取消目录选择、目录手动刷新、模型发现和连接检查，关闭 SSE 与 HTTP 并等待在途请求退出，包括已接收的 Prompt/模型配置写入，再释放依赖；依赖恢复后在原端口重启。目录刷新请求断连会取消其来源操作并等待 reader 实际退出。Web 单独关闭不取消已交给 Harness 的 Run，应用根关闭则按依赖顺序取消并等待所有执行。前端不保存权威业务状态，不直接连接 Provider、SQLite 或系统凭据库。

## 本机协议

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/v1/agents` | 返回全局 Agent `{id}` 列表 |
| `GET /api/v1/projects` | 返回项目 ID、名称、规范化目录路径和可用状态 |
| `POST /api/v1/projects/directories/browse` | open 预留浏览会话；page 读取有界当前层目录 |
| `POST /api/v1/projects/directories/close` | 关闭浏览会话并等待句柄清理 |
| `POST /api/v1/projects` | 确认后的绝对路径登记，realpath 后复用已有项目 |
| `GET /api/v1/projects/:id/sessions` | 列出项目下的 Session |
| `POST /api/v1/sessions` | 用 `{projectId,agentId,modelId?}` 创建 Session；省略模型时使用 Agent 默认值或 `null` |
| `POST /api/v1/sessions/:id/model` | 用 `{modelId}` 保存会话选择；只影响后续 Run |
| `GET /api/v1/sessions/:id` | 读取 Session 元数据、`projectId`、`modelId`、`historyMode` 与 `protocolId`，不返回 turns |
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

## Run 变更通知与协议视图

Session 组件在接受 Run、记录过程、请求取消和结算的事务成功后，通过 Nya `harness.run.changed` 发布冻结的 `{sessionId, runId, revision}`。只通知实际变化；幂等重复、无变化调用和回滚不发布。版本取自对应事务，通知不携带消息、Prompt、凭据或原生错误。持久化的 RunEvent 与查询接口仍是事实来源，完成通知包含的 revision 对应终态及成功节点已一起提交的状态。

Web 组件用 `ctx.on()` 订阅，监听器只向 SSE 发送队列入队。监听注册由 Nya Effect 管理，HTTP 层拥有连接、心跳、待发送队列和清理等待。发布方使用 `ctx.parallel()` 等待分发并隔离错误，记录固定日志，不将已提交操作返回成失败；监听器不得等待客户端网络或启动 Run 工作。模型/工具的执行、取消、`waitRun` 和资源 `done` 仍走原服务契约。

每个工作区共用一个 EventSource，分屏订阅集合变化时替换连接。SSE 拒绝未知参数、重复会话、超过四个会话、缺失会话及跨源浏览器请求；会话 ID 最多 1024 字符，单个 Web 实例最多 64 条连接。会话校验结束后再次检查关闭与断开状态。连接建立后发送 `ready`，每次 ready（包括自动重连）都触发查询补齐；不提供独立事件回放游标。`run-changed` 只用于标记会话需要刷新，允许合并和重复，客户端按 Run revision 合并状态、按 afterSeq 补齐过程记录。

每条连接最多保留四条待发送提示，每个会话只留最近一条；背压期间暂停写入，15 秒未排空则关闭连接，由客户端重连并补查。空闲时每 15 秒发送注释心跳。连接断开清除发送任务、心跳和监听；Web 关闭主动销毁流并等待实际关闭，避免长连接阻塞 HTTP 退出。组件重启重新订阅，旧连接由浏览器重连恢复。

协议 Loop 通过 Runtime 发布 `harness.run-view`，载荷为 `{sessionId,runId,sequence,frame:{protocolId,schemaVersion,exchangeId,payload}}`；`payload` 是安全投影的完整 `ProtocolViewSnapshot`。Runtime 持有最新快照，Web 组件重启不会丢失运行期展示。Web 解码后在同一 SSE 连接发送 `protocol-view`，数据为 `{sessionId,runId,snapshot}`。它不进入持久 RunEvent，也不递增 Run revision。每连接最多积压 128 个不同 Run 的快照或 256 KiB，同一 Run 未发送的旧帧由新帧替换；超限只关闭展示订阅。模型调用不等待网络消费者，`run-changed` 仍优先用于事实同步。

快照明确携带 `envelopeVersion:1`、`viewSchemaVersion:1`、`protocolId`、Session/Run 身份、独立的 `viewRevision`、`provisional/committed` 状态和有序 exchange/block。应用投影限制单快照最多 48 KiB，并明确标注截断；只保留文本、推理摘要、工具状态、受控详情和引用。Web 再按白名单解码，拒绝无效身份、结构、版本及引用范围；不显示任意 raw response、签名、原生续轮对象或密钥。引用仅允许不带用户名/密码的 HTTP(S) URL，正文使用 `textContent`，链接使用 `noopener noreferrer`。

每次 `ready`、恢复可见或校准读取后，控制器为活动 Run、当前路径及展开对象查询 `/view`。运行中查询优先读 Runtime；终态查询从 Session 原生记录投影，并使用 `committed` 状态。reducer 按 Session/Run/协议隔离，忽略同状态下重复或倒退的 `viewRevision`，允许终态覆盖临时态，拒绝终态之后的迟到临时帧。完整替换使漏帧、乱序和断线重连不会拼接错误文本；终态仍以持久 Run 与成功节点为准。控制器缓存按 Run 隔离并回收非可见历史，最多保留 64 个非当前视图缓存项。

共享线程通过 `protocols/modules.ts` 的静态 `getProtocolWebModule` 选择协议模块，不解释原生语义。Responses、标准 Chat Completions、DeepSeek、Anthropic 与 Gemini 各自绑定 `encodeInput/decode/reduce/mount`，共用文本编码器和安全 Turn 基元；模块解码与挂载拒绝其他协议或未知版本，未知协议没有通用回退，输入也不能提交。文本编码保留原文，模板只在服务端处理一次。Turn 按 Run 固定挂载，内部按 exchange/block 身份更新，保留未变化的 DOM；显示安全文本和块、工具状态、Responses 引用与搜索，以及 Anthropic 服务端工具暂停状态。composer 现在支持一段文本加有序图片：文件选择、粘贴和拖入共用保序上传队列；五种协议在配置具备有效图片能力时均可提交图片。图片使用 Session 归属的不可变引用，浏览器不生成原生 image_url，也不执行工具。运行退出和清理全部完成后才结算，最终历史展示由持久记录重建。

Prompt 操作者由 Web 宿主固定为持久身份 `local-web-user`，浏览器不能提交 `actorId` 或所有者字段。组件仍检查文档所有权和 Agent 管理权限；其他宿主身份创建的文档不会自动归属本机用户。修订冲突返回 `409 prompt-conflict`，发布冲突返回 `409 prompt-publication-conflict`，权限拒绝返回 `403 prompt-forbidden`。创建和编辑请求允许最多 1 MiB JSON，随后由 Prompt 领域校验 100000 字符的内容限制；其他请求继续采用 64 KiB 上限。

HTTP 等待超时、断开或 Web 单独关闭只释放等待者，不取消 Run。详细合约、迁移与客户端语义见[对话树实施记录](./session-conversation-tree.md)。

工具过程按 `name` 区分 `bash` 与 `apply_patch`，事件使用 `tool-started`、`tool-observed`、`tool-failed`；旧 Bash 事件由状态读取边界归一化后再发布。客户端根据事件顺序、请求 ID 和工具名归并当前调用，同一 ID 在后续模型批次重新使用时仍保留两条记录。Apply Patch 卡片显示 `applied/rejected/partial/cancelled`，保留已完成的文件变更、未完成操作和诊断；部分提交或移动未删源不会显示成完整成功。清理失败仍显示已知变更事实，状态显示失败。补丁预览单独标注截断，不影响持久记录或模型收到的工具结果。

## 页面流程

页面按浏览器可视高度布局，采用旧版 Anybox 桌面端经典主题的中性灰形态。桌面由 54px 功能轨、236px 项目与会话侧栏、剩余宽度的会话工作区组成；工作区顶栏与各面板标签式标题栏均为 40px。主画布为 `#f2f2f2`，侧栏为 `#e8e8e8`，功能轨为 `#ededed`，使用细分割线、小圆角和低对比度选中背景。功能轨顶部控制侧栏显隐，中部打开项目与会话，底部提供使用说明和设置；侧栏保留品牌、新建会话、项目与会话树和 Agent 摘要。所有项目同时列在树中，各项目的会话缩进显示在对应项目下，默认展开并可通过项目行左侧箭头独立折叠。整棵项目树使用剩余空间统一滚动，子会话列表不单独滚动；项目树与对话记录独立滚动，消息增长不会撑高整页。收起侧栏保留功能轨并释放水平空间，已有面板、草稿与查看位置保持不变。来源和迁移边界见[桌面界面迁移记录](./anybox-desktop-ui-migration.md)。

对话和输入框以不超过 880px 的阅读列居中。用户消息靠右显示为浅灰小气泡，助手正文直接置于画布；面板顶部保留起点、上一级和后续分支导航。输入框为细边框、6px 圆角，显示当前 Agent、会话模型选择器、发送起点、发送和取消按钮，文本区按内容增高；Enter 发送，Shift + Enter 换行。新会话与空工作区复用页面内嵌的 `anybox-mark` SVG symbol，点阵猫盒来自旧版静止帧，不请求外部品牌图片。根节点有已有分支时，空状态说明当前查看位置并显示最多三个快捷分支按钮，完整后续分支仍由顶部选择器分页访问；不会自动把最后完成节点当作查看位置。图标操作提供 `title` 悬停提示与 `aria-label` 或屏幕阅读器文本，键盘焦点使用可见描边。

不超过 760px 时，功能轨缩为 44px，侧栏默认收起，通过功能轨按钮打开覆盖式抽屉，不再挤占对话区高度。抽屉打开时主区域不可交互，键盘焦点留在侧栏；关闭按钮、遮罩或 Esc 收起抽屉并将焦点返回开关。点击可用的会话或新建会话按钮后收起抽屉，切换项目仍留在导航中。跨越断点时关闭抽屉，恢复页面内存中的桌面折叠偏好。侧栏显隐由 `client.ts` 管理，不持久化为服务端状态，也不重建会话控制器。

配置项通过功能轨底部“设置”打开原生模态弹窗。模型服务默认展示“我的连接”和所选连接的模型列表；连接状态区分未配置 Key、协议未安装、准备失败和停用。列表可以按模型名称/远端 ID 搜索，筛选全部、可用或不可用项，并逐行展示来源、不可用原因和参数预设标记。点击“参数设置”打开对应模型的参数编辑器；连接设置默认折叠，需要补 Key 或处理失败时展开。

浏览器只在 `localStorage` 记住模型设置中选中的连接 ID；再次打开时按该 ID 恢复，即使连接当前不可用也保留选择，方便补 Key 或修复。没有有效偏好时，优先选择包含可用模型的启用连接，其次是已启用且有 Key 或无需认证的连接，最后回退到第一个；空列表进入添加流程。此偏好不包含凭据，也不改变会话的模型选择。首次状态读取失败仍可点击“刷新状态”重试。

“添加提供方”打开独立流程：目录侧栏选择统一 Provider 定义与连接方案，表单确认账号连接名称、代理地址和 API Key，保存后自动准备适用模型并返回模型列表。目录只在添加流程中展示；模型详情、弃用开关、模态、价格、限制和完整快照来源放在折叠预览区。选择已有提供方仍可创建另一账号连接，公共定义与实际账号保持独立身份；未知映射可以在表单中手动选择协议。目录搜索保留可见的已选提供方，连接方案按自身身份匹配，不沿用其他提供方的选项序号。关闭或离开添加流程取消目录读取，释放搜索/轮询 timer；不同读取和刷新错误独立保留，已有连接仍可管理。

连接名称、地址、认证、超时、启停与新 Key 使用同一保存操作；所属 Provider 与协议创建后固定，Key 留空保留现有凭据。删除 Key 需在表单内确认，随后模型列表更新可用状态。高级连接设置提供模板、认证方式、超时、连接检查与版本历史。模型参数编辑器提供原生参数、能力与推理声明、自定义模型和“另存为参数预设”，远端发现收进单独折叠区。用户自定义 Provider/Model 明确 source:user；参数预设 baseline:false，与基础配置共享模型定义但拥有独立稳定配置 ID。参数以 `{protocolId,formatVersion:1,value}` 保存，表单的原生 dotted path（如 `reasoning.effort`、`thinking.type`）构建嵌套 JSON，拒绝原型键和路径冲突。初始化保存 descriptor 默认值，读取已有配置保留省略；Anthropic `max_tokens` 默认 4096，来源限制较小则取较小值。Responses/Anthropic 的搜索开关仅在能力明确声明 `webSearch.support=supported` 时启用，目录不按协议猜测模型支持；表单只生成相应原生服务端搜索工具配置，本地 Bash/Apply Patch 声明由 Driver 提供。保存使用 expectedRevision，冲突保留表单；历史不返回秘密。非秘密草稿只在当前页面按连接/配置身份保留，Key 在切换账号、关闭或 Esc 时清空。窄屏先关闭导航抽屉，弹窗仅内部滚动。

连接和 Key 分别提交：先保存连接配置，再使用返回的修订号更新新 Key。Key 写入失败时明确报告已保存的连接，并可在该连接上重试；保存成功后的状态刷新失败也保留已接纳的身份和修订号。刷新、重试或保存连接保留当前模型编辑器与非秘密草稿；每个账号分别记住已保存配置或新草稿这一编辑目标，以及编辑器是否可见和展开。新自定义模型和新参数预设即使收起、刷新或切换账号再返回，也可继续编辑；再次点击新建入口恢复已有的新草稿，仅显式“放弃修改”才清除它。草稿沿用开始修改时的修订号，服务器已有新修改时仍由 CAS 返回冲突。“另存为参数预设”使用当前表单参数与能力声明，与原配置共享模型定义但保存为独立配置，原模型配置继续保留。

用户点击“添加项目”打开统一应用内对话框，固定目标设备名称、实例身份和连接版本，默认从目标 Harness 的主目录开始，可浏览真实目录、编辑路径、筛选、切换隐藏项和分页。失败保留输入和位置，只有确认当前文件夹后才登记，取消不改变项目列表。有效目录链接进入后显示规范路径。原生窗口仅是启动器确认本机身份后的可选快捷入口；旧版 Harness 缺少浏览能力时在同一对话框手动输入路径并显示升级说明，不使用 window.prompt。目录状态控制器和 DOM 视图位于 src/client，HarnessClient 只负责固定目标请求；接口、键盘与焦点、分页清理及升级边界见[项目目录选择](project-directory-picker.md)。列表常驻显示项目名称，完整路径通过悬停提示查看，目录不可访问时额外显示状态。页面路由记录项目与可选 Session ID。无需切换项目即可浏览各项目展开的会话；点击项目名称选择顶部“新建会话”的所属项目，项目行右侧的新建按钮则直接在该项目中创建会话，均使用设置中选定的全局 Agent。行内新建按钮在悬停或键盘聚焦项目行时显示，触屏始终显示。已加载会话从首条可用输入在页面内派生标题，依次取祖先路径、直接子节点或已读 Run；未打开、尚无已知输入的列表项回退为 Session ID 摘要，不新增标题接口或持久字段。项目目录后来不可访问时，项目、Session 和 Run 历史数据仍保留，创建会话与新 Run 返回 `project-unavailable`。

面板持有明确的 `viewNodeId` 和 `focusedRunId`，起点默认为虚拟根，不推断最后完成节点。对话区域显示选中节点的祖先路径；后续分支通过直接子节点选择器分页浏览。原生完整节点提供继续、编辑重发和重新生成；运行记录展示独立标题、状态卡片与可展开工具过程。失败、取消、中断不会伪装成成功助手回复，主动跟随的 Run 会显示失败/取消/中断提示；旧版 Run 的起点未知标记也保留。`dialogue-v1` Session 保留原文、历史分支和查看操作，输入、选模、编辑重发与重新生成全部禁用，并提示新建会话；不自动导入或拼接为原生历史。每次发送固定可空父节点、当前选择的 `modelId` 与新幂等键，写入当前标签页的待提交存储后才 POST；确认接受即可继续提交，正在执行的 Run 不阻止新键提交。草稿按 Session/父节点保存在页面内存，过程缓存按 Run 隔离。只有用户仍在原位置且没有开始新输入时，当前标签页主动提交的 Run 才在成功后导航到结果。切换查看位置、关注其他 Run、输入新草稿或关闭面板都会停止自动跟随。

刷新或重新打开会话时，先按键只读查询已接受 Run，再恢复未确认提交。已有 `anybox.web.v2.pending` 存储继续读取，新记录明确携带 `schemaVersion:1`；旧记录缺少该版本、父节点或固定模型且查不到已接受 Run 时，仅恢复输入供用户选定位置和模型后确认，不自动转换后重发。旧只读 Session 的未接受输入保留为草稿并提示新建会话。已发出的写请求即使面板关闭也按原 Session 和幂等键结算；关闭面板只停止读取和轮询，不调用取消接口。Key 仅在 Provider 表单中提交；响应不返回原值，也不把 Key 写入 sessionStorage。

每个会话的模型选择由服务端 `Session.modelId` 持久化，模型选择器按 ProviderConnection 分组并显示不可用原因。首次接受原生 Run 后 Session 固定 `protocolId`，前端禁选其他协议并提示新建会话；选模接口和 Run 显式模型覆盖均再次校验，不靠 UI 维持约束。同协议配置仍由后端检查历史和能力兼容性。有效工具能力未知或不支持时，Harness 不提供 Bash/Apply Patch，按纯文本方式调用，只有明确可用工具能力才提供这两项工具。Composer 保留会话模型选择器，模型配置统一从“设置 → 模型”进入。没有选定可用模型时禁止新提交；没有可用模型时提示前往设置配置。历史仍可阅读，已接受 Run 保持原快照。配置写入后刷新共享模型列表并更新所有面板，不自动替换会话选择。切换模型只影响后续 Run，重试未确认请求继续携带原 `modelId`，不会因另一个页面修改 Session 选择而改用其他模型。

“设置 → Prompt 管理 → 打开 Prompt 编辑器”提供文档列表、草稿编辑、版本预览和 Agent 绑定。首次可点击“编辑当前指令”，将内置指令复制为本机用户的草稿；已有可管理绑定则直接打开对应文档。保存、发布、应用是三个独立步骤：保存不改变已发布内容，发布不自动切换绑定，应用只影响后续 Run，所有项目共享该 Agent 的绑定。用户可选择旧版本重新应用。编辑与发布都校验页面读取的修订号；冲突保留输入供复制，并提供显式放弃修改及重新读取操作。未保存时阻止切换文档或关闭编辑器，避免静默丢失输入。

第一版没有项目删除、目录迁移、项目专属 Agent/Prompt 或工具审批。对话分支共用项目目录，不提供文件快照、修改回滚或环境可复现性；未来工作区绑定单独设计。


## 分屏布局与资源归属

- 一个工作区最多四个面板，可跨项目；同一 Session 仅一份面板与控制器。点击已打开会话聚焦它，点击其他会话替换活动面板。侧栏选择或折叠项目保留工作区和其他项目的会话列表；顶部新建会话使用侧栏选中项目，项目行的新建按钮使用所在项目。
- 从会话列表或面板标题拖到目标四边创建/移动分屏，中央无落点；Pointer Events 在移动超过 6px 后显示落点预览，Esc 或取消手势不改变布局。菜单另提供右侧/下方打开。达到数量上限仍可移动或替换。
- 布局是二叉树，叶节点绑定会话；分割节点记录水平/垂直方向、比例和两个子节点。关闭叶节点收拢兄弟节点。每叶最小 320×260px，分隔条 8px，嵌套区域递归计算尺寸；分隔条支持指针拖动和方向键每次 5% 调整。
- 窗口不超过 760px 或当前树无法满足最小尺寸时，保留布局并显示切换条及活动面板。恢复足够空间后还原。移动和响应式切换复用面板 DOM/控制器，保留输入、滚动和过程展开；后台更新只渲染对应面板，阅读历史时不强制滚到底部。
- 布局、活动面板、侧栏项目保存在 `anybox.web.workspace.v1`，查看位置和关注对象保存在 `anybox.web.positions.v1`，均属于 sessionStorage。普通未发送草稿仅在当前页面内保留。恢复会话后重新读取服务端数据；无效叶节点移除，网络故障保留视图重试，布局存储失败提示但不禁止操作。刷新不恢复隐式自动跟随。
- 原项目/会话 hash 继续有效，URL 表示活动会话。恢复布局后按 URL 聚焦已有会话或替换活动面板；前进/后退使用相同规则，不回放布局树。侧栏浏览项目与活动会话独立。
- 每个打开会话只有一个串行刷新任务，由共享 SSE 通知触发；连接健康时每 30 秒校准，连接未就绪或断线时每 5 秒兜底查询，恢复可见后立即刷新。隐藏页面收到通知只标记待刷新。读取、提交/取消或节点导航中收到通知会合并并在完成后补查，不等待下一次定时校准。按会话列出所有 Run，按 revision 合并，按 afterSeq 增量读取活动/展开对象的事件。请求代次和 AbortController 防止已关闭视图的旧响应发布。
- 关闭/替换释放读取、定时器及 DOM 监听器，并更新共享 SSE 的订阅集合；最后一个面板关闭时释放连接。控制器仍可完成原已发出写入，草稿留在页面内存供重开使用。所有面板共享现有 HTTP 与 Nya 服务，增加面板不创建额外 Context、组件、数据库表或运行生命周期。

## 验收

`tests/workspace-layout.test.mjs` 覆盖四方向分割、跨项目移动、上限、关闭收拢、尺寸约束、损坏记录恢复和 URL；`tests/session-client.test.mjs` 覆盖独立运行/取消、关闭和延迟响应、丢响应查键、旧 pending、存储拒绝、revision 合并、显式节点与乱序完成。HTTP 测试验证新增浏览器模块白名单，继续阻止访问宿主模块。

`tests/tool-trace.test.mjs` 与 Web HTTP 测试使用本地受控事件验证混合工具、重复请求 ID、补丁的四种结果、部分移动、清理失败事实和 Unicode 预览截断；此验证不访问真实模型或工作区数据库。

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

Chrome 验收使用真正的 Models/Harness/Web 与临时 SQLite，凭据库和 HTTP 传输注入测试替身：创建无需认证的 Responses 连接、获取候选列表、确认能力并保存模型、会话选模、观察临时流文本切换为最终节点、取消第二次运行，以及修改参数后查询两个历史版本。390px 宽度验证表单内部滚动和模型选择器；测试没有访问真实远端模型、真实 Key 或工作区数据库。

### 公共目录与原生协议验收（2026-09-28）

`tests/models-directory-web.test.mjs` 使用真实 Nya、三套临时 SQLite、本地 HTTP 和原生 JSON/SSE mock，验证 Anthropic 与 Gemini 的文本、Bash 工具续轮、最终答案，以及代理地址、4096 默认参数、目录移除保留配置、双账号自动基础配置、参数预设、幂等同步重试、失败保旧、断连和关闭等待实际 reader 退出。`tests/models-client.test.mjs` 补充新表单默认值、模态与协议匹配、独立目录读取代次、刷新/查询乱序、分通道错误保留、预先取消不发请求以及关闭后过期成功/失败响应不发布。模块内测试覆盖缓存/ETag/退避、实际退出、旧配置、参数校验、签名私有化和分页发现。

2026-09-28 统一定义接入阶段的 Chrome 验收（此次布局整理前）使用临时 Models/Harness/Web 宿主和内存凭据、HTTP 替身：在目录选择 Anthropic、调整代理地址并保存一次测试 Key 后，兼容模型自动加入可用列表，基础配置持久保存 4096 输出默认值，弃用模型显示原因。高级模型设置默认折叠；新增 8192 输出的参数预设后基础配置仍在。会话选择自动模型后完成流式文本和 Bash 续轮至最终答案；手动刷新保留未保存的名称/地址，页面重载后会话选择与答案仍在，控制台无 error/warn。复现入口为 `node tests/helpers/catalog-browser-host.mjs`；测试标签页和临时宿主已关闭并清理，完整范围见[验收记录](models-catalog-validation.md)。

同日的模型服务整理使用 Codex 内置浏览器验证独立添加流程、账号连接列表、模型搜索/状态筛选、统一保存连接与 Key、删除 Key 后整组不可用、参数预设保留原基础配置，以及保存/刷新/切换账号后保留非秘密草稿。新增模型与预设收起后仍能恢复，明确放弃才清除；受控外部修改后保存旧草稿返回冲突，表单内容保留，放弃修改可载入最新参数。窄屏验证单列布局和操作可达性，浏览器无 warning/error。截图与具体步骤见[界面验收](models-catalog-validation.md#模型服务排布与交互整理)。最终 `npm run check`：426 项通过，2 项系统凭据测试按门控跳过，0 失败。

### 原生 Turn 视图与只读历史验收（2026-09-28）

Web 相关 115 项测试通过，覆盖原生参数与启动转换、Session 选模与旧 pending、协议视图解码和 reducer、四面板布局、SSE 完整快照合并及背压、目录 HTTP、工具卡片和组件关闭。新增服务端测试验证运行中快照在 Web 组件替换后仍可查询，终态投影在整个应用重启后恢复；同一会话跨协议选模和显式 Run 覆盖均被拒绝。`tests/protocol-view-client.test.mjs` 验证私有字段过滤、稳定块身份、重复/漏帧/乱序与终态拒绝迟到临时帧、引用偏移和安全 URL。

实际 Chrome 验收运行 `CATALOG_BROWSER_SEED=1 node tests/helpers/catalog-browser-host.mjs`，使用真实 Models/Harness/Web、临时 SQLite、内存凭据与模拟原生 HTTP：发送 Anthropic 文本并刷新恢复答案及选模；运行本地 Bash 并查看完成卡片和 stdout；编辑已完成节点生成同父兄弟分支，确认仅渲染选中路径；提交含 `<script>` 的普通消息后确认 DOM 没有注入脚本，原文按文本显示。模型表单保留 `max_tokens:4096` 与原生嵌套字段；搜索能力未知时开关禁用，显式改为支持后启用。

另以 `CATALOG_BROWSER_LEGACY=1` 在测试库插入旧文本历史，验证原始输入和答案仍可读、分支导航可用，模型选择、发送、编辑和重新生成禁用，并显示“只读历史”。浏览器验收发现并修复首次绑定后模型选择缓存未刷新，以及旧会话输入禁用状态被覆盖的问题。测试标签页和两个临时宿主均已关闭并等待退出；没有使用真实凭据、外部模型或现有工作区数据库。

### 图片输入的客户端状态

`image-client.ts` 持有可测试的草稿存储、两路上传队列和工作区续期器；这些是 Web Frontend 的内部函数，不注册额外组件。图片字节由 Session/图片组件导入和保管。`session-client.ts` 仍负责选定父节点、幂等提交和导航，草稿包含原文及有序图片。pending v2 把引用持久保存后才发送，丢失响应先按幂等键校准；v1 文本兼容，未知图片记录只恢复为显式待确认草稿。图片-only、编辑重发和重新生成均复用同一引用，不从预览反推输入。

图片上传中或失败会阻止发送；移除取消该上传，排队并发槽位在请求实际退出后才释放。刷新页面不保留 File/base64，未完成上传显示为失败占位。预览使用同源图片 URL，不放宽 CSP。草稿每 5 分钟续期，覆盖所有 Session/父节点和已关闭面板的 pending；页面重新可见及提交前再校准。未接受图片 24 小时后过期不能复活，已接受 Run 的保留不依赖浏览器。协议/能力不支持时保留草稿并提示切换模型或移除图片。限制与接口见 [Web Frontend](modules/web/web-frontend.md)。

2026-09-29 使用 `ANYBOX_TEST_IMAGE_INPUT=1 node tests/helpers/workspace-browser-host.mjs`、临时数据库、内存凭据、原生 Chat HTTP 替身和生成的 320×180 PNG，在原生 Chrome 中验证文件选择上传、同源预览、刷新保留纯图片草稿、纯图片运行成功、编辑重发保留原图、刷新保留修改后的文本与图片、重新生成创建另一成功分支且图片引用不变。截图已在验收时目视检查；临时宿主和新建标签页随后关闭。此验收不调用真实远端模型，后端重启恢复和图片分支隔离由原生协议集成测试覆盖。

项目文件引用已接入现有 textarea、按节点草稿、多分屏及历史编辑/重新生成。发送固定快照，历史预览保持原内容；交互、HTTP 和 pending v3 的详细规则见[项目文件引用设计](project-file-references-design.md)。

## 会话归档与恢复

项目会话菜单提供“归档”，侧栏“已归档会话”打开跨项目原生对话框，展示项目、会话标识与归档时间；列表支持查看、恢复、加载、空态与失败重试。请求期间禁止同会话重复写入，旧列表响应不能覆盖新查询结果。

归档成功关闭对应面板，更新布局与路由但保留草稿和查看位置。归档历史打开后只读，输入/附件/选模/编辑重发/重新生成均锁定，历史分支和附件读取可用；恢复按钮解锁原生会话，旧文本会话继续只读。恢复不自动打开未显示会话。轮询检测其他标签页的归档转换，首次加载归档会话则留在只读视图；重新可见刷新项目与归档列表。未知提交继续先查询幂等结果，只有确认未接受才合并回原父节点草稿。

验收使用 `tests/helpers/workspace-browser-host.mjs` 的临时库和受控模型，覆盖跨项目归档、四分屏移除、草稿保留、历史只读、恢复、窄屏对话框和键盘焦点。后端与前端行为测试通过根 `npm run check` 执行。
