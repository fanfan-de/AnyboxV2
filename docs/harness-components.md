# Harness 组件说明

状态：2026-09-25，对应当前代码。本文逐个说明 Harness 运行时的 Nya 组件：它负责什么、提供哪个服务、依赖谁、持有哪些资源、关闭时如何清理。阶段计划见 [Agent Harness 重建计划](./agent-harness-plan.md)，建模方法见 [用函数式思想建模 Agent Harness 的开发](./functional-agent-harness-development.md)，Prompt 与存储的专题设计见 [Prompt 管理模块设计](./prompt-management-design.md) 和 [本地 SQLite 存储组件](./local-sqlite-storage.md)。

## 总览

### 放置规则

当前只使用一个应用根 Context。应用先安装大模型 API 组件和本地 SQLite，`createHarness` 再把 Agent、Prompt、状态、Session、Run、AgentLoop 等组件直接安装在同一个根上。组件按职责和依赖拆分，不为 Harness、项目或任务建立额外的 Nya 作用域。Nya 服务按名称注册在根上；同一个根只安装一套 Harness 服务，也只安装一种大模型 API 组件。

应用拥有根上组件的生命周期。`harness.close()` 是当前的应用关闭入口：先停止接受外部调用，再卸载根上的全部组件，等待清理。大模型 API 组件的在途请求和数据库连接也会关闭；该 Harness 门面关闭后不可复用。重启应用时需重新装配组件，通常新建根。

### 组件与依赖

```text
应用根 Context
├─ DeepSeek Chat Completions  提供 llm
├─ 本地 SQLite ....... 提供 local-storage
├─ Agent ............ 提供 harness.agents
├─ 内存状态 .......... 提供 harness.state
├─ Session .......... 提供 harness.sessions       注入 agents、state
├─ Prompt ........... 提供 harness.prompts        注入 local-storage
├─ Agent Prompt ..... 提供 harness.agent-prompts  注入 agents、prompts、local-storage
├─ AgentLoop ........ 提供 harness.agent-loop     注入 state、llm
└─ Run .............. 提供 harness.runs           注入 agents、state、agent-prompts、llm、agent-loop
```

`createHarness` 按上面的依赖顺序安装业务组件；关闭时由 Nya 按依赖关系先清理消费者，再清理其资源提供者。

| 组件 | 位置 | 源码 |
| --- | --- | --- |
| DeepSeek Chat Completions | 应用根 | `src/llm/deepseek-chat-completions/component.ts`、`domain.ts`；服务契约在 `src/llm/port.ts` |
| 本地 SQLite | 应用根 | `src/storage/sqlite.ts`、`src/storage/port.ts` |
| 组合根 | 安装到应用根 | `src/harness.ts` |
| Agent | 应用根 | `src/agent/component.ts`、`src/agent/domain.ts` |
| 内存状态 | 应用根 | `src/run/memory-state.ts` |
| Session | 应用根 | `src/run/session-component.ts` |
| Prompt | 应用根 | `src/prompt/component.ts`、`domain.ts`、`sqlite-storage.ts`、`legacy-json-import.ts` |
| Agent Prompt | 应用根 | `src/agent/prompt-binding-component.ts`、`prompt-binding-storage.ts` |
| AgentLoop | 应用根 | `src/run/agent-loop-component.ts` |
| Run | 应用根 | `src/run/component.ts`、`src/run/domain.ts` |

### 所有组件共用的约定

- **组件形态**：每个组件是一个带 `name`、`inject` 和 `apply(ctx, config, deps)` 的对象。`apply` 完成初始化并用 `ctx.provide` 提供服务后立即返回，不运行长期循环。`deps` 是本轮依赖的快照，组件只通过它使用其他服务。
- **撤销顺序**：Nya 卸载一个组件时，先撤回它提供的服务，并等所有依赖该服务的组件退出，再按后进先出执行它登记的 Effect 清理。所以任何组件被撤销时，下游消费者总是先停下。
- **停止接收 → 取消 → 等待**：持有在途操作的组件都有一个 `accepting` 标志。清理时先置为 `false` 拒绝新请求，再取消已接受的操作，最后等它们真正退出。
- **`OwnedCall`**（`src/contracts.ts`）：可取消的调用分成 `result`（业务结果）、`cancel(reason)` 和 `done`（实际工作与资源都已退出）。`result` 已结算不代表资源已释放，只有 `done` 才代表。
- **`llm` 服务契约**（`src/llm/port.ts`）：Run 和 AgentLoop 只依赖 `prepare(profileId)` 和 `call({ plan, messages })` 两个方法，以及项目自有的消息、调用计划和失败类别。提供该服务的 API 组件把原生请求、响应类型和凭据留在自己内部。
- **纯函数与副作用分离**：各目录下的 `domain.ts` 放校验和状态转换的纯函数，返回冻结的新值；时间和 ID 通过 `RuntimeInputs`（`now`、`newId`）从外部传入。`component.ts` 才接触 Nya、存储和 HTTP。
- **错误不泄露细节**：提供方的原始错误在边界处归一为固定类别和固定文案，不把第三方错误或传输细节带进 Run。

## 应用根中的资源组件

### DeepSeek Chat Completions

**服务** `llm` · **注入** 无 · **创建** `createDeepSeekChatCompletionsComponent(config, transport)`

这是应用当前唯一安装的大模型 API 组件。组件按 API 格式划分，而不是按供应商再抽象一层：它直接拥有 DeepSeek 非流式 Chat Completions 的原生请求格式、HTTP 传输、密钥、响应解析、超时、取消和清理。以后接入其他 API 格式（例如 OpenAI Responses API）时，是另一个提供同一 `llm` 服务的组件；应用启动时只安装其中一个。

**配置。** 构造组件时 `validateDeepSeekConfiguration` 校验配置：`version` 非空；`profiles` 非空，每个 profile 只允许 `id`、`model`、`maxOutputTokens`、`temperature`、`timeoutMs` 这几个字段，ID 唯一；`maxOutputTokens` 为正整数，`temperature` 在 0 到 2 之间，`timeoutMs` 为不超过 2147483647 的正整数。校验结果是冻结的选择项，附带配置版本号。配置或传输选项无效时构造直接抛出 `TypeError`。

**传输与凭据。** `transport` 提供 `apiKey()`、可选的 `baseUrl`（必须是 HTTP 或 HTTPS，默认 `https://api.deepseek.com`）和可选的 `fetch`。`apply` 启动时读取一次密钥，密钥为空则组件启动失败；密钥只存在于组件闭包中，不进入调用计划、Run 状态或对外快照。轮换密钥或修改配置的方式是由应用替换整个组件。

**服务接口**（`LLMPort`）：

- `prepare(profileId)`：Run 准入时调用，返回冻结的调用计划。计划对外只包含 `profileId` 和 `configVersion`；对应的 profile 保存在组件私有的映射中，只对当前这一轮组件实例有效。未知 profile 抛出 `model-unavailable`，组件正在关闭时抛出 `dependency-unavailable`。
- `call({ plan, messages })`：把项目自有的消息映射为原生请求体（`model`、`messages`、`max_tokens`、`temperature`、`stream: false`），带 Bearer 密钥 POST 到 `/chat/completions`，返回 `OwnedCall<string>`。来自其他组件实例的计划抛出 `model-unavailable`。

**调用语义。**

- **同步拒绝**：消息为空，或含有 `developer` 角色时，`call` 同步抛出 `unsupported-request`，不发起请求。Chat Completions 未记录 `developer` 角色，组件不会擅自改变其优先级。
- **超时**：超过 profile 的 `timeoutMs` 后中止请求，`result` 立即以 `timeout` 失败；`done` 仍要等传输真正退出才结算。
- **传输与 HTTP 失败**：`fetch` 抛错归一为 `provider-failure`；非 2xx 响应会先取消响应体，再以 `provider-failure` 失败，响应内容不进入错误信息。
- **响应校验**：JSON 解析失败、`choices[0].finish_reason` 不是 `stop`、或 `message.content` 不是字符串时，`result` 以 `invalid-response` 失败。被截断的输出和工具调用因此不会被当作成功。
- **取消**：`cancel(reason)` 通过 `AbortController` 中止请求，原因作为 `signal.reason` 传给传输。传输退出后 `result` 以 `provider-failure` 失败（由超时引起的则是 `timeout`）；`done` 在 fetch 与响应体读取都退出后完成。
- **清理失败**：取消非 2xx 响应体失败时，`done` 以 `cleanup-failure` 失败，并在组件卸载时一并报告。

失败类别共七种：`model-unavailable`、`dependency-unavailable`、`unsupported-request`、`timeout`、`provider-failure`、`invalid-response`、`cleanup-failure`。每种类别都有固定文案，不带提供方的原始信息。

**清理。** 卸载时停止接收，以 `llm-disposed` 中止所有在途请求并等待各自的 `done`，收集到的清理失败统一抛出。

**替换。** 应用卸载旧组件并安装新组件时，Nya 先停下 Run 和 AgentLoop，这期间的在途 Run 以 `dependency-unavailable` 失败；旧组件等请求退出后卸载，新组件一提供 `llm` 服务，Run 和 AgentLoop 就自动重启。同一幂等键仍返回原 Run，新键才使用新配置和新密钥。

**尚未支持**：流式输出、工具调用（`tool_calls`）、`developer` 角色、`reasoning_content`、`usage` 统计、`top_p` 等其他采样参数、重试与限流处理。真实 API 尚未联网验收，行为测试全部使用本地 HTTP 服务或可控的 `fetch`。

### 本地 SQLite

**服务** `local-storage` · **注入** 无 · **创建** `createLocalSqliteComponent(file)`

本地 SQLite 是整个应用通用的本地持久化组件，排他持有一个数据库文件及其连接。它不知道任何领域的表结构。

**启动。** `apply` 依次完成：规范化路径并创建父目录；创建同路径的 `.lock` 目录以取得排他所有权（已存在时以 `occupied` 失败）；打开连接；初始化存储自身的表布局。布局用 `PRAGMA user_version` 标记，并建立 `schema_migrations(domain, version)` 表；遇到无法识别的已有数据库会以 `schema-version` 拒绝启动。启动中任何一步失败，已取得的连接和锁都会回滚释放。

**服务接口**（`LocalStoragePort`）：

- `read(work, signal?)`：在只读模式下执行回调，回调拿到 `StorageReader`，提供参数化的 `get` 和 `all`。
- `transaction(work, signal?)`：以 `BEGIN IMMEDIATE` 开启事务执行回调。回调额外拿到 `execute`；它抛错、被拒绝或 `signal` 在提交前中止，都会回滚。一个事务可以同时写多个领域的表。
- `migrate(domain, migrations)`：为一个领域补齐缺失的迁移。版本号在领域内从 1 连续编号；每个迁移和它的版本记录在同一事务中提交，失败则回滚并以 `migration-failed` 拒绝。迁移必须是同步函数。领域记录的版本高于传入的迁移列表时以 `schema-version` 拒绝，防止旧代码误读新表。

所有操作在同一连接上按接受顺序串行执行。回调结束后，交给它的读写句柄立即失效。错误统一为带 `code` 的 `LocalStorageError`，驱动的对象和错误不会越过这个组件。

**清理。** 卸载时停止接收新操作，等待队列中已接受的读、事务和迁移全部结束，然后关闭连接，最后删除锁目录。取消不会强行中断异步回调，回调须自己响应 `signal`。进程异常退出后留下的 `.lock` 需要在确认原进程已停止后手动删除。

## 组合根：createHarness

**源码** `src/harness.ts` · **形态** 将业务组件安装到现有根的受信函数

`createHarness(root, options)` 是受信的组合根。它只接受宿主的根 Context，要求根上已经有 `llm` 和 `local-storage` 服务。

**选项**（`HarnessOptions`）：

- `agents`：Agent 定义列表，必填。
- `legacyPromptStorePath`：可选，首次启动时从旧 Prompt JSON 文件导入。
- `canManageAgent(actorId, agentId)`：可选，由宿主提供的 Agent 管理授权；默认允许所有已认证用户。
- `now`、`newId`：可选，替换时钟和 ID 生成器，测试中用来得到确定的结果。

**启动。** 它在根上按依赖顺序逐个安装组件并等待就绪。某个组件启动失败会直接抛出它的错误；如果它因缺少依赖停在 `PENDING`，会报出所缺的服务名，例如 `component harness-agent-loop is waiting for llm`。启动失败会卸载根上的全部组件，清理已安装组件以及大模型 API 组件和 SQLite，再抛出错误。

**对外接口**（`Harness`）把 Session、Run、Prompt 和 Agent Prompt 服务的公开方法合在一起，另加 `close()`。每次调用都会用 `context.get()` 取当前的服务实例，从不缓存，因此组件重启后调用自然落到新实例上；服务暂时不可用时直接报错。`getPublishedVersion` 和 `resolveRunPrompts` 只供内部组件使用，不对外暴露。

**关闭。** `close()` 是幂等的：先设置关闭标志，之后所有调用立即报 `harness is closing`；然后卸载应用根上的全部组件。关闭会等待 Run 的实际退出、Prompt 写入、大模型 API 组件的请求退出和数据库连接的清理。该 Harness 门面不能再次使用；重启应用需重新安装所需组件。

## 应用根中的业务组件

### Agent

**服务** `harness.agents` · **注入** 无 · **创建** `createAgentComponent(agents)`

Agent 组件保存本次 Harness 可用的 Agent 定义。每个定义包含 `id`、默认 `instructions`（默认系统指令）和 `modelProfileId`。

`validateAgents` 要求列表非空、ID 唯一、三个字段都是非空字符串，并返回冻结的副本。校验在 `createHarness` 期间进行，失败时 Harness 启动失败。服务只提供 `get(id)` 和 `list()`。

Agent 定义是静态的，不持久化；修改时需替换 Agent 组件或创建新的应用根。`modelProfileId` 引用的是当前大模型 API 组件配置中的 profile，这个引用直到 Run 准入时才检查：profile 不存在时，新 Run 以 `model is unavailable` 被拒绝，不会写入任何状态。

### 内存状态

**服务** `harness.state` · **注入** 无 · **创建** `createMemoryStateComponent()`

内存状态是 Session 和 Run 数据的唯一所有者。它在内存中持有 Session、Run、每个 Run 的 Prompt 快照、LLM 调用计划，以及幂等键索引。

**服务接口**（`StatePort`）：

- `createSession(id, agentId, now)`、`getSession(id)`：创建和读取 Session。
- `findAcceptedRun(input)`：准入前检查。Session 必须存在；同一 Session 下同一幂等键、同样输入时返回已有的 Run，输入不同则报错；同一 Session 已有进行中的 Run 时报错。
- `acceptRun(id, input, now, prompts, plan)`：重新检查上述条件，然后一次性写入 Run、Prompt 快照、调用计划和幂等键。整个过程是同步的，所以检查和写入之间不会插入其他操作。
- `getRun(id)`：对外可见的 Run。
- `getRunPrompts(id)`、`getRunPlan(id)`：Run 的内部快照，只给 AgentLoop 使用，不能对外暴露。
- `requestCancellation(id, now)`：把 `running` 改为 `cancelling`。
- `settleRun(id, outcome, now)`：写入终态。Run 成功时，这次的输入和输出会作为一个新轮次追加到 Session。

状态转换本身是 `src/run/domain.ts` 中的纯函数，内存状态只负责保存结果。

**清理与限制。** 卸载时停止接收并清空全部数据，没有重启恢复。Session、AgentLoop 和 Run 都依赖它，它被卸载时这三个组件会先停下。反过来，AgentLoop 或 Run 单独重启时数据不受影响，已有的 Session 和 Run 仍可查询。持久化 Run 状态属于 H3 阶段。

### Session

**服务** `harness.sessions` · **注入** `harness.agents`、`harness.state` · **创建** `createSessionComponent(inputs)`

Session 组件是创建和查询会话的入口：

- `createSession(agentId)`：确认 Agent 存在后，用 `newId` 和 `now` 在内存状态中创建 Session。
- `getSession(id)`：读取 Session 及其已完成的轮次。

它本身不保存数据，之所以单独成为组件，是为了有自己的依赖范围：它只依赖 Agent 和内存状态，所以大模型 API 组件、AgentLoop 或 Run 被替换时，创建和查询 Session 不受影响。

### Prompt

**服务** `harness.prompts` · **注入** `local-storage` · **创建** `createPromptComponent(inputs, legacyJsonPath?)`

Prompt 组件管理用户编写的 Prompt 文档及其发布版本。它只依赖存储，不知道 Agent 的存在。

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

**服务** `harness.agent-prompts` · **注入** `harness.agents`、`harness.prompts`、`local-storage` · **创建** `createAgentPromptComponent(inputs, canManageAgent, legacyJsonPath?)`

Agent Prompt 组件决定每个 Agent 实际使用哪些 Prompt 版本。每个 Agent 的每种用途类型最多绑定一个已发布版本。

**服务接口**（`AgentPromptPort`）：

- `bindPrompt(actorId, agentId, versionId)`：绑定一个版本。调用者必须通过宿主的 `canManageAgent` 授权，并且拥有该版本；新绑定会替换同一用途类型的旧绑定。
- `getAgentPrompts(actorId, agentId)`：查看某个 Agent 当前生效的 Prompt，同样需要管理权限。
- `resolveRunPrompts(agentId)`：供 Run 准入使用，返回按 `agent-instruction`、`context`、`task-template` 顺序排列的快照，每份快照包含版本 ID、角色和内容。

**默认指令。** Agent 没有绑定 `agent-instruction` 时，使用 Agent 定义中的 `instructions` 作为默认的 `system` 指令。默认指令的版本 ID 由 Agent ID 和指令内容的哈希组成，指令一变，ID 也跟着变。如果已绑定的版本读不到了，新 Run 会明确失败，不会悄悄退回默认指令。

**存储。** 启动时通过 `migrate('agent-prompt', ...)` 建立绑定表，加载绑定并逐条确认所引用的版本仍然存在，然后形成读投影。绑定写入与 Prompt 一样，先排队、再提交事务、最后更新投影。传入 `legacyJsonPath` 时，它在 Prompt 导入完成后，于自己的事务内导入旧文件中的绑定，并单独记录来源。所以 Prompt 导入成功而绑定导入失败时，重启只会补做绑定。

**清理。** 卸载时停止接收绑定，并等待已接受的写入完成。Agent 被移除时 Agent Prompt 会停下，但 Prompt 文档服务不受影响。

### AgentLoop

**服务** `harness.agent-loop` · **注入** `harness.state`、`llm` · **创建** `createAgentLoopComponent(inputs)`

AgentLoop 是已接受 Run 的执行者，独占每个 Run 的在途调用，直到调用的结果和退出都被观察到之后，才把 Run 结算为终态。当前每个 Run 只有一次模型调用，H2 阶段的工具循环也会在这里实现。它只通过 `llm` 服务契约发起调用，不知道背后是哪个 API 组件。

**服务接口**（`AgentLoopPort`）：

- `start(runId)`：从内存状态读出 Run 的 Prompt 快照、调用计划和 Session 历史，用纯函数 `buildLLMMessages` 组装消息，然后调用 `llm.call`。如果调用在发起时就同步失败（例如 `unsupported-request`），Run 立即结算为 `failed`。
- `cancel(runId, reason)`：取消一个 Run 的在途调用，见下文的取消原因。
- `wait(runId)`：返回该 Run 最终结算后的值；Run 已经结束时直接返回当前状态。

**消息组装顺序**：`agent-instruction` 快照、`context` 快照、Session 历史轮次（依次为 user 和 assistant），最后是当前输入。如果绑定了 `task-template`，当前输入会先填进模板。

**结算规则。**

1. 调用发起后立即开始观察 `done`，因为它可能早于 `result` 失败。
2. 先等 `result` 得出完成或失败，然后无论如何都等 `done`。
3. `done` 失败或取消时抛出异常，结果都改为 `cleanup-failure`。这类失败还会记录下来，在组件卸载时抛出，因此 `harness.close()` 会以失败结束。
4. Run 没有处于取消中，而这个 Run 是因依赖撤销被取消的，结果改为 `dependency-unavailable`。
5. 最后交给内存状态写入终态。

**取消原因。**

| 原因 | 来源 | Run 终态 |
| --- | --- | --- |
| `user-requested` | `harness.cancelRun` | 先变为 `cancelling`，退出后为 `cancelled` |
| `owner-disposed` | `harness.close()` 发起应用根关闭 | 同上 |
| `dependency-unavailable` | 依赖被撤销，或 AgentLoop 自身被卸载 | `failed`，类别为 `dependency-unavailable` |

**清理。** 卸载时停止接收，以 `dependency-unavailable` 取消所有仍在执行的 Run，并等它们全部结算。

### Run

**服务** `harness.runs` · **注入** `harness.agents`、`harness.state`、`harness.agent-prompts`、`llm`、`harness.agent-loop` · **创建** `createRunComponent(inputs, isHarnessClosing)`

Run 组件是 Run 的准入与对外控制入口。它决定一个请求能否成为 Run，并在接受时固定这次 Run 使用的配置；实际执行交给 AgentLoop。

**服务接口**（`RunPort`）：

- `startRun({ sessionId, input, idempotencyKey })`：按下面的准入步骤接受 Run 并启动执行。输入中不能携带模型选择。
- `getRun(id)`：查询 Run。
- `cancelRun(id)`：以 `user-requested` 取消并返回当前状态。
- `waitRun(id)`：等待终态。

**准入步骤。**

1. 校验输入。
2. 用 `findAcceptedRun` 检查重复请求。同一幂等键会原样返回最初的 Run，即使之后配置或 Prompt 绑定已经改变，也不重新解析配置、不发起第二次调用。
3. 读取 Agent 定义，调用 `resolveRunPrompts` 固定 Prompt 快照，调用 `llm.prepare` 固定调用计划。
4. 用 `acceptRun` 原子地写入 Run 和快照。
5. 交给 `AgentLoop.start` 执行。

第 2 步到第 4 步都是同步的，不会与其他请求交错。因此，同一 Session 同时只会有一个 Run 在执行，同一个幂等键也只会产生一次调用。

**对外可见的 Run** 包含 ID、Session、输入、幂等键、状态、时间、`promptVersionIds` 和 `llmSnapshot`（profile ID 和配置版本），终态时还有 `output`，或 `error` 与 `errorCategory`。Prompt 内容、模型参数和凭据都不会出现在对外的 Run 中。状态只有五种：`running`、`cancelling`、`completed`、`cancelled`、`failed`。

**清理。** 卸载时停止接收，逐个取消自己接受的 Run 并等待全部结算。取消原因由关闭方式决定：应用根正在关闭时用 `owner-disposed`，Run 因为依赖被撤销而卸载时用 `dependency-unavailable`。

## 一次 Run 经过的组件

1. 宿主调用 `harness.startRun`，组合根取到当前的 Run 服务。
2. **Run** 校验输入，通过**内存状态**检查重复请求和进行中的 Run。
3. **Run** 从 **Agent** 读取定义，从 **Agent Prompt** 取得 Prompt 快照，再请 **DeepSeek Chat Completions** 通过 `llm.prepare` 固定调用计划。
4. **Run** 通过**内存状态**原子地接受 Run，然后调用 **AgentLoop**。
5. **AgentLoop** 组装消息并调用 `llm.call`；**DeepSeek Chat Completions** 把消息映射为原生请求并发送。
6. 请求退出后，**DeepSeek Chat Completions** 完成解析和错误归一，**AgentLoop** 确定结果并在**内存状态**中结算；Run 成功时，这一轮对话追加到 Session。
7. `harness.waitRun` 返回终态。

## 撤销与关闭时发生什么

| 事件 | 先停下的组件 | 在途 Run | 不受影响 |
| --- | --- | --- | --- |
| `harness.close()` | 应用根全部组件；先退出依赖消费者，再清理资源提供者 | `cancelled`；内存数据随之清空 | 无；DeepSeek 请求中止、SQLite 也关闭 |
| 应用替换大模型 API 组件 | Run、AgentLoop，然后等旧组件的请求退出 | `failed`，`dependency-unavailable` | Agent、Session、Prompt、Agent Prompt、内存状态、SQLite |
| 应用卸载 SQLite | Run、Agent Prompt、Prompt，然后关闭连接并释放锁 | `failed`，`dependency-unavailable` | Agent、Session、内存状态、AgentLoop、大模型 API 组件 |
| Agent 被移除 | Run、Agent Prompt、Session | `failed`，`dependency-unavailable` | Prompt、内存状态、AgentLoop、大模型 API 组件 |
| 内存状态被卸载 | Run、AgentLoop、Session | `failed`，`dependency-unavailable`；随后数据清空 | Agent、Prompt、Agent Prompt、大模型 API 组件 |

所有情况下，停下的组件都会先拒绝新请求，再等已接受的操作真正退出。单个依赖组件恢复后，其消费者由 Nya 自动重启，组合根的下一次调用会取到新实例。`harness.close()` 后该门面保持关闭，重新启动须再次装配组件。

## 附：H0 资源探针

`src/resource-probe.ts` 中的 `h0-resource-probe` 不属于 Harness 运行时，`createHarness` 不会安装它。它是 H0 阶段用来验证资源归属的最小组件：注入 `h0.model`，提供 `h0.runs`，卸载时取消并等待自己发起的调用。`tests/resource-boundaries.test.mjs` 仍用它确认 Nya 的关闭顺序与资源退出等待。
