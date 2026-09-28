# Harness 组件说明

Harness 与本机 Web 已直接接入独立通用包 `packages/models`，通过 `models` 执行模型、通过 `models.settings` 管理连接、模型和密钥、通过 `models.catalog` 查询和刷新公开目录。多个 Provider 和协议可以同时工作；通用模块不导入本项目业务源码。包内契约与实现见 [Models 模块](../packages/models/README.md)。

状态：2026-09-28，对应当前代码。本文是项目现有 Nya 组件的职责清单，覆盖 Harness、本机 Web 宿主和通用 Models 模块，并单独说明仅用于验证的 H0 探针。逐个说明组件负责什么、提供哪个服务、依赖谁、持有哪些状态与资源、关闭时如何清理；组合根、Agent 定义和浏览器模块另行说明，不计为 Nya 组件。

先看下方职责总览；理解 Run 的执行与记录如何分工，可直接看[一次 Run 的执行与记录由谁维护](#一次-run-的执行与记录由谁维护)。阶段计划见 [Agent Harness 重建计划](./agent-harness-plan.md)，建模方法见 [用函数式思想建模 Agent Harness 的开发](./functional-agent-harness-development.md)，Prompt 与存储的专题设计见 [Prompt 管理模块设计](./prompt-management-design.md) 和 [本地 SQLite 存储组件](./local-sqlite-storage.md)。

## 总览

### 放置规则

当前只使用一个应用根 Context。宿主先安装 Models 配置存储、凭据、协调服务、协议与目录来源/缓存/服务组件，以及业务本地 SQLite；`createHarness` 校验只读 Agent 定义，再把 Projects、Bash、Apply Patch、Prompt、Session、Run、AgentLoop 等组件直接安装在同一个根上。目录选择器和 Web 也安装在这个根上，不为 Harness、Provider、Model、项目或任务创建额外 Context。

Models 配置、公开目录缓存和业务存储使用三个独立 SQLite 文件；配置库保存本地 Provider/Model，缓存库保存公共快照和 ETag，业务库持有 Session、Run、Prompt、Projects 等领域表。三者各有排他资源所有者，数据库路径不能相同。系统凭据使用独立命名空间。一个根安装一套 Models 服务与一套 Harness 服务，Provider 和 Model 是配置记录，多个协议组件通过注册服务接入。

应用拥有根上组件的生命周期。`harness.close()` 先停止接受门面调用，再卸载根上的全部组件，等待模型 execution、HTTP、工具、数据库和凭据操作退出。该门面关闭后不可复用；重启须重新装配组件，通常新建根。

### 组件与依赖

```text
应用根 Context
├─ Models 配置存储 ... 提供 models.store；拥有独立 SQLite
├─ Models 凭据 ....... 提供 models.vault；拥有系统凭据操作
├─ Models 协调服务 ... 提供 models、models.settings、models.protocols；注入 models.store、models.vault
├─ Responses 协议 .... 注入 models.protocols，按注册代登记实现
├─ 标准 Chat 协议 .... 注入 models.protocols，按注册代登记实现
├─ Anthropic 协议 .... 原生 Messages；注入 models.protocols
├─ Gemini 协议 ....... 原生 Interactions；注入 models.protocols
├─ DeepSeek 协议 ..... 宿主扩展；注入 models.protocols，复用标准 Chat 的传输与解析
├─ Models 目录来源 ... 提供 models.catalog-source；拥有匿名 HTTP 请求
├─ Models 目录缓存 ... 提供 models.catalog-cache；拥有独立 SQLite
├─ Models 目录服务 ... 提供 models.catalog；注入 catalog-source、catalog-cache
├─ 业务本地 SQLite ... 提供 local-storage
├─ 目录选择器 ........ 提供 host.directory-picker；无注入依赖
├─ Projects ......... 提供 harness.projects；注入 local-storage
├─ Bash ............. 提供 tools.bash；注入 projects
├─ Apply Patch ...... 提供 tools.apply-patch；注入 projects
├─ Session .......... 提供 harness.sessions、harness.session-runs；注入 local-storage、projects
├─ Prompt ........... 提供 harness.prompts；注入 local-storage
├─ Agent Prompt ..... 提供 harness.agent-prompts；注入 prompts、local-storage
├─ AgentLoop ........ 提供 harness.agent-loop；注入 session-runs、models、tools.bash、tools.apply-patch
├─ Run .............. 提供 harness.runs；注入 projects、sessions、session-runs、agent-prompts、models、agent-loop
└─ Web 前端 ......... 提供 web.frontend；注入 projects、sessions、runs、prompts、agent-prompts、
                     models、models.settings、models.catalog、host.directory-picker
```

这是服务依赖清单，不是 Context 层级。Agent 定义由组合根传给 Session、Agent Prompt 和 Run。协议组件依赖 Models 注册服务；Models 配置加载不依赖任何协议，缺少协议的配置仍可查询。公开目录只依赖来源与缓存，模型执行不依赖目录。Session 不注入 Models，因此模型服务替换不会撤销持久业务查询。关闭顺序由 Nya 根据真实依赖决定，组合根不复制依赖图。

### 职责与状态归属总览

下表中的运行时组件都安装在应用根；Models 同时承载多个连接、模型与协议。源码入口链接指向实际提供服务的组件，内部辅助模块由对应组件拥有。

| 组件 | 主要作用 | 持有的状态或资源 | 源码入口 |
| --- | --- | --- | --- |
| Models 配置存储 | 保存 Provider、Model、不可变版本与凭据操作日志 | 独立 SQLite 连接、排他所有权、配置记录与事务 | [store.ts](../packages/models/src/store.ts) |
| Models 凭据 | 按槽位读写系统凭据，等待实际退出 | 系统凭据条目、按槽位排序的在途操作 | [vault.ts](../packages/models/src/vault.ts) |
| Models 协调服务 | 配置协调、能力校验、协议注册和模型调用 | Provider 操作队列、协议注册代、待打开 execution 与在途管理操作 | [component.ts](../packages/models/src/component.ts) |
| Models 目录来源 | 获取和归一公开 models.dev 数据 | 匿名 HTTP 请求、reader、ETag 条件请求与退出等待 | [catalog-source.ts](../packages/models/src/catalog-source.ts) |
| Models 目录缓存 | 原子保存公开快照与刷新状态 | 第三套 SQLite 连接、排他所有权、写入队列或可观察的内存后备 | [catalog-cache.ts](../packages/models/src/catalog-cache.ts) |
| Models 目录服务 | 查询快照、协调刷新与发布 | 不可变目录、刷新计时器、在途刷新、状态 | [catalog.ts](../packages/models/src/catalog.ts) |
| 模型协议组件 | 编码原生请求，解析 JSON/SSE 与工具参数，维护候选续轮数据 | HTTP 调用、响应流与协议私有续轮状态 | [Responses](../packages/models/src/protocols/responses.ts)、[Chat Completions](../packages/models/src/protocols/chat-completions.ts)、[Anthropic](../packages/models/src/protocols/anthropic-messages.ts)、[Gemini](../packages/models/src/protocols/gemini-interactions.ts)、[DeepSeek 扩展](../src/web/deepseek-protocol.ts) |
| Bash 工具 | 在指定项目目录执行一次命令 | 子进程、输出缓冲、超时与终止计时器、在途调用 | [bash-component.ts](../src/tool/bash-component.ts) |
| Apply Patch 工具 | 预检并应用一次文本文件补丁 | 跨项目串行队列、源文件快照、临时文件与目录、提交事实、在途调用 | [apply-patch-component.ts](../src/tool/apply-patch-component.ts) |
| 本地 SQLite | 提供通用读写事务与按领域迁移 | 数据库连接、文件排他锁、串行操作队列 | [sqlite.ts](../src/storage/sqlite.ts) |
| Projects | 登记项目目录身份、检查目录可用性 | 项目持久记录、在途目录检查与存储操作 | [component.ts](../src/project/component.ts) |
| Session | 拥有会话、对话树、Run 记录及其查询与事务规则 | 持久记录、配置快照、迁移、恢复、在途数据操作和提交后通知 | [component.ts](../src/session/component.ts) |
| Prompt | 管理 Prompt 草稿和不可变发布版本 | 文档与版本表、已提交读投影、写入队列 | [component.ts](../src/prompt/component.ts) |
| Agent Prompt | 管理 Agent 的版本绑定，解析 Run 所需的 Prompt 快照 | 绑定表与读投影、写入队列、默认指令映射 | [prompt-binding-component.ts](../src/agent/prompt-binding-component.ts) |
| AgentLoop | 驱动已接受 Run 的模型与工具循环，取消并等待调用退出 | 活动 Run 登记、每 Run 的 ModelExecution 与执行闭包、调用句柄、等待者与清理错误 | [agent-loop-component.ts](../src/run/agent-loop-component.ts) |
| Run | 准入、幂等协调、固定配置，以及启动、取消和等待 | 准入期间的 execution 与取消控制器、交接任务和已接收 Run ID；业务记录交给 Session | [component.ts](../src/run/component.ts) |
| 目录选择器 | 打开一次原生目录选择窗口 | 单个在途对话框调用、子进程、中止与退出跟踪 | [directory-picker.ts](../src/web/directory-picker.ts) |
| Web 前端 | 将本机 HTTP 请求接到业务服务，提供浏览器客户端 | HTTP 监听器、请求等待与取消跟踪、重启时沿用的端口 | [component.ts](../src/web/component.ts)、[server.ts](../src/web/server.ts) |

`src/harness.ts` 是装配与转发函数，`src/agent/domain.ts` 中的 Agent 定义是只读配置；它们都不提供独立 Nya 服务。浏览器中的工作区和会话控制器也不是服务端 Nya 组件。H0 探针仅用于资源归属验证，见文末。

### 所有组件共用的约定

- **组件形态**：每个组件是一个带 `name` 和 `apply(ctx, config, deps)` 的对象，有服务依赖时通过 `inject` 声明。`apply` 完成初始化并用 `ctx.provide` 提供服务后返回，不让长期任务阻塞启动。`deps` 是本轮依赖的快照，组件只通过它使用注入服务。
- **撤销顺序**：Nya 卸载一个组件时，先撤回它提供的服务，并等所有依赖该服务的组件退出，再按后进先出执行它登记的 Effect 清理。所以任何组件被撤销时，下游消费者总是先停下。
- **停止接收与等待退出**：持有在途操作的组件通过接收标志或关闭状态拒绝新请求。模型、工具和执行循环还会取消已接受的工作并等待实际退出；存储及写入队列则等待已接受的操作完成。Session 通过清理 Effect 等待已接受的数据操作和提交后通知完成；SQLite 单独拥有连接与通用队列。
- **工具 `OwnedCall`**（`src/contracts.ts`）：`result` 是业务结果，`cancel(reason)` 只请求取消，`done` 表示实际工作与资源退出。工具的结果可先于退出到达，AgentLoop 必须观察两者。
- **模型 `ModelCall`**（`packages/models/src/types.ts`）：公共 `result` 在底层调用退出、完成成功结果的候选上下文提交并释放本轮占用后才结算；正常调用者只需等待一次 `result`。`done` 仍供资源所有者等待退出并识别清理失败，AgentLoop 统一立即观察两者。超时或取消不能用提前结束 Promise 代替资源退出。
- **Models 公共服务**：`models.list/get/open` 查询与打开执行上下文；`models.settings` 管理连接、模型、密钥、版本、模型发现和连接检查；`models.protocols` 仅供受信协议组件注册实现；受信 `models.source-data` 接纳统一来源定义，可选 `models.catalog` 提供刷新状态。Nya 按名称提供服务，这些名字区分职责，不构成权限隔离。
- **私有边界**：协议原生类型、错误、认证编码及续轮数据留在 Models 内；密钥值不进入 Provider/Model 查询 DTO、执行快照、Run、事件或日志。Host 将 Models 固定错误映射为 Run 的固定类别。
- **纯函数与副作用分离**：领域模块放校验和状态转换的纯函数，返回冻结的新值；时间和 ID 通过 `RuntimeInputs`（`now`、`newId`）从外部传入。Nya 装配、存储、模型传输和工具执行分别集中在对应组件及其内部实现中。
- **错误不泄露细节**：提供方的原始错误在边界处归一为固定类别和固定文案，不把第三方错误或传输细节带进 Run。

## 应用根中的资源组件

### Models 配置存储

**服务** `models.store` · **注入** 无 · **创建** `createModelsStoreComponent({ path })`

独占通用模块自己的 SQLite 文件，保存统一 Provider/Model 定义、连接和模型配置的当前记录与不可变版本、来源接纳版本/连接同步状态，以及系统凭据操作意图日志。定义带稳定内部 ID 与 user/external 来源；外部定义按命名空间更新，用户定义不推断来源。ProviderConnection 保存所属 Provider 定义、协议、地址与私有凭据引用；ModelConfiguration 保存所属模型定义、连接、固定远端 ID/定义版本、能力和参数。每组连接/模型定义只有一个基础配置，可增加 baseline:false 参数预设。连接的协议/所属定义，以及配置的连接/所属模型定义创建后不可修改。

存储服务可通过 Nya 注入替换；包内默认实现不依赖 `local-storage` 或业务领域迁移。配置保存使用 `expectedRevision` 检测冲突。协议未安装时仍加载、保留配置，由 Models 查询将相应模型标为不可用。关闭时等待已接收提交并释放连接与排他所有权。

### Models 凭据

**服务** `models.vault` · **注入** 无 · **创建** `createModelsVaultComponent({ namespace, openEntry? })`

凭据组件使用 `@napi-rs/keyring` 的异步接口接入 macOS Keychain、Windows Credential Manager 和 Linux Secret Service；Linux 显式使用 `secret-service`，不回退到内核 keyring、SQLite 或明文文件。`openEntry` 是行为测试与宿主系统绑定的注入点。

`read/write/delete` 按凭据槽位排序。初始化不要求凭据库可用；操作时以固定 `credential-unavailable` 等类别报告失败，所以缺少或无法访问 Key 不会阻止配置页面启动。关闭停止接收，取消并等待已接受操作实际退出；原生操作不能用提前拒绝 Promise 冒充退出。内存字符串只能释放引用，不能承诺擦除。

密钥轮换由 Models 协调：先在配置数据库登记操作意图，再写新的系统凭据槽位，最后事务提交新引用并安排旧槽位清理。失败或异常退出后的日志用于回收孤立条目；历史仅保留非秘密配置。ProviderConnection 查询只返回 `credentialConfigured`，不会返回槽位引用或密钥值。

### Models 协调服务

`models.settings.deleteConnection(id, expectedRevision)` 在连接队列内原子删除当前连接、全部执行配置与同步状态，保留定义和不可变版本历史。凭据退休意图同事务登记，删除后等待 Vault 清理，失败意图留待恢复；已打开 execution 继续使用私有快照与已读取凭据，新 execution 返回 not-found。来源接纳跳过排队期间已删除的连接，不重新创建账号。

**服务** `models`、`models.settings`、`models.protocols`、`models.source-data` · **注入** `models.store`、`models.vault` · **创建** `createModelsComponent()`

按 ProviderConnection 协调配置修改、密钥操作与 execution 初始化；解析本次配置并读完本地凭据后释放该连接的顺序约束，远端请求不占用配置队列。`models.open({ modelId, history?, tools?, requirements?, options?, signal? })` 固定 ModelConfiguration、ProviderConnection、模型定义版本、协议实现版本、有效参数和本次取得的凭据，返回内存中的 `ModelExecution`。普通配置修改、启停和密钥替换只影响新 execution。

execution 不是 Nya 组件或业务 Session。它持有规范化消息和协议私有续轮信息，`generate({ messages, onEvent? })` 只接收新增消息。同一 execution 拒绝重叠调用，不同 execution 可并发。工具参数 JSON 与调用对应关系由模块校验；工具参数的业务含义、授权和执行归宿主 AgentLoop。

结果同时包含文本、工具调用、用量和完成状态。只有 `completed` 的工具调用可执行；`incomplete`、`refused` 与真实清理失败结束执行链。只有完整成功、未取消且底层退出成功时才提交候选上下文，普通错误不自动重试。`close()` 幂等，停止新调用，取消并等待当前调用，释放上下文与凭据引用。

能力声明区分支持、不支持与未知，并结合协议实现和当前参数计算有效能力。未知或不支持的必需能力在调用前拒绝；可选参数保持省略，不能静默丢弃。当前消息契约只接受文本与用户定义函数工具，图片能力可登记但有效值为 false。协议 `defaultValue` 初始化新基础配置和新建表单；保存的参数才进入快照，不在执行时插入隐藏默认值。

### Models 目录来源、缓存与服务

**来源服务** `models.catalog-source` · **注入** 无 · **创建** `createModelsDevCatalogSourceComponent({ fetch? })`

固定匿名请求 `https://models.dev/api.json?type=all`，保留所有模态的公共元数据，归一为自有契约。组件独占响应 reader、请求取消和实际退出；不读取 Provider Key。上游 SDK 标签只作为数据，不能触发动态导入。来源可通过 Nya 替换。

**缓存服务** `models.catalog-cache` · **注入** 无 · **创建** `createModelsCatalogCacheComponent({ path, fallbackToMemory? })`

独占与配置库、业务库分离的 SQLite 文件，按规范化来源 URL 缓存快照、ETag 与成功检查时间。原子事务与排队写入由此组件拥有，关闭等待已接受写入后释放连接。初始化不可用时默认回退到内存，状态明确显示 `storage-unavailable`；宿主可禁止后备。该后备仅保存公开目录，不影响 Vault 的秘密存储要求。

**目录服务** `models.catalog` · **注入** `models.catalog-source`、`models.catalog-cache`、`models.source-data` · **创建** `createModelsCatalogComponent({ autoRefresh? })`

启动优先采用 Models 配置库已接纳的来源，再使用有效缓存或随包上游快照；provenance 记录 URL、采集时间、SHA-256 和版本，运行时验证后才加载。`apply` 完成有限初始化后返回。目录服务仅提供状态/刷新，统一定义的搜索、筛选、模态、价格、limits 与 controls 由 models.settings 提供。来源接纳原子更新外部定义与历史，再为连接补齐缺少的基础配置；同步有 pending/ready/failed 状态与 retryConnection。执行能力仍由保存的配置和协议计算，目录没有给出的 reasoning modes、efforts 或预算不能猜测补齐。

自动刷新在首次或缓存距成功检查 24 小时时于后台运行；使用 ETag，`304` 保留数据并更新检查时间，失败保留旧快照、一小时后重试，默认 HTTP 超时 30 秒。手动 `refresh(signal?)` 与自动刷新共用一个在途所有权，重叠请求返回 `busy`。请求实际退出后才接纳缓存提交，提交成功后发布；已经开始的原子提交不因晚到取消回滚。清理停止准入和计时器，取消获取并等待退出与已接纳提交。目录依赖撤销会重启其 Web 消费者，不撤销 Run/AgentLoop 的模型 execution。

定义的 source 显式标记来源命名空间；刷新不改写已保存连接/配置、Key 或会话选模，来源移除不删除配置。`resolveCatalogConnections` 仅把已知连接提示和已安装协议转为方案，可由宿主模板和协议 sourceMappings 补充。未知协议、非文本和弃用条目仍显示不可用原因，手动配置继续可用。打包快照仅通过显式 `npm --prefix packages/models run catalog:update` 更新，普通构建和测试不联网下载目录。

### 模型协议组件

**注入** `models.protocols` · **创建** `createResponsesProtocolComponent()`、`createChatCompletionsProtocolComponent()`、`createAnthropicMessagesProtocolComponent()`、`createGeminiInteractionsProtocolComponent()`、宿主的 `createDeepSeekProtocolComponent()`

五个协议可同时安装。组件在 `apply` 中注册协议 ID、实现版本、参数表单描述、校验、能力计算、模型发现/连接检查及原生调用函数，并通过 Effect 注销本次注册代。前端可以选择已注册协议，不能上传实现代码。运行时按 ProviderConnection 的 `protocolId` 分派，品牌模板只负责预填配置。

- **Responses**：调用 `/responses`，使用 `store: false`，支持普通 JSON 与 SSE；私有保留 reasoning、消息 phase 和函数调用续轮信息，不使用服务端会话或 `previous_response_id`。函数调用通过 `call_id` 对应工具结果，最终消息 phase 使用 `final_answer`。
- **标准 Chat Completions**：调用 `/chat/completions`，支持文本、文本与工具同时返回、工具参数增量与用量；输出长度编码为 `max_completion_tokens`，推理档位等参数由协议表单及模型声明校验。
- **Anthropic Messages**：调用 `/messages`，固定 `anthropic-version: 2023-06-01`，通过 `x-api-key` 发送 workspace-scoped API Key。`maxOutputTokens` 必填、表单默认 `4096`；disabled/adaptive/enabled 模式与 effort 需要本地能力声明，enabled 预算至少 `1024` 且低于输出上限，启用 thinking 时 temperature 只能省略或为 `1`。前导 system/developer 转成顶层 system，中途指令明确拒绝。私有保存有序 thinking、signature、redacted thinking 与原生工具 ID，以完整内容块续轮；不增加 beta 头。
- **Gemini Interactions**：调用 `/interactions`，采用 `v1beta` 地址与 `x-goog-api-key`，固定 `store: false`。可选输出上限、已声明的 thinkingLevel 与 thinkingSummaries；不接受 temperature。私有保存原生步骤、thought 摘要与签名，不使用服务端会话、后台代理或内建工具。
- **DeepSeek 非推理扩展**：位于宿主 `src/web/deepseek-protocol.ts`，复用通用 Chat 的传输与解析，将输出长度编码为 `max_tokens`，固定 `thinking: { type: 'disabled' }`。它不提供推理参数，不接受 `developer` 消息，相关输入明确失败，不悄悄改写角色或丢弃参数。

模型发现和显式连接检查通过协议实现；发现返回候选项，不覆盖本地模型。Anthropic 与 Gemini 支持分页发现，拒绝重复模型 ID 或循环游标；检查只请求一个列表页，不执行付费生成。HTTP、SSE、工具参数解析与错误归一化留在协议边界；底层 `result` 与 `done` 分开，公共 Models 服务等待退出后再提交上下文和返回结果。流事件只表示临时进展，thinking 摘要复用 `reasoning-summary-delta`，签名不出公共结果；工具增量与最终工具调用复用同一公共 ID。不订阅时不缓存，订阅回调异常不会改变模型结果。

注销先停止该注册代的新调用，取消并等待其 execution、模型发现与连接检查；其他协议继续工作。旧代清理不能撤销重新注册的新代。注销不会替 AgentLoop 取消它拥有的工具：已接受工具批次由 AgentLoop 继续执行并等待退出，后续 `generate()` 因旧 execution 已关闭而失败。若撤销整个 Models 服务，Nya 会先停止依赖它的 Run/AgentLoop，连同工具执行一起取消并等待。

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

本地 SQLite 是业务域共用的本地持久化组件（Models 默认使用独立配置存储），排他持有一个数据库文件及其连接。它不知道任何领域的表结构。

**职责边界。** 它持有连接、文件锁、接收标志和串行队列，保证回调中的读写与事务正确执行。Session、Run、Prompt 等记录的含义和合法变化由各领域组件决定；例如 Run 是否可以完成由 Session 组件的领域规则判断，本组件只负责提交或回滚其事务。

**启动。** `apply` 依次完成：规范化路径并创建父目录；创建同路径的 `.lock` 目录以取得排他所有权（已存在时以 `occupied` 失败）；打开连接；初始化存储自身的表布局。布局用 `PRAGMA user_version` 标记，并建立 `schema_migrations(domain, version)` 表；遇到无法识别的已有数据库会以 `schema-version` 拒绝启动。启动中任何一步失败，已取得的连接和锁都会回滚释放。

**服务接口**（`LocalStoragePort`）：

- `read(work, signal?)`：在只读模式下执行回调，回调拿到 `StorageReader`，提供参数化的 `get` 和 `all`。
- `transaction(work, signal?)`：以 `BEGIN IMMEDIATE` 开启事务执行回调。回调额外拿到 `execute`；它抛错、被拒绝或 `signal` 在提交前中止，都会回滚。一个事务可以同时写多个领域的表。
- `migrate(domain, migrations)`：为一个领域补齐缺失的迁移。版本号在领域内从 1 连续编号；每个迁移和它的版本记录在同一事务中提交，失败则回滚并以 `migration-failed` 拒绝。迁移必须是同步函数。领域记录的版本高于传入的迁移列表时以 `schema-version` 拒绝，防止旧代码误读新表。

所有操作在同一连接上按接受顺序串行执行。回调结束后，交给它的读写句柄立即失效。错误统一为带 `code` 的 `LocalStorageError`，驱动的对象和错误不会越过这个组件。

**清理。** 卸载时停止接收新操作，等待队列中已接受的读、事务和迁移全部结束，然后关闭连接，最后删除锁目录。取消不会强行中断异步回调，回调须自己响应 `signal`。进程异常退出后留下的 `.lock` 需要在确认原进程已停止后手动删除。

## 组合根：createHarness

**源码** `src/harness.ts` · **形态** 将业务组件安装到现有根的受信函数

`createHarness(root, options)` 是受信的组合根。它只接受宿主的根 Context，要求根上已经有 `models` 和 `local-storage` 服务。Models 可以在空配置、缺少协议或密钥时启动；未选模型或无法打开模型时，Run 准入明确拒绝，不写入已接受记录。

**持有状态与边界。** 组合根保存已校验的 Agent 定义、时间与 ID 输入、门面关闭标志及幂等关闭 Promise。它不注册自己的 Nya 服务，也不保存每 Run 的执行闭包；组件依赖与资源清理顺序交给 Nya。

**选项**（`HarnessOptions`）：

- `agents`：Agent 定义列表，必填。
- `legacyPromptStorePath`：可选，首次启动时从旧 Prompt JSON 文件导入。
- `canManageAgent(actorId, agentId)`：可选，由宿主提供的 Agent 管理授权；默认允许所有已认证用户。
- `now`、`newId`：可选，替换时钟和 ID 生成器，测试中用来得到确定的结果。

**启动。** 它在根上按依赖顺序逐个安装组件并等待就绪。某个组件启动失败会直接抛出它的错误；如果它因缺少依赖停在 `PENDING`，会报出所缺的服务名，例如 `component harness-agent-loop is waiting for models`。启动失败会卸载根上的全部组件，清理已安装组件以及 Models、目录和三套 SQLite 资源，再抛出错误。

**对外接口**（`Harness`）把 Projects、Session、Run、Prompt 和 Agent Prompt 服务的公开方法合在一起，包括 `getRunEvents(id)`，另加只返回 Agent ID 的 `listAgents()` 和 `close()`。服务调用每次都用 `context.get()` 取当前实例，不缓存跨组件重启的服务引用；服务暂时不可用时直接报错。`requireAvailable`、`getPublishedVersion` 和 `resolveRunPrompts` 只供内部组件使用，不对外暴露。

**关闭。** `close()` 是幂等的：先设置关闭标志，之后所有调用立即报 `harness is closing`；然后卸载应用根上的全部组件。关闭会等待 Run 的实际退出、Prompt 写入、Models 的请求与凭据操作退出和数据库连接的清理。该 Harness 门面不能再次使用；重启应用需重新安装所需组件。

## 应用根中的业务组件

### Agent 定义（只读配置）

`src/agent/domain.ts` 定义必填的 `id`、`instructions` 与可选的默认 `modelId`。它是启动配置，不提供 Nya 服务，也不持久化。`validateAgents` 要求列表非空、ID 唯一，已提供字段为非空字符串；冻结副本传给 Session、Agent Prompt 和 Run。修改定义需重新装配 Harness。

没有默认模型也允许启动，用于先打开 Web 配置。Run 按显式 `RunInput.modelId`、Session 的 `modelId`、Agent 默认值的顺序选择；最终仍未选择时以 `model-unavailable` 拒绝。显式会话模型由 Harness/Web 入口查询当前 Models 服务校验，Session 自身仅保存模型 ID，不依赖 Models。

### Projects

**服务** `harness.projects` · **注入** `local-storage` · **创建** `createProjectComponent(inputs)`

登记绝对路径所指的现有目录；`realpath` 规范化后以路径去重，同一路径再次录入返回原 ID。项目包含稳定 ID、目录名、完整路径和动态计算的 `available` 状态。提供异步 `openProject(path)`、`listProjects()`、`getProject(id)` 与供 Session/Run 使用的 `requireAvailable(id)`。目录失效不删除记录，历史仍可读；创建会话和新 Run 被拒绝。第一版没有删除、迁移目录或项目专属配置。Projects 只注入 SQLite，不反向依赖 Session 或 Run；卸载时等待已接收操作。

**持有状态与边界。** 项目身份持久化在 `projects` 领域表中，目录可用性在访问时重新检查；内存中只跟踪接收状态和在途操作。Projects 不持有对话数据或 Run 执行闭包，不为每个项目创建 Context；Bash 的工作目录检查与 Apply Patch 的相对路径基准检查也复用它。

### Session

**服务** `harness.sessions`、`harness.session-runs` · **注入** `local-storage`、`harness.projects` · **创建** `createSessionComponent(inputs, agents)`

**职责。** Session 是会话事实的唯一领域所有者：会话元数据、不可变完整轮次节点、Run 记录、幂等键、Prompt 内容快照、模型可见配置快照、执行阶段与事件均由它管理。中间会话工作区通过它查询历史和运行记录。组件独立于模型与执行组件；卸载模型或 AgentLoop 不会撤销 Session 服务。它不维护全局当前节点，前端查看位置也不是后端事实。

**两个服务面。** 两者由同一个组件、同一套存储和生命周期提供，拆分用于明确调用职责，不构成权限隔离。

| 服务 | 调用者 | 接口 |
| --- | --- | --- |
| `harness.sessions` / `SessionPort` | Web、Harness；Run 读取会话 | `createSession`、`selectSessionModel`、`getSession`、`listSessions`、`getNode`、`getNodePath`、`listNodes`、`getRun`、`getRunByKey`、`listRuns`、`getRunEvents` |
| `harness.session-runs` / `SessionRunPort` | Run、AgentLoop | `findAcceptedRun`、`registerRun`、`loadRunContext`、`getRun`、`getRunExecution`、`recordRunEvent`、`requestCancellation`、`settleRun` |

`createSession(projectId, agentId, modelId?)` 校验 Agent 与项目目录后生成 ID、时间并提交会话，保存显式选择或 Agent 默认模型，没有选择时保存 `null`。`selectSessionModel(sessionId, modelId)` 修改后续调用的默认选择，不改变已接受 Run。历史查询不要求目录仍可访问。`registerRun(id, input, now, prompts, model)` 仅接收可持久化的配置快照，在事务内再次校验同键、父节点与完整祖先路径；同键同输入同父节点且显式模型选择一致时返回原 Run，冲突则拒绝。`loadRunContext(id)` 在一次读取中返回 Run、项目 ID、固定起点的祖先路径与 Prompt 快照，不返回运行期 execution。

**持有状态与内部实现。** `src/session/domain.ts` 保存会话值、对话树类型和纯校验；`src/session/sqlite-records.ts` 是组件内部 SQL 实现，不独立注册 Nya 服务，也不持有 execution。它沿用 `run-state` 迁移账本和现有表名，重构无需改写既有数据。Run 及执行阶段的纯转换仍位于 `src/run/domain.ts` 与 `src/run/execution.ts`。内存中只有只读 Agent 配置、接收标志和在途数据操作；`ModelExecution` 由 Run 打开并直接交给 AgentLoop，密钥和协议续轮状态留在 Models 内部。

**事务与恢复。** 模型与工具启动意图在外部调用前提交，观察在调用退出后提交。成功终态、完整轮次节点、结果节点引用、执行阶段及终态事件在同一事务提交。Session 校验持久转换，AgentLoop 负责确保资源已退出，两者共同保证成功节点不会提前可见。启动时在事务中将遗留的 `running`、`cancelling` 结算为 `interrupted` 并记录恢复事件，保留历史及幂等键，不恢复 execution 或重放外部副作用。`run-state` v4 增加会话/Run 的模型 ID 与请求选择，将旧 `llm_snapshot_json` 列改名为 `model_snapshot_json`；读取旧 profile 快照时只返回 `legacyModelSnapshot`，`modelSnapshot` 为 `null`。新写入只保存 ExecutionSnapshot；旧对话来源不明确的 Run 仍保持 `legacy-unknown`。

Run 接受、执行记录、取消请求和结算实际提交后，通过 Nya `ctx.parallel` 发出类型化的 `harness.run.changed`，载荷只包含 `{ sessionId, runId, revision }`。幂等重试、无变化的取消或结算、失败及回滚均不发出通知；成功结算通知发生在完整轮次节点与 Run 终态原子提交之后。事件只提示消费者重新查询，持久 RunEvent 和查询服务仍为事实来源。监听器应只入队，通知失败只记日志，不把已提交写入变成失败；在途操作集合也覆盖事件分发的退出。

**清理。** Nya 先撤回两个服务，并让 Web、Run、AgentLoop 等消费者退出；这期间已注入的 Session 服务仍能完成取消和结算。随后 Session 的 Effect 停止接收新操作，等待已接受的项目校验、数据库访问和通知分发完成。最后才允许上游 Projects 和 SQLite 清理资源。已保存记录留在数据库，重新安装 Session 会恢复查询能力。

工具扩展不新增数据库表或列。新执行 JSON 只写 `toolCalls`，新工具事件只写 `tool-started`、`tool-observed`、`tool-failed`，请求与观察用工具名区分 Bash 和 Apply Patch。`parseRunExecution` 将历史 `bashCalls` 读成工具总数，`parseRunEvent` 将历史 `bash-*` 读成带 `name: 'bash'` 的新事件；保留原始序号、时间和输出，支持原有 `afterSeq` 光标。兼容只在持久读取边界保留，不维护旧写入器，也不全量改写已结算历史。

### Prompt

**服务** `harness.prompts` · **注入** `local-storage` · **创建** `createPromptComponent(inputs, legacyJsonPath?)`

Prompt 组件管理用户编写的 Prompt 文档及其发布版本。它只依赖存储，不知道 Agent 的存在。

**职责边界。** Prompt 拥有文档、版本和访问规则，Agent Prompt 拥有版本选择与绑定，Session 组件拥有已接受 Run 的内容快照。编辑草稿或发布新版本不会修改已接受 Run 的快照；消息组装交给 AgentLoop 中调用的纯函数。

**概念。** 一个 Prompt 文档有所有者、名称、描述和一份可编辑的草稿。草稿带有递增的修订号、用途类型（kind）、消息角色（role）和内容。发布会把当前草稿复制成一个不可变的版本。用途类型与允许的角色如下：

| 用途类型 | 允许的角色 | 额外规则 |
| --- | --- | --- |
| `agent-instruction` | `system`、`developer` | 无 |
| `context` | `developer`、`user` | 无 |
| `task-template` | `user` | 必须恰好包含一次 `{{input}}` |

此外，名称最长 200 字符，描述最长 2000 字符，内容最长 100000 字符。这些规则都在 `src/prompt/domain.ts` 的纯函数中实现。绑定 `developer` 角色的版本在 DeepSeek 非推理协议下会让新 Run 以 `unsupported-request` 失败，见上文。

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

**服务** `harness.agent-loop` · **注入** `harness.session-runs`、`models`、`tools.bash`、`tools.apply-patch` · **创建** `createAgentLoopComponent(inputs)`

AgentLoop 拥有已接受 Run 的 `ModelExecution`、模型与工具调用、取消状态和退出等待。`start({ runId, execution })` 在第一次异步读取前同步登记所有权，再读取 Session 的固定输入并核对 execution 快照。停止接收或拒绝其他 execution 的重复交接时同步抛错，不取得新对象的所有权；同一 Run、同一 execution 的重复交接复用原启动任务。

组件级 `active` 保存 execution、启动/完成任务与取消函数；`rejected` 保留不能完成持久结算的失败任务，防止重放副作用；`failures` 汇总清理问题。每个 Run 有独立闭包，保存当前调用、当前工具、待发送新增消息、取消原因与状态写入 Promise、execution 的幂等关闭任务和累计工具输出量。同一 Run 内串行，不同 Run 可并发；Apply Patch 的资源队列仍跨项目串行。

**工具与消息。** `validateToolBatch` 检查整批 ID、已知名称及参数结构；未知工具、重复 ID 或无效字段使整批零执行。Bash 命令的业务校验归 AgentLoop，补丁文本语法与文件匹配由 Apply Patch 返回可修正观察。AgentLoop 直接注入两个工具服务，不增加工具注册中心。

第一次 `generate` 的消息由 `buildModelMessages` 按 Agent 指令、context、固定父节点的完整祖先对话、当前输入顺序组装；task-template 只替换当前输入。兄弟分支、失败记录和历史工具轨迹不进入上下文。此后只发送新增的 `{ role: 'tool', callId, content }`，不重复发送助手工具请求或完整历史；Models 已保存规范化消息与原生续轮信息。

**执行与结算。**

1. 每次模型/工具启动前向 Session 提交启动意图。模型通过 execution 的 `generate` 调用；工具通过各自的 `execute` 调用，句柄取得后立即观察 `result` 与 `done`。
2. Models 公共 `result` 已保证底层退出；工具仍可能先返回业务结果。AgentLoop 统一等待实际退出，`done` 先拒绝时不无限等待悬空 `result`。
3. 只有 `completed` 才消费工具调用；文本与多个工具请求可以同时出现。`incomplete`、`refused` 分别记为 `incomplete-response`、`refused-response`，不执行其中任何工具。没有工具调用时检查最终文本及大小，然后准备成功结算。
4. 工具按整批顺序执行并记录观察，非零 Bash 退出码、Apply Patch 语法拒绝/冲突/部分提交可以交给下一轮模型。取消和执行器故障停止后续推进。模型与工具调用没有固定次数上限；最终文本最多 65536 字节，工具输出累计最多 131072 字节，其中 Bash 计 stdout/stderr，Apply Patch 计结构化结果的 JSON UTF-8 字节。
5. 任一结算路径先关闭 execution 并等待退出，成功后才请求 Session 原子提交终态和完整节点。取消方法异常、调用 `done` 拒绝或 execution 关闭失败按固定清理类别失败，并留给组件关闭报告；清理失败不能被普通取消掩盖。
6. 持久读取/写入失败会取消并等待已取得调用；可恢复时结算为 `state-write-failure`，持续失败保留失败任务并拒绝等待者。恢复只把遗留记录标为 `interrupted`，不会自动重放副作用。

**进度。** `onEvent` 通过 `harness.run-model-event` 发出 `{ sessionId, runId, event }`。这是临时展示数据，不写成持久 RunEvent，也不作为工具执行依据；Web 监听器只向有界 SSE 队列入队。最终输出和工具事实以 Session 的已提交记录为准。

**控制接口。** `cancel(runId, reason)` 记录取消原因、取消当前调用并关闭 execution；`wait(runId, signal?)` 等待启动、资源退出及结算。等待信号只释放等待者，不取消 Run。

| 原因 | 来源 | 终态（清理与持久化成功时） |
| --- | --- | --- |
| `user-requested` | `harness.cancelRun` | `cancelling` 后为 `cancelled` |
| `owner-disposed` | 应用根关闭 | 同上 |
| `dependency-unavailable` | 依赖或 AgentLoop 被撤销 | `failed`，类别 `dependency-unavailable` |

取消先于成功提交则不创建成功节点，成功先提交则后续取消返回 completed。组件卸载时停止接收，取消并等待全部已登记 Run 的调用、execution 关闭和持久结算。

### Run

**服务** `harness.runs` · **注入** `harness.projects`、`harness.sessions`、`harness.session-runs`、`harness.agent-prompts`、`models`、`harness.agent-loop` · **创建** `createRunComponent(inputs, agents, isHarnessClosing)`

Run 负责准入、幂等、配置固定和执行交接；AgentLoop 接管之后由它持有 execution 和工具调用。Run 的 `requests` 协调同键请求，`admissions` 跟踪异步准入，`opening` 持有准入中止控制器，`untransferred` 跟踪尚未交接的 execution；`handoffs` 和 `owned` 覆盖已可查询记录到执行器接管的窗口。

**服务接口。** `startRun({ sessionId, parentNodeId, input, idempotencyKey, modelId? })` 接受显式模型 ID；`cancelRun(id)` 请求取消并返回当前状态；`waitRun(id, signal?)` 等待交接、执行和退出，信号只取消等待。Run 查询仍经 Session。

**准入步骤。**

1. 校验输入，并在任何新配置解析前检查幂等键。同键只有输入、父节点和显式 `modelId` 均一致才复用原 Run。未显式传模型的重试继续返回原结果，不受后来会话模型、配置或 Prompt 修改影响。
2. 从 Session 读取会话，通过 Projects 检查目录，按显式请求、Session、Agent 默认值解析模型 ID；由 Agent Prompt 固定 Prompt 快照。
3. 根据 Models 当前有效工具能力决定是否提供 Bash/Apply Patch 定义，调用 `models.open`，等待配置固定与凭据读取。此时已有取消所有者，但尚未创建 Run 记录；模型缺失、凭据不可用或能力冲突会拒绝准入。
4. 在接收事务前登记交接任务，再调用 `registerRun` 原子保存业务输入、Prompt 和 `execution.snapshot`；Session 从未持有 execution 本身。
5. 同步调用 `AgentLoop.start({ runId, execution })` 转移所有权。如果同步拒绝，由 Run 关闭 execution 后结算已接受记录；异步执行失败由 AgentLoop 负责。重复接受或准入失败时，未转移对象也必须关闭。

同键冲突立即拒绝，不同键独立打开 execution。同一 Session、同一父节点可以有并发 Run，不建立会话或父节点执行锁。交接前的取消只标记 `cancelling` 并请求中止，由准入所有者等待 execution 清理后结算，避免先宣告取消完成而隐藏清理失败。

**可见快照。** Run 包含 `modelId`、`requestedModelId` 和 `modelSnapshot`；快照记录本地模型/Provider ID、版本、远端模型 ID、协议 ID/版本及有效生成参数，不包含地址、密钥或协议私有上下文。旧记录使用可空 modelSnapshot 与只读 legacyModelSnapshot。其余历史定位、Prompt 版本 ID、revision、时间、输出、错误类别和 resultNodeId 仍由 Session 提供。

**清理。** 停止接收后先中止正在打开的 execution，并取消已转移的 Run，等待所有准入、交接和执行退出。未转移的已接受记录由准入所有者关闭资源再结算；已转移记录由 AgentLoop 结算。应用根关闭使用 `owner-disposed`，依赖撤销使用 `dependency-unavailable`。

## 本机宿主的 Models 装配与迁入

`src/web/models-startup.ts` 的 `installWebModels` 在同一根上安装 Models 存储、凭据、协调服务、Responses、标准 Chat、Anthropic Messages、Gemini Interactions、DeepSeek 扩展，以及公开目录的来源、缓存和服务。通用模块也可由独立宿主装配，示例见 [模块 README](../packages/models/README.md#install-in-an-application)。`src/web/startup-config.ts` 在打开资源前校验数据库路径、命名空间、端口和首次迁入配置。

`ANYBOX_MODELS_DATABASE` 默认为 `./data/models.sqlite`，`ANYBOX_MODELS_NAMESPACE` 默认为 `anybox.models`；`ANYBOX_HARNESS_DATABASE` 独立指定业务数据库。`ANYBOX_MODELS_CATALOG_DATABASE` 默认位于 Models 配置文件旁的 `models-catalog.sqlite`，三个文件路径必须不同。目录启动与刷新不使用旧 LLM 环境参数或账号 Key。只有 Models 配置为空时，旧 `ANYBOX_LLM_*` 参数才用于创建迁入 Provider 和默认 Model：默认 DeepSeek 非推理、`deepseek-flash`、temperature 0.7，输出长度省略；首次 Responses 导入须显式提供模型 ID。已有配置后重启不会覆盖用户编辑。

首次迁入只读取旧 `anybox` 命名空间下对应固定凭据 ID，经 Models 日志化密钥流程复制到新槽位，旧条目不修改、不删除。旧凭据读取失败或新凭据库写入失败时仍创建可编辑配置，显示未配置密钥；不回退明文。`packages/api-key-manager` 仅在这一兼容读取路径使用，旧 `credentials.read/settings` 不再安装为应用服务。

中断迁入只识别保留的导入 Provider ID 且尚无模型的状态，保留已提交 Provider/密钥并补建模型；若已提交协议与当前启动模板不一致，则保留连接、跳过自动建模，由用户在 Web 明确配置。已有用户连接不会被误认为导入任务。数据库没有可用默认配置时仍可启动设置页；Agent 可省略默认 modelId，配置后再选择。

## 原生目录选择组件

**服务** `host.directory-picker` · **注入** 无 · **创建** `createDirectoryPickerComponent()`

**职责与持有状态。** 组件只负责一次选择交互，保存平台支持状态、接收标志和一个包含中止控制器及退出 Promise 的活动调用。它返回路径，由 Web 接着调用 Projects 登记项目；不保存项目身份或 Run 状态。

本机 Web 宿主安装一个目录选择组件。macOS 上由无 shell 的 `/usr/bin/osascript` 调用系统的 `choose folder`，只接受一个在途选择；返回绝对 POSIX 路径或取消结果。原生错误不传出组件，选择失败和忙碌使用固定类别。其他平台报告 `supported: false`，不阻止 Web 启动。请求断开或组件卸载时终止在途子进程并等待退出；项目路径的最终校验、规范化和去重仍由 Projects 组件负责。

## 本机 Web 前端组件

**服务** `web.frontend`（本机访问 URL）· **注入** `harness.projects`、`harness.sessions`、`harness.runs`、`harness.prompts`、`harness.agent-prompts`、`models`、`models.settings`、`models.catalog`、`host.directory-picker` · **创建** `createWebFrontendComponent(harness.listAgents(), port?)`

**职责与持有状态。** 服务端组件拥有 HTTP 监听器、已校验的 Agent ID 清单、监听端口及请求生命周期；服务器内部跟踪目录选择请求、中止或完成等待响应的操作及关闭 Promise。它调用业务服务完成写入和控制，不持有 AgentLoop 的执行闭包。浏览器显示的数据是服务端记录的读取结果，面板布局、草稿和查看位置由客户端模块独立维护。

本机宿主在 `createHarness` 后将它安装到同一个应用根，并传入已校验的 Agent ID 列表。组件持有只监听 `127.0.0.1` 的 HTTP 服务，提供静态页面和同源 `/api/v1`；HTTP 层构造公开的 Agent ID、Session、Run、Run 事件视图、模型目录及配置状态。`GET /api/v1/runs/:id/events` 通过 Session 服务读取有序事件，返回按工具名区分的 `tool-*` 事件；Bash 的 stdout、stderr 与 Apply Patch 补丁预览分别最多 2048 UTF-8 字节。页面保留 Bash 命令、状态与退出码，并展示补丁的实际变更、未完成项及诊断；已取得的补丁结果在清理失败时也可展示。浏览器脚本是可替换的薄客户端，不导入 Nya 或 Harness。组件通过本轮 `deps` 调用 Projects、Session、Run、Prompt、Agent Prompt、目录选择器及 Models 服务，不缓存跨重启的服务引用。

**模型管理。** Web 通过 models.settings 查询统一 Provider/Model 定义、管理 ProviderConnection/ModelConfiguration、Key、CAS 版本、发现和检查；保存连接与 Key 后自动准备适用模型。目录服务仅提供来源状态和刷新。查询不返回 Key，修改携带 expectedRevision。协议字段驱动高级参数表单；Session 持久选择稳定配置 ID，模型选择器按连接分组。

统一目录展示 Provider/Model 的 user/external 来源、搜索、弃用、模态、价格和 limits。用户选 Provider、确认连接方案与 Key 后，系统自动准备文本契约与显式协议映射适用的模型，不要求逐个保存。全模型列表显示不可用原因；额外预设和自定义模型位于高级设置。同步失败保留连接和 Key并可重试。来源刷新补齐缺少基础配置，不改已有参数；来源移除仍可使用固定的执行配置。

HTTP /api/v1/models 返回执行配置摘要；/models/providers 和 /models/definitions 查询/管理统一定义，/models/connections 和 /models/configurations 管理实际连接与执行参数，连接的 /models 展示全部模型状态、/retry 重试同步。目录 /models/catalog 只提供状态，/refresh 接纳来源。Session 的 /model 更新默认配置 ID。远端发现、检查和刷新支持断连取消并等待退出；已接纳提交仍完成。首次迁入在协议注册前恢复稳定 default 配置 ID，避免中途失败后生成额外随机基础配置。

Prompt 管理以宿主固定的 `local-web-user` 身份调用文档与绑定服务，不接受浏览器声明身份。页面可编辑草稿、发布版本、预览历史并应用到 Agent；编辑与发布携带修订号检查，绑定继续由 Agent Prompt 校验。普通管理操作不重启组件。关闭监听器时等待已接收的写入请求完成，再由 Nya 关闭 Prompt 及绑定服务；管理能力直接复用现有组件，没有在 Web 中另存 Prompt 或拼装 Run 消息。

浏览器工作区支持最多四个跨项目 Session 面板。布局纯函数、工作区管理、会话控制器与面板视图只是前端模块，不是 Nya 组件。每个工作区拥有一条按会话过滤的 EventSource；每个打开的 Session 独立持有读取 AbortController、串行刷新和视图监听器，移动时复用，关闭/替换时释放。SSE 通知触发对应会话补查，连接健康时 30 秒校准、未就绪或断线时 5 秒兜底，重连及恢复可见时补查。已发出的提交/取消写入保持原对象归属，关闭面板不取消 Run。会话树查看节点、关注 Run 与活动 Run 集合分别管理；显式父节点与待提交键进入请求，布局和查看位置仅保存在浏览器标签页。新增脚本经静态资源白名单提供；模型目录、会话选择与临时进度由薄客户端消费。

Web 通过 `ctx.on('harness.run.changed', ...)` 监听提交后的变化，通过 `harness.run-model-event` 监听临时流进度，Nya 自动清理订阅；监听回调只向 HTTP 层入队。服务器拥有 SSE 连接、每连接最多四会话的合并状态队列，以及最多 128 帧/256 KiB 的进度队列、心跳和背压超时，最多接收 64 条连接。慢消费者超限只断开展示订阅，不等待浏览器，也不影响模型结果；重连后补查持久记录，临时进度不重放。HTTP 监听器由组件的 Effect 清理：卸载时停止接收请求，取消在途目录选择，销毁 SSE 并等待连接与请求退出，再由 Nya 清理其依赖。依赖撤销时，Web 组件随之停下；依赖恢复后，组件在原监听端口重新提供服务并重新订阅。进程的 SIGINT/SIGTERM 由 `src/web/serve.ts` 接收，并通过 `harness.close()` 卸载整个根。协议、同源限制与刷新恢复见 [薄 Web 客户端设计](./web-client-design.md)。

## 一次 Run 经过的组件

1. 宿主调用 `harness.startRun`，门面取得当前 Run 服务。
2. Run 检查输入及幂等键，读取 Session、项目和 Prompt，并解析显式/会话/Agent 默认模型 ID。
3. Run 调用 `models.open`，由 Models 固定配置版本、有效参数、协议注册代和凭据；准入所有者负责取消和等待这一阶段。
4. Run 将 execution 的公开快照交给 Session 持久化，然后把 execution 直接交给 AgentLoop。
5. AgentLoop 记录模型启动意图，组装首轮消息并调用 `execution.generate`。Models 通过已固定的协议发送请求，解析 JSON/SSE、文本、工具参数与状态，在实际退出后提交候选续轮数据。
6. 已完成的工具请求由 AgentLoop 整批校验并逐个执行，观察写入 Session；后续生成只提交新增工具结果。临时模型事件发给 Web 有界订阅，不作为执行依据。
7. AgentLoop 等待工具退出并关闭 execution，随后 Session 原子提交成功 Run、完整轮次节点与结果引用，或提交明确失败/取消；`harness.waitRun` 返回终态。

## 一次 Run 的执行与记录由谁维护

同一个 Run 同时是一项正在执行的工作，以及一份需要被查询、保留的业务记录。本文区分四个职责：

| 组件 | 负责的问题 | 典型状态 |
| --- | --- | --- |
| Run | 请求能否被接受，配置是否固定，控制请求发给谁 | 准入任务、尚未交接的 execution、幂等协调、交接 Promise、Run ID |
| AgentLoop | 当前调用是什么，如何继续、取消并等它退出 | 执行闭包中的 execution、调用句柄、新增消息、取消原因、启动与完成任务 |
| Session | Run 当前是什么业务状态，哪些变化合法且已经提交 | `running/cancelling/completed` 等状态、执行阶段、事件、对话节点 |
| 本地 SQLite | 如何排他访问数据库并提交或回滚事务 | 数据库连接、文件锁、串行操作队列 |

例如 Run A 正在等待模型回答：AgentLoop 持有 A 的调用句柄，Session 组件保存 A 的 `running` 与 `model-in-flight` 记录。记录阶段不会自动发起请求；真正调用 `execution.generate()`、持有返回句柄并观察退出的是 AgentLoop。启动意图在调用之前提交，所以记录也不能单独证明某个 HTTP 请求已发出或仍然存活。

用户取消 A 时，假设取消和清理均成功且取消先于成功提交：

| 步骤 | AgentLoop 与资源提供方 | Session 组件 |
| --- | --- | --- |
| 接收取消 | A 的闭包记住原因，调用 `current.cancel()`，请求写入取消状态 | 按规则将 A 从 `running` 改为 `cancelling` |
| 等待退出 | Models/Bash 中止请求或进程；Apply Patch 停止后续文件并等当前提交与清理退出；AgentLoop 等待 `done` 和 execution 关闭 | 保留 `cancelling`，不提前宣告资源已经释放 |
| 提交终态 | AgentLoop 确认退出后请求结算 | 在事务中提交 `cancelled`、终止阶段和事件 |
| 释放登记 | AgentLoop 从 `active` 移除 A | 保留业务记录供查询 |

若完成先提交，后续取消返回原成功结果；若清理失败，AgentLoop 请求提交对应失败。Session 组件依据纯函数规则和事务确定最终记录，成功时将 Run 终态、完整轮次节点和结果引用一起提交。它不会通过修改一条状态记录来终止 HTTP 请求或子进程。

两个 Run 并发时，AgentLoop 用一个 `active` Map 管理两份独立执行闭包，Session 组件按 Run ID 保存各自记录；同一进程的存储操作串行，模型与工具工作仍可并发。进程异常退出后闭包消失，持久记录仍在；Session 组件重启时把遗留的在途 Run 结算为 `interrupted`，不自动续跑外部副作用。

## 撤销与关闭时发生什么

下表的终态以取消、清理和持久化成功为前提；已提交终态不会因后续关闭而重写。清理与持久化失败按前述规则报告。

| 事件 | 清理范围 | 在途 Run | 保留或不受影响 |
| --- | --- | --- | --- |
| `harness.close()` | 根上全部组件，先消费者后资源提供者 | 取消并等待准入、调用、execution 关闭、目录刷新与已接纳写入和结算 | 三套 SQLite 中的已提交配置、目录缓存与业务历史 |
| 替换/重启 Models 协调服务 | Web、Run、AgentLoop 和协议消费者退出，然后 Models 清理 execution 与管理操作 | 未完成工作通常以 `dependency-unavailable` 失败 | Session、Prompt、Agent Prompt、Projects、业务 SQLite |
| 单个协议注销/重注册 | 仅该注册代的 execution、发现和连接检查 | 在途模型调用取消；已接受工具由 AgentLoop 继续执行并等待，下次生成因旧 execution 关闭而失败 | 其他协议、配置记录、业务查询；新代不会被旧代清理撤销 |
| 编辑/停用 ProviderConnection 或 ModelConfiguration，替换/删除 Key | 不重启组件，不取消已打开 execution | 使用原快照和已取得凭据继续 | 已接受 Run；新 execution 使用新状态或明确拒绝 |
| 卸载 Models 凭据/存储 | Models 及其消费者先退出，再清理凭据操作或配置数据库 | 取消并等待，通常以依赖不可用失败 | Session、Prompt、Projects 和业务数据库 |
| 卸载 Models 目录来源/缓存/服务 | Web 与目录消费者先退出，再清理刷新、请求和缓存写入 | 模型调用继续使用已固定配置 | Models 执行、协议、凭据、Session 与业务数据库 |
| 卸载业务 SQLite | Web、Run、AgentLoop、Session、工具、Projects、Agent Prompt、Prompt 按依赖退出，再关闭连接 | 取消并等待后结算 | Models 的配置库、协议与凭据服务 |
| 卸载 Agent Prompt | Web、Run 退出；Run 取消并等待已接收工作 | `dependency-unavailable` | Prompt、Session、Models；AgentLoop 服务可保留 |
| 卸载 Session | Web、Run、AgentLoop 先退出，再等待记录操作与通知 | `dependency-unavailable`，历史保存在数据库 | Prompt、Agent Prompt、Projects、Models |

单个依赖恢复后，其消费者由 Nya 自动重启，门面下一次调用取得当前服务。协议重新注册只使新 execution 可用，不复活旧执行链。应用整体 `close()` 后门面保持关闭，重新启动须再次装配。

## 附：H0 资源探针

`src/resource-probe.ts` 中的 `h0-resource-probe` 不属于 Harness 运行时，`createHarness` 不会安装它。它是 H0 阶段用来验证资源归属的最小组件：注入 `h0.model`，提供 `h0.runs`，卸载时取消并等待自己发起的调用。`tests/resource-boundaries.test.mjs` 仍用它确认 Nya 的关闭顺序与资源退出等待。

它持有接收标志、调用到退出 Promise 的活动映射以及清理错误；没有 Session、持久 Run、幂等记录或工具循环。该组件仅验证资源所有者必须取消并等待退出的基础契约。
