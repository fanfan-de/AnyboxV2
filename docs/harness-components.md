# Harness 组件说明

状态：2026-09-26，对应当前代码。本文是项目现有 Nya 组件的职责清单，覆盖 Harness、本机 Web 宿主、可替换的凭据与模型实现，并单独说明仅用于验证的 H0 探针。逐个说明组件负责什么、提供哪个服务、依赖谁、持有哪些状态与资源、关闭时如何清理；组合根、Agent 定义和浏览器模块另行说明，不计为 Nya 组件。

先看下方职责总览；理解 Run 的执行与记录如何分工，可直接看[一次 Run 的执行与记录由谁维护](#一次-run-的执行与记录由谁维护)。阶段计划见 [Agent Harness 重建计划](./agent-harness-plan.md)，建模方法见 [用函数式思想建模 Agent Harness 的开发](./functional-agent-harness-development.md)，Prompt 与存储的专题设计见 [Prompt 管理模块设计](./prompt-management-design.md) 和 [本地 SQLite 存储组件](./local-sqlite-storage.md)。

## 总览

### 放置规则

当前只使用一个应用根 Context。应用先安装凭据组件、大模型 API 组件和本地 SQLite，`createHarness` 校验只读 Agent 定义，再把 Projects、Bash、Apply Patch、Prompt、状态、Session、Run、AgentLoop 等组件直接安装在同一个根上。本机 Web 宿主使用一个自包含的 API Key 服务组件，再在同一根上安装 Web 前端组件。组件按职责和依赖拆分，不为 Harness、项目或任务建立额外的 Nya 作用域。Nya 服务按名称注册在根上；同一个根只安装一套 Harness 服务，也只安装一种凭据组件和一种大模型 API 组件。

应用拥有根上组件的生命周期。`harness.close()` 是当前的应用关闭入口：先停止接受外部调用，再卸载根上的全部组件，等待清理。大模型 API 组件的在途请求和数据库连接也会关闭；该 Harness 门面关闭后不可复用。重启应用时需重新装配组件，通常新建根。

### 组件与依赖

```text
应用根 Context
├─ API Key 服务 ..... 提供 credentials.read、credentials.settings；无注入依赖
│  （或系统凭据库 ..... 提供 credentials.read、credentials.manage）
│  （或外部凭据来源 .. 只提供 credentials.read）
├─ DeepSeek Chat Completions 或 OpenAI Responses
│  └─ 提供 llm；注入 credentials.read（只安装其中一种）
├─ 本地 SQLite ....... 提供 local-storage
├─ 目录选择器 ......... 提供 host.directory-picker；无注入依赖
├─ Projects ......... 提供 harness.projects      注入 local-storage
├─ Bash ............. 提供 tools.bash            注入 projects
├─ Apply Patch ...... 提供 tools.apply-patch     注入 projects
├─ SQLite 状态 ...... 提供 harness.state         注入 local-storage、projects
├─ Session .......... 提供 harness.sessions       注入 projects、state；接收 Agent 定义
├─ Prompt ........... 提供 harness.prompts        注入 local-storage
├─ Agent Prompt ..... 提供 harness.agent-prompts  注入 prompts、local-storage；接收 Agent 定义
├─ AgentLoop ........ 提供 harness.agent-loop     注入 state、llm、tools.bash、tools.apply-patch
├─ Run .............. 提供 harness.runs           注入 projects、state、agent-prompts、llm、agent-loop；接收 Agent 定义
└─ Web 前端 ......... 提供 web.frontend            注入 projects、sessions、runs、prompts、agent-prompts、credentials.settings、host.directory-picker；接收 Agent ID 列表
```

以上为服务依赖清单，不是额外的 Context 层级。`createHarness` 安装业务组件；本机宿主在它之前选择凭据、模型和 SQLite 实现，在它之后安装目录选择器与 Web。关闭时由 Nya 按依赖关系先清理消费者，再清理其资源提供者。

### 职责与状态归属总览

下表中的运行时组件都安装在应用根；三种凭据实现互斥，两种模型实现互斥。源码入口链接指向实际提供服务的组件，内部辅助模块由对应组件拥有。

| 组件 | 主要作用 | 持有的状态或资源 | 源码入口 |
| --- | --- | --- | --- |
| API Key 服务 | 向本机 Web 提供已注册凭据的读取与管理 | 注册清单、系统凭据库存储、按 ID 排序的在途操作 | [settings.ts](../src/credentials/settings.ts)；通用实现位于 `packages/api-key-manager/` |
| 系统凭据库 | 向受信宿主提供系统凭据读写能力 | 系统存储访问、同 ID 操作顺序、取消与退出跟踪 | [system-keyring.ts](../src/credentials/system-keyring.ts) |
| 外部凭据来源 | 将部署方的读取函数接入凭据服务 | 在途读取及中止控制；不缓存密钥、不自行持久化 | [external-source.ts](../src/credentials/external-source.ts) |
| DeepSeek Chat Completions | 执行一次原生模型请求，返回文本或工具请求 | 模型配置、计划映射、每计划的密钥读取结果、HTTP 调用与超时 | [component.ts](../src/llm/deepseek-chat-completions/component.ts) |
| OpenAI Responses | 执行一次 Responses 请求，返回文本或工具请求 | 模型配置、每计划的密钥读取结果与原生续轮上下文、HTTP 调用与超时 | [component.ts](../src/llm/openai-responses/component.ts) |
| Bash 工具 | 在指定项目目录执行一次命令 | 子进程、输出缓冲、超时与终止计时器、在途调用 | [bash-component.ts](../src/tool/bash-component.ts) |
| Apply Patch 工具 | 预检并应用一次文本文件补丁 | 跨项目串行队列、源文件快照、临时文件与目录、提交事实、在途调用 | [apply-patch-component.ts](../src/tool/apply-patch-component.ts) |
| 本地 SQLite | 提供通用读写事务与按领域迁移 | 数据库连接、文件排他锁、串行操作队列 | [sqlite.ts](../src/storage/sqlite.ts) |
| Projects | 登记项目目录身份、检查目录可用性 | 项目持久记录、在途目录检查与存储操作 | [component.ts](../src/project/component.ts) |
| SQLite 状态 | 保存并约束 Session、对话节点和 Run 的业务记录 | 持久状态、执行阶段与事件；内存中的活动 Run 计划和在途存储操作 | [sqlite-state.ts](../src/run/sqlite-state.ts) |
| Session | 创建会话、查询会话及对话树 | 只读 Agent 配置与本轮服务依赖；会话数据交给状态组件 | [session-component.ts](../src/run/session-component.ts) |
| Prompt | 管理 Prompt 草稿和不可变发布版本 | 文档与版本表、已提交读投影、写入队列 | [component.ts](../src/prompt/component.ts) |
| Agent Prompt | 管理 Agent 的版本绑定，解析 Run 所需的 Prompt 快照 | 绑定表与读投影、写入队列、默认指令映射 | [prompt-binding-component.ts](../src/agent/prompt-binding-component.ts) |
| AgentLoop | 驱动已接受 Run 的模型与工具循环，取消并等待调用退出 | 活动 Run 登记、每 Run 执行闭包、调用句柄、等待者与清理错误 | [agent-loop-component.ts](../src/run/agent-loop-component.ts) |
| Run | 准入、幂等协调、固定配置，以及对外查询和控制 | 准入与交接任务、已接收 Run ID；业务记录交给状态组件 | [component.ts](../src/run/component.ts) |
| 目录选择器 | 打开一次原生目录选择窗口 | 单个在途对话框调用、子进程、中止与退出跟踪 | [directory-picker.ts](../src/web/directory-picker.ts) |
| Web 前端 | 将本机 HTTP 请求接到业务服务，提供浏览器客户端 | HTTP 监听器、请求等待与取消跟踪、重启时沿用的端口 | [component.ts](../src/web/component.ts)、[server.ts](../src/web/server.ts) |

`src/harness.ts` 是装配与转发函数，`src/agent/domain.ts` 中的 Agent 定义是只读配置；它们都不提供独立 Nya 服务。浏览器中的工作区和会话控制器也不是服务端 Nya 组件。H0 探针仅用于资源归属验证，见文末。

### 所有组件共用的约定

- **组件形态**：每个组件是一个带 `name` 和 `apply(ctx, config, deps)` 的对象，有服务依赖时通过 `inject` 声明。`apply` 完成初始化并用 `ctx.provide` 提供服务后返回，不让长期任务阻塞启动。`deps` 是本轮依赖的快照，组件只通过它使用注入服务。
- **撤销顺序**：Nya 卸载一个组件时，先撤回它提供的服务，并等所有依赖该服务的组件退出，再按后进先出执行它登记的 Effect 清理。所以任何组件被撤销时，下游消费者总是先停下。
- **停止接收与等待退出**：持有在途操作的组件通过接收标志或关闭状态拒绝新请求。模型、工具和执行循环还会取消已接受的工作并等待实际退出；存储及写入队列则等待已接受的操作完成。Session 没有自有长期资源或清理 Effect，数据操作由其依赖组件持有。
- **`OwnedCall`**（`src/contracts.ts`）：可取消的调用分成 `result`（业务结果）、`cancel(reason)` 和 `done`（实际工作与资源都已退出）。`result` 已结算不代表资源已释放，只有 `done` 才代表。
- **`llm` 服务契约**（`src/llm/port.ts`）：Run 和 AgentLoop 只依赖 `prepare(profileId)`、`call({ plan, messages, tools? })`、`supportsTools`，以及项目自有的工具定义、请求、观察消息、结构化模型结果和失败类别。提供该服务的 API 组件把原生请求、响应类型和凭据留在自己内部。DeepSeek 与 OpenAI Responses 均声明 `supportsTools: true`。
- **凭据契约**（`src/credentials/port.ts`）：`credentials.read` 提供 `read(id, signal?)`，缺失返回 `undefined`；`credentials.manage` 有 `write(id, secret)` 和 `delete(id)`。两者分开注册是给受信宿主的命名约定，不是访问边界：Nya 服务按名称寻址，根上任何组件都能注入。失败是带固定类别的 `CredentialFailure`：`store-unavailable`、`operation-failed`、`closed`、`cancelled`，不携带系统信息、条目名或密钥。
- **纯函数与副作用分离**：领域模块放校验和状态转换的纯函数，返回冻结的新值；时间和 ID 通过 `RuntimeInputs`（`now`、`newId`）从外部传入。Nya 装配、存储、模型传输和工具执行分别集中在对应组件及其内部实现中。
- **错误不泄露细节**：提供方的原始错误在边界处归一为固定类别和固定文案，不把第三方错误或传输细节带进 Run。

## 应用根中的资源组件

### 系统凭据库

**服务** `credentials.read`、`credentials.manage` · **注入** 无 · **创建** `createSystemKeyringComponent({ namespace, openEntry? })`

系统凭据库把应用的密钥交给操作系统的凭据库保存，并独占对它的每次访问。它固定依赖 `@napi-rs/keyring@2.1.0` 的异步 API：macOS 接入 Keychain，Windows 接入 Credential Manager，Linux 明确指定 Secret Service（gnome-keyring、KWallet 等）。库在 Linux 默认会在没有 Secret Service 时静默改用内核 keyring，而那份存储重启即失，所以组件用 `{ linux: { store: 'secret-service' } }` 禁止回退。

**职责与持有状态。** Nya 适配层拥有通用包创建的存储实例及其关闭时机；存储实例跟踪按凭据 ID 排序的操作、中止控制与退出等待。它不接收 Run ID、执行闭包或模型消息。凭据 ID 的管理范围由受信宿主决定；需要注册清单和 Web 管理接口时，选择下文的 API Key 服务组件。

**条目。** `namespace` 是条目的 service 名，凭据标识是条目的账户名：DeepSeek 使用 `llm/deepseek-chat-completions/default`，OpenAI Responses 使用 `llm/openai-responses/default`。不同安装、开发库与正式库、测试与正式必须用不同命名空间，否则共用同名条目。`openEntry` 只供测试替换条目来源，默认打开平台凭据库。

**启动。** `apply` 先打开一个探测条目：打开条目不读写内容，但在没有 Secret Service 的 Linux 上会失败，于是组件在安装时就以 `store-unavailable` 失败，而不是等 DeepSeek 首次读取。macOS 和 Windows 的真实访问发生在读取时。

**服务接口。**

- `read(id, signal?)`：读取密钥，缺失返回 `undefined`；取消会等待底层读取退出。
- `write(id, secret)`：写入或替换；密钥必须是非空字符串，不做修剪，也不出现在任何错误信息中。
- `delete(id)`：删除；只在条目不存在时返回 `false`，凭据库拒绝删除时抛出。

标识和密钥的校验错误是 `TypeError`；打开条目失败是 `store-unavailable`；凭据库的读写拒绝（锁定、无权限、条目歧义等）一律归一为 `operation-failed`，原生错误不挂在 `cause` 上。

**清理。** 卸载时停止接收（新操作以 `closed` 拒绝），对已接受的操作发出中止信号，然后等它们全部退出。原生调用一旦开始就无法打断，中止只对尚未开始的任务生效；被中止后才退出的操作以 `cancelled` 拒绝，即使底层库在中止后返回了值。同一个凭据 ID 的读取、写入、删除按接收顺序串行执行；写入完成后的新读取取得新值。

**安全边界。** 凭据库只保护静态存储。密钥经 `read` 进入进程内存后由模型组件持有；两种模型组件均在同一 Run 的多个模型轮次复用，JavaScript 无法擦除字符串。macOS 的 Keychain 条目访问权绑定创建它的可执行文件；换用其他路径的 Node 二进制读取时系统可能弹出授权提示，无人值守时表现为读取阻塞或失败。

### 外部凭据来源

**服务** `credentials.read` · **注入** 无 · **创建** `createExternalCredentialSourceComponent({ read })`

给没有桌面凭据库的 Linux 部署使用：密钥的持久化由部署方负责，本组件只把受信宿主的异步读取函数 `read(id, signal)` 接成 `credentials.read`。它不落盘、不缓存、不注册 `credentials.manage`。读取函数返回 `undefined` 或 `null` 表示缺失，返回非字符串是 `TypeError`，抛错一律归一为 `store-unavailable`，调用中的 LLM 将其转为 `credential-unavailable`，不会退回到 SQLite 或明文文件。

**持有状态。** 内部操作跟踪器维护接收标志，以及每次读取的 `AbortController` 与退出 Promise。它管理读取操作的生命周期；密钥来源、更新方式和持久存储由宿主提供。

清理与系统凭据库相同：拒绝新读取，向在途读取的 `signal` 发出中止，等读取函数退出。行为测试用它加一个内存映射充当假凭据组件（`tests/helpers/memory-credentials.mjs`）。

### DeepSeek Chat Completions

**服务** `llm` · **注入** `credentials.read` · **创建** `createDeepSeekChatCompletionsComponent(config, transport?)`

这是本机 Web 宿主默认安装的大模型 API 组件。组件按 API 格式划分，而不是按供应商再抽象一层：它直接拥有 DeepSeek 非流式 Chat Completions 的原生请求格式、HTTP 传输、密钥、响应解析、超时、取消和清理。OpenAI Responses 是另一个提供同一 `llm` 服务的组件；应用启动时只安装其中一个。

**持有状态与边界。** 组件级维护计划到配置的 `plans` 映射、计划到密钥读取 Promise 的 `runKeys` 映射、在途调用集合及清理错误。每次 `call` 创建自己的请求闭包，保存中止控制器、计时器与传输状态。它返回工具请求，由 AgentLoop 决定和执行后续步骤；它不持有完整 Run 执行闭包，也不写 Run 终态。

**配置。** 构造组件时 `validateDeepSeekConfiguration` 校验配置：`version` 非空；`profiles` 非空，每个 profile 只允许 `id`、`model`、`maxOutputTokens`、`temperature`、`timeoutMs` 这几个字段，ID 唯一；`maxOutputTokens` 可选，提供时须为正整数，省略时使用模型 API 默认输出长度；`temperature` 在 0 到 2 之间，`timeoutMs` 为不超过 2147483647 的正整数。校验结果是冻结的选择项，附带配置版本号。配置或传输选项无效时构造直接抛出 `TypeError`。

本机 Web 宿主默认使用 `deepseek-flash`，默认不设置 `maxOutputTokens`，不附加 1024 token 输出上限；可通过启动环境变量覆盖模型和输出长度，模型服务端的输出与上下文限制仍然适用。组件不硬编码模型名。

**传输。** 可选的 `transport` 提供 `baseUrl`（必须是 HTTP 或 HTTPS，默认 `https://api.deepseek.com`）和 `fetch`。

**凭据与轮换。** 组件注入 `credentials.read`，`apply` 只初始化配置与服务，缺少 Key 时也提供 `llm`。每个 Run 的调用计划首次传入 `call` 时，`OwnedCall` 异步读取一次 `deepSeekCredentialId`（`llm/deepseek-chat-completions/default`）；同一计划的后续模型轮次复用首次取得的 Key。缺失或空值为 `credential-missing`；读取失败为 `credential-unavailable`。Key 只留在组件私有内存，不进入计划的公开字段、Run 状态、快照或错误。Web 保存或删除后，新 Run 读取新状态，已取到 Key 的 Run 继续使用该值，无须重启。

**服务接口**（`LLMPort`）：

- `prepare(profileId)`：Run 准入时调用，返回冻结的调用计划。计划对外只包含 `profileId` 和 `configVersion`；对应的 profile 保存在组件私有的映射中，只对当前这一轮组件实例有效。未知 profile 抛出 `model-unavailable`，组件正在关闭时抛出 `dependency-unavailable`。
- `call({ plan, messages, tools? })`：把项目自有的消息和工具定义映射为原生请求体（`model`、`messages`、`tools`、`temperature`、`stream: false`；仅显式配置输出上限时带 `max_tokens`），带 Bearer 密钥 POST 到 `/chat/completions`，返回 `OwnedCall<ModelReply>`。来自其他组件实例的计划抛出 `model-unavailable`。

**调用语义。**

- **同步拒绝**：消息为空，或含有 `developer` 角色时，`call` 同步抛出 `unsupported-request`，不发起请求。Chat Completions 未记录 `developer` 角色，组件不会擅自改变其优先级。
- **超时**：超过 profile 的 `timeoutMs` 后中止请求，`result` 立即以 `timeout` 失败；`done` 仍要等传输真正退出才结算。
- **传输与 HTTP 失败**：`fetch` 抛错归一为 `provider-failure`；非 2xx 响应会先取消响应体，再以 `provider-failure` 失败，响应内容不进入错误信息。
- **响应校验**：`finish_reason: stop` 须含最终文本；仅在提供工具定义时接受 `finish_reason: tool_calls`，解析函数 ID、名称和 JSON 参数并形成项目自有请求。畸形原生响应以 `invalid-response` 失败；参数 JSON 无效留给 AgentLoop 的整批校验，确保整批零执行。工具轮次显式设置 `thinking: { type: 'disabled' }`，异常返回的非空 `reasoning_content` 以 `invalid-response` 拒绝。
- **取消**：`cancel(reason)` 通过 `AbortController` 中止请求，原因作为 `signal.reason` 传给传输。`result` 立即以 `provider-failure` 失败（由超时引起的则是 `timeout`）；`done` 在凭据读取、fetch 与响应体读取都退出后完成。
- **清理失败**：取消非 2xx 响应体失败时，`done` 以 `cleanup-failure` 失败，并在组件卸载时一并报告。

失败类别包括：`model-unavailable`、`dependency-unavailable`、`unsupported-request`、`timeout`、`provider-failure`、`invalid-response`、`cleanup-failure`、`credential-missing`、`credential-unavailable`。每种类别都有固定文案，不带提供方的原始信息。

**清理。** 卸载时停止接收，以 `llm-disposed` 中止所有在途请求并等待各自的 `done`，收集到的清理失败统一抛出。

**替换与重启。** 应用卸载旧组件并安装新组件，或对组件调用 `restart()` 时，Nya 先停下 Run 和 AgentLoop，这期间的在途 Run 以 `dependency-unavailable` 失败；旧的一轮等请求退出后卸载，新的一轮一提供 `llm` 服务，Run 和 AgentLoop 就自动重启。同一幂等键仍返回原 Run，新键使用新配置；密钥轮换无需重启。

**凭据组件被撤销。** `credentials.read` 消失时本组件和依赖它的 Run 服务停在 `PENDING`；在途调用被取消，并等待凭据读取或 HTTP 资源实际退出。新凭据组件提供服务后，Nya 自动重新启动消费者。

**尚未支持**：流式输出、thinking 模式下的工具调用、`developer` 角色、`usage` 统计、`top_p` 等其他采样参数、重试与限流处理。2026-09-26 已用真实 DeepSeek 在临时项目完成贪吃蛇生成冒烟验证，长命令写文件和多轮工具调用均完成；默认行为测试仍使用本地 HTTP 服务或可控的 `fetch`。

### OpenAI Responses

**服务** `llm` · **注入** `credentials.read` · **创建** `createOpenAIResponsesComponent(config, transport?)`

它与 DeepSeek Chat Completions 是互斥的 API 格式实现，Run 和 AgentLoop 不区分两者。配置包含版本和非空 profile 列表；profile 必须有 `id`、`model`、`timeoutMs`，可选 `maxOutputTokens` 和 `temperature`，省略时不发送对应参数。组件构造时校验配置及 `transport.baseUrl`、`transport.fetch`，默认端点为 `https://api.openai.com/v1/responses`。也可配置标准 Responses 兼容服务的 API 基础地址；实际模型名称由宿主选择。

**职责与持有状态。** 它负责单次模型请求的协议转换与资源退出，持有配置、计划私有状态、在途调用集合、清理错误及每次调用的请求闭包。每个计划私有保存一次密钥读取的结果及工具续轮检查点；后者包含完整原生 input/output 与预期通用消息前缀，保留 reasoning、消息 phase 和函数调用。原生上下文不扩展 `LLMPort`，也不进入 Run、事件、Prompt 或 SQLite。Run 的循环、工具执行和结算仍归 AgentLoop。

**凭据与生命周期。** 组件启动时提供 `llm`；同一 Run 首次调用内从 `credentials.read` 读取 `openAIResponsesCredentialId`（`llm/openai-responses/default`）一次。缺失、空值或读取失败使该 Run 以固定类别失败，密钥只留在组件内。受信宿主写入或轮换后，后续新 Run 读取新值，已取得密钥的 Run 继续复用。同一计划在上一次 `done` 完成前拒绝重叠调用；`prepare` 仅公开 profile ID 和配置版本。撤销、重启、关闭会停止接收，取消在途调用并等待 `done` 实际退出。

**原生请求与响应。** `call` 将项目自有的四种文本消息角色和函数定义映射到 Responses 原生协议，非流式 POST 到基础地址下的 `/responses`，设置 `store: false`，提供工具时请求 `reasoning.encrypted_content`，不使用服务端会话或 `previous_response_id`。响应必须是 `status: completed`；`function_call` 使用 `call_id` 关联工具请求与 `function_call_output`，由 AgentLoop 校验并执行。最终助手文本接受 `final_answer`、未设置或 `null` 的 phase；`commentary` 只参与原生上下文续传，不作为最终回答。未完成、拒绝、未提供工具时的函数调用及畸形响应统一为 `invalid-response`；工具参数 JSON 无效交给 AgentLoop 整批校验，确保整批零执行。HTTP 与传输失败为 `provider-failure`。超时会立即结算 `result`，但 `done` 等 HTTP 传输退出；取消、清理失败与 DeepSeek 组件使用同一项目自有错误类别。

**续轮与失败。** 下一次调用必须保留检查点中的通用消息前缀，并依原批次顺序追加全部工具观察；组件校验后只将这些结果追加到私有原生上下文。只有成功解析、未取消且清理完成后才推进检查点，检查点提交与计划解锁位于同一最终 `done` 阶段；失败、取消或清理失败均不推进，`done` 之后可显式重试同一模型输入，AgentLoop 不自动重试。最终文本释放续轮上下文；不同计划、Run 和组件实例之间互相隔离。新 Run 的历史仍仅由成功对话节点的文本构成，不恢复上个 Run 的私有 reasoning。

**限制与验证。** 当前不支持流式输出、多模态、内置托管工具或服务端会话。需要特定模型支持的采样参数由宿主选择；省略可选的 `temperature` 可避免向不支持它的模型发送该字段。真实 OpenAI API 尚未联网验收，本地验证使用模拟 HTTP 和可控传输，覆盖原生工具闭环、reasoning/phase 回传、计划隔离、凭据复用与失败、取消、超时和清理等待。本机 Web 可在启动时选择本组件，仍只安装一种模型实现。

### Bash 工具

**服务** `tools.bash` · **注入** `harness.projects` · **创建** `createBashComponent(options?)`，源码在 `src/tool/bash-component.ts`。`createHarness` 将它安装在应用根，AgentLoop 注入此服务；DeepSeek 与 Responses 均可原生请求 Bash，Web 可展示执行过程。

**职责与持有状态。** 组件负责一次命令及其进程资源，维护在途调用集合和清理错误；每次调用的闭包持有子进程、输出缓冲、计时器、中断原因与退出标志。它只接收项目 ID 和命令，不接收 Run 执行闭包；工具批次的先后顺序、消息回填和 Run 结算由 AgentLoop 协调。

`execute({ projectId, command })` 根据 Projects 的项目 ID 取得目录，以它为工作目录运行一次 `/bin/bash -c`，返回 `OwnedCall<BashResult>`。`BashResult` 包含退出码、信号、stdout、stderr 和截断标记；非零退出码是命令结果。命令须为非空字符串且不含 NUL，应用不另设命令字节数上限，长 heredoc 可用于完整写入文件；底层仍受操作系统进程参数大小限制。默认超时 120 秒，stdout 与 stderr 合计最多保留 65536 字节。子进程只接收 PATH、HOME、TMPDIR、LANG；工作目录并不限制 Bash 对其他路径或网络的访问。

取消或超时会先结算 `result`，向独立进程组发送 TERM，默认 5 秒后仍未退出则发送 KILL；`done` 等进程及输出管道实际关闭。组件卸载会停止接收新命令，取消并等待已接受的调用。提供方错误归一为固定 `BashFailure` 类别。Windows 当前不安装该组件。

### Apply Patch 工具

**服务** `tools.apply-patch` · **注入** `harness.projects` · **创建** `createApplyPatchComponent(options?)`，源码在 `src/tool/apply-patch-component.ts`。组合根直接安装在应用根，AgentLoop 直接注入此服务，向支持工具的模型提供 `apply_patch` 定义。`execute({ projectId, patch })` 返回 `OwnedCall<ApplyPatchResult>`；组件不接收 Run 闭包、不写 Run 终态。

**职责与状态。** 组件独占一个跨项目串行队列、接收标志、活动调用集合和清理错误；每个已接受调用持有补丁操作、源文件字节与文件身份快照、临时文件与目录、已完成变更和当前提交位置。队列等前一调用的 `done` 后才开始下一调用，覆盖预检、提交和清理。它只协调该组件的补丁调用，不限制 Bash、其他进程或编辑器写同一目录。文件系统操作可通过 `options.filesystem` 替换，用于确定性故障与取消测试。

**纯函数和类型边界。** `apply-patch-domain.ts` 提供 `parsePatch`、`validatePatchText` 和 `applyPatchText`；`apply-patch-types.ts` 定义操作、文本块、变更与诊断。解析器只接受 `*** Begin Patch` / `*** End Patch` 包裹的 Add、Delete、Update，以及 Update 后的 Move；支持纯移动、多块 `@@`、精确整行锚点与 `*** End of File`。Add 内容行以 `+` 开头，生成 LF 文本，空 Add 创建空文件；Update 使用空格、`-`、`+` 行，首块可省略 `@@`。不接受 heredoc、标准 unified diff、环境指令或空操作集。

所有文本须是合法 UTF-8，拒绝 NUL、裸 CR 和混合 LF/CRLF；Update 保留 BOM、原换行类型和末尾换行状态，原空文件新增内容使用 LF。文本块始终匹配原始文件，精确、唯一、顺序且不重叠；锚点从前一块结束后定位，EOF 限定文件结尾。纯插入必须能由空文件、唯一锚点或 EOF 明确定位，不进行模糊匹配。

**文件与路径。** 相对路径基于 Projects 返回的项目目录，绝对路径及 `..` 仍按应用用户权限访问；项目不构成文件系统沙箱。父目录可以通过符号链接解析为规范路径；目标本身的符号链接、多个硬链接、目录及其他非普通文件均拒绝。Add 和 Move 目标必须不存在；同一补丁不能重复触及同一路径、规范别名或父子目标，macOS 还保守合并 Unicode 规范形式与大小写等价拼写，Windows 保守合并大小写等价拼写；即使底层卷区分大小写，同批这些路径也拒绝重叠。不存在的父目录只在提交时创建，预检不创建文件或目录。

**预检与提交。** 先解析全补丁并读取所有源文件，验证文件身份、编码、匹配、目标和路径冲突，生成内存中的完整结果；第一项提交前再次检查整个计划。提交按补丁顺序逐文件进行，提交前复核源内容和文件身份。写入先在目标所在目录创建私有临时目录与文件，保留原文件普通权限位；Update 通过 rename 替换原文件，Add/Move 通过同文件系统 link 发布，避免覆盖并发出现的目标。Move 先发布目标，再复核并删除源文件，可能只完成目标创建。

这不是多文件事务：后续失败不会回滚先前变更。源复核也不是与 Bash 或外部写入者共享的锁，不能消除所有检查与写入之间的竞争；不承诺保存文件 inode、所有者、ACL 或扩展属性，也不提供崩溃后的回滚与重放。

**结果与失败。** `ApplyPatchResult.status` 为 `applied`、`rejected`、`partial` 或 `cancelled`；`changes` 是已经完成的 `added/updated/deleted` 文件事实，`pending` 是尚未完整结束的原操作，`diagnostic` 可带固定代码、文案、路径或行号。语法、上下文、路径、文件变化和预期文件系统失败作为工具观察返回，模型可检查事实后修正；尚无已完成变更的拒绝为 `rejected`，已存在变更则为 `partial`。Move 删除源失败时，结果保留目标已新增、原移动仍未完成，不声称已移动。提供方不可用等执行器故障与临时资源清理失败使用固定失败类别，不传出原生异常。

**取消与清理。** 取消登记标志，在排队、预检或下一个文件提交前停止；已经开始的单文件提交（包括 Move 的两步）等其实际退出，不强行中断文件系统 Promise。取消可能返回部分甚至全部已完成变更，不回滚它们。`result` 表示结果事实，`done` 还等待临时文件、临时目录与本次创建但仍为空的父目录清理；保留已经包含已提交文件或其他写入者内容的目录。清理失败使 `done` 拒绝，AgentLoop 以 `tool-cleanup-failure` 结算，并在失败事件中保留已经取得的补丁结果；关闭也报告清理失败。卸载停止接收、取消所有已接受调用并等待它们的 `done`。

**本地验证。** 域、文件组件、循环与 Web 测试使用临时目录、可控文件系统、受控模型和模拟 HTTP，覆盖精确文本变更、全量预检、部分提交、取消、清理和持久事实。新工具尚未进行真实模型联网验收。

### 本地 SQLite

**服务** `local-storage` · **注入** 无 · **创建** `createLocalSqliteComponent(file)`

本地 SQLite 是整个应用通用的本地持久化组件，排他持有一个数据库文件及其连接。它不知道任何领域的表结构。

**职责边界。** 它持有连接、文件锁、接收标志和串行队列，保证回调中的读写与事务正确执行。Session、Run、Prompt 等记录的含义和合法变化由各领域组件决定；例如 Run 是否可以完成由 SQLite 状态组件的领域规则判断，本组件只负责提交或回滚其事务。

**启动。** `apply` 依次完成：规范化路径并创建父目录；创建同路径的 `.lock` 目录以取得排他所有权（已存在时以 `occupied` 失败）；打开连接；初始化存储自身的表布局。布局用 `PRAGMA user_version` 标记，并建立 `schema_migrations(domain, version)` 表；遇到无法识别的已有数据库会以 `schema-version` 拒绝启动。启动中任何一步失败，已取得的连接和锁都会回滚释放。

**服务接口**（`LocalStoragePort`）：

- `read(work, signal?)`：在只读模式下执行回调，回调拿到 `StorageReader`，提供参数化的 `get` 和 `all`。
- `transaction(work, signal?)`：以 `BEGIN IMMEDIATE` 开启事务执行回调。回调额外拿到 `execute`；它抛错、被拒绝或 `signal` 在提交前中止，都会回滚。一个事务可以同时写多个领域的表。
- `migrate(domain, migrations)`：为一个领域补齐缺失的迁移。版本号在领域内从 1 连续编号；每个迁移和它的版本记录在同一事务中提交，失败则回滚并以 `migration-failed` 拒绝。迁移必须是同步函数。领域记录的版本高于传入的迁移列表时以 `schema-version` 拒绝，防止旧代码误读新表。

所有操作在同一连接上按接受顺序串行执行。回调结束后，交给它的读写句柄立即失效。错误统一为带 `code` 的 `LocalStorageError`，驱动的对象和错误不会越过这个组件。

**清理。** 卸载时停止接收新操作，等待队列中已接受的读、事务和迁移全部结束，然后关闭连接，最后删除锁目录。取消不会强行中断异步回调，回调须自己响应 `signal`。进程异常退出后留下的 `.lock` 需要在确认原进程已停止后手动删除。

## 组合根：createHarness

**源码** `src/harness.ts` · **形态** 将业务组件安装到现有根的受信函数

`createHarness(root, options)` 是受信的组合根。它只接受宿主的根 Context，要求根上已经有 `llm` 和 `local-storage` 服务。缺少密钥时 `llm` 仍启动，未配置就提交的 Run 以 `credential-missing` 失败。

**持有状态与边界。** 组合根保存已校验的 Agent 定义、时间与 ID 输入、门面关闭标志及幂等关闭 Promise。它不注册自己的 Nya 服务，也不保存每 Run 的执行闭包；组件依赖与资源清理顺序交给 Nya。

**选项**（`HarnessOptions`）：

- `agents`：Agent 定义列表，必填。
- `legacyPromptStorePath`：可选，首次启动时从旧 Prompt JSON 文件导入。
- `canManageAgent(actorId, agentId)`：可选，由宿主提供的 Agent 管理授权；默认允许所有已认证用户。
- `now`、`newId`：可选，替换时钟和 ID 生成器，测试中用来得到确定的结果。

**启动。** 它在根上按依赖顺序逐个安装组件并等待就绪。某个组件启动失败会直接抛出它的错误；如果它因缺少依赖停在 `PENDING`，会报出所缺的服务名，例如 `component harness-agent-loop is waiting for llm`。启动失败会卸载根上的全部组件，清理已安装组件以及大模型 API 组件和 SQLite，再抛出错误。

**对外接口**（`Harness`）把 Projects、Session、Run、Prompt 和 Agent Prompt 服务的公开方法合在一起，包括 `getRunEvents(id)`，另加只返回 Agent ID 的 `listAgents()` 和 `close()`。服务调用每次都用 `context.get()` 取当前实例，不缓存跨组件重启的服务引用；服务暂时不可用时直接报错。`requireAvailable`、`getPublishedVersion` 和 `resolveRunPrompts` 只供内部组件使用，不对外暴露。

**关闭。** `close()` 是幂等的：先设置关闭标志，之后所有调用立即报 `harness is closing`；然后卸载应用根上的全部组件。关闭会等待 Run 的实际退出、Prompt 写入、大模型 API 组件的请求退出和数据库连接的清理。该 Harness 门面不能再次使用；重启应用需重新安装所需组件。

## 应用根中的业务组件

### Agent 定义（只读配置）

`src/agent/domain.ts` 定义 `id`、默认 `instructions`（默认系统指令）和 `modelProfileId`。它是启动配置，不提供 Nya 服务，也不持久化。`createHarness` 调用 `validateAgents`，要求列表非空、ID 唯一、三个字段都是非空字符串，并把冻结副本传给 Session、Agent Prompt 和 Run。修改定义需重新装配 Harness，通常新建应用根。

`modelProfileId` 引用当前大模型 API 组件配置中的 profile，直到 Run 准入时才检查；profile 不存在时，新 Run 以 `model is unavailable` 被拒绝，不写入状态。

### Projects

**服务** `harness.projects` · **注入** `local-storage` · **创建** `createProjectComponent(inputs)`

登记绝对路径所指的现有目录；`realpath` 规范化后以路径去重，同一路径再次录入返回原 ID。项目包含稳定 ID、目录名、完整路径和动态计算的 `available` 状态。提供异步 `openProject(path)`、`listProjects()`、`getProject(id)` 与供 Session/Run 使用的 `requireAvailable(id)`。目录失效不删除记录，历史仍可读；创建会话和新 Run 被拒绝。第一版没有删除、迁移目录或项目专属配置。Projects 只注入 SQLite，不反向依赖 Session 或 Run；卸载时等待已接收操作。

**持有状态与边界。** 项目身份持久化在 `projects` 领域表中，目录可用性在访问时重新检查；内存中只跟踪接收状态和在途操作。Projects 不持有对话数据或 Run 执行闭包，不为每个项目创建 Context；Bash 的工作目录检查与 Apply Patch 的相对路径基准检查也复用它。

### SQLite 状态

**服务** `harness.state` · **注入** `local-storage`、`harness.projects` · **创建** `createSqliteStateComponent(inputs)`

**职责。** SQLite 状态组件保存 Session、对话节点和 Run 的权威业务记录，并在事务中校验、提交它们的合法变化。它被 Session、Run、AgentLoop 共同使用；它不发起模型请求或工具调用，不持有这些调用的取消句柄。

**持有状态。**

- **持久记录**：Session、不可变完整轮次节点、Run、幂等键、Prompt 内容快照、模型可见配置快照、执行阶段及事件，按 `run-state` 领域登记表迁移。执行记录包含 `phase`、修订号、模型调用次数 `modelCalls`、工具调用总数 `toolCalls`、工具批次和下一工具索引。
- **内存状态**：`plans` 按 Run ID 保存活动 Run 的 `LLMPlan`，另有接收标志与在途存储操作集合。计划只作为不透明对象保留；原生配置和密钥仍在 LLM 组件内，只有 `plan.snapshot` 持久化。Run 结算后删除计划，组件退出时清空，不在重启后重放。
- **转换规则**：`domain.ts` 与 `execution.ts` 的纯函数计算合法变化，本组件负责在事务中读取当前记录、应用变化并提交。执行阶段会反馈给 AgentLoop，决定下一步允许执行什么；状态组件自身不会调度外部调用。

`StatePort` 的读写均返回 Promise：`createSession(id, projectId, agentId, now)`、`getSession(id)`、`listSessions(projectId)`、`findAcceptedRun(input)`、`acceptRun(id, input, now, prompts, plan)`、`getRun(id)`、`listRuns(sessionId, query?)`、`getRunByKey(sessionId, key)`、`getNode(sessionId, id)`、`getNodePath(sessionId, id)`、`listNodes(sessionId, parentId, query?)`、`getRunPrompts(id)`、`getRunPlan(id)`、`getRunExecution(id)`、`getRunEvents(id, afterSeq?)`、`recordRunEvent(id, event, at)`、`requestCancellation(id, now)`、`settleRun(id, outcome, now)`。接受 Run 的事务再次检查同键、父节点与完整祖先路径，并原子保存 Run、历史定位、组装版本和配置快照；模型与工具启动事件在外部调用前提交，观察事件在退出后提交。成功终态、完整轮次节点、结果节点引用、执行阶段及事件在同一事务提交。同键同输入同父节点返回原 Run，同键换输入或父节点拒绝。

启动时在事务中将遗留的 `running`、`cancelling` 结算为 `interrupted` 并写入恢复事件，保留幂等键与历史，不重放已记录的工具意图；旧版 SQLite Run 表由 `run-state` 第 2 版迁移补齐执行状态与事件表，第 3 版迁移完整轮次树并将旧 Run 标为 `legacy-unknown`。卸载时停止接收并等待已接受的存储操作；Nya 先让 Session、AgentLoop 和 Run 等消费者退出。状态数据留在 SQLite 中。

工具扩展不新增数据库表或列。新执行 JSON 只写 `toolCalls`，新工具事件只写 `tool-started`、`tool-observed`、`tool-failed`，请求与观察用工具名区分 Bash 和 Apply Patch。`parseRunExecution` 将历史 `bashCalls` 读成工具总数，`parseRunEvent` 将历史 `bash-*` 读成带 `name: 'bash'` 的新事件；保留原始序号、时间和输出，支持原有 `afterSeq` 光标。兼容只在持久读取边界保留，不维护旧写入器，也不全量改写已结算历史。

### Session

**服务** `harness.sessions` · **注入** `harness.projects`、`harness.state` · **创建** `createSessionComponent(inputs, agents)`

Session 是创建和查询会话的入口。`createSession(projectId, agentId)` 显式指定项目，先校验全局 Agent 和项目目录可用，再在持久状态中创建会话。`getSession(id)` 和 `listSessions(projectId)` 返回会话元数据，`getNode(sessionId, id)`、`getNodePath(sessionId, parentId)`、`listNodes(sessionId, parentId, {cursor?, limit?})` 查询节点、祖先路径与分页子节点；目录后来不可访问时仍可查看。Session 自己不存数据，也不依赖模型或 AgentLoop。

**持有状态与清理。** 只保留只读 Agent 定义、运行时输入及本轮依赖引用，没有每会话执行器、Run 闭包或自有长期资源，因而没有单独的清理 Effect。实际目录检查和持久操作由 Projects 与状态组件跟踪。它不维护全局当前节点，Run 的对话起点由请求显式提供。

### Prompt

**服务** `harness.prompts` · **注入** `local-storage` · **创建** `createPromptComponent(inputs, legacyJsonPath?)`

Prompt 组件管理用户编写的 Prompt 文档及其发布版本。它只依赖存储，不知道 Agent 的存在。

**职责边界。** Prompt 拥有文档、版本和访问规则，Agent Prompt 拥有版本选择与绑定，状态组件拥有已接受 Run 的内容快照。编辑草稿或发布新版本不会修改已接受 Run 的快照；消息组装交给 AgentLoop 中调用的纯函数。

**概念。** 一个 Prompt 文档有所有者、名称、描述和一份可编辑的草稿。草稿带有递增的修订号、用途类型（kind）、消息角色（role）和内容。发布会把当前草稿复制成一个不可变的版本。用途类型与允许的角色如下：

| 用途类型 | 允许的角色 | 额外规则 |
| --- | --- | --- |
| `agent-instruction` | `system`、`developer` | 无 |
| `context` | `developer`、`user` | 无 |
| `task-template` | `user` | 必须恰好包含一次 `{{input}}` |

此外，名称最长 200 字符，描述最长 2000 字符，内容最长 100000 字符。这些规则都在 `src/prompt/domain.ts` 的纯函数中实现。绑定 `developer` 角色的版本在当前 DeepSeek 组件下会让新 Run 以 `unsupported-request` 失败，见上文。

**服务接口**（`PromptPort`）：

- `createPrompt(actorId, input)`：创建文档，调用者成为所有者，草稿修订号为 1。
- `editPrompt(actorId, id, expectedRevision, patch)`：修改草稿。`expectedRevision` 必须等于当前修订号，否则报修订冲突，用来防止并发编辑互相覆盖。
- `publishPrompt(actorId, id)`：把当前草稿发布为新版本；草稿自上次发布后没有改动时报错。
- `getPrompt`、`getPromptVersions`、`listPrompts`：只能读取自己拥有的文档，读取别人的文档报 `prompt access denied`；列表只包含调用者自己的文档。
- `getPublishedVersion(id)`：按 ID 读取已发布版本，不检查权限，只给 Agent Prompt 等受信组件使用。

`actorId` 必须由宿主认证后传入，组件不会信任客户端自报的身份。

**存储。** 启动时通过 `migrate('prompt', ...)` 建表，然后把全部文档和版本加载成内存中的读投影，读操作都是同步读取这份投影。写操作先排进组件自己的队列，按顺序提交 SQLite 事务，事务成功后才更新投影；所以写方法返回时数据已经落盘。

**旧数据导入。** 传入 `legacyJsonPath` 时，首次启动会在一个事务内导入旧 JSON 文件中的文档和版本，并记录来源路径；源文件不会被修改。之后用同一路径启动会跳过导入，用不同路径则报错。导入要求 Prompt 表为空。

**清理。** 卸载时停止接收写入，并等待队列中已接受的写入提交完成。

### Agent Prompt

**服务** `harness.agent-prompts` · **注入** `harness.prompts`、`local-storage` · **创建** `createAgentPromptComponent(inputs, agents, canManageAgent, legacyJsonPath?)`

Agent Prompt 组件决定每个 Agent 实际使用哪些 Prompt 版本。每个 Agent 的每种用途类型最多绑定一个已发布版本。

**持有状态与边界。** 组件拥有绑定读投影、写入队列和由只读 Agent 定义生成的默认指令映射。`resolveRunPrompts` 在准入时解析当前绑定并返回快照；它不持有活动 Run，也不在执行中重新改写该 Run 已固定的 Prompt。文档编辑与发布仍通过 Prompt 组件完成。

**服务接口**（`AgentPromptPort`）：

- `bindPrompt(actorId, agentId, versionId)`：绑定一个版本。调用者必须通过宿主的 `canManageAgent` 授权，并且拥有该版本；新绑定会替换同一用途类型的旧绑定。
- `getAgentPrompts(actorId, agentId)`：查看某个 Agent 当前生效的 Prompt，同样需要管理权限。
- `resolveRunPrompts(agentId)`：供 Run 准入使用，返回按 `agent-instruction`、`context`、`task-template` 顺序排列的快照，每份快照包含版本 ID、角色和内容。

**默认指令。** Agent 没有绑定 `agent-instruction` 时，使用 Agent 定义中的 `instructions` 作为默认的 `system` 指令。默认指令的版本 ID 由 Agent ID 和指令内容的哈希组成，指令一变，ID 也跟着变。如果已绑定的版本读不到了，新 Run 会明确失败，不会悄悄退回默认指令。

**存储。** 启动时通过 `migrate('agent-prompt', ...)` 建立绑定表，加载绑定并逐条确认所引用的版本仍然存在，然后形成读投影。绑定写入与 Prompt 一样，先排队、再提交事务、最后更新投影。传入 `legacyJsonPath` 时，它在 Prompt 导入完成后，于自己的事务内导入旧文件中的绑定，并单独记录来源。所以 Prompt 导入成功而绑定导入失败时，重启只会补做绑定。

**清理。** 卸载时停止接收绑定，并等待已接受的写入完成。卸载 Agent Prompt 时，Prompt 文档服务不受影响。

### AgentLoop

**服务** `harness.agent-loop` · **注入** `harness.state`、`llm`、`tools.bash`、`tools.apply-patch` · **创建** `createAgentLoopComponent(inputs)`

AgentLoop 是已接受 Run 的执行者，负责在途调用的执行协调与退出等待。模型可返回最终文本或由 Bash、Apply Patch 组成的工具批次；AgentLoop 先校验整批请求，再按顺序执行、记录观察并回填消息，继续调用模型。每次模型与工具调用都先通过状态组件记录启动意图，再发起外部调用；正常取得结果后还必须等待 `done` 才推进。它只通过 `llm` 服务契约发起模型调用，不知道背后是哪个 API 组件。DeepSeek、OpenAI Responses 和受控替身均使用同一个工具循环，原生协议差异留在 API 组件内部。

`validateToolBatch` 以 `ValidatedToolRequest` 的两个已知名称检查整批 ID 和参数结构；未知名称、无效字段或重复 ID 使整批零执行。补丁文本语法与文件匹配交给 Apply Patch，在工具观察中返回可修正诊断。`ToolObservation` 按 `name` 关联 `BashResult` 或 `ApplyPatchResult`，不扩散文件系统或原生模型类型；AgentLoop 直接注入并分派两个服务，不增加工具注册中心或新 Context。

**组件级状态。** 一个组件实例统一管理多个并发 Run：

| 状态 | 用途 |
| --- | --- |
| `accepting` | 控制是否接受新执行，卸载时关闭接收 |
| `active` | 按 Run ID 登记 `{ started, finished, cancel }`，用于去重、定位执行与统一关闭 |
| `rejected` | 保存最终 Promise 拒绝的执行，防止在同一组件实例中再次启动并重放副作用；普通已结算的 `failed` Run 不进入这里 |
| `failures` | 保存清理失败及未能正常结算的错误，供卸载时报告 |
| `waitFor` | 管理可以独立取消的等待者订阅，不取消它们等待的 Run |

**每 Run 的执行状态。** 每次首次 `start(runId)` 创建一份独立闭包；两个活动 Run 各有一份下列状态，共用的只是注入服务和组件级登记：

| 状态 | 用途 |
| --- | --- |
| `started`、`finished` | 表示启动交接与整个执行完成；启动前就终止时，`started` 随最终结果结算 |
| `current` | 当前 `OwnedCall`，每 Run 最多一个；保存结果、取消和资源退出接口 |
| `currentKind`、`request` | 当前模型或工具步骤，以及从执行记录取出的待执行工具请求 |
| `messages` | 从固定快照、祖先路径和输入组装的消息，随后追加本 Run 的工具请求与观察 |
| `reason`、`cancellation` | 取消原因和取消记录写入的 Promise，后续检查等待该写入 |
| `cancelError`、`cleanupProblem` | 取消方法异常及已确认的清理失败 |
| `totalToolOutputBytes` | 本 Run 的累计工具输出字节数，用于限制输出总量 |

`active` 中的取消方法通过闭包访问对应 Run 的变量；详细执行状态没有传给其他组件。Run 服务只持有准入/交接任务和 ID，通过 `start/cancel/wait` 操作它。LLM、Bash 与 Apply Patch 各自持有单次调用的资源闭包，并与 AgentLoop 引用同一个 `OwnedCall`；它们不会因此取得整个 Run 的执行闭包。

**与业务记录的边界。** AgentLoop 驱动状态变化，SQLite 状态组件保存并约束变化。AgentLoop 不独立维护可写的 `run.status`，而是读取最新 Run、提交事件和结算请求；`currentKind`、`request` 根据状态服务返回的执行阶段推进。调用句柄、等待任务和消息累积留在本轮执行内存中，Run 终态与节点则通过状态服务原子提交。完整示例见[一次 Run 的执行与记录由谁维护](#一次-run-的执行与记录由谁维护)。

**服务接口**（`AgentLoopPort`）：

- `start(runId)`：从 SQLite 状态读出 Run 的 Prompt 快照、调用计划和固定起点的祖先路径，用纯函数 `buildLLMMessages` 组装消息，再按持久执行阶段调用模型或工具。如果调用在发起时就同步失败，Run 按固定类别结算为 `failed`。
- `cancel(runId, reason)`：取消一个 Run 的在途调用，见下文的取消原因。
- `wait(runId, signal?)`：等待启动、资源退出与结算；Run 已经结束时返回当前状态。取消等待信号仅释放等待者，不取消 Run。

**消息组装顺序**：`agent-instruction` 快照、`context` 快照、Run 固定起点的祖先节点（依次为原文 user 和最终 assistant），最后是当前输入。如果绑定了 `task-template`，当前输入会先填进模板。兄弟分支、失败记录和历史工具轨迹不参与上下文；工具请求及观察只在当前 Run 内累积。

**结算规则。**

1. 调用发起后立即开始观察 `done`，因为它可能早于 `result` 失败。
2. `result` 得出完成或失败后仍等 `done`；若 `done` 先拒绝，直接报告清理失败，不无限等待可能永不完成的 `result`。
3. `done` 拒绝或调用 `cancel()` 时抛出异常，按当前调用类型报告 `cleanup-failure` 或 `tool-cleanup-failure`。这类失败还会记录下来，在组件卸载时抛出，因此 `harness.close()` 会以失败结束。
4. Run 没有处于取消中，而这个 Run 是因依赖撤销被取消的，结果改为 `dependency-unavailable`。
5. Bash 非零退出码，以及 Apply Patch 的语法拒绝、冲突和部分提交，都是工具观察，会交给下一次模型调用；取消先于后续推进，执行器故障按固定类别结算。模型与工具调用次数只记录进度，不设固定次数上限，循环持续到最终回答、取消或失败；最终文本最多 65536 字节，累计工具输出最多 131072 字节，其中 Bash 计 stdout/stderr，Apply Patch 计结构化结果的 JSON UTF-8 字节。
6. 最后交给 SQLite 状态原子写入终态、执行阶段与事件；成功时还创建节点并写入结果引用。取消先提交则不会创建成功节点，成功先提交则后续取消返回 completed。
7. 状态读取或写入失败停止推进，取消并等待已取得的调用；可恢复写入时以 `failed` / `state-write-failure` 结算（取消请求不掩盖存储故障），已知清理失败仍优先保留；持续失败则等待者收到持久化错误。失败执行登记保留至组件退出，禁止重复 start 重放；重启只结算 interrupted。

**取消原因。**

| 原因 | 来源 | Run 终态 |
| --- | --- | --- |
| `user-requested` | `harness.cancelRun` | 先变为 `cancelling`，退出后为 `cancelled` |
| `owner-disposed` | `harness.close()` 发起应用根关闭 | 同上 |
| `dependency-unavailable` | 依赖被撤销，或 AgentLoop 自身被卸载 | `failed`，类别为 `dependency-unavailable` |

**执行所有权。** 首次异步读取前按 runId 登记唯一启动/完成任务，重复 start 共用登记；启动期间的取消被保留，在发起下一调用前检查。wait 不因尚无调用句柄而提前返回。

执行正常结算后从 `active` 删除；最终 Promise 拒绝时移入 `rejected` 并保留到组件退出。统一登记不意味着串行执行：每个 Run 的异步循环独立推进，同一 Run 内的模型与工具步骤串行；Apply Patch 还在自己的资源边界内跨 Run、跨项目串行处理补丁。组件重建不恢复这些闭包；异常退出遗留的持久记录在状态组件启动时按恢复规则结算。

**清理。** 卸载时停止接收，以 `dependency-unavailable` 取消所有仍在启动或执行的 Run，并等它们全部退出和结算。

### Run

**服务** `harness.runs` · **注入** `harness.projects`、`harness.state`、`harness.agent-prompts`、`llm`、`harness.agent-loop` · **创建** `createRunComponent(inputs, agents, isHarnessClosing)`

Run 组件是 Run 的准入与对外控制入口。它决定一个请求能否成为 Run，并在接受时固定这次 Run 使用的配置；实际执行交给 AgentLoop。

**持有状态与边界。** 内存中的 `requests` 按 Session 与幂等键协调同键请求，`admissions` 跟踪准入任务，`handoffs` 按 Run ID 跟踪接受到启动的交接，`owned` 保存尚需等待结算的已接收 Run ID；另有接收标志和等待者订阅。这里的闭包处理准入与交接，不保存 AgentLoop 的 `current`、`messages` 或取消原因。Run 查询转给状态服务，执行取消和等待转给 AgentLoop；`owned` 中保存 ID 不表示拥有模型或子进程句柄。

**服务接口**（`RunPort`）：

- `startRun({ sessionId, parentNodeId, input, idempotencyKey })`：按下面的准入步骤接受 Run 并启动执行。输入中不能携带模型选择。
- `getRun(id)`、`listRuns(sessionId, {active?, parentNodeId?})`、`getRunByKey(sessionId, key)`：按 ID、会话/起点或幂等键查询执行记录。
- `getRunEvents(id, afterSeq?)`：按序增量读取 Run 的持久事件；未知 Run 返回 `undefined`。
- `cancelRun(id)`：以 `user-requested` 取消并返回当前状态。
- `waitRun(id, signal?)`：等待准入交接、启动、资源实际退出和终态。信号仅取消等待，不取消执行。

**准入步骤。**

1. 校验输入。
2. 按 Session 的幂等键先用 `findAcceptedRun` 检查重复请求。同一幂等键且输入、父节点一致时返回最初的 Run，即使之后配置或 Prompt 绑定已经改变，也不重新解析配置、不发起第二次调用。
3. 从状态组件读取 Session，通过 Projects 检查项目目录可用，读取启动时传入的 Agent 定义，调用 `resolveRunPrompts` 固定 Prompt 快照，调用 `llm.prepare` 固定调用计划。Run 不注入 Session 服务。
4. 用 `acceptRun` 原子地写入 Run 和快照。
5. 交给 `AgentLoop.start` 执行。

准入按 `(sessionId, idempotencyKey)` 协调，同键冲突立即拒绝，不同键独立准备。同一 Session、同父节点可同时运行；SQLite 仅在短暂提交时串行，不持有 Session 或父节点执行锁。Run 在接受事务前登记交接任务，覆盖“数据库已可读、AgentLoop 尚未接管”的等待窗口。

**对外可见的 Run** 包含 ID、Session、输入、幂等键、历史定位 `history`、`contextVersion`、递增 `revision`、状态、时间、`promptVersionIds` 和 `llmSnapshot`（profile ID 和配置版本），成功时还有 `output` 与 `resultNodeId`，否则可能有 `error` 与 `errorCategory`。Prompt 内容、模型参数和凭据都不会出现在对外的 Run 中。状态有 `running`、`cancelling`、`completed`、`cancelled`、`failed` 和异常退出后恢复的 `interrupted`。

**清理。** 卸载时停止接收，立即取消已接管的启动/执行任务，同时等待准入与交接；关停期间刚提交的 Run 在首次调用前取消，最后等待全部结算。取消原因由关闭方式决定：应用根正在关闭时用 `owner-disposed`，Run 因为依赖被撤销而卸载时用 `dependency-unavailable`。

## 自包含 API Key 服务组件

**服务** `credentials.read`、`credentials.settings` · **注入** 无 · **创建** `createApiKeyServiceComponent({ namespace, definitions })`

**职责与持有状态。** 这是本机 Web 默认的凭据组件，统一拥有注册清单、管理服务和系统存储实例。按凭据 ID 的操作排序、中止与退出等待由通用包实现，Nya 适配层负责注册服务和关闭实例。管理状态来自凭据库读取，密钥不进入 Run、Prompt 或 SQLite；模型配置与执行仍由模型组件和 AgentLoop 负责。

可移植包 `packages/api-key-manager` 的 `createApiKeyService` 自己持有系统凭据库存储、已注册凭据清单和操作顺序，不依赖 Anybox 的其他组件。Anybox 只用一个无注入依赖的 Nya 适配层提供读取与管理服务。受信宿主注册 `{ id, label, category }` 清单；DeepSeek、视频模型和其他服务使用相同的 `read`、`list`、`write`、`delete` 方法。`list()` 只返回公开元数据和 `configured` 状态；写入与删除只返回该项状态，不回传原 Key。未注册 ID 被拒绝。关闭时组件等待在途凭据操作实际退出。现有 DeepSeek ID 和 `anybox` 命名空间不变，无需迁移钥匙串条目。

单独的系统凭据库组件仍可供不需要管理清单的宿主使用；外部来源组件供部署方提供只读凭据。当前 Web 宿主只安装自包含 API Key 服务组件，注册启动时所选 API 的一个凭据，不叠加安装这些备选组件。

## 原生目录选择组件

**服务** `host.directory-picker` · **注入** 无 · **创建** `createDirectoryPickerComponent()`

**职责与持有状态。** 组件只负责一次选择交互，保存平台支持状态、接收标志和一个包含中止控制器及退出 Promise 的活动调用。它返回路径，由 Web 接着调用 Projects 登记项目；不保存项目身份或 Run 状态。

本机 Web 宿主安装一个目录选择组件。macOS 上由无 shell 的 `/usr/bin/osascript` 调用系统的 `choose folder`，只接受一个在途选择；返回绝对 POSIX 路径或取消结果。原生错误不传出组件，选择失败和忙碌使用固定类别。其他平台报告 `supported: false`，不阻止 Web 启动。请求断开或组件卸载时终止在途子进程并等待退出；项目路径的最终校验、规范化和去重仍由 Projects 组件负责。

## 本机 Web 前端组件

**服务** `web.frontend`（本机访问 URL）· **注入** `harness.projects`、`harness.sessions`、`harness.runs`、`harness.prompts`、`harness.agent-prompts`、`credentials.settings`、`host.directory-picker` · **创建** `createWebFrontendComponent(harness.listAgents(), port?)`

**职责与持有状态。** 服务端组件拥有 HTTP 监听器、已校验的 Agent ID 清单、监听端口及请求生命周期；服务器内部跟踪目录选择请求、中止或完成等待响应的操作及关闭 Promise。它调用业务服务完成写入和控制，不持有 AgentLoop 的执行闭包。浏览器显示的数据是服务端记录的读取结果，面板布局、草稿和查看位置由客户端模块独立维护。

本机宿主在 `createHarness` 后将它安装到同一个应用根，并传入已校验的 Agent ID 列表。组件持有只监听 `127.0.0.1` 的 HTTP 服务，提供静态页面和同源 `/api/v1`；HTTP 层构造公开的 Agent ID、Session、Run、Run 事件视图和已注册凭据状态。`GET /api/v1/runs/:id/events` 通过 Run 服务读取有序事件，返回按工具名区分的 `tool-*` 事件；Bash 的 stdout、stderr 与 Apply Patch 补丁预览分别最多 2048 UTF-8 字节。页面保留 Bash 命令、状态与退出码，并展示补丁的实际变更、未完成项及诊断；已取得的补丁结果在清理失败时也可展示。浏览器脚本是可替换的薄客户端，不导入 Nya 或 Harness。组件通过本轮 `deps` 调用 Projects、Session、Run、Prompt、Agent Prompt、目录选择器和通用凭据设置服务，不缓存跨重启的服务引用。

**模型启动配置。** `src/web/startup-config.ts` 的纯函数 `parseWebStartupConfig` 在打开资源前校验环境变量，`createWebLLMComponent` 构造选中的 API 组件；应用仍只安装一种模型实现。`ANYBOX_LLM_API` 默认 `deepseek-chat-completions`，也接受 `openai-responses`；DeepSeek 默认模型为 `deepseek-flash`，Responses 的 `ANYBOX_LLM_MODEL` 必填。API 基础地址、超时、输出长度和温度可通过 `ANYBOX_LLM_*` 配置；超时默认 30000 毫秒，输出长度默认省略，温度默认 DeepSeek 为 0.7、Responses 不发送。空变量和非法地址在启动前拒绝，不自动加载 dotenv。完整参数与官方、标准兼容端点启动示例见 [README](../README.md#本机-web-界面)。Web 设置页只管理已注册 Key，模型选择在重启时生效，不增加浏览器模型切换协议。

Prompt 管理以宿主固定的 `local-web-user` 身份调用文档与绑定服务，不接受浏览器声明身份。页面可编辑草稿、发布版本、预览历史并应用到 Agent；编辑与发布携带修订号检查，绑定继续由 Agent Prompt 校验。普通管理操作不重启组件。关闭监听器时等待已接收的写入请求完成，再由 Nya 关闭 Prompt 及绑定服务；管理能力直接复用现有组件，没有在 Web 中另存 Prompt 或拼装 Run 消息。

浏览器工作区支持最多四个跨项目 Session 面板。布局纯函数、工作区管理、会话控制器与面板视图只是前端模块，不是 Nya 组件。每个打开的 Session 独立持有读取 AbortController、串行轮询和视图监听器；移动时复用，关闭/替换时释放。已发出的提交/取消写入保持原对象归属，关闭面板不取消 Run。会话树查看节点、关注 Run 与活动 Run 集合分别管理；显式父节点与待提交键进入请求，布局和查看位置仅保存在浏览器标签页。新增脚本经静态资源白名单提供，后端服务契约和依赖图不变。

HTTP 监听器由组件的 Effect 清理：卸载时停止接收请求，取消在途目录选择并等待服务关闭，再由 Nya 清理其依赖。依赖撤销时，Web 组件随之停下；依赖恢复后，组件在原监听端口重新提供服务。进程的 SIGINT/SIGTERM 由 `src/web/serve.ts` 接收，并通过 `harness.close()` 卸载整个根。协议、同源限制与刷新恢复见 [薄 Web 客户端设计](./web-client-design.md)。

## 一次 Run 经过的组件

1. 宿主调用 `harness.startRun`，组合根取到当前的 Run 服务。
2. **Run** 校验输入，通过**SQLite 状态**检查同一 Session、同一幂等键的重复请求；不同键可以并发接受。
3. **Run** 从 **Projects** 检查会话目录，再从启动时传入的 Agent 定义读取配置，从 **Agent Prompt** 取得 Prompt 快照，再请所选的大模型 API 组件通过 `llm.prepare` 固定调用计划。这一步不读取凭据。
4. **Run** 通过**SQLite 状态**原子地接受 Run，然后调用 **AgentLoop**。
5. **AgentLoop** 组装消息并调用 `llm.call`；所选 API 组件在本 Run 首次调用时读取 Key，映射消息和工具定义并发送原生请求。Responses 另外在组件内部维护原生续轮上下文。
6. 模型可返回最终回答或工具请求。**AgentLoop** 整批校验后逐项执行 Bash 或 Apply Patch，将助手请求和对应观察回填给模型，直到最终回答或固定失败；每次模型、工具启动和观察写入**SQLite 状态**，成功时在 Run 固定父节点下创建完整轮次节点，与终态一起原子提交。
7. `harness.waitRun` 返回终态。

## 一次 Run 的执行与记录由谁维护

同一个 Run 同时是一项正在执行的工作，以及一份需要被查询、保留的业务记录。本文区分四个职责：

| 组件 | 负责的问题 | 典型状态 |
| --- | --- | --- |
| Run | 请求能否被接受，配置是否固定，控制请求发给谁 | 准入任务、幂等协调、交接 Promise、Run ID |
| AgentLoop | 当前调用是什么，如何继续、取消并等它退出 | 执行闭包中的调用句柄、消息、取消原因、启动与完成任务 |
| SQLite 状态 | Run 当前是什么业务状态，哪些变化合法且已经提交 | `running/cancelling/completed` 等状态、执行阶段、事件、对话节点 |
| 本地 SQLite | 如何排他访问数据库并提交或回滚事务 | 数据库连接、文件锁、串行操作队列 |

例如 Run A 正在等待模型回答：AgentLoop 持有 A 的调用句柄，状态组件保存 A 的 `running` 与 `model-in-flight` 记录。记录阶段不会自动发起请求；真正调用 `llm.call()`、持有返回句柄并观察退出的是 AgentLoop。启动意图在调用之前提交，所以记录也不能单独证明某个 HTTP 请求已发出或仍然存活。

用户取消 A 时，假设取消和清理均成功且取消先于成功提交：

| 步骤 | AgentLoop 与资源提供方 | SQLite 状态组件 |
| --- | --- | --- |
| 接收取消 | A 的闭包记住原因，调用 `current.cancel()`，请求写入取消状态 | 按规则将 A 从 `running` 改为 `cancelling` |
| 等待退出 | LLM/Bash 中止请求或进程；Apply Patch 停止后续文件并等当前提交与清理退出；AgentLoop 等待 `done` | 保留 `cancelling`，不提前宣告资源已经释放 |
| 提交终态 | AgentLoop 确认退出后请求结算 | 在事务中提交 `cancelled`、终止阶段和事件 |
| 释放登记 | AgentLoop 从 `active` 移除 A | 保留业务记录供查询 |

若完成先提交，后续取消返回原成功结果；若清理失败，AgentLoop 请求提交对应失败。状态组件依据纯函数规则和事务确定最终记录，成功时将 Run 终态、完整轮次节点和结果引用一起提交。它不会通过修改一条状态记录来终止 HTTP 请求或子进程。

两个 Run 并发时，AgentLoop 用一个 `active` Map 管理两份独立执行闭包，状态组件按 Run ID 保存各自记录；同一进程的存储操作串行，模型与工具工作仍可并发。进程异常退出后闭包消失，持久记录仍在；状态组件重启时把遗留的在途 Run 结算为 `interrupted`，不自动续跑外部副作用。

## 撤销与关闭时发生什么

下表列出主要业务与资源变化；已安装的 Web 也会随其依赖撤销而停下。终态描述以取消、清理和持久化成功为前提，清理或存储失败按前述失败规则报告；已经提交的终态不会因后续关闭而重写。

| 事件 | 先停下的组件 | 在途 Run | 不受影响 |
| --- | --- | --- | --- |
| `harness.close()` | 应用根全部组件；先退出依赖消费者，再清理资源提供者 | `cancelled`；历史保留在 SQLite 中 | 无；模型请求中止、SQLite 也关闭 |
| 应用替换或重启大模型 API 组件 | Run、AgentLoop，然后等旧组件的请求退出 | `failed`，`dependency-unavailable` | Session、Prompt、Agent Prompt、Projects、SQLite 状态、SQLite、凭据组件 |
| Web 保存或删除 Key | 无 | 已取得 Key 的 Run 继续；后续 Run 读取新状态 | 所有组件 |
| 应用卸载凭据组件 | Run、AgentLoop、大模型 API 组件，然后中止并等待凭据库操作 | `failed`，`dependency-unavailable` | Session、Prompt、Agent Prompt、Projects、SQLite 状态、SQLite |
| 应用卸载 SQLite | Run、AgentLoop、Session、Bash、Apply Patch、SQLite 状态、Projects、Agent Prompt、Prompt 按依赖先后退出，然后关闭连接并释放锁 | `failed`，`dependency-unavailable` | 大模型 API 组件 |
| Agent Prompt 被卸载 | Run，并取消、等待在途调用 | `failed`，`dependency-unavailable` | Prompt、Session、SQLite 状态、AgentLoop、大模型 API 组件 |
| SQLite 状态被卸载 | Run、AgentLoop、Session | `failed`，`dependency-unavailable`；历史仍在数据库中 | Prompt、Agent Prompt、Projects、大模型 API 组件 |

所有情况下，停下的组件都会先拒绝新请求，再等已接受的操作真正退出。单个依赖组件恢复后，其消费者由 Nya 自动重启，组合根的下一次调用会取到新实例。`harness.close()` 后该门面保持关闭，重新启动须再次装配组件。

## 附：H0 资源探针

`src/resource-probe.ts` 中的 `h0-resource-probe` 不属于 Harness 运行时，`createHarness` 不会安装它。它是 H0 阶段用来验证资源归属的最小组件：注入 `h0.model`，提供 `h0.runs`，卸载时取消并等待自己发起的调用。`tests/resource-boundaries.test.mjs` 仍用它确认 Nya 的关闭顺序与资源退出等待。

它持有接收标志、调用到退出 Promise 的活动映射以及清理错误；没有 Session、持久 Run、幂等记录或工具循环。该组件仅验证资源所有者必须取消并等待退出的基础契约。
