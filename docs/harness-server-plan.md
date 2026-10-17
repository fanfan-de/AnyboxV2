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

当前恢复限于已保存模型响应的工具等待、消费、清理及结算；model-pending 仍 interrupted，不重发模型，但排空已有 worker scope。显式 Nya 卸载/依赖撤销继续取消并排空 Run，idle worker 作为设备服务独立运行。真实 worker 继承 Unix guard，本次仅 Linux 实测，Windows 真实 worker 尚未支持；systemd/macOS 实际部署、阶段 3 的跨机器托管工作区及阶段 4 模型 exchange 不在此次验收内。

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

回归使用真实 SQLite、HTTP、worker、文件句柄与受控退出门闩，覆盖禁止工具零副作用、丢回执后只消费一次成功事实、无回执恢复及未发送取消窗口、查询/管理调用关闭等待、目录上限及界面换代。跨机器单次只读查询取消仍只结束 Authority 观察，不宣称远端文件资源已经退出；worker 独立持有并清理这些查询，本次没有新增跨机器取消确认协议。当前真实 worker 支持范围仍为 Unix，Windows 与其他平台发行保持原阶段边界。

macOS / Node.js 24.16.0 上以 `TMPDIR=/private/tmp caffeinate -i npm run check` 完成类型检查、构建、浏览器资源校验和全量测试：1432 项中 1418 项通过、14 项按既有门控跳过，零失败、零取消；相较初始 U1 试合净增加 32 项测试。各组定向回归也全部通过，修复前构建已验证对应缺陷会触发断言。worker 测试临时目录统一正规化，避免 macOS `/var` 别名影响原有读图用例。未修改 NyaCore，未调用真实模型或系统 Vault，未重新进行跨机器 HTTPS 验收。

### 桌面角色整合修复（2026-10-17）

本次将独立桌面角色与 Computer 管理整合到已包含 U1 修复的 main，保留双方文档与 Claude Agent 正式应用注册；后续原生 worker、随包运行时和平台服务管理的发行实现不在本次范围。

修复四项问题：权限修改的工具清理失败后，该附着在同一 boot 内持续拒绝新工作，并保留实际 scope 句柄供取消、关闭、权限重试和根关闭继续等待退出；同一个观察者的只读连接不再占用显式启动流程；多个进程对同一目录的启动通过独立 SQLite 启动事务协调，在锁内复核已运行实例，启动超时先终止并等待自己尚未交接的子进程退出；Claude Agent 每次激活重新读取共享设备连接，保持未改变的设备、线程观察与草稿，连接换代则取消旧代请求，迟到的发现结果不能启动隐藏页面的 Agent 或覆盖新界面。

回归使用真实 worker、独立 CLI 进程、SQLite、工具子进程以及可控请求与退出门闩；覆盖权限失败后的准入、控制重试、新 boot 恢复，启动竞争、锁拥有者强杀、观察关闭与失败启动，以及新本机配对、设备换代、草稿/Run 观察保留和页面关闭等待。

macOS / Node.js 24.16.0 上以 `TMPDIR=/private/tmp caffeinate -i npm run check` 完成类型检查、构建、浏览器资源校验与全量测试：1465 项中 1451 项通过、14 项按既有门控跳过，零失败、零取消，用时约 150 秒；相较桌面角色试合新增的 16 项回归全部通过，修复前构建已确认原缺陷触发断言。真实 Electron utility process 的有限复验覆盖纯客户端不启动本机服务、客户端只创建自身数据库、两个正式应用登记及执行端独立启动/关闭，详见[角色边界](runtime-roles-and-distribution.md)。未修改 NyaCore，未调用真实模型或读写系统 Vault，未做完整桌面 smoke、成品安装及新的跨机器验收；平台发行与 Windows 真实 worker 仍属后续范围。
