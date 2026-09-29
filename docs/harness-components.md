# Harness 组件说明

多实例部署已实现，当前目录与 HTTP/客户端边界见 [Harness 模块边界](harness-module-boundary.md)；独立启动和凭据/恢复见[部署说明](harness-deployment.md)。每个执行进程保留以下单根组件关系，客户端使用独立根。

本文保留跨组件协作总览；逐个组件的完整说明见 [模块与组件手册](./modules/README.md)，按 Models、执行、项目与会话、图片、Prompt、工具、存储、Web 和资源验证分目录。新增组件或调整接口、依赖和清理行为时，同步更新相应独立文档。

状态：2026-09-29，已按五种协议图片输入、项目文件快照引用及会话归档/恢复核对。组件契约见本文与 [会话树](./session-conversation-tree.md)、[Models 模块](../packages/models/README.md)，具体行为以当前源码及行为测试为依据。迁移决策和验收矩阵见 [原生协议设计](./native-protocol-agent-framework-design.md)。

独立 Harness 模块的目标归属、目录结构及当前路径映射见 [Harness 模块边界与目标目录结构](./harness-module-boundary.md)。该规划区分 Harness 业务组件、Models／存储依赖、宿主与客户端；本文继续记录当前单根装配和实际生命周期，不将规划中的目录或 API 适配计作已完成组件。

## 根、服务与资源归属

应用只使用一个 Nya 根 Context。Models、业务 SQLite、图片资源、Projects、Project Files、Prompt、Session、协议应用绑定、RunRuntime、Run 和 Web 直接安装在根上；Provider、Model、项目与 Session 都是数据身份，不建立子 Context。`src/harness/index.ts` 是受信组合根，Agent 定义是启动时校验的只读配置，不是独立服务。组件用 `inject` 声明依赖并使用 `apply` 的 `deps` 快照；外部请求通过根的 `get()` 取得当前服务。Nya 负责撤销与清理顺序，组合根不复制依赖图。

| 组件 | 服务 / 主要依赖 | 独占资源与关闭行为 |
| --- | --- | --- |
| Models 配置存储 | `models.store` | 独立 SQLite、配置版本与凭据意图；等已接受事务退出 |
| Models Vault | `models.vault` | 系统凭据操作；取消并等待，不回退到文件或 SQLite |
| Models 协调服务 | `models`、`models.settings`、`models.protocols`、`models.source-data`；注入 store/vault | 连接配置队列、驱动注册代、execution、管理操作；停止准入、撤销并等待 |
| 五种协议驱动 | 注入 `models.protocols` | 原生参数、JSON/SSE、codec 和 HTTP；按注册代注销 |
| 目录来源 | `models.catalog-source` | 匿名 HTTP、reader、ETag；取消并等待 |
| 目录缓存 | `models.catalog-cache` | 第三套独立 SQLite；等缓存写入，初始化可用内存后备 |
| 目录调度 | `models.catalog`；注入 source/cache/source-data | 定时器、刷新及接纳；停止调度、取消并等待提交 |
| 业务 SQLite | `local-storage` | 排他连接、串行事务和领域迁移；等所有下游退出 |
| 图片资源 | `harness.image-assets`；注入 local-storage | 排他图片目录、校验队列、临时文件、读取与 GC；取消并等待实际退出 |
| Projects | `harness.projects`；注入 local-storage | 项目目录身份、目录检查与记录 |
| Project Files | `harness.project-files`；注入 local-storage/projects | 文件搜索、读取、SQLite 快照、准备批次与保留凭证；取消并等待文件和数据库操作 |
| Bash / Apply Patch | `tools.bash` / `tools.apply-patch`；注入 projects | 子进程 / 跨项目文件队列与临时资源；取消后等实际退出 |
| Prompt | `harness.prompts`；注入 local-storage | 草稿、不可变发布版本及已接纳写入 |
| Agent Prompt | `harness.agent-prompts`；注入 prompts/local-storage | Agent 绑定及 Prompt 快照解析 |
| Session | `harness.sessions`、`harness.session-runs`；注入 local-storage/projects/image-assets/project-files | 会话及归档状态、Run、节点、原生记录与事务；取消并等待附件调用，等已接受写入与通知 |
| 协议应用注册 | `harness.protocol-agents`；注入 models/models.protocols/image-assets | 固定驱动与 Loop 组合、准备中的资源、Run 租约；撤销后等 program 释放 |
| 单协议应用绑定 | 注入 protocol-agents/models.protocols | 该驱动代租约；完整安装后发布准入，卸载只撤销本代 |
| RunRuntime | `harness.run-runtime`；注入 session-runs/bash/apply-patch | 活动 program、所有受管操作、取消/等待者和临时视图；退出后结算 |
| Run | `harness.runs`；注入 projects/sessions/session-runs/agent-prompts/models/protocol-agents/run-runtime | 准入、幂等和交接前资源；停止准入并等交接与在途 Run |
| 执行访问管理 | `host.access` | 既有业务库中的实例身份与令牌摘要；撤销观察连接 |
| 客户端连接 | `client.connections` | 独立 client.sqlite 与系统凭据意图日志 |
| 客户端网关 | `client.gateway` | 独立监听器、静态页面、JSON/上传/SSE 转发与退出等待 |
| 本机目录选择器 | `host.directory-picker` | 客户端根中的原生对话框；仅匹配启动确认的本机实例 |
| Web | `host.harness-api`；注入业务与 Models 管理服务 | HTTP、共用 SSE、读取消与背压；停止监听并等连接退出 |

源码入口分别位于 `packages/models/src/`、`src/{project,project-files,prompt,session,image,run,protocol-agents,tool,web}/`。Session 的 `sqlite-records.ts` 是内部提供方，不额外注册组件。H0 的 `src/resource-probe.ts` 仅用于资源归属验证，不是正式执行路径。

三套数据库路径不能相同。配置库持有定义、连接、版本化原生参数、`historyScopeEpoch` 和 Vault 意图；目录缓存只存公开来源；业务库持有 Session/Run/Prompt/Projects、图片元数据/保留凭证及文件快照正文/准备批次/保留凭证。图片原字节另存图片组件独占目录，文本快照不新增目录。系统凭据始终由 macOS Keychain、Windows Credential Manager 或 Linux Secret Service 保存。各领域组件在 `apply` 中调用 `migrate(domain, migrations)`，通用 SQLite 不接收业务迁移列表。

## Models 原生边界

`models.list/get` 查询实际配置，`models.openNative({ modelId, lease, restore?, resources?, requirements?, signal? })` 固定连接、参数、能力和驱动代；只读取一次凭据。配置队列仅覆盖本地初始化，不覆盖网络。设置、改名、启停或 Key 修改只影响新 execution。

`models.protocols.register(driver)` 返回本代登记与类型化 `acquire()` 租约；注销立即撤销准入、取消本代 execution 与管理操作，等待退出。应用绑定持有具体代租约；不能把新的实现偷偷替换进旧 Run。其他协议及 Session 查询继续可用。

`NativeExecution.prepareExchange(intent, { resourceRefs })` 无外部副作用地固定本次请求、上下文版本、增量记录和单次 `start()`。启动再次检查撤销、占用、上下文版本与单次消费。原生 intent 的认证、模型、地址、存储策略、本地工具声明不能由保存的参数覆盖。执行返回原生响应及版本化记录，不再公开统一消息或 `ModelResult`。同一 execution 不允许重叠调用。

操作的 `result` 与 `done` 含义不同：底层结果可能早于退出，`done` 表示工作与清理已经结束（拒绝表示清理失败）。Models 在底层真实退出后才提交候选上下文并返回公共结果；`done` 失败不会无限等待悬空的 `result`。`close()` 同步关闭准入，幂等取消、等待和冻结退出报告，报告保留已确认记录、诊断、恢复元数据与清理状态，再释放凭据与可变上下文。即使关闭失败，已知事实不能被成功状态替代或丢弃。

Models 配置库 v3 将当前旧参数纯函数转换为 `{ protocolId, formatVersion: 1, value }`，不访问网络或 Vault，不修改旧版本 JSON。未知扩展或不能无损转换的参数保留 formatVersion 0 可读状态，禁止执行并显示待迁移。DeepSeek 转换器留在宿主。Anthropic 新配置显式初始化 `max_tokens: 4096`，执行时不补隐藏默认值。

## 协议应用绑定与独立 Loop

`src/harness/protocol-agents/registry.ts` 将具体驱动代、Loop、输入编码、历史策略和展示投影闭包绑定为 `PreparedRunProgram`。公共 Run 只准备并交接 program；Runtime 只调用 `execute(host)` 和 `close()`，不解释停止原因。初始化声明只允许已知 Bash 与 Apply Patch；不存在动态工具注册中心。

| 协议 | 原生历史与 Loop 决策 | 参数与专属能力 |
| --- | --- | --- |
| Responses | 有序 output items、reasoning/encrypted_content、phase、item ID 与 call_id；回填 function_call_output | `store:false`；web_search 显式能力门控，正文 URL 引用；拒绝/未完成不成功 |
| Anthropic Messages | 完整 content、thinking/signature/redacted、tool_use 与 server_tool_use；只执行本地工具；pause_turn 自动继续 | 固定版本头与 x-api-key；`max_tokens`；基础 web_search_20250305；跨响应保留服务端 ID |
| Chat Completions | 原生 messages、assistant/tool_calls、tool 消息与 finish_reason | `max_completion_tokens`、reasoning_effort；无统一消息恢复来源 |
| Gemini Interactions | 按时间顺序保留 steps、thought signature、函数身份与结果 | generation_config；`store:false`；不用 previous_interaction_id 或后台任务 |
| DeepSeek 非推理 | 独立 ID，复用 Chat transport/codec/Loop 工厂 | `max_tokens`、固定 disabled thinking、拒绝 developer；转换器仅在宿主 |

五种协议均支持 JSON、流式消费、客户端工具往返、持久记录、跨 Run/重启恢复和安全 Turn 展示，也均支持显式声明能力的静态 JPEG/PNG/WebP 本地图片输入和项目文本文件资料。音频、图片输出、工具返回图片、用户交互等待、远端后台任务及并行工具调度不在本期范围。图片及搜索能力必须由配置明确声明，不按协议 ID 推断模型能力。

原生恢复记录可包含签名与加密 continuation，但不含密钥、认证头、Vault 引用或句柄。它们是受信服务端数据。浏览器从白名单投影读取文本、摘要、工具状态和安全 http(s) 引用，不能下载任意原生记录。

## Run 准入与资源交接

1. 校验请求形状，先按 Session 和幂等键查已接受 Run；重试不重新读取当前配置、Prompt 或打开模型。
2. 检查项目、Session 模式、归档状态、选模与协议。`dialogue-v1` 和归档会话只读；新 Run 必须显式给出可空 `parentNodeId`。
3. 只读取指定成功父链。根固定初始 instruction/context 和工具声明；后代继承。每个新 Run 固定当前 task-template，只替换本次原始输入一次。
4. 经 Session 受管读取本轮文件快照并等待退出，在模板文本后附加用户文件资料、编码图片引用，再准备独立 program/execution；检查连接、模型、语义参数、历史格式和工具契约兼容。地址、认证方式或成功 Key 变更改变 epoch；失败写 Key、改名、超时、启停和目录刷新不改变。
5. Session 接受事务复核归档状态、绑定与父恢复引用，原子固定首次协议，并通过图片与文件组件 retainIn 在同一事务验证及永久保留有序引用。不同协议并发首次准入只接受符合已提交绑定的一方；失败准备由 Run 关闭并等待。
6. `RunRuntime.start({ runId, program })` 在第一次异步读取前同步登记所有权。同步拒绝表示未接管，由 Run 清理；之后均由 Runtime 清理和结算。

`waitRun()` 覆盖已接受但尚未交接的窗口。取消 waiter 只停止等待，不取消 Run。关闭门面先阻止新调用，随后 Nya 卸载根全部组件，等待准备、模型、工具、记录、Vault 与数据库退出；关闭后的 Harness 不可复用。

## RunRuntime 与持久屏障

Runtime 不包含“模型→工具→模型”的协议阶段机。`RunHost.perform()` 顺序固定为：提交启动意图及请求配方 → 检查停止 → 同步启动并登记句柄 → 立即观察 result/done → 等实际退出 → 提交观察 → 返回协议 Loop。任何持久化失败立即关闭新操作准入；启动意图失败时零外部操作，观察失败时不能开始下一项操作。

工具整批校验名称、ID 与参数，再逐个通过同一屏障执行。Apply Patch 的补丁业务校验由工具处理；可修正结果回到协议 Loop。取消不会撤销已发生的工具事实；当前文件发布与临时资源清理仍需等待。Runtime 保存真实观察，包括清理失败前返回的部分提交，再关闭 program。资源清理失败、模型拒绝/截断或持久化失败不能创建成功节点。

Session 独占 Run 终态事务；Runtime 仅提议完成、失败或取消。`ProtocolConclusion` 是应用结束提案和结果记录引用，不是每次 API 响应归一化。成功结果还需通过输出上限和资源退出检查。结算结束后才释放应用/驱动租约和等待者。

## Session 原生持久化与恢复

`harness.sessions` 提供会话、节点、Run、事件与记录查询。`harness.session-runs` 提供幂等查找、原子接受、父链恢复、启动/观察账本、取消与结算。Session 不持有模型 execution、模型/工具调用句柄或凭据，也不按协议停止原因驱动执行。

`run-state` v7 保存（v5 原生结构、v6 通用资源引用列、v7 会话归档状态及索引）：Session 历史模式和协议绑定；版本化原始输入、根初始化与 schemaVersion 3 模型快照；增量请求/响应记录；公共操作账本；不可变上下文链节；节点结果引用。请求配方引用前驱和本次增量；链节引用父链与本 Run 记录，不存从根开始的 ID 数组或重复完整历史。恢复时 codec 才在内存中重建原生请求。

成功终态、最终记录、恢复引用、完整节点、结果引用和终态事件在同一事务提交。失败、取消、清理失败只能归档事实与诊断，不发布可继续节点。重启将遗留活动 Run 标为 interrupted，不重放网络或工具。只恢复所选父链；同父并发、编辑和重新生成均不包含兄弟或被替换节点。

旧 Session、节点、事件和 schemaVersion 1/2 或 profile 快照保留读取兼容，旧 JSON 不重写，不保留旧写入器。编辑/重新生成取原始输入与原节点父引用，不能将已套模板的文本再次套模板。首次绑定后取消或失败不会解除 Session 协议。

`archiveSession` / `restoreSession` 幂等修改可空 archivedAt。项目列表默认排除归档会话，`listArchivedSessions` 跨项目按归档时间倒序查询。归档与接受 Run 在业务事务中串行裁决：存在 running/cancelling Run 时拒绝归档，归档先提交则新 Run 被拒绝，已经接受的幂等结果仍优先返回。归档不删除节点、原生记录、图片或文件引用；历史查询和附件读取、草稿续期继续可用，恢复旧 dialogue-v1 仍不能继续执行。

## Web 展示与重连

共享工作区负责四面板、分支导航、Run 控制、滚动、订阅和重连；协议模块负责输入、原生参数表单、展示 decoder/reducer 和 Turn。Turn 按 Run/节点稳定挂载，更新调用 update，移除调用 dispose，不在每个 delta 重建整段历史。

`GET /api/v1/runs/:id/view` 返回白名单快照：活动视图来自 Runtime，历史视图由已提交记录投影。信封包括 Session、Run、协议、展示版本、exchange、块 ID 和独立 viewRevision。当前实现发送有界全量替换快照；旧帧忽略，断号、重连、首次发现活动 Run 与终态触发校准，最终持久投影覆盖临时内容。工具最终观察由持久 Run trace 展示。

四 Session 共用 SSE；未发送的同 Run 快照可合并，背压预算和慢连接清理仍有效。显示裁剪只影响投影，不影响原生历史。旧会话显示只读及新建空会话入口。旧浏览器待提交键先查询已接受 Run，未接受内容不自动转换或重新提交。图片选择、粘贴和拖拽共用有序上传队列；草稿及 pending 只保存文本与引用，覆盖所有分支续期，失效图片保留占位并阻止发送。

项目文件通过 @ 搜索或附件入口选择，发送时准备快照；pending v3 先保存准备键，再保存快照 ID，最后提交 Run。历史编辑和重新生成默认复用快照，只有显式更新才读取当前文件。归档成功关闭对应面板并保留草稿、位置；统一归档列表支持只读查看与恢复，归档状态通过查询校准，不增加 SSE 事件。

## 工具、目录与恢复的独立边界

Bash 组件拥有子进程、输出缓冲、超时与终止计时器。Apply Patch 独占跨项目串行队列、全量文件预检、逐文件发布和临时资源。补丁仅接受普通 UTF-8，拒绝目标符号链接、多硬链接、二进制、混合换行和不唯一上下文；项目目录是路径基准，不是沙箱。多文件变更不构成原子事务，changes/pending 必须反映实际事实，取消不回滚已完成文件。

目录匿名消费 models.dev，SDK 标签只作数据。启动使用已接纳来源、有效缓存或验证过 provenance/SHA-256 的随包快照；24 小时后台 ETag 刷新，失败保留旧来源并在一小时后重试。普通构建测试不下载目录，只有显式 catalog:update 更新快照。来源刷新不覆盖连接、Key、已有执行参数、启停、选模或在途 execution。

协议撤销通知同时关闭应用 Run 准入并取消该代受管操作（包括本地工具），等待清理后释放租约。其他协议继续工作；撤销 Models 服务则由 Nya 让其消费者先退出。撤销 Session/业务 SQLite 时，下游先取消并结算，存储再等待已接受写入。异常进程退出后需确认原进程消失再处理排他锁。

## 本地升级与验证

Models 配置库 v3 与业务库中的各领域迁移独立提交；业务库当前包含 `run-state` v7、`image-assets` v1 和 `project-files` v1，不能用 Session 的迁移版本代表通用存储版本。不建立跨库事务；任一必需组件启动失败均阻止 Run 准入。升级真实数据前先 `harness.close()` 等资源退出，备份配置库、业务库及图片原字节目录，再启动新组合根。代码回退须同时恢复备份，旧代码不能直接打开升级库。

根 `npm run check` 覆盖 Models 与应用行为测试。测试使用临时 SQLite、内存凭据和模拟 HTTP；真实模型 API 与各平台系统凭据仍需分别门控验收，本地模拟不能替代这些结论。

## 图片资源与原生请求

完整契约见[图片输入设计](./multimodal-image-input-design.md)。图片组件保存原始字节，并在与 Run 共用的业务事务中保留引用；当前 NativeRunInput v3 与原生 v2 请求只存图片元数据和引用，不含 base64。五种协议的 execution 固定作用域读取端口，只有操作意图持久化且 start 登记后才读取、校验并编码请求：Responses 与 Chat/DeepSeek 使用 data URL，Anthropic 使用 base64 source，Gemini 使用 data/mime_type。工具续轮和重启从所选父路径恢复引用。读失败、摘要不符和超限都明确失败；不退回纯文本。

五种协议驱动均为 2.1.0、Loop 为 1.1.0、新记录为 v2，兼容旧 2.0.0/1.0.0 的 v1 文本历史及混合父链。只有验证整条父路径无图片时允许有效 imageInput 从 false 变 true；账户 epoch、模型定义版本、参数和其他能力仍严格比较。

## 项目文件引用

Harness 在应用根安装 [Project Files](modules/sessions/project-files.md)，注入 Projects 与业务存储，Session 通过依赖使用它。组件独占文本文件搜索、读取、SQLite 快照和回收，project-files v1 自行登记表。Session 接受事务同步保留文件引用，Run 准备时读取本轮内容并等待退出，协议注册表仅编码用户资料。没有新增数据库连接、文件目录、Context 或模型工具。详见[跨组件设计](project-file-references-design.md)。
