# Application HTTP 监听组件

[宿主模块](README.md) · [harness server 业务适配器](harness-http.md)

`src/host/component.ts` 的 `createApplicationApiComponent(root,catalog,port,{authenticated,host})` 创建 `host-application-api`，提供 `host.http: ApplicationHttpServer`（url、幂等 close）。注入 app.products、app.activity，以及认证模式的 host.access。它不导入 Anybox Harness/Models 类型，应用失败或缺依赖时仍提供目录和控制。

内部 `startApplicationHttpServer` 是客户端和执行端共用的监听器实现。执行端使用 `/api/v1`；客户端 Shell 使用 `/api/client/v1`。组件持有监听 socket、请求集合、监听器生命周期信号及撤销订阅。注册目录拥有精确静态地址与业务前缀；静态文件只从映射读取，不遍历任意路径。

生产执行端认证 Bearer 和 instanceId；无认证客户端校验 Host、Origin 和 Sec-Fetch-Site。设置 CSP/no-store。产品控制保持既有接口，已接受控制不因断连取消。业务归属由目录路由固定，身份头仅能与归属一致。授权、Activity 登记、根上当前适配器捕获均在首次异步业务工作前完成。

桌面客户端额外配置私有 `transportSecret` 时，监听器先以常量时间摘要比较校验 `X-Anybox-Desktop-Transport`，再执行原 Host/Origin 及目录规则。校验覆盖静态资源和全部 API，不能以回环地址替代桥接授权；凭证由桌面受信进程在转发时添加，页面脚本不持有它。执行端访问令牌与此传输凭证的职责和归属独立，普通 Web 监听行为不变。

ApplicationHttpContext 提供 appId、actorId、signal 和 retainUntil。handle Promise 代表请求/流实际退出；finally 等待 retainUntil 保留操作退出后释放租约和 HTTP 任务。监听器关闭会等待这些已受理任务，宿主必须与根资源取消同时排空。GET 是可取消观察，写入默认为阻塞活动。资源或 SSE 应响应 signal 并等待实际退出。接口说明见 src/host/applications/registration.ts。

close 同步停止 HTTP 准入、发送关闭信号并取消未完成请求体，等待已接受处理完成和 socket 释放；已接受普通写入可完成响应。令牌撤销关闭其活动响应。应用业务取消、DTO 和通知属于应用适配器。Effect 调用同一 close 并报告故障；宿主聚合 HTTP 与 Nya 清理错误。

通用客户端与执行宿主的 `prepareClose()` 同步开始监听器关闭，同时停止产品控制和应用运行时准入；它等待控制与装配退出，保留组件与存储直到宿主 `close()` 卸载整根。HTTP 排空还等待 `retainUntil()` 保留操作及租约实际退出，因此只在 `close()` 中与 Nya 根清理一起等待，避免 Run 需要根清理取消而 HTTP 先等待 Run 的死锁。执行端的 `closing` 从准备阶段开始即为 true，Run 准备同步关闭；已接纳运行的取消与实际退出仍由后续根清理负责。两个方法均幂等，准备失败不跳过后续资源清理。

浏览器入口归各应用静态资源。Anybox Harness 只挂载项目与会话工作区，侧栏底部将一处紧凑设备选择器与设置图标放在同一行，连接、模型与 Prompt 在工作区设置的分类面板中管理；设备的“启动 Agent”“停止 Agent”位于“管理连接”分类。此布局不改变宿主监听器、HTTP 分派和应用启停契约，具体展示与恢复见[Web 客户端设计](../../web-client-design.md)和[宿主设计](../../products-v1.md)。

项目会话列表与已归档列表使用 Session 返回的 `title`，无需打开会话或加载对话历史。标题由 Session 从首次已接受输入派生；打开不同分支、关闭面板或刷新页面不改变名称。空会话继续显示短 ID；新会话首次发送后，面板读取 Session 时同步更新列表标题，不再从当前路径或临时 Run 列表缓存名称。

工作区设置的“Agent 工具”读取所选执行设备的统一目录与 Agent 工具配置，支持单项复选、名称/功能搜索、功能分类和来源过滤，可自由跨来源组合。来源只是显示标签，明确依赖显示为待补选工具；保存与重新加载都固定设备与 Agent，CAS 冲突保留草稿，未保存或正在保存时参与 canLeave 检查。`tools-client.ts` 属于现有 Web 生命周期，不新增 Nya 组件或数据库。关闭组件取消目录/配置读，等待已提交设置写入。会话输入区只读显示创建时固定的原始工具名称与来源，修改 Agent 不变更已打开会话。

Codex、Claude Code 和 DeepSeek Harness 工具使用独立调用名，轨迹和协议工具卡通过真实观察显示命令、进程 ID/退出码/信号、输出、文件内容、实际文件变更、未完成项和搜索结果，原始参数/结果保留为可展开的字面 JSON。工具读取的图片使用本会话保留引用生成已有认证资源 URL，显示可打开原图的缩略图；不从工具提供的任意 URL 加载图片。每个 Run 的轨迹组展示最后一份已提交计划或 todo 完整列表；只有 tool-observed 更新列表，空列表明确清空，尚未执行的请求不成为计划事实。Run 关闭的通用操作事件只公开进程退出字段，按 process session ID 补充 Codex exec/stdin 卡的最终输出与状态，包括取消时实际终止事实。cleanup-failed 仍保留已有结果、部分文件变更及图片引用。工具事实继续按模型 exchange、requestId 与出现位置隔离；未知工具请求不从任意字段猜测执行动作。测试入口为 `tests/tools-client.test.mjs`、`tests/agent-tools.test.mjs` 和工具轨迹/摘要测试。

会话顶部“分支”提供覆盖式总览，线性对话保留当前祖先路径，轮次旁可切换同父成功分支。内部 `conversation-tree.ts` 只从已查询的成功结果关系与真实节点派生展示索引，`conversation-tree-view.ts` 持有各面板独立的折叠、滚动、焦点及可撤销 DOM 监听，不新增 Nya 组件、HTTP 或持久资源。进行中 Run 以独立状态行进入轨迹；旧历史不补造关系，归档与旧会话仍只读。关闭面板清理监听，隐藏面板不进行零尺寸布局写入。规则和验收入口见[对话树](../../session-conversation-tree.md#查询与-web)。

Anybox Harness 对话与轨迹明细共同挂载四协议各自的展示 v2 内容组件。共享容器管理 exchange 顺序、稳定 mount/update/dispose 以及输入；Markdown、引用、折叠和工具事实为基础 UI，不建立通用原生内容类型或新增 Nya 组件。推理摘要/思考内容/推理内容默认折叠，标题显示生成状态；推理、工具与工具组共用折叠箭头、固定图标槽和标题行样式，左侧对齐，推理竖线仅显示在展开正文中。各面板独立保留手动展开、焦点、滚动及轨迹选中行，刷新后恢复默认。轨迹列表只使用派生摘要和搜索文本，每个模型调用仍只有一个真实计时行。

对话使用 `presentation:'compact'`，推理、工具与工具组的折叠标题行高 28px、上下外边距 2px，保留字号与展开正文、最终回复的阅读间距。Chat Completions 的空白正文块保留挂载身份与原生记录，但隐藏整个显示块，避免正文外边距撑开过程行；流式更新为非空文字时原地恢复显示。工具摘要行呈现名称、动作、真实状态及有效耗时；异常增加一行事实原因。工具摘要纯函数位于 `tool-call-view.ts`，已知命令、状态和补丁变更以持久执行事实为准，无事实只解析完整已知参数；待同步、缺失和读取失败明确区分，不推断执行成功。`protocols/primitives.ts` 持有稳定摘要按钮、原地详情与默认收起的原始参数；详情单一滚动区最多 320px，复制原文并保留截断提示。事实、流式帧和终态同步不重建按钮或丢失焦点、展开与详情滚动。

`protocols/view.ts` 只根据挂载对象的本地工具展示标记排列同一 exchange 内相邻工具，两个及以上显示稳定折叠组；文本、思考、拒绝、服务端工具及截断提示打断分组。组收起仍显示需关注数量和首个异常原因，不累加耗时。单工具增长为组时保留已展开详情或组内焦点，之后尊重用户选择。服务端工具的独立摘要由协议模块解释，不加入本地分组。轨迹模型明细采用 `presentation:'detail'`（默认），工具行打开完整详情。对话和轨迹的交互选择按面板独立保留至关闭；折叠及复制监听随 block、exchange 或面板 `dispose()` 撤销。HTTP、SSE、持久协议和 Nya 生命周期合约保持不变。

协议工具卡仅由请求层展示一处“原始参数”，优先展示和复制模型请求的原始 JSON 字符串；请求展示不完整且已有库工具执行事实时，使用执行记录中的参数并明确标注来源。嵌入的执行详情省略参数披露项，继续展示原始结果与实际执行事实。独立轨迹工具详情仍展示执行记录中的参数，避免去重后失去入口。

事件读取已完成但活动 Run 尚未取得匹配工具事实时，摘要仍为中性的“执行事实待同步”；终态且事件已读取才把缺失事实列为需关注。读取失败独立提示。请求内容和持久结果切换时，先把将被隐藏的复制按钮焦点移到稳定详情区域，保留用户展开和阅读位置。

原生对话与轨迹明细只展示受 48KiB 预算约束的 v2 投影及截断提示，缺少投影时显示读取或不可用状态，不以保存的聚合回复降级；完整聚合文本只参与轨迹摘要与搜索，旧 dialogue-v1 的只读文本展示继续保留。

客户端、执行设备和 Web 静态资源同步升级到展示 v2，旧或未知展示格式明确显示不兼容；旧原生记录 v1/v2 和旧绑定版本仍在服务端重新投影，不增加数据库迁移。旧 dialogue-v1 继续只读。

协议展示的行为入口为 `tests/tool-call-view.test.mjs`、`tests/protocol-web-modules.test.mjs`、`tests/session-view.test.mjs` 与 `tests/trajectory.test.mjs`。运行 `node tests/helpers/native-view-browser-host.mjs` 可启动隔离浏览器验收宿主，使用内存样本复验四协议内容、1→2→3 工具增长和终态更新、长输出/失败/部分补丁、默认紧凑与详细模式以及约 320px/四分屏布局；不访问真实模型、凭据或工作区数据库。

验证：tests/desktop-host-boundaries.test.mjs、tests/products-api.test.mjs、tests/application-host.test.mjs、tests/remote-harness-server.test.mjs、tests/deployment-boundaries.test.mjs；npm run check。
