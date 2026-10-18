# Anybox

本仓库 [AnyboxV2](https://github.com/fanfan-de/AnyboxV2) 是 Anybox 后续开发的维护仓库。旧仓库 [anybox](https://github.com/fanfan-de/anybox) 已停止维护，保留历史代码与资料；新的开发、问题反馈和贡献请在本仓库进行。产品名称仍为 **Anybox**，Agent 产品名称为 **Anybox Harness**。

文档入口：[项目文档](docs/README.md) · [命名与边界](docs/naming.md) · [模块与组件手册](docs/modules/README.md)。组件按内聚职责分目录，每个组件有独立的接口、功能、数据归属、生命周期与测试说明。

Anybox 是 NyaCore 应用的宿主应用，负责受信应用的注册、装配、启停、公共资源与界面承载。正式目录目前提供 **Anybox Harness** 与 **Claude Agent** 两个独立应用包。Anybox Harness 是 Agent 产品，其可部署到本地或远端服务器的通用服务端核心称为 **harness server**；Agent 工作区、模型管理和 Prompt 管理属于 Anybox Harness；执行设备连接、凭据与转发由两个应用各自拥有，不设置应用间共享业务层。源码中通用宿主位于 `packages/host/src/`，Anybox Harness 完整应用位于 `packages/app-harness/src/`，默认目录与进程入口位于 `packages/distribution/src/entrypoints/`；详见 [应用宿主](docs/products-v1.md)与[目录边界](docs/harness-module-boundary.md)。[通用 Models 模块](packages/models/README.md) 已接入 Anybox Harness 与本机 Web：用户在统一模型目录选择 Provider、配置 API Key，适用模型自动加入可用列表；每个会话独立选模并查看流式回答。模块提供 `models`、`models.settings`、`models.protocols`、受信 `models.source-data` 和可选目录刷新服务 `models.catalog`，不依赖 Anybox Harness、业务 Session 或前端框架；[Models 模块手册](docs/modules/models/README.md)说明其资源与扩展边界。

每个执行实例使用一个 Nya 根 Context，本机客户端另有独立根。Models 配置存储、系统凭据、模型服务、协议和目录组件，与 harness server 的 SQLite、Prompt、Projects、Session、Run、RunRuntime、协议应用绑定、Bash、Apply Patch 直接安装在同一根。Nya 管理依赖、重启和清理顺序；Provider、Model、项目和会话都是数据记录。

当前原生协议框架见[组件说明](docs/harness-server-components.md)与[原生协议迁移设计](docs/native-protocol-agent-framework-design.md)。进程与可组合单元的图示见[架构快照（2026-10-15）](docs/architecture/anybox-harness-architecture-2026-10-15.md)，当前包边界和独立服务装配以[应用包设计](docs/application-packages-design.md)与[独立业务服务](docs/application-standalone-services.md)为准。

Session 持有完整轮次对话树，允许同一父节点启动多个 Run。新请求必须提供 `parentNodeId`（空会话用 `null`）；成功节点只继承祖先路径，并在资源退出后原子提交。Web 支持节点查看、分支选择、多 Run 状态及最多四个跨项目拖拽分屏，布局与查看位置在当前标签页内恢复。详见[对话树设计](docs/session-conversation-tree.md)。

macOS Apple Silicon 桌面版使用 Electron，完整复用这套 Web 前端和服务。`npm run desktop:dev` 启动开发版，`npm run desktop:make` 生成 `.app`、DMG 和 ZIP；安装用户无需安装 Node.js。桌面内置本机 harness server 并支持远端设备，数据与 Web/CLI 隔离。关闭窗口隐藏应用，明确退出才关闭本机服务。详见[桌面构建与安装](docs/desktop-packaging.md)及[运行边界](docs/desktop-runtime.md)。

源码通过 npm workspaces 拆为 `host`、`app-harness`、`app-claude-agent` 及独立共享包，最小接入契约位于 `application-api`。`distribution` 保留现有 CLI、桌面与默认应用组合；宿主不直接依赖具体应用、设备连接、目录适配或 Vault。纯界面应用无需后台和业务 HTTP。D0a 源码拆包之后，D0a.1 提供[应用业务服务独立运行](docs/application-standalone-services.md)：两个应用拥有各自的 HTTP、认证和独立入口，Anybox 复用同一业务装配；不要求安装 host、distribution 或另一个应用。D0b 已完成生命周期接入、能力版本门禁及按消费者装配，D1.1 已建立独立安装事实、操作账本与跨进程使用凭证；D1.2 提供独立空宿主、完整签名应用包和只读校验/准备工具，构建命令及信任策略见[产物手册](docs/modules/package-management/archives.md)。D1.3 已接入[本地文件安装与中断恢复](docs/modules/package-management/installation.md)：先登记再读取，验证签名与独立准备后提交不可变目录，成功保留为已安装待生效，不启动应用业务。客户端管理入口和离线 CLI 支持查询、取消及显式恢复，信任策略由宿主外部配置；D1.4 已接入[正式角色加载与受控生效](docs/modules/package-management/activation.md)：最小 CLI/桌面宿主通过固定角色入口、连续使用凭证与稳定连接交接；全部相关应用及页面通过关闭保护并实际退出后才重启，全部新代 ready 才显示完成，新装应用保持关闭。宿主始终只管生命周期，业务及数据归各应用。原 distribution 默认完整组合仍保留，旧全量桌面尚未整体迁入按需发行；D1.5 已接入本机卸载和代码回收：全部页面与角色实际退出后回收所有安装版本，默认保留数据，独立使用者阻塞、删除失败显式恢复，其他应用工作区保留；D2 接在线下载，D3 接旧发行迁入，见[应用包设计](docs/application-packages-design.md)。

## 最小调用

先按 [Models 安装示例](packages/models/README.md#install-in-an-application)在根上安装配置存储、凭据、模型服务和需要的协议，通过 `models.settings` 选择 Provider 定义并创建连接；有 Key 的适用模型自动形成执行配置。自定义模型另建用户定义和配置。随后装配 harness server 核心：

```js
import { installHarnessServerCore } from './dist/applications/harness/core/index.js'
import { createLocalSqliteComponent } from './dist/storage/sqlite.js'
import { createImageAssetsComponent } from './dist/applications/harness/core/image/component.js'

// root 已提供 models；assistant 是保存过的 ModelConfiguration ID。
await root.installComponent(createLocalSqliteComponent('./data/harness.sqlite'))
await root.installComponent(createImageAssetsComponent({ directory: './data/harness.sqlite.images' }))
const installation = await installHarnessServerCore(root, {
  agents: [{ id: 'demo', instructions: 'Answer briefly.', modelId: 'assistant' }],
  canManageAgent: (actorId, agentId) => actorId === 'alice' && agentId === 'demo',
})
const { api } = installation
try {
  const project = await api.openProject(process.cwd())
  const session = await api.createSession(project.id, 'demo', 'assistant')
  const run = await api.startRun({
    sessionId: session.id, parentNodeId: null, input: 'Hello',
    modelId: 'assistant', idempotencyKey: 'request-1',
  })
  console.log(await api.waitRun(run.id))
} finally {
  try { await installation.close() } finally { await root.fiber.dispose() }
}
```

模型选择顺序为本次 `RunInput.modelId`、会话的 `modelId`、Agent 的可选默认 `modelId`。`selectSessionModel(sessionId, modelId)` 只影响后续 Run；同一幂等键始终返回原 Run，修改输入、父节点或显式模型 ID 会冲突。新会话在首次接受 Run 时固定协议；已有 dialogue-v1 会话只读，需新建空会话开始原生历史。具备有效工具能力的模型收到 Bash 与 Apply Patch 定义，其余可用模型执行纯文本调用。

Run 先检查幂等键，再由协议应用绑定通过 `models.openNative()` 固定配置、驱动代与凭据，生成 PreparedRunProgram 交给 RunRuntime。协议 Loop 直接解释原生响应；每次调用先 `prepareExchange()`，经 Runtime 持久化意图后启动，等待结果与真实退出再提交观察。Session 保存增量原生记录及不可变父链，跨 Run、重启和分支恢复保留签名、reasoning、原生工具 ID 与顺序。Runtime 关闭 program 后才提交成功节点，取消或清理失败不会伪造完成。浏览器只接收安全展示投影。

Prompt 支持草稿、不可变发布版本及 Agent 绑定，用途为 `agent-instruction`、`task-template`、`context`；`task-template` 必须恰含一个 `{{input}}`。编辑、发布后还需绑定；Session 首次接受固定初始 instruction/context，所有根分支与后代沿用原记录。当前 task-template 仅处理每个新 Run 的原始输入一次；应用新初始指令需新会话。身份与授权由受信宿主提供，不能信任客户端自报 `actorId`。详见 [Prompt 管理](docs/prompt-management-design.md)。

旧 Models SQLite 的原生参数 schema v3 迁移继续用于兼容读取，当前 harness server 首次装配时将旧配置完整导入 `models.json`；业务 run-state 沿用独立迁移账本。升级真实数据前先关闭旧 harness server 并备份配置、业务数据库及附件，导入后将 JSON 一并纳入备份；迁移任一失败阻止运行，回退代码须恢复升级前备份。模型参数改为版本化原生结构；成功修改 Key、地址或认证范围后不能继续旧父链，改名不影响续接。

## 模型配置与凭据

Provider/Model 管统一服务商与模型定义，标记 user 或 external 来源。ProviderConnection 管账号连接、协议、地址、认证和超时；ModelConfiguration 关联定义和连接，固定远端标识/模型定义版本、能力和参数。保存连接与 Key 后自动准备适用模型，每个连接/模型定义只有一个基础配置，额外参数预设使用 baseline:false。每次保存生成不可变版本，`expectedRevision` 检查并发编辑；配置、停用或密钥变更只影响新 execution。模型能力区分支持、不支持和未知，前端只读显示声明与当前有效能力，生成参数仍可编辑。能力需修正时停止所属执行设备的 Agent，直接编辑 `models.json` 中的 `configurations[].capabilities` 再重新启动。未知工具、图片、搜索和推理能力不会自动判定为支持；流式在未知时按默认开启规则执行。

harness server 装配在 Models 启用后安装 Responses、标准 Chat Completions、Anthropic Messages 和 Gemini Interactions 四种协议。协议提供参数表单、范围、枚举和新建表单默认值；未设置的可选参数保持省略，模型发现只返回候选项，不覆盖本地配置。Anthropic 的 `max_tokens` 必填，新建表单预填 `4096`；Gemini Interactions 固定 `store: false`，当前参数不接受 temperature 或旧推理预算。保存不需要网络检查。当前调用契约接受文本、函数工具、流式事件，以及显式声明能力的本地静态 JPEG/PNG/WebP 图片输入；音频、视频和图片输出等其他模态只作为目录参考信息。

DeepSeek 使用标准 Chat Completions。通用参数支持互斥的 `max_tokens` / `max_completion_tokens`，以及显式 `thinking: { type: 'disabled' | 'enabled' }`；省略时沿用服务商默认。宿主显式注入旧 `deepseek-chat-completions` 读取转换；包不硬编码 DeepSeek。旧连接存储身份、Key 引用与历史账本保留，当前 Settings 展示标准协议，后续连接修改沿用原存储身份及既有 epoch 规则。新配置参数和原生 Run 记录使用 `chat-completions`，旧原生历史不改写，满足其余恢复条件时可续接；未知参数转换失败保留原 value 为只读待迁移状态。接口依据见 [DeepSeek Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)。Responses 使用 `store: false`，原生 reasoning、phase 与函数续轮记录由 Session 受信持久化，执行时由私有 execution 恢复。Responses web_search 和 Anthropic web_search_20250305 默认关闭，显式声明能力后可在参数表单启用；Anthropic pause_turn 自动续轮。

Models 默认独占 `./data/models.json`，直接保存非秘密配置、历史、凭据引用与清理日志。首次 JSON 不存在时完整导入旧 `models.sqlite`，保留旧库；已有 JSON 为当前权威，不与 harness server 数据库或目录缓存共用路径。停止 Agent 后可编辑当前配置，启动时校验并生成新版本；运行中外部修改会使后续保存报告冲突。完整结构见 [JSON 配置存储](docs/modules/models/json-store.md)。密钥保存在 macOS Keychain、Windows Credential Manager 或 Linux Secret Service，系统存储不可用时返回固定 `credential-unavailable`，仍可查看非秘密配置，不回退到明文或 SQLite。管理读取、Run 快照和错误均不返回密钥。服务名不是权限边界，`models.settings` 只交给受信宿主。

公开来源匿名读取 [models.dev](https://models.dev) 的完整 JSON，使用独立 `models-catalog.sqlite` 缓存。启动优先采用 Models 配置库已接纳的来源，再使用有效缓存或随包离线快照；成功检查（含 304）24 小时后过期，失败一小时后重试，手动刷新可立即检查。来源接纳到统一 Provider/Model 定义后，新增适用模型补齐缺少的基础配置；已有连接、配置与在途 execution 保持固定，来源移除保留已配置模型。能力、价格与限制带显式来源，未知字段保持未知；同一 Provider 定义可对应多个独立账号连接。

## Apply Patch 工具

harness server 在应用根安装 `tools.apply-patch`，向模型提供 `apply_patch({ patch })`；Bash 继续负责命令、检查和测试。补丁采用 `*** Begin Patch` / `*** End Patch`，支持 Add、Delete、Update、Move、多块 `@@`、精确行锚点和 EOF 标记；不接受 heredoc、标准 unified diff 或环境指令。文本解析与修改是纯函数，文件组件独占跨项目串行队列和临时资源，无新工具注册中心。

相对路径基于项目目录，绝对路径和 `..` 按应用用户的文件权限访问，不构成沙箱。仅处理普通 UTF-8 文本文件，拒绝目标符号链接、多硬链接、NUL、无效编码和混合换行；更新保留 BOM、LF/CRLF 与末尾换行习惯。上下文必须精确、唯一并按原文件顺序匹配。全部文件先预检，再逐项提交并检查源文件是否变化；创建和移动目标不能覆盖已有文件。预检不建立跨文件事务，也不能与 Bash 或外部写入者形成文件锁。

工具返回 `applied`、`rejected`、`partial` 或 `cancelled`，包含已经完成的 `changes`、尚未完成的 `pending` 和可选诊断。语法或文件冲突作为观察回填给模型；取消不回滚已完成变更，`done` 等当前文件提交和临时资源清理完成。清理失败使 Run 失败并保留已知变更事实。Web 可展示补丁预览与这些结果；新工具事件使用 `tool-*`，执行计数使用 `toolCalls`，旧 Bash 记录在读取时兼容。本轮 Apply Patch 验证使用本地文件、受控模型及模拟 HTTP，未做真实模型联网验收；详细限制见 [组件说明](docs/harness-server-components.md#工具目录与恢复的独立边界)。

## 本机 Web 界面

先运行 `npm run harness:server:init` 生成一次性显示的设备访问令牌，再运行 `npm run web`。先打开 Anybox Harness，在其连接管理中添加 `http://127.0.0.1:3001` 并填入令牌。执行端与客户端是两个进程，也可分别使用 `npm run harness:server` / `npm run client`。云端与其他设备使用 HTTPS 配对。详见[独立部署、发行与恢复](docs/harness-server-deployment.md)。打开终端打印的 `http://127.0.0.1:<port>` 地址。新安装点击 Anybox Harness 后打开所选 Agent；已有业务库保留 Agent 打开目标。在 Anybox Harness 内进入“模型管理”：

1. 在公共目录中选择提供方和连接方案，点击“填写新提供方”；也可选择模板或手动填写。调整账号名称、代理地址、认证和 API Key 后保存。
2. 保存连接和 Key 后，适用目录模型自动准备基础配置。高级设置可编辑生成参数、新建参数预设或自定义模型；能力只读展示，人工修正需编辑执行设备的 JSON 配置。
3. 回到会话的模型选择器，选择本地 Model 后发送消息。

可以编辑、启停提供方与模型，替换或删除 Key，查询历史版本并显式检查连接。修改保存后立即作用于新 Run，已接受 Run 保留原配置。Key 只显示配置状态；无需认证的提供方也可使用。提供方的协议创建后不可更改，要切换协议需创建新提供方。

在“我的连接”选择账号后，详情顶部的“删除连接”会先展示确认信息。确认后删除该连接、Key 及其基础模型和参数预设，保留 Provider/Model 定义、配置历史、历史对话和已开始的 Run；使用已删除配置的会话须重新选择模型。删除最后一个连接后，重启不会重新迁入旧默认连接。

首次使用空 Models 数据库时，宿主将旧 `ANYBOX_LLM_*` 配置导入固定的默认连接/模型，并尝试从旧 `anybox` 凭据命名空间复制对应密钥，保留原条目。之后重启不会重复读取旧密钥或覆盖用户配置；旧环境变量不再负责运行时切换。若启动中断后环境协议改变，已提交连接会保留，由设置页完成模型配置。

| 环境变量 | 默认值与用途 |
| --- | --- |
| `ANYBOX_WEB_PORT` | `3000`，客户端本机端口 |
| `ANYBOX_HARNESS_DATABASE` | `./data/harness.sqlite`，业务数据 |
| `ANYBOX_MODELS_CONFIG` | 当前 Models JSON 配置，默认 `./data/models.json`；未设置时从旧 Models 路径派生 `.json` 路径 |
| `ANYBOX_MODELS_DATABASE` | `./data/models.sqlite`，仅 JSON 不存在时的旧配置导入源 |
| `ANYBOX_MODELS_CATALOG_DATABASE` | 默认在旧 Models 路径旁的 `models-catalog.sqlite`，不能与配置文件或其他库共用文件及文件别名 |
| `ANYBOX_MODELS_NAMESPACE` | `anybox.models`，系统凭据命名空间 |
| `ANYBOX_LLM_API` | 仅初次导入：`chat-completions` 或 `openai-responses`；旧 `deepseek-chat-completions` 保留为默认 DeepSeek 导入兼容入口，保存为 `chat-completions` |
| `ANYBOX_LLM_MODEL` | 仅初次导入：DeepSeek 默认 `deepseek-flash`，Responses 必填 |
| `ANYBOX_LLM_BASE_URL` | 仅初次导入：DeepSeek 默认 `https://api.deepseek.com`，Responses 默认 `https://api.openai.com/v1` |
| `ANYBOX_LLM_TIMEOUT_MS` | 仅初次导入：`30000`，正整数且不超过 `2147483647` |
| `ANYBOX_LLM_MAX_OUTPUT_TOKENS` | 仅初次导入：可选正整数，省略时使用服务端默认值 |
| `ANYBOX_LLM_TEMPERATURE` | 仅初次导入：`0` 到 `2`，DeepSeek 默认 `0.7`，Responses 省略 |

环境变量仍在安装资源前校验，不加载 dotenv；已设置的空值会报错。API 地址只填基础地址，不附加 `/responses` 或 `/chat/completions`，不带用户名、密码、查询串或 fragment。

Anybox Harness 内的“Prompt 管理”可编辑、发布、预览并绑定版本。“模型服务”配置与会话选择通过薄 HTTP 入口调用 Nya 服务。`/api/v1/changes` 同时提供提交后的 Run 变更提示和临时模型进展；慢连接受有界队列限制，只影响展示订阅。最终内容以持久 Run 和节点查询为准，刷新不会恢复半截流式输出。工具过程、取消与失败仍由 Run 状态展示。

执行端默认监听 `127.0.0.1:3001`，远端通过 HTTPS 反向代理和拥有者设备令牌接入。SIGINT/SIGTERM 通过应用宿主 `close()` 停止准入并等待整个执行根清理；单独客户端关闭只断开观察。异常退出的在途 Run 重启后结算 `interrupted`，不重放工具。详见 [Web 客户端设计](docs/web-client-design.md)。

只运行单个应用的业务服务时，可使用应用自己的 `anybox-harness-server` 或 `anybox-claude-agent` 命令，均提供 `serve`、`init`、`recover-access` 和 `new-identity`。CLI 默认回环端口分别为 3001 和 3002；原 `anybox harness-server` 与 `npm run harness:server` 继续提供两个应用的默认组合。独立入口沿用既有数据与身份，同一数据文件必须先关闭原托管实例才能打开，不能仅更换端口并发运行。配置、公开工厂和验收边界见[独立业务服务](docs/application-standalone-services.md)。

## 本地验证

Node.js 最低版本为 22.13。将 NyaCore 与本仓库放在同一目录，先在 NyaCore 运行 `npm ci` 和 `npm run build`，再在本仓库运行：

```sh
npm ci
npm run check
```

根检查同时构建和测试 `packages/models`，覆盖目录归一化、离线缓存、刷新调度、协议解析、配置版本、凭据日志、并发与生命周期，以及 Anybox Harness、迁移和 Web 行为。默认测试使用临时 SQLite、内存凭据和模拟 HTTP。可用 `node tests/helpers/catalog-browser-host.mjs` 在隔离宿主中复验目录建连接、参数配置、会话选模和原生工具续轮，范围与操作见 [Web 客户端验收](docs/web-client-design.md#验收)。

真实凭据验证需另行运行 `ANYBOX_KEYRING_TESTS=1 node --test tests/system-keyring.test.mjs`；Linux 无 Secret Service 时加 `ANYBOX_KEYRING_EXPECT_NO_STORE=1` 验证固定拒绝且无明文回退。2026-09-25 的 macOS 验收属于旧 API Key 组件，不能代替新 Models Vault 的平台验收；本次 macOS、Windows、Linux 原生凭据测试均未执行。`packages/api-key-manager` 保留独立通用包与旧凭据读取用途，旧应用 `llm` 和凭据 Nya 包装已删除。

真实模型文本与重启续接冒烟测试位于 `tests/native-live-api.test.mjs`，默认跳过。它要求独立设置 `ANYBOX_NATIVE_API_TESTS=1`、显式选择协议并提供端点、模型、Key 和原生参数，使用临时库与内存 Vault；完整命令及范围见[联网验证入口](docs/native-protocol-agent-framework-design.md#11-独立联网验证入口)。普通检查不会发送真实模型请求，本次也未启用该门控。

| 路径 | 用途 |
| --- | --- |
| `packages/models/` | 通用 Models 服务、配置与凭据存储、协议实现及测试 |
| `packages/app-harness/src/core/agent/`、`packages/app-harness/src/core/prompt/` | Agent 定义、Prompt 草稿、版本与绑定 |
| `packages/app-harness/src/core/project/`、`packages/app-harness/src/core/session/` | 项目身份、会话树、Run 记录与恢复 |
| `packages/app-harness/src/core/run/` | Run 准入、PreparedRunProgram 交接、RunRuntime 与操作事实 |
| `packages/app-harness/src/core/tool/` | Bash 与 Apply Patch 资源组件 |
| `packages/storage-sqlite/src/` | 可选 SQLite 端口、事务、领域迁移与排他所有权；保留既有单连接和数据位置 |
| `packages/app-harness/src/core/index.ts` | harness server 核心组合与 `HarnessServerApi` |
| `packages/distribution/src/composition/harness-server.ts`、`server-runtime.ts`、`server-config.ts`、`server-models.ts` | harness server 的宿主组合、按需装配、配置与 Models 接入 |
| `packages/host/src/` | 通用应用注册、生命周期、访问管理、HTTP 分派与前端外壳 |
| `packages/app-harness/src/` | Anybox Harness 注册、装配、领域组件、业务 API、客户端网关与界面 |
| `packages/distribution/src/entrypoints/` | 正式应用目录、默认配置、启动命令与进程信号 |
| `packages/host/src/web/`、`packages/host/web/index.html`、`packages/host/web/style.css` | Anybox 应用列表、标签与全局路由 |
| `packages/app-harness/src/web/`、`packages/app-harness/web/` | Anybox Harness 多实例工作区、连接与设置界面 |
| `tests/helpers/controlled-models.mjs` | 可控 Models 契约替身 |
| `tests/helpers/managed-models.mjs` | 实际 Models 模块与可控协议的测试装配 |
| `docs/harness-server-components.md` | 组件职责、依赖、状态归属与清理 |
| `docs/harness-server-plan.md` | 阶段、边界与验收记录 |

通用应用宿主支持按受信目录注册多个 NyaCore 应用，并在 Web 工作区中独立打开、保留界面和停止。正式目录提供 Anybox Harness 与 Claude Agent；开发入口见[应用接入说明](docs/application-development.md)，设计见[应用宿主](docs/products-v1.md)。
