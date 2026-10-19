# harness server 重建计划

状态：2026-10-14。本分支直接使用相邻 NyaCore，已完成原生协议执行迁移以及 H0 资源边界、H1 闭环、持久会话树、Prompt 管理、Bash/Apply Patch 工具循环、通用 Models 和本机 Web 接入；当前已接入 Computer 本机资源及独立 worker、工具等待重启接续，以及可组合单元 U0 的附着登记。下方日期验收记录描述各次交付，当前行为以本节与[组件说明](./harness-server-components.md)为准。

## 当前基线

[通用 Models 模块](../packages/models/README.md)提供 `models`、`models.settings`、`models.protocols`，配置与业务分库。Provider/Model 管统一来源定义，ProviderConnection 管连接和密钥引用，ModelConfiguration 管执行版本、能力与参数；配置和不可变历史写 SQLite，秘密只存系统凭据库。Responses、Anthropic Messages、标准 Chat Completions 和 Gemini Interactions 四种协议可同时安装，支持多连接并发、文本、工具和流式事件。协议注册与注销按注册代隔离，取消后等待实际退出。旧应用 `llm` 及凭据包装已删除，仅保留旧数据和旧密钥的读取兼容。

每个进程的组件直接安装在唯一 Nya 根；Authority 与 Runtime 同进程，工具执行采用独立 worker 根。Session 独占会话、Run、不可变节点、原生记录和恢复引用；Projects 管项目身份。Run 检查幂等、选模、指定父链和 Prompt，协议绑定准备固定驱动代的 PreparedRunProgram。RunRuntime 同步接管资源，管理意图/观察持久屏障、取消、退出与结算；协议独立 Loop 决定工具回填和续轮。旧 AgentLoop、统一消息和 `models.open()` 已删除。

Computer 安装本机 worker 客户端、实例提供方、Computers、Workspaces 和 Computer Operations。Session 同事务接纳工具声明及独立 resume cursor；Operations 按需激活 worker 并准备 pinned-local binding，worker 固定路径执行、保存 receipt/result 和真实退出。实例 pin 与 reservation 持有到 scope 实际退出；纯模型和计划不激活 computer。Runtime 进程异常退出后接管原工具等待、清理和结算，接纳/消费去重及 owner 栅栏保护副作用和额度；未保存模型响应的 Run 仍 interrupted。远端托管工作区、模型 owner 与弹性提供方按[资源设计](./computer-resource-design.md)后续阶段实施。

会话持久保存可空 modelId；新 native-local-v1 Session 首次接受 Run 原子固定协议，旧 dialogue-v1 只读。schemaVersion 3 快照包含定义身份、驱动代、原生参数与非秘密 historyScopeEpoch，不含凭据。根初始化与工具契约沿指定父链继承，每个新 Run 的当前 task-template 仅处理本次原始输入一次。恢复记录增量保存，跨 Run/重启重建本地原生上下文；失败、取消、清理失败没有可继续节点，有效工具等待游标可接续；无游标或模型响应未保存的异常中断结算 interrupted，不自动重放。

本机 [Web 客户端](./web-client-design.md)通过统一 Provider/Model 目录选提供方、配置 Key 后自动准备适用模型，`models.settings` 提供连接与模型参数编辑、启停、Key 设置/替换/删除、能力和协议参数、发现、检查与历史。每个会话可以独立选模，提交和重试固定显式模型 ID。配置变更只影响新 execution，无需重启。启动环境变量继续校验，但旧 `ANYBOX_LLM_*` 只在空 Models 库初始化时导入，已有设置不会被覆盖。旧密钥复制到新命名空间，原条目保留；系统凭据不可用不会退回明文，也不阻止浏览非秘密配置。

Web 支持显式节点查看、同父节点并发、跨项目四面板和标签页内布局恢复；关闭视图不取消 Run。Session 提交后发送变更提示，RunRuntime 发布协议安全展示快照，共用有界 SSE 展示通道。最终节点和 Run 查询是事实来源，流式片段不落为成功历史。Prompt 草稿编辑、版本发布、历史预览与 Agent 绑定仍由独立服务提供。

本次验证使用临时 SQLite、内存凭据、模拟 HTTP 与真实浏览器，覆盖配置、发现、选模、流式回答、取消、版本历史和窄屏布局；没有访问真实业务数据库或远端模型。Models Vault 的原生跨平台验收仍由 `ANYBOX_KEYRING_TESTS=1` 门控，不能继承旧凭据组件的验收结论。

## 设计边界

- 业务状态转换、输入校验和恢复决策优先写成纯函数，以显式输入产生新状态或变更计划。模型、工具、存储、时钟和 Nya 组件装配是明确的副作用边界。新增业务实现不使用类组织状态。
- Anybox 自己定义领域数据和组件契约。由 Nya 组合根选择实现，组件通过 `inject` 获取本轮依赖快照；外部请求从根 Context 获取当前服务，不缓存跨组件重启的引用。
- 生命周期由资源所有者管理。组件初始化完成后返回；Run 的模型和工具调用可以取消，并能等待实际工作与清理结束。关闭先停止接收新任务，再结算和释放已有任务。进程信号与强制退出由宿主处理。
- Session、Run、幂等键、Prompt 内容及模型可见配置快照由单一 SQLite 实例排他持有。进程异常退出后从有效 resume cursor 接续原 worker 操作；无新凭证或未保存模型响应的 Run 结算 `interrupted`，不自动重放未知外部副作用。
- 第三方库可以用于阶段性实现，但类型、错误、状态和生命周期留在适配器内部。同一行为与资源清理合约用于验证替代实现。首版可用与最终自研分别验收。

## 实施顺序

每阶段只冻结下一阶段必需的契约，不预先生成完整组件目录或空接口。

| 阶段 | 交付 | 验收重点 |
| --- | --- | --- |
| H0 契约与资源边界（已完成） | 可取消调用契约；用最小 Nya 组件验证取消和关闭顺序 | strict 类型检查；领域契约不依赖 Nya 或具体实现；在途任务真正退出后才完成清理 |
| H1 无网络闭环（已完成） | Agent 定义、Session、一次可控模型调用、Run 接受/查询/取消/等待、内存状态 | 输入到终态可查询；同键请求不重复执行；并发与取消竞态有行为测试；无遗留任务 |
| H2 受控多步循环（已完成） | 模型请求 Bash 或 Apply Patch、整批参数校验、串行执行、结果回填、可取消的多轮调用和输出上限 | 无效工具零执行；长文件完整写入；不按固定调用次数中断；取消不开始下一项；状态与事件一致；失败不伪造成功 |
| H3 Run 持久化与恢复（工具意图与观察已接入） | 单实例排他状态提供方、原子记录、关闭后重开、异常退出清算 | 去重与历史可恢复；未完成工具标记不确定；不自动重放副作用 |
| H4 真实模型与交互（Models 文本/工具/流式与 Web 已完成本地接入；新版协议联网验收另行记录） | 按已验证的模型协议适配流式输出、工具调用、审批或提问 | Mock 与真实适配器通过共享契约；凭据与取消边界明确；联网验收与各平台凭据库验收单独记录 |

本机 Web 参考组件已独立于 harness server 阶段接入；产品 Gateway、Client SDK、多端宿主和完整 UI 后续推进。阶段编号不是预先确定的包、组件或服务数量。

## 验收与后续

当前检查覆盖 Models 与 harness server 共享契约、配置版本与密钥日志、模型选择和旧数据迁移、工具续轮、取消/卸载等待、临时进展与最终业务结果分离。组件或资源归属变化须同步行为测试，并运行 `npm run check`。后续真实模型 API、各平台系统凭据、远程产品宿主与账号体系分别验收。

### Computer 第二阶段（2026-10-10）

独立本机 worker 已承担实际工具、进程 scope 和耐久执行账本。Authority 保持独占业务库，Computer Operations 升级 v2，Session run-state v10 保存独立 resume 状态与 owner，四协议 Loop 升级 1.3.0；原工具契约、原生记录 v2 与历史 JSON 保持兼容。阶段 1 进程内执行路径及固定宿主提供方已删除，测试替身留在 tests/helpers。

WSL Linux / Node.js 24.16.0 完整 npm run check 退出码 0，类型检查与构建通过；1307 项测试中 1293 项通过、14 项按原门控跳过、0 项失败。新增 36 项第二阶段测试全部通过，无跳过：真实 Runtime/worker 故障 14 项、worker 行为 5 项、取消准入窗口 3 项、恢复等待隔离 1 项、Session 恢复 8 项与四协议恢复 5 项。Runtime PID SIGKILL 后原 Bash 副作用/receipt/result 只一次；两端确认丢失、旧 owner、Codex stdin/output、取消断网、真实部分补丁、清理/结算、账户 epoch 拒绝及未知 worker 事实均覆盖。暂离线授权或遗留排空不阻塞其他 Run 的等待，观察中止不取消原 worker 操作，关闭仍等待实际退出。完整证据与限制见 [资源设计验收记录](computer-resource-design.md#71-阶段退出标准)。

当前恢复限于已保存模型响应的工具等待、消费、清理及结算；model-pending 仍 interrupted，不重发模型，但排空已有 worker scope。显式 Nya 卸载/依赖撤销继续取消并排空 Run，idle worker 作为设备服务独立运行。此阶段验收时真实 worker 仍继承 Unix guard，仅 Linux 实测，Windows 尚未支持；该历史范围不覆盖后续 Windows 原生实现。2026-10-19 的 Harness 0.1.2 迁入与当前验证另见[原生平台支持](native-platform-support.md)。systemd/macOS 实际部署、阶段 3 的跨机器托管工作区及阶段 4 模型 exchange 不在该次验收内。

### Computer 第一阶段（2026-10-10，历史交付记录）

资源契约已加入现有单根：Computers 独占 `computers` v1，Workspaces 独占 `workspaces` v1，Computer Operations 独占 `computer-operations` v1；Session 的 run-state v9 和原生历史格式保持不变。本机提供方不持有数据库、网络或虚拟机生命周期，内部工具适配器不是额外组件。

验收重点为纯模型/计划无激活、计算工具按需准备、接纳事务原子性、同 ID 声明冲突、固定 workspacePath、scope 引用持有到实际退出、取消与清理失败、旧项目/工具兼容及依赖无环。资源与工作区的行为测试使用临时业务 SQLite 和受控提供方，无须 Unix Shell；既有实际 Shell 测试继续遵守平台限制。完整检查统一运行 `npm run check`，不将模拟测试视为 worker 重启或真实跨机器验收。

本轮 WSL Linux 完整 `npm run check` 通过：类型检查与构建通过，1271 项测试中 1257 项通过、14 项按原门控跳过、0 项失败。新增 27 项资源/工作区/操作测试也在 Windows 验证通过；本轮未修改 NyaCore，未调用真实模型、系统 Vault 或云资源。

### 原生协议迁移（2026-09-28）

P0–P7 的正式代码已切换：Models 0.2.0 原生接口及配置 v3；Session v5 与只读旧会话；五协议独立 Loop、共享 RunRuntime、版本化参数、绑定/历史兼容和协议 Web 展示。Responses 搜索引用与 Anthropic 服务器搜索/pause_turn 均有本地端到端测试。五协议工具往返、跨 Run、重启、分支隔离、签名/加密续轮与增量存储验证见 `tests/native-protocol-agents.test.mjs`。新版 API 和真实 Vault 平台验证仍单独门控。

配置和业务迁移各自事务提交，未使用实际业务数据。发布前必须关闭旧进程并备份两库；半升级启动失败时不运行 Run，代码回退配合备份恢复。最终检查结果记录在原生协议设计的实现验收附录。

### Models 集成验收（2026-09-28）

harness server 改用 Models execution，Web 暴露 Provider/Model/Key 管理和会话选择，删除退役 API 实现和专属测试。新测试覆盖不同模型并发、幂等重试保留原配置、模型选择持久化、文本与工具同返、新增消息续轮、截断/拒绝失败、准入和交接窗口取消、关闭/清理失败以及 HTTP 配置与 SSE。真实浏览器验证使用实际 harness server / Models 与内存凭据、模拟网络；未进行真实 API 或新 Vault 的平台验收。

`npm run check` 通过：301 项测试，299 项通过，2 项真实系统凭据测试按门控跳过，0 项失败。

### 历史验收记录

以下保留各次交付当时的实现与测试数量，旧 `llm` 契约等描述不代表当前调用路径。

### Apply Patch 本地验证（2026-09-26）

在现有 Bash 之外加入独立的 Apply Patch 文件资源组件，直接安装在应用根并由 AgentLoop 注入。纯补丁解析和精确文本变更与文件系统副作用分开；两个已知工具使用判别联合，不建立动态注册框架。文件组件持有跨项目串行队列，先检查所有操作，再按文件提交；取消和故障返回已完成变更与未完成项，`done` 等当前提交及清理退出。单文件临时发布不构成多文件事务，Bash 和外部进程也不共享该队列。

新执行记录使用 `toolCalls` 和带工具名的 `tool-started`、`tool-observed`、`tool-failed`；旧 `bashCalls` 与 `bash-*` 仅在读取时归一化，保留事件序号和时间，不重写历史、不增加表或列。异常重启仍结算 `interrupted`，不自动重放补丁。

本地验证覆盖补丁语法、空文件、Unicode、BOM、LF/CRLF、末尾换行、精确与歧义匹配、文件类型、路径冲突、全量预检、部分提交、取消、清理失败和依赖撤销；工具循环及 Web 验证覆盖混合批次、可修正的拒绝结果、历史兼容和两类工具展示。所有测试使用临时文件、受控模型或模拟 HTTP，不构成真实 DeepSeek/OpenAI 对新工具的联网验收。本轮 `npm run check` 已通过，真实凭据库测试仍按原门控跳过。

### Responses 工具循环与启动配置验收（2026-09-26）

已用本地模拟 HTTP、可控传输与临时 SQLite 验证 Responses 非流式工具闭环、reasoning/phase 续传、计划隔离、每 Run 一次的密钥读取、取消及清理等待，并验证 Web 启动配置和所选凭据注册。`npm run check` 通过：共 173 项，171 项通过，2 项真实凭据库测试按门控跳过，0 项失败。公共 `LLMPort` 和数据库结构不变，验证未使用实际业务数据库；真实 OpenAI API 尚未联网验收。

### Web 分屏验收（2026-09-26）

保留原生 TypeScript/HTML/CSS，无新 Nya 组件和运行依赖。完成四面板二叉布局、四边拖拽、嵌套尺寸约束、键盘调节、窄窗口切换、跨项目导航、旧 URL 及 sessionStorage 恢复；面板移动保留控制器和草稿，关闭释放读取并保留后台 Run。已删除旧单会话全局状态路径，保留 Prompt 和凭据设置。`npm run check` 通过（149 通过，2 项真实凭据库测试按门控跳过）；浏览器使用临时 SQLite 与可取消受控模型验收，未触碰实际业务数据库。

### Run 变更 Event 与 Web SSE 验收（2026-09-27）

Session 组件在 Run 接受、执行记录、取消和结算事务实际提交后，通过 Nya 发出 `harness.run.changed`。通知只携带 Session、Run ID 和修订号；查询服务与持久 RunEvent 仍是事实来源。Web 组件通过 `ctx.on` 接收通知，向浏览器按订阅 Session 推送 SSE；每个工作区共用一条连接，最多订阅四个 Session。通知按 Session 合并，慢连接有背压超时，卸载和依赖重启会关闭连接、等待退出并移除监听器。浏览器收到通知后串行刷新；健康连接每 30 秒校准，断连时每 5 秒兜底，并在重新连接与页面恢复可见时补查。

行为测试覆盖提交后才通知、幂等与回滚无通知、监听器异常隔离、原子节点可见、并发修订、SSE 订阅过滤和来源校验、队列与慢连接清理、关闭及依赖重启，以及读取、写入、节点导航期间的通知合并。`npm run check` 通过：共 238 项，236 项通过，2 项真实凭据库测试按门控跳过，0 项失败。浏览器使用临时 SQLite、内存凭据和受控模型验证跨项目四面板、两个项目的完成状态与回答自动展示、运行取消、刷新页面后的四面板和终态恢复，控制台无错误。本轮没有修改 NyaCore，也未使用实际业务数据库或调用真实模型 API。

## 图片输入增量（2026-09-29）

Chat/DeepSeek 接通本地静态图片、工具续轮和成功父路径重启恢复。Session run-state 升为 v6，NativeRunInput 写 v2；独立图片组件管理原始资源和原子保留，Models 资源端口在受管操作中解析引用，Web 支持有序上传、分支草稿与续期。详细范围、版本兼容与验证入口见[图片输入设计](./multimodal-image-input-design.md)。其他协议图片能力继续关闭。

## 工具库与按 Agent 混选增量（2026-10-04）

完成受信静态 22 项目录：Codex 五项、Claude Code 七项、DeepSeek Harness 八项及既有 Anybox Bash/Apply Patch。稳定 ID、来源版本、参数和固定调用名前缀分别保存；推荐默认是 Codex 五项与 Claude Read/Write/Edit/Glob/Grep。设置按执行设备和 Agent 保存，创建 Session 原子复制不可变选择；后续修改只影响新 Session，Codex exec/write 缺失依赖明确拒绝。

Session run-state 写 v9，新 NativeInitialization v2 / tool-library-v1 复制选择；旧 v1 / known-tools-v1 和旧原生记录不改写。四种协议 Loop 写 1.2.0 并读取旧 Loop，驱动 2.1.0 与记录 v2 保持不变。

新增根上的进程和文件执行器，分别持有按 Run 的管道命令、stdin/输出及文件读取、搜索和图片导入；来源写入复用 Apply Patch 队列。正常模型结束也终止并等待剩余进程，经通用 tool-process-cleanup 操作保存实际退出后再结算。工具图片与观察同事务保留，再以用户图片块及 resourceRefs 进入下一次增量请求；文本模型返回不支持诊断。

验收入口：tool-catalog、process-tools、file-tools、native-tool-library 及现有 Run/原生协议行为测试，统一执行 npm run check。检查不使用实际业务库、真实模型 API 或系统 Vault；未修改 NyaCore。具体契约和升级边界见[工具库设计](./tools-library-design.md)。

## 可组合单元 U0：附着登记（2026-10-14）

按[可组合部署单元设计](./composable-units-design.md)实施 U0。根上新增 `harness.unit-attachments` 组件，独占 `unit-attachments` v1 迁移域，保存 harness server 与 Models、Computer 单元之间的附着记录和审计事件；附着码与单元凭证只保存 SHA-256 摘要并只返回一次。组合根把同进程 Models（`models-local`）与本机 worker（`computer-local`）登记为本机单元，组件在启动事务中幂等创建附着 ID 固定为 `local:<kind>` 的 approved 附着；本机附着不可经 API 撤销，Models 本机单元的 bootId 每次装配生成，本机 worker 的实际 workerId/bootId 仍只在操作绑定时固定，打开 Authority 不触碰 worker 目录。

Session 注入该组件，run-state 升为 v11，在 `harness_runs` 增加 `unit_bindings_json`；`registerRun` 在接受事务内复核 Run 传入的引用仍为 approved 且 epoch 相同。Run 准入固定本机 Models/Computer 的绑定引用，恢复接管前校验引用，不匹配时交给只清理的 Runtime 并结算 `dependency-unavailable` 失败，不改绑当前单元。HTTP 增加 `/units/attachments`、`/units/attach-codes`、`/units/attachments/:id/revoke` 三条拥有者侧路由，不设旧别名；Run DTO 与 Web 不变。远端拨出、单元侧消费附着码、按附着区分的 worker 授权和远端代理组件属于 U1/U3，不预建。

验收入口：`tests/unit-attachments.test.mjs`、`tests/harness-server-core.test.mjs` 的本机附着固定与恢复栅栏场景、`tests/harness-server-http.test.mjs` 的附着路由；直接装配 Session 的夹具经 `tests/helpers/unit-attachments.mjs` 登记同样的本机单元。macOS / Node.js 24.16.0 上 `npm run check` 类型检查与构建通过，1314 项测试中 1302 项通过、11 项按原门控跳过、1 项失败；该失败是 `tests/computer-worker.test.mjs` 的真实 worker 图片用例，在未改动的 HEAD 上同样失败，属于本机环境既有问题，不由本次引入。未调用真实模型、系统 Vault 或远端单元，未修改 NyaCore。

### U0 整合验收（2026-10-17）

本次仅将 U0 整合到包含 Claude Agent 的 main。带回同一启动事务共用初始化时间的修复，并以每次读取递增一毫秒的时钟验证本机附着及其审计事件的时间与顺序。U0 核心测试在断言失败时释放受控模型的 result/done，等待宿主、临时账本连接与根关闭；新增过期引用在接受事务拒绝写入的回归。测试宿主先排空普通 HTTP handler，再关闭核心，同时等待 listener 上保留的 Run 租约，避免关闭等待环；关闭测试验证及时取消，并在失败时等待资源退出。

macOS 上使用 `TMPDIR=/private/tmp npm run check` 完成类型检查、构建与全量测试：共 1373 项，1360 项通过、13 项按既有门控跳过，零失败、零取消。定向附着、核心与 HTTP 测试也全部通过。U1 远端传输、桌面运行角色与平台发行实现均未带入；未修改 NyaCore，未调用真实模型、系统 Vault 或远端单元。

## 可组合单元 U1 第 1 步：按附着授权、回环控制与单元拨出（2026-10-14）

Computer 单元侧：worker 根新增 `computer-worker-attachments`（独占 `computer-worker-attachments` v1，记录服务的 harness server、设备拥有者设定的上限与凭据意图；单元凭证只在系统凭据命名空间，默认 `anybox.computer-worker`，由 `ANYBOX_COMPUTER_WORKER_NAMESPACE` 指定）与 `computer-worker-dialout`（消费附着码、每个 approved 附着一条长轮询循环、领取请求交本地执行器并 POST 回执）。worker 执行器 `computer-worker` 升 v2，Run 表记录所属附着；每个授权带 `attachmentId`，首次 claim 固定 Run 归属，其他附着的 claim/submit/get 一律拒绝，工具接纳同事务检查上限（目录与工具契约），撤销附着时取消并排空其 Run。worker 回环增加 `/attachments/list|consume|revoke`，本机 worker 客户端提供 `computer.local-worker-control`。

harness server 侧：`harness.unit-attachments` 增加常量时间的凭证认证；新增 `harness-unit-transport`（内存邮箱：长轮询领取、回执、连接状态；关闭只拒绝等待中的请求）。通用宿主在应用注册增加 `http.selfAuthenticated` 前缀与 `ApplicationHttpContext.principal`，`/units/unit/*` 只在 `/api/v1/apps/agent` 下可达、不要求也不接受设备令牌。`computer-operations` 升 v3，scope 记录 Run 固定的 Computer 附着引用，新工具声明进入 starting 前复核附着仍有效，恢复与控制声明使用同一附着；RunRuntime 把 Run 的附着引用交给 `openRun`。拥有者侧新增 `/units/local-computer/attachments` 三条路由。

验收入口：`tests/unit-transport.test.mjs`（纯规则、认证、领取/回执/超时/换代/关闭、宿主路由）、`tests/computer-worker-attachments.test.mjs`（经真实认证监听器的端到端拨出：附着、ceiling 与跨附着拒绝、两侧撤销、worker 重启续连；真实系统凭据用例由 `ANYBOX_KEYRING_TESTS=1` 门控）；既有 worker/操作/恢复测试改为显式 `local:computer` 授权。macOS / Node.js 24.16.0 上 `npm run check` 类型检查与构建通过，1321 项测试中 1308 项通过、12 项按原门控跳过、1 项失败；该失败仍是 `tests/computer-worker.test.mjs` 的真实 worker 图片用例，属本机环境既有问题。未调用真实模型、系统 Vault，未做真实跨机器 HTTPS 验收，未修改 NyaCore。远端代理组件、字节通道、只读查询面、Web 入口与故障注入矩阵分别属于 U1 第 2–6 步。

## 可组合单元 U1 第 2 步：远端 Computer 代理组件（2026-10-14）

新增 `computer-unit-worker-proxy`（第 4 步与本机实例提供方合并为 `computer-worker-router`），以与本机形态相同的服务名提供 `computer.worker` 与 `computer.instance-provider`（providerId `unit`）：按授权中的附着经 `harness.unit-transport` 投递 claim/submit/get，同一单元 boot 上的 claim 不重复，`get` 附带上次状态让单元在本地等待变化；`info` 与实例激活向单元请求身份、平台与架构；`shutdown` 固定拒绝。传输失败映射为可重试的 `worker-unavailable`，单元的拒绝保留原 code。`apply` 不等待远端；Effect 只中止本代在途请求，远端已接受操作继续。

组合根按 `computerUnit` 选择形态：本机形态与此前相同；远端形态不安装本机 worker 客户端与本机实例提供方、不登记 `local:computer` 本机附着，Run 准入经新增的 `harness.unit-attachments.binding(id)` 固定配置的远端附着。`server-config` 解析 `ANYBOX_COMPUTER_UNIT=local|remote` 与 `ANYBOX_COMPUTER_ATTACHMENT`，变量写入部署说明。Computer Operations 的 `acceptIn` 接收 Run 固定的 Computer 附着（Session 从 Run 记录传入）：远端附着的声明放在逻辑计算机 `unit:<attachmentId>`，规格取附着记录中单元声明的平台/架构（新增 `getIn` 同步读取，不做批准栅栏；栅栏仍在声明进入 starting 前）。

同一步还有两处配套变更：Computers 每次激活都向提供方重新确认（并发共享一次），不再从内存缓存回答，重启后的 worker 或远端单元得到新代次而不是过期引用；代理把"无人领取"与"已领取但回执丢失"区分为 `worker-unreachable` 与 `worker-unavailable`，Operations 对没有任何 receipt 的 Run 让工具声明以不可用失败、取消与 close-scope 不等待远端，已有 receipt 的 Run 按普通失联继续等待。Workspaces 接受 providerId 为 `unit` 的实例并保持 pinned-local。

验收入口：`tests/computer-worker-router.test.mjs`（配置解析；无单元时安装即返回、准入 `computer-unavailable`；按附着路由、Effect 只放弃本地观察而单元继续执行；真实 worker 附着后以远端形态重新装配 harness server，经代理完成 Bash 与 Apply Patch Run，单元离线时 Run 以 `tool-unavailable` 结算，单元重启回来后以新代次继续）。macOS / Node.js 24.16.0 上 `npm run check` 类型检查与构建通过，1325 项测试中 1312 项通过、12 项按原门控跳过、1 项失败（仍是本机环境既有的 worker 图片用例）。字节通道、只读查询面、按项目绑定、Web 入口与故障注入矩阵属第 3–6 步。

## 可组合单元 U1 第 3 步：字节通道（2026-10-14）

拨出传输不再把工具图片以 base64 内嵌回传：worker 拨出循环在回报 `submit`/`get` 事实前，从 worker 自己的图片组件读取原字节并 `POST /units/unit/bytes?scope=<sessionId>`（头部带 MIME、`x-anybox-sha256`、`x-anybox-byte-length`），harness server 经 Session 导入为该会话的草稿资源并返回 `{ assetId, sha256, byteLength, mimeType }`；事实的 `images` 只带 `{ ref, pushed }`，`WorkerOperation` 新增工具操作的 `sessionId`。Operations 校验回执与 ref 的摘要/长度一致并经 `describe` 确认草稿存在，再随观察同事务保留，不再导入；回执缺失或不符结算 `computer-operation-conflict`。回环传输保留 base64。

验收入口：`tests/computer-worker-router.test.mjs`（直接端口经代理读取图片：事实无 base64、回执摘要与长度一致、harness server 草稿字节与原图一致、重复事实复用回执、字节通道需单元凭证）、`tests/computer-operations.test.mjs`（受控 worker 返回 `pushed` 回执：保留而不再导入、摘要不符或资源缺失拒绝）。受控模型夹具不能把图片回传给模型，完整图片 Run 在远端形态下未经夹具验证。macOS / Node.js 24.16.0 上 `npm run check` 类型检查与构建通过，1326 项测试中 1313 项通过、12 项按原门控跳过、1 项失败（本机环境既有的 worker 图片用例）。

## 可组合单元 U1 第 4 步：只读查询面与项目绑定（2026-10-14）

Computer 契约新增不经操作账本的只读查询面 `query({ attachmentId, query })`：`stat`、`list`、`search`、`read` 复用 Project Files 的文件系统规则，worker 执行器要求附着 approved 且根路径落在其目录上限内，回环 `/query` 与拨出 `query` 请求种类都接入。第 2 步的远端代理与本机实例提供方合并为 `computer-worker-router`：同名 `computer.worker` 与 `computer.instance-provider`，按授权附着把调用路由到回环 worker（`computer.local-worker`，本机客户端改提供此名）或单元传输，实例提供方按资源 providerId（`local`/`unit`）确认；Computers 接受提供方声明的多个 ID。单元在失联窗口内没有轮询过时请求立即失败，离线不再等满领取窗口。

项目绑定 Computer 附着：`projects` v2 增加 `computer_attachment_id` 并把唯一键改为 (path, 绑定)，旧项目迁入时绑定 `local:computer`；`openProject(path, { computerAttachmentId? })` 远端绑定由单元的 `stat` 在上限内解析规范路径，可用性由单元回答，离线即不可用并拒绝准入；Projects 不注入 worker（它是 worker 根工具的依赖），由组合根传入按调用解析当前 `computer.worker` 的 `computerQuery` 入口。Project Files 注入 `computer.worker`，按项目绑定选本机文件系统或单元查询面（搜索、预览、准备、目录树快照），快照仍保存在 harness server。Run 接受事务改为从项目绑定取 Computer 引用，Session 把它传给 Operations；组合的 `ANYBOX_COMPUTER_ATTACHMENT` 只作为远端形态新项目的默认绑定，本机形态也可把单个项目绑定到远端附着。HTTP `POST /projects` 增加可选 `computerAttachmentId`，Project DTO 带绑定。宿主目录选择器仍只浏览 harness server 本机，远端项目以绝对路径登记。

验收入口：`tests/computer-worker-router.test.mjs`（无单元时的路由与查询失败；查询面 stat/list/search/read 与越界拒绝；远端形态下默认绑定、单元回答可用性、远端项目的搜索/预览/准备/快照/目录树、单元离线时准入立即拒绝且项目不可用、单元重启后继续；本机形态同时服务本机项目与远端绑定项目：上限外目录拒绝、同路径不同单元是两个项目、两个 Run 各自落在所绑定 worker、远端项目读取经单元）。受控 worker 夹具按需站在 `computer.local-worker` 或 `computer.worker` 之后。

## 可组合单元 U1 第 5 步：Web 附着入口（2026-10-14）

新增浏览器模块 `units-client.ts`：设置弹窗增加“单元附着”分类（`setupUnitsSettings`，使用所选设备的固定 Api）列出该 harness server 的附着并生成一次性 Computer 附着码、撤销远端附着；“管理连接”每台设备增加“附着到远端 harness server”入口（`setupLocalAttachments`，经该设备的 `/units/local-computer/attachments` 由其本机执行器消费附着码，设定目录/工具上限，列出连接状态并可撤销）。附着码只显示一次，关闭设置弹窗丢弃输入。客户端网关白名单只接纳拥有者侧 `/units/attachments`、`/units/attach-codes`、`/units/attachments/:id/revoke` 与 `/units/local-computer/attachments[/:id/revoke]`，单元侧路由不经网关。错误映射增加 `unit-*` 与 `worker-attach*` 提示。项目绑定到远端附着尚未进入 Web，仍经 `POST /projects` 的 `computerAttachmentId`。

验收入口：`tests/units-client.test.mjs`（纯规则、设置面板列出/生成/撤销与错误提示、连接管理附着入口消费与撤销、网关白名单）。第 4、5 步合并一次 macOS / Node.js 24.16.0 `npm run check`：类型检查与构建通过，1331 项测试中 1318 项通过、12 项按原门控跳过、1 项失败（本机环境既有的 worker 图片用例）。

## 可组合单元 U1 第 6 步：故障注入行为测试（2026-10-14）

新增 `tests/computer-unit-faults.test.mjs` 与子进程夹具 `tests/helpers/unit-harness-process.mjs`，单元在测试进程内运行、经真实认证 HTTP 拨出：

| 故障 | 退出事实与断言 |
| --- | --- |
| 网络中断（单元侧 fetch 失败 4 秒，命令期间完成） | Run 保持 running 不被判失败；恢复后拿到原结果，`effect.log` 一行、toolCalls 1、tool-observed 一次、receipt 保留、pins 释放 |
| 单元重启（关闭并重开 worker，新 bootId） | 在途命令成为 cancelled 事实并只消费一次，Run 以 `tool-cancelled` 结算且不重放；旧 boot 保存的 scope 清理由新 boot 返回，pins 释放；后续 Run 在同一逻辑计算机的新代次上完成 |
| 单元进程 SIGKILL（真实 worker 子进程，`tests/helpers/unit-worker-process.mjs`，新 bootId） | 没有任何 boot 记录 scope 清理：在途操作成为 outcome-unknown，Run 以 `tool-cleanup-failure` 结算且不重放，pin 不释放；同一 worker 以新 boot 应答即证明旧实例已退出，Computers 退役旧实例并换代，worker 侧 uncertain 的旧 Run 不再栅栏同一 workspace，后续 Run 完成；应用关闭报告清理失败 |
| 撤销附着（命令运行中） | 单元下一次轮询 401 后本地撤销、删除凭证并取消命令；新 Run 准入被拒绝；harness server 把已置位操作记为 outcome-unknown，scope 清理报告失败、pins 不释放，应用关闭报告清理失败 |
| harness server SIGKILL（真实子进程，固定端口与实例身份） | 单元保持运行；替代进程 `restarted` 后单元重连，恢复接管经 `authorizeRun` 等待单元回来，查回同一 receipt，Run 完成、输出为原结果、`effect.log` 一行、模型调用 2 次、唯一成功节点 |

配套变更：Computer Operations 在传输失败后复核附着仍 approved（撤销即 outcome-unknown，不再无限等待）。真实跨机器 HTTPS 与系统凭据验收未进行，仍由 `ANYBOX_KEYRING_TESTS=1` 门控的单元凭证用例与后续部署验收记录覆盖。macOS / Node.js 24.16.0 上 `npm run check` 类型检查与构建通过，1335 项测试中 1322 项通过、12 项按原门控跳过、1 项失败（本机环境既有的 worker 图片用例）。

真实部署发现的回归（2026-10-14）：`projects` v2 最初用"建新表、删旧表、改名"重建，而 `harness_sessions.project_id` 以外键引用项目且 node:sqlite 默认强制外键，带会话的账本在删表时报 `FOREIGN KEY constraint failed`，本机与腾讯云上的 Agent 目标都以 `product-startup-failed` 启动失败；空表测试没有覆盖。改为事务内 `PRAGMA defer_foreign_keys = ON`、复制到临时表、删表、同名建新表并按原 ID 回填，`tests/project-directories.test.mjs` 增加带外键引用行的 v1 账本迁移用例。客户端网关对 `/units/*` 改用 `/api/v1/apps/agent` 上游路径（这些路由没有兼容别名），`tests/products-api.test.mjs` 验证。

## 可组合单元 U1 真实跨机器验收（2026-10-14）

腾讯云上海 harness server 升级到 `fd161c6-u1b-20261014`（commit fd161c6 加未提交的 U1 工作树），本机 macOS 以同一构建运行 Anybox Harness 客户端、本机 harness server 与独立 worker。经网关走通：本机消费附着码（单元凭证进入 macOS Keychain）、远端登记绑定该附着的项目、真实 DeepSeek 模型驱动的 Bash/Apply Patch/Read Run、`codex_view_image` 经字节通道保留远端资产、项目文件搜索/预览/目录树；归档与会话查询不变。故障注入完成本机 worker SIGKILL（u1b 暴露回归，修正后以 u1c 复验，见下两段）与在途撤销附着（见 u1c 段之后）；远端 harness server 的进程 SIGKILL 被本机执行环境拒绝，未做真实验收，只有进程内子进程用例覆盖。详细 ID 与事实见[可组合单元设计](composable-units-design.md)第 9 节。

真实跨机器故障注入发现的回归（2026-10-14，腾讯云 harness server 操作本机 Mac worker）：SIGKILL 本机 worker 后，旧 Run 的 pin 因无人观察 scope 退出而永不释放，Computers 对同一逻辑计算机的换代被 `computer-pinned` 拒绝，worker 侧 uncertain 的旧 Run 又以 `worker-binding-conflict` 栅栏同一 workspace，之后该单元上所有新 Run 都以 `tool-unavailable` 失败；进程内的单元重启用例因优雅关闭记录了清理而没有覆盖。修正为提供方在同一 worker 以新 bootId 应答时返回 `previousExited: true`，Computers 据此退役带未释放 pin 的旧实例，worker 的同 workspace 栅栏排除 uncertain Run；本机 worker 客户端在每次调用前检查已连接 PID，异常退出后首个调用即重连或重启。新增单元进程 SIGKILL 故障用例、提供方证明换代用例与客户端重连用例。

`fd161c6-u1c-20261014` 重新验收（2026-10-14 19:29 升级，同一腾讯云 harness server 与本机 Mac）：升级后首个 Run `be297b50` 激活逻辑计算机 `unit:898a9abc…` 时，本机 worker 已以新 bootId 应答，带 `9f3edd0b` 未释放 pin 的第 1 代被退役并换到第 2 代；命令执行中 SIGKILL 本机 worker，本机随后的第一个本地调用观察到死亡 endpoint、第二个调用 3 秒内重启 worker，拨出 8 秒内重新连接，旧 Run 在 kill 后 14 秒以 `tool-cleanup-failure` 结算，其 pin 作为事实保留未释放，`worker-restart3.log` 只有一行；后续 Run `f7c490bd` 换到第 3 代完成并释放 pin（实例表 1 retired / 2 retired / 3 ready）。升级本身的观察：切换时旧 u1b 进程对 SIGTERM 记录 `harness server shutdown failed` 并以退出码 1 结束，入口没有打印原因（已改为打印错误链，未重新部署）；新进程在 3.6 GB 内存的 VM 上 `applying` 约 2 分钟才 `running`，期间本机拨出循环因 `product-unavailable` 进入 offline 并按退避自动重连，`running` 后 30 秒内恢复 connected，无须重新附着。本机 Mac 在附着期间空闲睡眠 23 分钟（18:44–19:07），唤醒后两侧仍显示 connected，没有在途 Run，不需要人工干预。

在途撤销（u1c，2026-10-14 19:38）：Run `d1f0771d` 的命令在本机执行中，经网关 `POST /units/attachments/898a9abc…/revoke` 撤销附着，远端立即记为 revoked；本机拨出循环约 20 秒内观察到撤销并终止了命令进程组（`sleep 60` 消失，`revoke2.log` 只有一行），该 Run 以 `tool-cleanup-failure` 结算；同一会话的新 Run 准入被拒（`project-unavailable`，项目绑定的附着已撤销）。随后远端签发新附着码、本机消费（附着 `f7a1936c`，20 秒内 connected）、远端以新附着把同一目录登记为新项目 `23e60d67` 并新建会话，Run `f174ff25` 执行 `cat revoke2.log` 得到 `once`，从撤销到恢复约 35 秒。第一次尝试的撤销请求没有 JSON 体而被 `invalid-json` 拒绝，那次 Run `331d1df4` 正常完成，不构成验收。

反向拓扑验收（2026-10-15，设计 1.1 节场景表第 5 行：本机 harness server + 远端 Computer）：本机 harness server（本机形态，Models 与客户端同在本机）经 SSH 反向隧道接受腾讯云 worker 的拨出附着（附着 `6ce26a47`，上限 `/home/anybox/projects`，服务器 worker 的单元凭证保存在服务器 gnome-keyring），把服务器目录 `/home/anybox/projects/demo` 登记为绑定该附着的项目，DeepSeek V4.1 Flash 驱动的 Run `97777b1f` 在服务器上执行 `hostname; pwd; cat README.md` 并返回 `VM-0-8-ubuntu`，从签发附着码到 Run 完成 34 秒。隧道做法见[部署说明](harness-server-deployment.md)。

测试环境注意：18:42 的完整 `npm run check` 中撤销故障用例被判 180 秒超时（总时长 963 秒），原因是本机在运行期间进入空闲睡眠 15 分钟，Node 计时器按连续时钟在唤醒后立即触发超时，并非并发负载或代码回归；用 `caffeinate -i -s` 保持唤醒后，同一组 7 个并发测试文件 134 秒通过（83/84，仅已知的 macOS 图片用例失败），故障用例文件单独 5/5。长时间检查需保证宿主不睡眠。

### U1 整合修复与验收（2026-10-17）

本次只将 U1 整合到已包含 Claude Agent 与 U0 修复的 main，保留双方文档、正式应用目录与共享宿主连接库。客户端拥有者侧单元路由使用 `/api/v1/apps/agent/units/*`，不增加旧别名或代理单元私有路由；未带入后续桌面运行角色和平台发行实现。

整合修复覆盖八项问题：Authority 在新工具置位前检查批准的工具许可，worker 在接纳事务与查询中按本机 canonical 身份检查批准 scope 与设备 ceiling；已领取提交因 boot 变化失效后保留执行不确定性，后续 claim/get/控制继续查回原事实，恢复时不把无回执等同于未执行，而本代明确尚未发送的新调用仍可取消退出；worker 关闭与附着撤销等待查询及真实文件句柄退出，拨出关闭等待已接受的管理调用，清理失败仍关闭 worker 根并留下失败回执；远端默认形态禁用 Authority 本机目录浏览、创建和系统窗口，保留手工远端绝对路径输入；查询目录别名不能扩大权限；远端目录恰好 1000 项可完整浏览，超过扫描上限明确返回 `file-tree-truncated` 并提示改用搜索或路径引用；附着面板同步清除秘密和自身 DOM，再等待旧请求退出，旧代清理不删除新表单。

回归使用真实 SQLite、HTTP、worker、文件句柄与受控退出门闩，覆盖禁止工具零副作用、丢回执后只消费一次成功事实、无回执恢复及未发送取消窗口、查询/管理调用关闭等待、目录上限及界面换代。跨机器单次只读查询取消仍只结束 Authority 观察，不宣称远端文件资源已经退出；worker 独立持有并清理这些查询，本次没有新增跨机器取消确认协议。该次交付时真实 worker 支持范围仍为 Unix，保留当时的平台发行边界；当前 Harness Windows worker 状态见[原生平台支持](native-platform-support.md)。

macOS / Node.js 24.16.0 上以 `TMPDIR=/private/tmp caffeinate -i npm run check` 完成类型检查、构建、浏览器资源校验和全量测试：1432 项中 1418 项通过、14 项按既有门控跳过，零失败、零取消；相较初始 U1 试合净增加 32 项测试。各组定向回归也全部通过，修复前构建已验证对应缺陷会触发断言。worker 测试临时目录统一正规化，避免 macOS `/var` 别名影响原有读图用例。未修改 NyaCore，未调用真实模型或系统 Vault，未重新进行跨机器 HTTPS 验收。

### 桌面角色整合修复（2026-10-17）

本次将独立桌面角色与 Computer 管理整合到已包含 U1 修复的 main，保留双方文档与 Claude Agent 正式应用注册；后续原生 worker、随包运行时和平台服务管理的发行实现不在本次范围。

修复四项问题：权限修改的工具清理失败后，该附着在同一 boot 内持续拒绝新工作，并保留实际 scope 句柄供取消、关闭、权限重试和根关闭继续等待退出；同一个观察者的只读连接不再占用显式启动流程；多个进程对同一目录的启动通过独立 SQLite 启动事务协调，在锁内复核已运行实例，启动超时先终止并等待自己尚未交接的子进程退出；Claude Agent 每次激活重新读取共享设备连接，保持未改变的设备、线程观察与草稿，连接换代则取消旧代请求，迟到的发现结果不能启动隐藏页面的 Agent 或覆盖新界面。

回归使用真实 worker、独立 CLI 进程、SQLite、工具子进程以及可控请求与退出门闩；覆盖权限失败后的准入、控制重试、新 boot 恢复，启动竞争、锁拥有者强杀、观察关闭与失败启动，以及新本机配对、设备换代、草稿/Run 观察保留和页面关闭等待。

macOS / Node.js 24.16.0 上以 `TMPDIR=/private/tmp caffeinate -i npm run check` 完成类型检查、构建、浏览器资源校验与全量测试：1465 项中 1451 项通过、14 项按既有门控跳过，零失败、零取消，用时约 150 秒；相较桌面角色试合新增的 16 项回归全部通过，修复前构建已确认原缺陷触发断言。真实 Electron utility process 的有限复验覆盖纯客户端不启动本机服务、客户端只创建自身数据库、两个正式应用登记及执行端独立启动/关闭，详见[角色边界](runtime-roles-and-distribution.md)。未修改 NyaCore，未调用真实模型或读写系统 Vault，未做完整桌面 smoke、成品安装及新的跨机器验收；平台发行与 Windows 真实 worker 仍属后续范围。

## D0a.1 应用业务服务独立运行（2026-10-17）

两个应用分别提供自己的独立服务工厂、HTTP 监听、兼容认证和 CLI：`createStandaloneHarnessServer` / `anybox-harness-server`、`createClaudeAgentServer` / `anybox-claude-agent`。独立入口创建唯一 Nya 根，Anybox 注册适配在已有根复用同一业务装配并增加活动保护；原 `anybox harness-server`、npm 与桌面默认组合保持。没有提取公共 HTTP/认证模块，没有拆数据库或改变既有运行角色，D0b 按消费者装配与应用下载安装仍属后续阶段。设计与接口见[独立业务服务](application-standalone-services.md)。

应用自己持有访问及监听组件，沿用 `host-access` v2 表、迁移、实例身份与令牌格式；监听依赖本轮访问服务，认证重启后同端口重绑，并在首次异步步骤前捕获业务服务。监听安装在业务之前，关闭同步停止准入、启动请求排空，再并行等待根清理及保留操作；Run 的 `result` 就绪不能代替 `done` 和真实资源退出。Claude Agent 同时补齐开始中索引操作的等待及 SDK 启动前准入复核，避免关闭期间持久化完成后漏启动新进程。

macOS / Node.js 24.16.0 上运行 `npm run check`：类型检查、工作区构建、Web 资产校验通过，1499 项测试中 1485 通过、14 跳过、0 失败、0 取消，测试约 154 秒。新增行为覆盖无宿主业务装配、两应用独立认证与 SSE、正常完成及取消、在途 SIGTERM、实际退出等待、认证组件重启重绑、端口绑定失败后的清理，以及“托管关闭 → Harness 独立打开 → Claude Agent 独立打开 → 托管重开”的历史、令牌、实例与目标状态兼容；同库双开被排他拒绝。

隔离回归把单个应用的声明生产依赖物理复制到仓库外并禁用 `NODE_PATH`，确认 host、distribution 和另一应用不可解析。另分别执行真实 `npm pack` 与 `npm install --offline --omit=dev --include=optional --ignore-scripts`，只安装目标应用及所需依赖，实际安装的 `.bin` 命令通过帮助、访问恢复、`serve`、认证业务查询、SSE 和 SIGTERM 退出；公开服务工厂在该安装中完成受控业务 Run。两个进程正常以 0 退出，监听实际释放。新 CLI 的入口判断支持 `.bin` 符号链接及 macOS `/var` 的真实路径。

受控执行使用内存凭据、模拟模型网络与 SDK，CLI 验收禁用外部网络；没有调用真实模型或读取系统 Vault，也未执行最终桌面成品及新的跨平台验收。独立服务只提供业务 HTTP 和身份管理，当前 Web 客户端依赖的宿主产品管理接口未纳入独立入口。


## 2026-10-17 D0a.2 应用客户端业务独立归属

取消应用间共享业务层并移除 `@anybox/execution-connections`。Harness 与 Claude Agent 各自持有连接存储、系统凭据、本机配对、白名单转发和管理 UI；连接组件由所属应用打开时安装、停止时取消并等待实际退出，互不使用另一应用的业务服务。旧共享元数据按应用只读迁入一次，凭据首次使用时复制到私有 namespace，来源保留；失败复制和清理可直接重试，不重放或恢复旧共享写入。桌面配对的 managed owner 按应用区分，Claude Agent 不再要求打开 Harness 配置设备。SQL 与原生目录窗口保持基础能力。边界、组件及兼容规则见[应用客户端业务独立归属](application-client-isolation.md)。

`npm run check` 最终通过：1509 项测试，1495 通过、14 跳过、0 失败。新增应用装配/退出、连接与凭据隔离、旧格式迁入与失败重试、独立取消等待、桌面 token owner 及连接管理窗口清理测试。验证中修正 Computer 撤销故障测试的观察时序：撤销状态先持久化，再等待凭据实际删除，不以状态查询代替清理完成；worker 实现未改动。真实系统凭据、真实 Claude SDK、其他受门控平台及成品包未在本轮验收；host-only 发行及应用下载安装仍属后续阶段。

## D0b 生命周期接入与基础能力按需装配（2026-10-17）

宿主按应用入口的必需/可选能力声明选择兼容提供方，固定运行代版本并协调共享消费者。提供方工厂在实际消费者打开时才创建组件；全部组件仍在进程唯一 Nya 根，由 Nya 处理真实依赖和清理顺序。必需能力未满足时不调用业务工厂，运行中失效停止对应入口的新 HTTP 准入；可选目录能力缺失、不支持或不兼容时，两应用自己的连接管理及显式路径仍可用。目录提供方最后消费者退出后释放，宿主自用 SQL 保留原连接和控制记录，不引入另一数据库或写入者。纯界面应用不创建后台、业务 HTTP 或假运行目标。

应用自己初始化、冻结业务、取消和排空实际资源。宿主只调用通用生命周期及 Activity；桌面执行端移除对 Harness Run 准入的直接读取，忙碌与退出检查覆盖注册的全部应用。已接受的初始化可取消且等待实际退出，过期代不能向新代安装资源。应用或提供方清理失败会保留所有权，阻止同进程重开并在根退出时报告；组件此前 `FAILED` 的回滚不能由后续成功的 `dispose()` 自动证明，沿用保守栅栏。明确清理完成的装配错误可显式重试。

行为测试覆盖空宿主、纯界面、必需能力门禁与恢复、可选能力降级、SemVer 冲突、共享最后消费者及系统目录窗口实际退出、常驻 SQL、取消初始化、其他应用独立运行、过期代、运行中依赖撤销、失败清理与整根退出。测试及组件契约见[应用包设计](application-packages-design.md#123-已完成阶段与验收边界)和[应用接入](application-development.md)。

最终 `npm run check` 退出码 0：类型检查、工作区构建及 Web 资源校验通过，1556 项测试中 1542 通过、14 项按既有门控跳过，0 失败、0 取消，测试约 154 秒。相对 D0a.2 新增 47 项测试。进程清理回归以显式退出门闩验证关闭等待，忽略 TERM 后的强制终止由独立用例覆盖，避免用过窄的测试宽限替代实际退出证明。

真实加载实验在 macOS 15.6 arm64 的独立 Node 24.16.0（ABI 137）及 Electron 44.5.1 主进程/utility process（Node 24.21.0，ABI 149）执行。通过各包公开入口解析同一个 `@nya/core` 0.1.0-rc.1 和 `Context`；实际 SQLite、通用宿主、惰性目录提供方开/停/重开及最后消费者释放通过，宿主 SQL 身份保持。`@napi-rs/keyring` 的平台原生模块仅加载、没有凭据调用；`sharp` 完成内存 PNG；编译后的 Cocoa 取消绑定在 Electron 主进程完成加载。没有创建窗口或系统面板，没有读写用户凭据和用户应用数据。

本次未修改 NyaCore。该实验采用工作区公开入口与当前依赖安装，不等于无工作区链接的独立 `.anybox-app`、正式 Forge/签名成品、真实 Keychain 操作、系统窗口交互或 Windows/Linux 验收。D1 本地包安装、生效和卸载及 D2 在线下载仍待实施。

## D1.1 安装事实与操作账本（2026-10-17）

新增独立的 `host-package-registry` 组件和 `host.package-registry` 端口，注入同根具名 SQLite 提供方 `host.package-registry-storage`。`registry.sqlite` 与原宿主控制及应用业务库分离，原数据和迁移不搬动。通用 SQLite 工厂支持显式服务名，仍保留相同的操作队列、事务和操作系统排他所有权。正式 CLI 客户端默认使用 `${clientDatabase}.applications`，可由 `ANYBOX_APPLICATION_DIRECTORY` 指定；桌面客户端使用 `<userData>/applications`，执行端不成为第二写入者。

包身份固定应用 ID、版本、内容摘要和目标平台；installed、selected、pending、入口运行目标和角色实际 ready 快照分别记录。幂等 requestId 查回原 operationId，操作阶段和事实提交使用预期修订 CAS。管理者接管提升 owner epoch，未完成操作进入待恢复状态，保留回执并要求显式核对，不重放未知外部效果。

角色使用快照在返回前提交 reservation，提供方所属包也参与固定与占用。秘密只返回一次、存储只留 SHA-256；角色导入前取得独立 usage 锚的实际 SHARED 锁并 claim。子 reservation 先于父释放提交，子锁独立于注册库管理者；旧快照失效不释放已在使用的旧版本。退出确认先栅栏新 claim，再以 EXCLUSIVE 锁证明读锁退出、持久撤销锚并记录 exited；锚缺失、损坏或退出不明继续阻止回收。锚始终保留在包目录之外，不按 PID、超时或删锁文件判断退出。

受控回收回调在选中/待生效指针、全部使用记录及历史锚复核之后进入，并持有同一操作的控制栅栏。回调成功提交 removed，失败保留 reclaiming 与待恢复结果；完成及待恢复回执都无法写入，或锁资源清理失败时，关闭本代准入并在根退出时报错，阻止未知副作用重放。关闭只取消并排空本地已接受操作，不等待外部角色或依赖自身退出的交接。

验证覆盖同根独立注册库、路径和文件别名拒绝、幂等与 CAS、身份不可变、待生效与实际版本并存、快照失效、父子连续交接、回收控制竞争、缺失锚、回执写入故障、配置固定和持久引用校验。真实 Node 子进程验证注册库写入互斥、管理者 SIGKILL 后接管，以及管理者关闭/重启后子进程持锁继续阻止退出确认；杀死对应子进程并等实际退出后，操作系统锁才允许确认。

最终 `npm run check` 退出码 0：类型检查、工作区构建及 Web 资源校验通过，1594 项测试中 1580 通过、14 项按既有门控跳过，0 失败、0 取消，测试约 155 秒。相对 D0b 新增 38 项测试，最终源码的 35 项包管理定向测试也全部通过。

真实运行时实验在 macOS arm64 的 Node 24.16.0 和 Electron 44.5.1 主进程/utility process（Node 24.21.0、SQLite 3.53.4）通过。独立注册库与控制库、空目录快照、claim/ready、关闭重开及 epoch 递增均通过；Node 子进程持有 SHARED 锁时，Electron 在自身读锁释放和管理者重启后仍拒绝退出确认。只有子进程实际释放并退出后，管理者才记录 exited，旧凭证随后无法重新获取锁。实验使用临时数据与工作区公开产物，所有自建进程正常退出，没有窗口、应用业务、Models 或 Vault 调用。

本次仍由静态默认目录加载正式应用，不把已有源码登记成已验证安装；没有新增用户安装、下载、切换或卸载按钮。D1.2 接入签名归档与独立产物验证，D1.3 接入真实文件安装，D1.4 将角色加载及激活接到快照契约，D1.5 接入文件回收和卸载。组件不读取 Models、Session、Run、连接或凭据业务，也没有业务迁移、密钥读写或第三方代码执行。实验不代表正式签名成品、真实安装包、GUI 或其他平台验收；未修改 NyaCore。

## D1.2 最小宿主、完整应用包与验证器（2026-10-17）

新增独立空宿主 Node CLI、固定 Electron 主入口和客户端 utility entry；没有应用、连接、Models、Vault、目录窗口或本机执行服务选择。空宿主沿用已有 Products、Activity、Shell 与独立注册库，每个服务进程仍只有一个 Nya 根。原 `distribution`、npm 与 Forge 默认命令继续保留静态完整组合。

`artifacts:build` 生成独立宿主目录及两个 `.anybox-app`：按实际物理依赖和声明范围复制预构建生产闭包，保留嵌套版本冲突、目标原生文件和许可证，排除开发脚本、普通 TypeScript 源码、工作区链接及不使用的 Claude SDK 平台可执行包。归档构建需要显式 Ed25519 私钥及 key ID；示例策略只含公钥，不被自动信任。目标使用预先提供的 Node/Electron 运行时，不运行 npm 或编译。

受限 ZIP v1 验证器检查大小、目录与本地头、路径与平台别名、模式、CRC、外部发布者/appId 授权、原始 manifest/files 签名、全部索引字节及逐角色运行条件。Web 图通过静态 AST、CSS/HTML/SVG 资源引用和既有注册目录检查。Node 注册工厂在独立准备进程中只构造描述；公共 Nya/API/SQL 固定到宿主模块，归档外依赖和私有共享副本均拒绝。worker main 不执行，纯界面包不需要 Node。取消、超时和成功均核对准备进程与所属进程组实际退出；退出不明保留临时载荷并报错。

新增 44 项行为测试，覆盖归档签名与破坏、限制与跨平台路径、静态闭包、资源 URL、角色兼容、注册冲突与声明一致性、共享运行时、实际取消/退出，以及生产依赖、版本冲突和空宿主退出。原宿主隔离夹具增加对没有 `files` 清单的合法第三方已发布包的支持，仍禁止工作区包省略公开产物声明。

最终 `npm run check` 退出码 0：类型检查、工作区构建及 Web 资源验证通过，1638 项测试中 1624 通过、14 项按既有门控跳过，0 失败、0 取消，测试约 157 秒。44 项新增定向测试全部通过。最终回归之后只同步验收文档，没有继续修改源码或测试。

真实仓库外实验使用 macOS 15.6 arm64、Node 24.16.0 和 Electron 44.5.1。独立宿主只有七个物理生产包，目录约 2.4 MiB，不含 Node/Electron 自身；普通 Node 空外壳、帮助和关闭通过。Electron 使用该独立目录创建隐藏窗口及实际客户端 utility process，`anybox-app://app` 下读取空 Products 得到 200/[]，关闭等待客户端退出，主进程退出码 0。没有窗口交互、目录面板或 Vault 业务调用。

| 独立应用 | 签名 ZIP 字节数 | 物理生产包数 | 独立验证结果 |
| --- | ---: | ---: | --- |
| Anybox Harness | 37,986,120 | 74 | 静态资源、client/execution 注册准备通过；worker 只检查兼容 |
| Claude Agent | 36,026,566 | 113 | 静态资源、client/execution 注册准备通过 |

两包的验证 CLI 都来自复制后的独立宿主，未借用仓库模块；另一个签名纯界面夹具没有 Node、后台、SQL 或运行条件，也通过。共检查 9,770 个产物文件，无链接、普通 TypeScript 源码或 SDK 平台 Claude 可执行包。独立 Node 原生检查完成 sharp 的 2×3 PNG、Keyring 绑定加载、ripgrep 15.0.0 执行和 Cocoa 目录绑定加载；没有构造 Keyring Entry、读写凭据、打开系统窗口或初始化应用业务。两个应用及 Computer worker 的独立 `--help` 均正常退出。所有自建子进程均已等待退出，临时签名私钥已删除，原有客户端和 worker 未重启。

契约与命令见[归档及产物手册](modules/package-management/archives.md)。本阶段没有向 D1.1 注册库写安装事实，也没有安装、生效或卸载入口；不把准备结果当作应用业务就绪。D1.3 接真实文件安装，D1.4 接正式角色加载/快照/激活，D1.5 接卸载。Node 准备的进程树适配当前仅 Unix Node >=22.15；Electron 和 Windows 保守报告准备运行时不可用，纯界面验证仍可单独运行。自包含运行时、正式 Forge/平台签名与公证、Windows/Linux 成品和其他平台实测仍待后续阶段；未修改 NyaCore。


## D1.3 本地文件安装与中断恢复（2026-10-17）

新增同根 `host-package-installer`，注入既有注册库并持有上传、暂存、签名验证、独立准备、文件提交、取消和恢复资源。`host-package-registry` v2 原地保留 v1 的操作、安装、快照、使用凭证与 epoch，增加预身份文件任务。`accept` 在任何受管读取之前保存 requestId、文件名、原始 SHA-256、大小及可选应用修订；相同输入查回原任务，不同输入冲突，不因重试再次读取或安装。任务和操作分别使用 CAS，验证后的身份才进入应用级串行 preparing 操作，不阻塞其他应用。

完整原始归档先保存并核对长度、摘要、文件同步；D1.2 验证器校验签名、索引、兼容与资源闭包，独立 Node 工厂只构造注册描述。准备成功后生成独立候选，保存全部生产载荷、签名元数据、原始归档和宿主回执，同步文件和目录再 rename 至 `packages/<appId>/<version>/<digest>`。提交前后重验目录、身份和字节，最后同事务写 installed 文件任务、安装事实和 awaiting-activation 操作，只更新 pending；selected、Products 运行目标、当前正式角色目录均不改变。同身份重新导入仍验证输入及既有目录，再复用原安装和来源；同版本不同摘要拒绝覆盖。

每次工作先耐久追加 `workGuardIds`，实际准备子进程取得 SHARED 锚。历史锚不随阶段或回执替换消失；旧管理者关闭或异常退出不释放子进程的真实使用。新管理者在清理、恢复或再次准备前必须排他证明全部历史锚退出并永久撤销；未知、缺失、损坏或仍被占用均保留待恢复，不用 PID、超时或客户端断开推断完成。取消与根关闭等待已接受生产源、读取、写入、句柄、准备进程和所属进程组实际退出。回执或清理失败不能伪造未安装，恢复记录也无法提交时停止本代准入并保留根清理错误。

重启后非终态任务进入 recovery-required，不自动消费半个上传流、重跑工厂或覆盖提交目录；已 installed 文件任务保持终态，后续生效操作恢复单独记录。默认 inspect 只查事实，显式 resume 在旧工作退出后重新校验完整原始包和真实目录，再接纳提交事实。discard 只清理确认未提交的任务暂存，已提交或提交阶段不明时保留版本。没有对应任务的孤儿暂存仅报告，不自动回收未知归属目录。

本机客户端增加 `/api/client/v1/app-packages` 状态和任务查询、意图接收、字节上传、取消及显式恢复；界面从用户选择的 File 上传，保留其他应用挂载和草稿。管理响应只含生命周期投影，不泄露绝对目录、原始工厂输出或凭证；不接收服务端路径、任意 URL、执行命令或请求自授信密钥。`ANYBOX_APPLICATION_TRUST` 指定外部发布者授权策略，未配置时不授信，不自动信任示例公钥。离线 `anybox-host install/operations/installations/cancel/recover` 使用同一根、同一单写锁；运行中管理者占用时拒绝第二写入者。安装器不读取应用业务库，不迁移业务、不改连接或凭据，也不调用应用业务取消接口。

行为测试覆盖预身份幂等/CAS、v1→v2 保留迁移、同应用串行绑定、原子事实与待生效、重新导入、无业务初始化、签名与目录破坏、取消等待、历史锚、子进程及所属资源实际退出。真实子进程 SIGKILL 用例包含 accepted、received、after-rename 和 before-ledger 四个边界，并新增同步准备工厂阻塞期间杀死管理者的第 5 个用例；重启先查回事实，旧子进程实际退出与历史锚证明完备后才显式恢复。独立准备生命周期用例继续检查管理者和子进程的实际资源归属；Unix 短暂 EPERM 保留监护进程实际 SHARED 并重查，只有真实进程组退出才释放，错误或超时不构成证明。界面回归覆盖恢复期间并行取消、迟到 list/PUT 响应的修订单调性，以及变更成功后重新读取完整安装事实。最终 `npm run check` 通过：1700 项测试，1686 通过、14 跳过、0 失败、0 取消，耗时 158818.996541 ms（约 159 秒）。14 项安装界面回归已在最终编译产物中通过；真实进程故障、HTTP、CLI、迁移及既有业务行为均纳入本轮检查。

实际完整应用归档的 HTTP 安装实验使用 macOS arm64、Node 24.16.0，以及独立临时安装根 `anybox-d13-real-install-*` 和外部公钥策略。两个输入均为 D1.2 构建的完整应用归档，经过真实意图接收、原始字节上传、签名验证、client/execution 描述准备及目录登记，结果如下：

| 应用归档 | 原始字节数 | 安装结果 |
| --- | ---: | --- |
| `agent-0.1.0-darwin-arm64.anybox-app` | 37,986,120 | installed；selected 为 null，pending 固定该身份 |
| `claude-agent-0.1.0-darwin-arm64.anybox-app` | 36,026,566 | installed；selected 为 null，pending 固定该身份 |

安装后及关闭重开的 Products 都是空数组；Models、Harness Run/Session、Computer、应用连接与 Claude Run 服务均不存在。重开后两个安装事实和 pending 保持，说明完整应用包可持久安装而不装配业务或切换当前空目录。实验没有模型请求、业务迁移、连接或凭据操作；它不把应用准备构造结果解释为业务就绪，也不扩大为角色激活、正式签名发行或其他平台验收。

仓库外最小宿主 CLI 实验使用最终构建的 `stageMinimalHost` 复制产物，临时目录命名为 `anybox-d13-external-host-*`。宿主只有七个生产包，没有应用生产依赖；在外部目录作为 cwd、清空 `NODE_OPTIONS` 和 `NODE_PATH`、不运行 npm 安装的条件下，通过 `host/anybox.mjs` 的真实命令分派依次执行 `install`、`installations` 和 `operations`，三个命令均退出 0。签名纯界面夹具登记为 installed，selected 为 null、pending 固定其身份，actual 为空。后续查询进程接管时仅把 awaiting-activation 包操作保留为待恢复，文件安装终态与事实不变。私钥只在实验进程内生成，未写磁盘；显式信任文件只含公钥。这验证了独立空宿主可以从外部目录完成本地安装及查询，范围仍是 macOS arm64 Node 24.16.0、纯界面包和外部运行时，不包含正式签名成品或角色业务启动。

安装器进一步把准备进程的临时载荷固定在 `staging/<installId>/preparation/<temporaryId>`，受同一任务和工作锚归属。旧管理者退出后仍可能使用的字节保留在可核对的位置；只有取得全部历史工作退出证明并撤销旧凭证后，才清理这些任务私有临时目录，不在全局临时目录遗留无任务归属的载荷。

当前验收范围是 macOS Node。Electron/Windows 的 Node 后台注册准备仍保守报告运行时不可用，不静默跳过需要的工厂；纯界面包不要求 Node 准备。原 Node/Electron 运行时外部提供、自包含成品及其他平台限制保持事实描述。正式运行目录仍为静态组合，D1.4 才接入快照加载、角色重启和生效，D1.5 才接入卸载，D2 才增加在线下载；本次没有重启现有客户端或独立 worker。实现契约见[安装组件](modules/package-management/installation.md)，未修改 NyaCore。

## D1.4 正式角色加载与版本生效（2026-10-17）

新增同根 `host-package-activation`，只注入安装注册库、Products 和 Activity。注册库 v3 原地增加耐久生效批次，保留 v1/v2 安装、文件任务和历史使用证明。installed、selected、pending、实际 ready 目录及 Products 后台目标各自保留事实；commit 不等于新代码运行，全部计划角色提交精确就绪回执、旧使用实际退出后才完成批次并清除 pending。新装后台继续关闭，纯界面入口不产生模拟后台。

固定加载器在导入前取得真实 SHARED 使用锁、claim 确切快照，重验不可变目录、签名、运行条件、能力和 Web 资源闭包。公开 Nya/API/SQL 解析到宿主同一实例，私有依赖保持应用自己的生产闭包；包含延迟导入在内的实际模块读取仍核验索引。只构造注册，实际业务初始化和迁移继续由应用的运行入口及 Nya 组件负责。代码使用证明保持到进程实际退出，关闭一个 JavaScript handle 不能证明模块或原生代码已卸载。仅受管包字节、目录或签名损坏会隔离对应身份；应用工厂读取自己的配置文件失败、信任策略或运行时变化不冒充包损坏。

最小 CLI 和最小 Electron 入口使用同一生命周期监督器、固定角色 bootstrap 及稳定 origin 代理。父进程没有 Nya 根、数据库连接或应用导入；客户端子进程独占注册库写锁，execution 通过私有 RPC 使用同一账本。父子 reservation 连续持有，旧角色实际退出后才交接写锁，新管理者取得当前 owner 的确切凭证后再导入。失去 IPC、超时和退出错误都不能替代实际资源退出。初始加载或交接失败会在确认旧角色退出后退回空管理宿主；不自动重放应用启动，查询和显式恢复仍可用。

生效冻结受影响进程中全部应用的 open/stop/retry 和 Activity 准入，再检查应用自己的 guard。所有已登记同源页面（含隐藏页面）分别检查全部挂载界面的 canClose 并等待真实 dispose。耐久 prepared 与当前短期 protected 证明分开，丢失响应只查原请求/操作，不提前清理页面或重复 mutation。其他应用的工作、草稿、断连或未知清理都会阻止切换，不由宿主查询业务表或取消 Run。已有后台目标和可恢复工作区位置保留，新装应用不自动打开或插入标签。

应用可以通过运行期上下文的可选 `startRole` 启动同一签名包声明的独立 worker。应用继续拥有其参数、目录、endpoint 和实际 worker 业务；宿主只核验身份、预留版本及启动固定入口。声明独立 worker 的包须显式 `lifecycleVersion: 1`，旧签名包保持可验证但正式加载要求更新，不静默使用旧的无账本 spawn。成功交接后 worker 独立持锁，宿主退出不停止它；版本生效遇到相关独立使用者时阻塞，等待应用自己的显式停止及实际退出证明。

`anybox-host apply/activation` 只调用显式回环管理 origin，不打开第二个注册库写入者。离线 install/operations/installations/cancel/recover 保持原语义。HTTP、CLI 和界面仅投影生命周期结果，不输出使用秘密、内部路径或原始工厂错误。组件关闭排空本地已接受控制，再释放写入所有权；不会等待必须先关闭自身根才能进行的角色重启。

专项行为入口包括 `package-activation-ledger`、`package-lifecycle-coordination`、`package-loader`、`package-managed-process`、`package-independent-role`、`package-role-proxy`、`package-activation-command`，以及页面、HTTP、真实 shell 和桌面 utility 适配测试。覆盖两角色升级、真实 SIGKILL、父子连续锁、初始损坏隔离、显式恢复、交接锁获取失败、独立 worker 存活、跨页面草稿、丢失回执和旧后台目标保护。

实际仓库外 macOS arm64 Node 实验重新构建了只有七个物理生产包的宿主，以及两份带 `lifecycleVersion: 1` 的完整签名归档。签名私钥只在构建进程内生成，未写入文件或输出；管理者仅接收显式公钥策略。运行使用独立物理依赖闭包，没有源码、工作区链接或目标设备 npm 安装步骤。

| 完整应用归档 | 原始字节数 | 生产包数 | 正式加载结果 |
| --- | ---: | ---: | --- |
| Anybox Harness | 37,991,277 | 74 | client/execution 均有精确 ready 回执，后台保持关闭 |
| Claude Agent | 36,028,341 | 113 | client/execution 均有精确 ready 回执，后台保持关闭 |

两包通过 HTTP 意图、原始字节上传、验证、准备和不可变目录提交，安装后 Products 仍为 `[]`、selected 为 null，pending 固定对应身份。随后原批次只提交一次 commit，最终 completed；客户端与执行端各加载两个应用，pending 清空，两个后台目标均为 disabled。正常关闭并重开后，selected 保留，两个新角色仍实际 ready；客户端库仅 `app-products` v2，执行库仅 `app-products` v2 和 `host-access` v2。没有 Models、Run、Session、连接或 worker 目录和业务组件初始化；所有实验管理者及角色进程均确认退出。完整包允许携带独立运行所需共享库副本，托管实际导入仍固定宿主公共实例，并拒绝相对绕入私有共享运行时。

真实 Electron 44.5.1 / Node 24.21.0 实验使用独立 userData 和隐藏窗口，经相同生产监督器、utility 入口、协议桥和完整 Shell 安装纯界面 1.0.0。首次生效得到新角色 ready 并安全 reload，`runtime: false`、未打开，无 execution 进程。挂载后安装 2.0.0，实际草稿拒绝返回 409，selected 1.0.0、pending 2.0.0 与原界面保留；放行后等待 123 ms 的实际 dispose 退出，再完成新角色 ready、reload 和 2.0.0 挂载。原标签、活动位置、hash 和稳定 origin 保留，最终 selected/actual 2.0.0、pending 为空；共三次页面加载，主进程 exit 0、stderr 为空，全部自有进程退出。

该实际复测补齐了页面 SSE 随 HTTP lifetime 退出、代理 GET/HEAD 断连真实注销旧订阅的回归，避免关闭等待循环和旧页面登记阻塞下一次生效；完整 body 已接受的 mutation 仍继续原操作。较慢的完整包准备期间，CLI 对丢失响应按同一 requestId 有界轮询，只等待与查询，不重发 mutation；默认整体观察窗口为 120 秒，单次请求最多 5 秒，超时仍不伪造完成。

最新 CLI 又在上述双完整包已选定的独立数据根中追加一个 1,747 字节的签名纯界面包，以原生 `anybox-host apply` 实际执行，13,622 ms 后 exit 0、completed。客户端实际目录为两完整应用加纯界面入口，执行端仍为两完整应用，两个后台目标继续 disabled；纯界面包没有增加持久后台目标，两个控制数据库的原行值保留，全部实验进程确认退出。CLI 整体观察不因准备阶段的暂时空查询而提前结束，也没有重复提交变更。

最终 `npm run check` 通过：1816 项测试，1802 通过、14 跳过、0 失败、0 取消；耗时 161680.871083 ms（约 162 秒），相对 D1.3 新增 116 项。该检查包含最终编译的当前 protected 证明、受管进程初始及交接故障回退、工厂配置文件缺失不隔离应用包、完整归档共享库副本的实际导入边界，以及运行中独立 worker 不被生效探测栅栏的回归；HTTP lifetime 结束 SSE、代理 GET/HEAD 注销旧观察和 CLI 延迟接纳查询也已纳入。`git diff --check` 同时通过。

实现及使用契约见[正式加载与生效组件](modules/package-management/activation.md)。当前 macOS arm64 Node 与隔离最小 Electron 验证不扩大为 Windows/Linux 成品、真实系统凭据或正式签名发行；Electron/Windows 的 Node 准备及独立 worker 启动限制保留。旧默认完整 distribution 桌面仍由 D3 迁入，D1.5 卸载和 D2 在线下载尚未实施；未重启用户现有客户端或独立 worker，未修改 NyaCore。

## D1.5 卸载与代码回收（2026-10-18）

复用既有 `host-package-activation` 接入显式 kind remove，不新增业务层或 Nya 组件。注册库 v4 原地规范旧批次的 activate 类型与 ownedUsageIds，仍保留安装、文件任务和使用历史。卸载意图固定目标应用全部未 removed 的版本，各自登记 remove 操作；prepare 不改指针或运行目标。全部相关角色的 Products 控制、Activity guard 和所有页面 canClose 通过后，实际 dispose 退出，才保存 client/execution 的关闭目标、原子清 selected/pending，并交接到排除目标应用的新目录。纯界面应用不产生后台目标；最后一个 execution 应用移除后不启动空 execution 进程。

新角色 ready 与卸载完成分开：先证明旧角色、父 reservation、历史失败尝试及所有本机登记使用者实际退出，再进入 reclaiming。文件适配器只在 `withReclamation` 排他保护下回收固定身份容器，保留业务 SQLite、Models JSON、Vault、图片、项目、worker 及远端服务归属。每个版本实际删除并同步目录后才登记 removed；所有目标成功后 `completeRemoval` 才使批次 completed。审计历史与 usage-locks 不随代码删除；部分成功保留已 removed 事实，失败项和原批次待显式恢复。重装以新请求登记原身份，沿用应用兼容数据并保持关闭。

注册库通过 Effect 固定最初的真实根目录、O_NOFOLLOW/O_DIRECTORY 句柄与 dev/ino，并在受控文件回调前传递私有根身份锚。适配器核对捕获的根与该锚，逐层持有并复核目录身份，内部符号链接及硬链接仅 unlink 本目录项，不跟随外部目标。根、祖先或容器替换均拒绝，不以 fresh realpath 重新授权删除根；并发 interrupt 先检查全部回收目标，不得改写尚在删除的操作。启动失败、正常关闭和在途回收等待均验证句柄实际释放；回收资源未退出前不释放根锚。Windows 当前保留宿主、账本和纯界面安装，不能取得该安全目录句柄时只拒绝破坏性回收，不声称已完成 Windows 卸载验收。

HTTP 及“我的应用”通过同一 /activations 卸载流程工作，默认保留数据；未完成回收、独立使用或未知退出均明确尚未卸载。所有页面在原 remove 批次 completed 后才移除目标标签和路由，保留其他应用位置；重启核对旧卸载还要求当前事实仍全部 removed，避免误清后来重新安装的工作区。在线 `anybox-host uninstall <appId> --endpoint <显式回环origin> --request-id <id>` 不另开注册库写入者；同 requestId 重跑只观察原批次，不重新准备或提交。恢复仍使用 `activation <id> --action resume`，查询、丢失回执和 CLI 中断不重放删除。

新增及扩展行为入口包括 `package-removal-ledger`、`package-reclamation`、`package-removal-managed`、`package-lifecycle-coordination`、`package-activation-command`、页面/管理界面与 HTTP 测试。覆盖运行中卸载、同应用多版本、隔离包、待生效包、被省略的旧 execution 退出证明、独立 worker 占用阻塞、部分回收及损坏目录恢复、根重定向、回收并发、同身份重装默认关闭、回收失败后其他应用在 client/execution 的开启目标保留、全页面草稿与工作区清理。宿主始终只处理通用生命周期，不查询或迁移业务，也不取消远端 Run。

最终 `npm run check` 通过：1867 项测试，1853 通过、14 跳过、0 失败、0 取消，耗时 164339.996416 ms（约 164 秒），相对 D1.4 新增 51 项。

最终构建的 macOS arm64 Electron 44.5.1 / Node 24.21.0 隐藏窗口实验使用独立 userData、实际 utility 角色和协议桥。纯界面 1.0.0→2.0.0 正常交接后，真实草稿使卸载返回 409，selected 2.0.0 和原界面保留；放行后等待 122 ms 的实际 dispose 退出，全部版本回收完成才安全 reload。目标标签清除、路由变为 `#/apps`，Products 为空，只保留 client 管理角色，无虚构后台或 execution 初始化。共四次页面加载，实验进程 exit 0，管理者和自有角色正常关闭。

仓库外 macOS arm64 Node 24.16.0 实验重新复制最终最小宿主的七个物理生产包，并复制 D1.4 隔离数据与两份原始完整签名应用包的安装目录，不借用工作区模块或运行 npm 安装。v3 的未完成批次原地迁入 v4，先保持管理目录为空，再由原 ID 的显式 resume 完成 client/execution 的精确加载；两个应用业务仍关闭。

实际在线 CLI 卸载 Anybox Harness 在 14,544 ms 内完成，全部 Harness 代码容器消失，Claude Agent 的完整代码和 client/execution ready 保留，特意放置的应用数据标记原字节保留。同 requestId 再运行卸载退出 0、查回原 completed 批次，没有再次准备或删除。随后卸载 Claude Agent，最后一个代码容器回收，Products 为空，只剩实际存活的 client 管理角色。关闭后注册库迁移为 v4，两个控制数据库的既有目标均为关闭，未新增 Models、Session、Run 或 Computer 业务表；所有自有角色确认退出。完整包仍为 D1.4 的 37,991,277 字节 Harness 与 36,028,341 字节 Claude Agent，验证的是实际完整载荷的卸载和保留边界，不是新正式签名发行。

`git diff --check` 通过。实现和命令见[生效与卸载组件](modules/package-management/activation.md#d15-本机卸载与代码回收)。当前验收不扩大为 Windows/Linux 成品、真实系统凭据或业务数据迁移；D2 在线下载和 D3 旧默认完整发行迁入继续单列。未重启用户原有客户端或独立 worker，未修改 NyaCore。

## Anybox Harness 0.1.2 Windows Computer（2026-10-19）

将 `feat/composable-units-u0` 的 `a2150b2` 原生 Computer 部分迁入 `packages/app-harness`：Windows Job Object、PowerShell/Git Bash、工具与搜索进程清理、worker 私有目录及目录身份检查，沿用当前 U1 授权、包角色回调、启动锁与真实退出等待。`src/core/platform/` 是现有组件的应用私有适配，不新增 Nya 组件，不依赖 Claude Agent 或宿主新业务。

本次不迁入旧提交的系统服务安装器、全量随包运行时或桌面目录选择功能；宿主包管理的 Windows prepare/independent-role 限制保留。旧分支的 1402 项测试及成品记录仅作历史证据。

Windows x64 的严格类型、全部包构建与资源校验通过，Harness 包 79 项全过，平台工具专项 92 通过/2 个 macOS 跳过，worker 启动与路由复测 12 项全过，应用边界及原生打包资源 6 项全过。已修复普通文件目录身份检查与未发布 worker 提前解除进程引用的回归；管理 API 已确认本机 `win32/x64` worker 正常运行。根 `npm run check` 的 2086 项测试为 1883 通过、143 失败、7 取消、53 跳过，未修改模块仍有 Windows 兼容失败，整体未通过；详细范围与日志见[原生平台支持](native-platform-support.md)。未修改 NyaCore、Claude Agent 或宿主业务实现，未运行真实模型/凭据门控或桌面成品验收。
