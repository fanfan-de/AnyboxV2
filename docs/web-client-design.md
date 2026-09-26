# 薄 Web 客户端第一版

状态：本机单用户参考实现，2026-09-26。已接入最多四个跨项目会话面板、拖拽分屏、标签页内布局恢复，以及会话树显式查看位置和多 Run 状态。验证使用临时数据库与受控模型，不访问真实凭据或工作区数据库。

## 边界

浏览器只通过同源 `/api/v1` 与本机 Web 组件交互。应用宿主在同一个 Nya 根上装配自包含 API Key 服务、DeepSeek、SQLite、Harness、目录选择器和 `web-frontend` 组件；Web 组件拥有 HTTP 监听器与静态页面，应用入口处理进程信号并通过 `harness.close()` 卸载整个根。Harness 负责项目、Session、Run 准入、幂等、执行、取消与结算。浏览器不导入 Nya 或 Harness，不直接访问模型、SQLite 或凭据，也不保存权威业务状态。

页面使用原生 TypeScript、HTML 和 CSS。`src/web/client.ts` 负责全局设置与启动；`workspace-layout.ts` 提供纯布局函数，`workspace-client.ts` 管理工作区，`session-client.ts` 管理每个会话的请求，`session-view.ts` 管理面板 DOM，`prompt-client.ts` 保留 Prompt 设置。浏览器模块只依赖浏览器 API；`src/web/component.ts` 接收 Harness 校验后的 Agent ID 列表，通过 Nya 注入 Projects、Session、Run、Prompt、Agent Prompt、目录选择器和通用凭据设置服务，`src/web/server.ts` 把服务映射为 HTTP 接口。公开的 Session、Run 和 Run 事件视图不暴露 Agent 指令、Prompt 内容快照、模型调用计划、密钥或 Nya 服务；Bash 命令与输出摘要会显示给本机页面。Prompt 管理接口单独返回可管理文档、版本和 Agent 当前使用的内容。依赖撤销时 Web 先取消在途目录选择，关闭监听器并等待请求退出（包括已接收的 Prompt 写入），再释放其依赖；依赖恢复后组件在原端口重启。

## 本机协议

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/v1/agents` | 返回全局 Agent `{id}` 列表 |
| `GET /api/v1/projects` | 返回项目 ID、名称、规范化目录路径和可用状态 |
| `GET /api/v1/projects/picker` | 返回原生目录选择器的 `{supported}` 状态 |
| `POST /api/v1/projects/pick` | 用 `{}` 打开原生目录选择窗口；选中后登记并返回项目，取消返回 `null` |
| `GET /api/v1/projects/:id/sessions` | 列出项目下的 Session |
| `POST /api/v1/sessions` | 用 `{projectId,agentId}` 创建 Session |
| `GET /api/v1/sessions/:id` | 读取 Session 元数据和 `projectId`，不返回 turns |
| `GET /api/v1/sessions/:id/runs` | 列出会话的 Run，支持 `status=active` 和 `parentNodeId` 过滤（`root` 表示虚拟根） |
| `POST /api/v1/sessions/:id/runs` | 用 `{parentNodeId: string|null,input,idempotencyKey}` 接受 Run；父节点必填 |
| `GET /api/v1/runs/:id` | 读取公开 Run 的 `history`、`revision`、状态与 `resultNodeId`/结果 |
| `GET /api/v1/runs/:id/events` | 支持 `afterSeq` 增量读取 Run 的过程事件；Bash 观察的 stdout、stderr 各截为最多 2048 UTF-8 字节，不返回内部快照 |
| `POST /api/v1/runs/:id/cancel` | 请求取消，返回当前 Run 状态 |
| `GET /api/v1/sessions/:id/nodes/:nodeId` | 完整节点 |
| `GET /api/v1/sessions/:id/nodes/:nodeId/path` | 根到节点的路径，`root/path` 为空 |
| `GET /api/v1/sessions/:id/nodes?parentNodeId=…` | 直接子节点分页，父节点必填；root 为根；支持 cursor、limit，返回 nodes、nextCursor |
| `GET /api/v1/sessions/:id/runs/by-key/:key` | 只读查回已接受请求，包括旧 Run |
| `GET /api/v1/runs/:id/wait?timeoutMs=…` | 0..25000 毫秒，默认 25000；返回 done、timedOut 与 run |
| `GET /api/v1/credentials` | 列出已注册凭据的公开元数据和配置状态 |
| `POST /api/v1/credentials/:id` | 用 `{key}` 保存已注册服务的 Key，返回该项状态 |
| `POST /api/v1/credentials/:id/delete` | 用 `{}` 删除已注册服务的 Key，返回该项状态 |
| `GET /api/v1/prompts` | 列出本机用户的 Prompt 文档和草稿 |
| `POST /api/v1/prompts` | 用 `{name,description?,kind,role,content}` 创建草稿 |
| `GET /api/v1/prompts/:id` | 读取可管理文档及草稿修订号 |
| `POST /api/v1/prompts/:id` | 用 `{expectedRevision,...patch}` 修改草稿；允许字段同创建接口 |
| `GET /api/v1/prompts/:id/versions` | 按发布顺序读取不可变版本 |
| `POST /api/v1/prompts/:id/publish` | 用 `{expectedRevision}` 发布当前已保存草稿 |
| `GET /api/v1/agents/:id/prompts` | 读取 Agent 各用途的当前内容，包括内置默认指令 |
| `POST /api/v1/agents/:id/prompts` | 用 `{versionId}` 将已发布版本应用到 Agent 的对应用途 |

成功响应是 JSON。失败响应是 `{ "error": { "code": "..." } }`；已知输入错误、对象不存在、准入冲突或项目不可用、服务不可用分别使用 400、404、409、503，未知错误统一为 500，不传出内部异常。写请求要求同源 `Origin` 和 JSON；所有请求要求本机地址的 `Host`，宿主只监听 `127.0.0.1`，不开放 CORS。本机单用户版本没有账号或远程访问能力。

Prompt 操作者由 Web 宿主固定为持久身份 `local-web-user`，浏览器不能提交 `actorId` 或所有者字段。组件仍检查文档所有权和 Agent 管理权限；其他宿主身份创建的文档不会自动归属本机用户。修订冲突返回 `409 prompt-conflict`，发布冲突返回 `409 prompt-publication-conflict`，权限拒绝返回 `403 prompt-forbidden`。创建和编辑请求允许最多 1 MiB JSON，随后由 Prompt 领域校验 100000 字符的内容限制；其他请求继续采用 64 KiB 上限。

HTTP 等待超时、断开或 Web 单独关闭只释放等待者，不取消 Run。详细合约、迁移与客户端语义见[对话树实施记录](./session-conversation-tree.md)。

## 页面流程

页面按浏览器可视高度布局。桌面端顶部操作、项目与会话导航、新建会话和消息输入框保持在一屏内；项目列表、会话列表与对话记录各自在区域内滚动，消息增长不会撑高整页。窄窗口将项目与会话并排放在顶部的紧凑导航区。配置项统一通过顶部“设置”按钮打开小型原生模态弹窗，集中提供新会话的 Agent 选择和 API Key 管理；主界面保留项目、会话与消息操作。弹窗支持关闭按钮与 Esc，关闭后清空未提交的 Key 并将焦点返回设置按钮。新会话使用弹窗中选定的 Agent，选择在当前页面内生效；弹窗内容超出小窗口高度时仅内部滚动，关闭按钮始终可见。

用户点击“添加项目”打开 macOS 原生文件夹选择窗口；选中后登记项目并显示名称和路径摘要，悬停可查看完整路径，取消不改变项目列表。浏览器不提供路径输入，也不能用旧的按路径 HTTP 接口登记项目。目录选择器在其他系统上报告不支持，Web 仍可启动。页面路由记录项目与可选 Session ID。选中项目后可浏览该项目的会话，使用设置中选定的全局 Agent 创建新会话。项目目录后来不可访问时，项目、Session 和 Run 历史仍可查看，创建会话与新 Run 返回 `project-unavailable`。

面板持有明确的 `viewNodeId` 和 `focusedRunId`，起点默认为虚拟根，不推断最后完成节点。对话区域显示选中节点的祖先路径；后续分支通过直接子节点选择器分页浏览。完整节点提供继续、编辑重发和重新生成；运行记录单独展示，失败、取消、中断不会伪装成助手回复，旧版 Run 明确标注起点未知。每次发送固定可空父节点与新幂等键，写入当前标签页的待提交存储后才 POST；确认接受即可继续提交，正在执行的 Run 不阻止新键提交。草稿按 Session/父节点保存在页面内存，过程缓存按 Run 隔离。只有用户仍在原位置且没有开始新输入时，当前标签页主动提交的 Run 才在成功后导航到结果。切换查看位置、关注其他 Run、输入新草稿或关闭面板都会停止自动跟随。

刷新或重新打开会话时，先按键只读查询已接受 Run，再恢复未确认提交。已有 `anybox.web.v2.pending` 格式继续读取；旧记录缺少父节点且查不到已接受 Run 时，仅恢复输入供用户选定位置后确认，不猜测起点、不自动发出写请求。已发出的写请求即使面板关闭也按原 Session 和幂等键结算；关闭面板只停止读取和轮询，不调用取消接口。API Key 管理仅操作宿主注册的服务，响应不返回原值。

“设置 → Prompt 管理 → 打开 Prompt 编辑器”提供文档列表、草稿编辑、版本预览和 Agent 绑定。首次可点击“编辑当前指令”，将内置指令复制为本机用户的草稿；已有可管理绑定则直接打开对应文档。保存、发布、应用是三个独立步骤：保存不改变已发布内容，发布不自动切换绑定，应用只影响后续 Run，所有项目共享该 Agent 的绑定。用户可选择旧版本重新应用。编辑与发布都校验页面读取的修订号；冲突保留输入供复制，并提供显式放弃修改及重新读取操作。未保存时阻止切换文档或关闭编辑器，避免静默丢失输入。

第一版没有项目删除、目录迁移、项目专属 Agent/Prompt、流式输出或工具审批。对话分支共用项目目录，不提供文件快照、修改回滚或环境可复现性；未来工作区绑定单独设计。


## 分屏布局与资源归属

- 一个工作区最多四个面板，可跨项目；同一 Session 仅一份面板与控制器。点击已打开会话聚焦它，点击其他会话替换活动面板。侧栏切换项目保留工作区，创建会话使用侧栏项目。
- 从会话列表或面板标题拖到目标四边创建/移动分屏，中央无落点；Pointer Events 在移动超过 6px 后显示落点预览，Esc 或取消手势不改变布局。菜单另提供右侧/下方打开。达到数量上限仍可移动或替换。
- 布局是二叉树，叶节点绑定会话；分割节点记录水平/垂直方向、比例和两个子节点。关闭叶节点收拢兄弟节点。每叶最小 320×260px，分隔条 8px，嵌套区域递归计算尺寸；分隔条支持指针拖动和方向键每次 5% 调整。
- 窗口不超过 760px 或当前树无法满足最小尺寸时，保留布局并显示切换条及活动面板。恢复足够空间后还原。移动和响应式切换复用面板 DOM/控制器，保留输入、滚动和过程展开；后台更新只渲染对应面板，阅读历史时不强制滚到底部。
- 布局、活动面板、侧栏项目保存在 `anybox.web.workspace.v1`，查看位置和关注对象保存在 `anybox.web.positions.v1`，均属于 sessionStorage。普通未发送草稿仅在当前页面内保留。恢复会话后重新读取服务端数据；无效叶节点移除，网络故障保留视图重试，布局存储失败提示但不禁止操作。刷新不恢复隐式自动跟随。
- 原项目/会话 hash 继续有效，URL 表示活动会话。恢复布局后按 URL 聚焦已有会话或替换活动面板；前进/后退使用相同规则，不回放布局树。侧栏浏览项目与活动会话独立。
- 每个打开会话只有一个串行刷新任务；有活动 Run 时约 1.2 秒，空闲或页面隐藏时 5 秒，恢复可见后立即刷新。按会话列出所有 Run，按 revision 合并，按 afterSeq 增量读取活动/展开对象的事件。请求代次和 AbortController 防止已关闭视图的旧响应发布。
- 关闭/替换释放读取、定时器及 DOM 监听器；控制器仍可完成原已发出写入，草稿留在页面内存供重开使用。所有面板共享现有 HTTP 与 Nya 服务，没有新的 Context、组件、数据库表或运行生命周期。

## 验收

`tests/workspace-layout.test.mjs` 覆盖四方向分割、跨项目移动、上限、关闭收拢、尺寸约束、损坏记录恢复和 URL；`tests/session-client.test.mjs` 覆盖独立运行/取消、关闭和延迟响应、丢响应查键、旧 pending、存储拒绝、revision 合并、显式节点与乱序完成。HTTP 测试验证新增浏览器模块白名单，继续阻止访问宿主模块。

浏览器验收使用 `npm run build` 后运行 `node tests/helpers/workspace-browser-host.mjs`，输出临时测试站点地址；Ctrl+C 关闭并清理临时库。2026-09-26 已验证会话拖入四面板、移动保留草稿、指针与键盘调整尺寸、跨项目导航、刷新恢复、窄屏切换、跨会话提交、关闭后运行继续、显式取消、双标签页发现其他 Run 且保持各自查看位置、设置和 Prompt 编辑器入口。此工具使用受控模型与内存凭据，不能作为真实模型或系统凭据库验收。
