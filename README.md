# AnyboxV2

基于相邻的 NyaCore 构建 Agent Harness。[通用 Models 模块](packages/models/README.md) 已接入 Harness 与本机 Web：用户在统一模型目录选择 Provider、配置 API Key，适用模型自动加入可用列表；每个会话独立选模并查看流式回答。模块提供 `models`、`models.settings`、`models.protocols`、受信 `models.source-data` 和可选目录刷新服务 `models.catalog`，不依赖 Harness、业务 Session 或前端框架；[架构图](docs/architecture/models-module.md)说明其资源与扩展边界。

应用只使用一个 Nya 根 Context。Models 配置存储、系统凭据、模型服务、协议和目录组件，与 Harness 的 SQLite、Prompt、Projects、Session、Run、AgentLoop、Bash、Apply Patch 直接安装在同一根。Nya 管理依赖、重启和清理顺序；Provider、Model、项目和会话都是数据记录。

当前项目框架见[三页架构说明与预览](docs/architecture/current-framework.md)，或用 draw.io 打开[可编辑架构图](docs/architecture/anybox-current.drawio)，查看整体组件、Models 模块与一次 Run 的执行和资源结算。

Session 持有完整轮次对话树，允许同一父节点启动多个 Run。新请求必须提供 `parentNodeId`（空会话用 `null`）；成功节点只继承祖先路径，并在资源退出后原子提交。Web 支持节点查看、分支选择、多 Run 状态及最多四个跨项目拖拽分屏，布局与查看位置在当前标签页内恢复。详见[对话树设计](docs/session-conversation-tree.md)。

## 最小调用

先按 [Models 安装示例](packages/models/README.md#install-in-an-application)在根上安装配置存储、凭据、模型服务和需要的协议，通过 `models.settings` 选择 Provider 定义并创建连接；有 Key 的适用模型自动形成执行配置。自定义模型另建用户定义和配置。随后装配 Harness：

```js
import { createHarness } from './dist/harness.js'
import { createLocalSqliteComponent } from './dist/storage/sqlite.js'

// root 已提供 models；assistant 是保存过的 ModelConfiguration ID。
await root.installComponent(createLocalSqliteComponent('./data/harness.sqlite'))
const harness = await createHarness(root, {
  agents: [{ id: 'demo', instructions: 'Answer briefly.', modelId: 'assistant' }],
  canManageAgent: (actorId, agentId) => actorId === 'alice' && agentId === 'demo',
})
try {
  const project = await harness.openProject(process.cwd())
  const session = await harness.createSession(project.id, 'demo', 'assistant')
  const run = await harness.startRun({
    sessionId: session.id, parentNodeId: null, input: 'Hello',
    modelId: 'assistant', idempotencyKey: 'request-1',
  })
  console.log(await harness.waitRun(run.id))
} finally {
  await harness.close()
}
```

模型选择顺序为本次 `RunInput.modelId`、会话的 `modelId`、Agent 的可选默认 `modelId`。`selectSessionModel(sessionId, modelId)` 只影响后续 Run；同一幂等键始终返回原 Run，修改输入、父节点或显式模型 ID 会冲突。旧会话没有选择时可在 Web 补选模型。具备有效工具能力的模型收到 Bash 与 Apply Patch 定义，其余可用模型执行纯文本调用。

Run 在准入时通过 `models.open()` 固定配置、能力、协议版本和凭据，将无秘密的 `execution.snapshot` 交给 Session，再把 execution 直接交给 AgentLoop。每轮 `generate()` 只追加新消息，模型模块保管原生续轮上下文；AgentLoop 校验并执行工具。模型 `result` 在实际退出与上下文提交后才返回；工具的 `result` 与 `done` 仍分别观察。AgentLoop 关闭 execution 后才能提交成功节点，取消或清理失败不会伪造完成。

Prompt 支持草稿、不可变发布版本及 Agent 绑定，用途为 `agent-instruction`、`task-template`、`context`；`task-template` 必须恰含一个 `{{input}}`。编辑、发布后还需绑定，新 Run 才使用新版本。身份与授权由受信宿主提供，不能信任客户端自报 `actorId`。详见 [Prompt 管理](docs/prompt-management-design.md)。

## 模型配置与凭据

Provider/Model 管统一服务商与模型定义，标记 user 或 external 来源。ProviderConnection 管账号连接、协议、地址、认证和超时；ModelConfiguration 关联定义和连接，固定远端标识/模型定义版本、能力和参数。保存连接与 Key 后自动准备适用模型，每个连接/模型定义只有一个基础配置，额外参数预设使用 baseline:false。每次保存生成不可变版本，`expectedRevision` 检查并发编辑；配置、停用或密钥变更只影响新 execution。模型能力区分支持、不支持和未知，前端分别显示声明与当前有效能力。未知能力不会被自动判定为支持。

本机宿主同时安装 Responses、标准 Chat Completions、Anthropic Messages、Gemini Interactions 及 DeepSeek 非推理扩展。协议提供参数表单、范围、枚举和新建表单默认值；未设置的可选参数保持省略，模型发现只返回候选项，不覆盖本地配置。Anthropic 的 `maxOutputTokens` 必填，新建表单预填 `4096`；Gemini Interactions 固定 `store: false`，当前参数不接受 temperature 或旧推理预算。保存不需要网络检查。当前调用契约接受文本、工具与流式事件，其他模态只作为目录参考信息。

DeepSeek 扩展复用通用 Chat Completions 传输与解析，只负责 `thinking: { type: 'disabled' }`、`max_tokens` 等原生差异；不支持推理参数或 `developer` 消息。接口依据见 [DeepSeek Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)。Responses 使用 `store: false`，在私有 execution 中保留 reasoning、phase 与函数续轮数据，不进入 Session 数据库。

Models 默认独占 `./data/models.sqlite`，与 Harness 数据库分开；数据库只保存配置、历史、凭据引用与清理日志。密钥保存在 macOS Keychain、Windows Credential Manager 或 Linux Secret Service，系统存储不可用时返回固定 `credential-unavailable`，仍可查看非秘密配置，不回退到明文或 SQLite。管理读取、Run 快照和错误均不返回密钥。服务名不是权限边界，`models.settings` 只交给受信宿主。

公开来源匿名读取 [models.dev](https://models.dev) 的完整 JSON，使用独立 `models-catalog.sqlite` 缓存。启动优先采用 Models 配置库已接纳的来源，再使用有效缓存或随包离线快照；成功检查（含 304）24 小时后过期，失败一小时后重试，手动刷新可立即检查。来源接纳到统一 Provider/Model 定义后，新增适用模型补齐缺少的基础配置；已有连接、配置与在途 execution 保持固定，来源移除保留已配置模型。能力、价格与限制带显式来源，未知字段保持未知；同一 Provider 定义可对应多个独立账号连接。

## Apply Patch 工具

Harness 在应用根安装 `tools.apply-patch`，向模型提供 `apply_patch({ patch })`；Bash 继续负责命令、检查和测试。补丁采用 `*** Begin Patch` / `*** End Patch`，支持 Add、Delete、Update、Move、多块 `@@`、精确行锚点和 EOF 标记；不接受 heredoc、标准 unified diff 或环境指令。文本解析与修改是纯函数，文件组件独占跨项目串行队列和临时资源，无新工具注册中心。

相对路径基于项目目录，绝对路径和 `..` 按应用用户的文件权限访问，不构成沙箱。仅处理普通 UTF-8 文本文件，拒绝目标符号链接、多硬链接、NUL、无效编码和混合换行；更新保留 BOM、LF/CRLF 与末尾换行习惯。上下文必须精确、唯一并按原文件顺序匹配。全部文件先预检，再逐项提交并检查源文件是否变化；创建和移动目标不能覆盖已有文件。预检不建立跨文件事务，也不能与 Bash 或外部写入者形成文件锁。

工具返回 `applied`、`rejected`、`partial` 或 `cancelled`，包含已经完成的 `changes`、尚未完成的 `pending` 和可选诊断。语法或文件冲突作为观察回填给模型；取消不回滚已完成变更，`done` 等当前文件提交和临时资源清理完成。清理失败使 Run 失败并保留已知变更事实。Web 可展示补丁预览与这些结果；新工具事件使用 `tool-*`，执行计数使用 `toolCalls`，旧 Bash 记录在读取时兼容。本轮 Apply Patch 验证使用本地文件、受控模型及模拟 HTTP，未做真实模型联网验收；详细限制见 [组件说明](docs/harness-components.md#apply-patch-工具)。

## 本机 Web 界面

运行 `npm run web`，打开终端打印的 `http://127.0.0.1:<port>` 地址。在“设置 → 模型服务”中：

1. 在公共目录中选择提供方和连接方案，点击“填写新提供方”；也可选择模板或手动填写。调整账号名称、代理地址、认证和 API Key 后保存。
2. 选择目录模型并点击“填写模型配置”，或获取连接返回的远端候选、手动填写模型标识；确认能力与默认参数并保存。
3. 回到会话的模型选择器，选择本地 Model 后发送消息。

可以编辑、启停提供方与模型，替换或删除 Key，查询历史版本并显式检查连接。修改保存后立即作用于新 Run，已接受 Run 保留原配置。Key 只显示配置状态；无需认证的提供方也可使用。提供方的协议创建后不可更改，要切换协议需创建新提供方。

在“我的连接”选择账号后，详情顶部的“删除连接”会先展示确认信息。确认后删除该连接、Key 及其基础模型和参数预设，保留 Provider/Model 定义、配置历史、历史对话和已开始的 Run；使用已删除配置的会话须重新选择模型。删除最后一个连接后，重启不会重新迁入旧默认连接。

首次使用空 Models 数据库时，宿主将旧 `ANYBOX_LLM_*` 配置导入固定的默认连接/模型，并尝试从旧 `anybox` 凭据命名空间复制对应密钥，保留原条目。之后重启不会重复读取旧密钥或覆盖用户配置；旧环境变量不再负责运行时切换。若启动中断后环境协议改变，已提交连接会保留，由设置页完成模型配置。

| 环境变量 | 默认值与用途 |
| --- | --- |
| `ANYBOX_WEB_PORT` | `0`，由系统分配本机端口 |
| `ANYBOX_HARNESS_DATABASE` | `./data/harness.sqlite`，业务数据 |
| `ANYBOX_MODELS_DATABASE` | `./data/models.sqlite`，模型配置，不能与业务数据库相同 |
| `ANYBOX_MODELS_CATALOG_DATABASE` | 默认在配置库旁的 `models-catalog.sqlite`，不能与配置库或业务库共用文件及文件别名 |
| `ANYBOX_MODELS_NAMESPACE` | `anybox.models`，系统凭据命名空间 |
| `ANYBOX_LLM_API` | 仅初次导入：`deepseek-chat-completions` 或 `openai-responses` |
| `ANYBOX_LLM_MODEL` | 仅初次导入：DeepSeek 默认 `deepseek-flash`，Responses 必填 |
| `ANYBOX_LLM_BASE_URL` | 仅初次导入：DeepSeek 默认 `https://api.deepseek.com`，Responses 默认 `https://api.openai.com/v1` |
| `ANYBOX_LLM_TIMEOUT_MS` | 仅初次导入：`30000`，正整数且不超过 `2147483647` |
| `ANYBOX_LLM_MAX_OUTPUT_TOKENS` | 仅初次导入：可选正整数，省略时使用服务端默认值 |
| `ANYBOX_LLM_TEMPERATURE` | 仅初次导入：`0` 到 `2`，DeepSeek 默认 `0.7`，Responses 省略 |

环境变量仍在安装资源前校验，不加载 dotenv；已设置的空值会报错。API 地址只填基础地址，不附加 `/responses` 或 `/chat/completions`，不带用户名、密码、查询串或 fragment。

“设置 → Prompt 管理”可编辑、发布、预览并绑定版本。“模型服务”配置与会话选择通过薄 HTTP 入口调用 Nya 服务。`/api/v1/changes` 同时提供提交后的 Run 变更提示和临时模型进展；慢连接受有界队列限制，只影响展示订阅。最终内容以持久 Run 和节点查询为准，刷新不会恢复半截流式输出。工具过程、取消与失败仍由 Run 状态展示。

宿主只监听 `127.0.0.1`，暂不提供远程访问和账号体系；SIGINT/SIGTERM 通过 `harness.close()` 停止接收并等待整个应用根清理。异常退出的在途 Run 重启后结算 `interrupted`，不重放工具。详见 [Web 客户端设计](docs/web-client-design.md)。

## 本地验证

Node.js 最低版本为 22.13。将 NyaCore 与本仓库放在同一目录，先在 NyaCore 运行 `npm ci` 和 `npm run build`，再在本仓库运行：

```sh
npm ci
npm run check
```

根检查同时构建和测试 `packages/models`，覆盖目录归一化、离线缓存、刷新调度、协议解析、配置版本、凭据日志、并发与生命周期，以及 Harness、迁移和 Web 行为。默认测试使用临时 SQLite、内存凭据和模拟 HTTP。本次浏览器验收完成目录建连接、修改代理地址、能力与 4096 参数预填、保存模型、会话选模和原生 Bash 工具续轮；刷新保留表单草稿。未调用真实模型或系统凭据库。可用 `node tests/helpers/catalog-browser-host.mjs` 复现目录流程，详情见 [验收记录](docs/models-catalog-validation.md)。

真实凭据验证需另行运行 `ANYBOX_KEYRING_TESTS=1 node --test tests/system-keyring.test.mjs`；Linux 无 Secret Service 时加 `ANYBOX_KEYRING_EXPECT_NO_STORE=1` 验证固定拒绝且无明文回退。2026-09-25 的 macOS 验收属于旧 API Key 组件，不能代替新 Models Vault 的平台验收；本次 macOS、Windows、Linux 原生凭据测试均未执行。`packages/api-key-manager` 保留独立通用包与旧凭据读取用途，旧应用 `llm` 和凭据 Nya 包装已删除。

| 路径 | 用途 |
| --- | --- |
| `packages/models/` | 通用 Models 服务、配置与凭据存储、协议实现及测试 |
| `src/agent/`、`src/prompt/` | Agent 定义、Prompt 草稿、版本与绑定 |
| `src/project/`、`src/session/` | 项目身份、会话树、Run 记录与恢复 |
| `src/run/` | Run 准入、Models execution 交接、AgentLoop 与状态转换 |
| `src/tool/` | Bash 与 Apply Patch 资源组件 |
| `src/storage/` | Harness SQLite 事务、领域迁移与排他所有权 |
| `src/harness.ts` | 受信组合根与服务转发 |
| `src/web/`、`web/` | 本机宿主、Models 装配、DeepSeek 扩展与浏览器界面 |
| `tests/helpers/controlled-models.mjs` | 可控 Models 契约替身 |
| `tests/helpers/managed-models.mjs` | 实际 Models 模块与可控协议的测试装配 |
| `docs/harness-components.md` | 组件职责、依赖、状态归属与清理 |
| `docs/agent-harness-plan.md` | 阶段、边界与验收记录 |
