# harness server 重建计划

状态：2026-10-10。本分支直接使用相邻 NyaCore，已完成原生协议执行迁移以及 H0 资源边界、H1 闭环、持久会话树、Prompt 管理、Bash/Apply Patch 工具循环、通用 Models 和本机 Web 接入；当前已接入 Computer 本机资源及独立 worker、工具等待重启接续。下方日期验收记录描述各次交付，当前行为以本节与[组件说明](./harness-server-components.md)为准。

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
