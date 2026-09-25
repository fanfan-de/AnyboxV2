# AnyboxV2

从 NyaCore 直接构建 Agent Harness。本分支已完成 [H1 无网络闭环](docs/agent-harness-plan.md)，并加入 [Prompt 管理模块](docs/prompt-management-design.md)：用户可编辑草稿、发布版本，将不同用途和消息角色的 prompt 绑定到 Agent。Prompt 文档、版本和绑定通过 [SQLite 存储组件](docs/local-sqlite-storage.md)持久化；大模型调用由应用安装的唯一一个 API 组件承担，可选择 DeepSeek 非流式 Chat Completions 或 OpenAI 非流式 Responses。当前本机 Web 宿主使用 DeepSeek。项目、Session 和 Run 已持久化；工具循环、流式输出和工具调用仍在后续阶段。

应用只使用一个 Nya 根 Context：凭据组件、大模型 API 组件、本地 SQLite、Agent、Prompt、Agent Prompt、Projects、持久状态、Session、Run 和 AgentLoop 都直接安装在根上。组件通过 `inject` 声明依赖，由 Nya 负责就绪、重启和清理顺序。Projects 登记本地目录身份，Session 和 Run 数据由同一个 SQLite 状态组件持有；项目不创建独立 Context 或数据库。Prompt、绑定和 Agent 定义全局共享。凭据组件提供 `credentials.read`；大模型 API 组件提供 `llm`，负责原生请求、HTTP、密钥、超时、取消和清理。Run 负责准入、配置快照与控制；AgentLoop 独占在途调用。SQLite 排他持有连接，各领域组件登记自己的表迁移。调用的 `result` 是业务结果，`done` 表示调用及资源实际退出；取消或卸载会等待 `done` 完成。

## 最小调用

```js
import { Context } from '@nya/core'
import { credentialManageServiceKey } from './dist/credentials/port.js'
import { createSystemKeyringComponent } from './dist/credentials/system-keyring.js'
import { createHarness } from './dist/harness.js'
import { createDeepSeekChatCompletionsComponent, deepSeekCredentialId } from './dist/llm/deepseek-chat-completions/component.js'
import { createLocalSqliteComponent } from './dist/storage/sqlite.js'

const root = new Context()
// The operating system's credential store, filed under this application's own namespace.
await root.installComponent(createSystemKeyringComponent({ namespace: 'anybox' }))
// Optional provisioning by the trusted host; later calls read the current key.
if (process.env.DEEPSEEK_API_KEY) {
  await root.get(credentialManageServiceKey).write(deepSeekCredentialId, process.env.DEEPSEEK_API_KEY)
}
// Reads the key once in each call; the key never enters Run state.
const llm = root.installComponent(createDeepSeekChatCompletionsComponent({
  version: 'model-config-1',
  profiles: [{ id: 'default', model: 'deepseek-chat', maxOutputTokens: 256, temperature: 0, timeoutMs: 30000 }],
}))
await llm
const database = root.installComponent(createLocalSqliteComponent('./data/harness.sqlite'))
await database
const harness = await createHarness(root, {
  agents: [{ id: 'demo', instructions: 'Answer briefly.', modelProfileId: 'default' }],
  canManageAgent: (actorId, agentId) => actorId === 'alice' && agentId === 'demo',
})

try {
  const draft = await harness.createPrompt('alice', {
    name: 'Concise replies', kind: 'agent-instruction', role: 'system',
    content: 'Answer in one sentence.',
  })
  const edited = await harness.editPrompt('alice', draft.id, draft.draft.revision, {
    content: 'Answer in one short sentence.',
  })
  const version = await harness.publishPrompt('alice', edited.id)
  await harness.bindPrompt('alice', 'demo', version.id)
  const project = await harness.openProject(process.cwd())
  const session = await harness.createSession(project.id, 'demo')
  const run = await harness.startRun({ sessionId: session.id, input: 'Hello', idempotencyKey: 'request-1' })
  console.log(await harness.waitRun(run.id))
} finally {
  await harness.close()
}
```

首版用途类型为 `agent-instruction`、`task-template` 和 `context`。消息角色与用途类型分别校验；`task-template` 须且仅须包含一个 `{{input}}`。用户编辑的是草稿，发布后还需显式绑定，新 Run 才会使用新版本。已接受的 Run 在 SQLite 中保存 Prompt 内容与可见模型配置快照；原生 LLM 调用计划只在本进程执行期间保留。对外 `llmSnapshot` 只包含 profile ID 和配置版本，不暴露 Prompt 内容、模型参数或凭据。传给 Prompt API 的 `actorId` 必须由受信宿主认证，不能直接信任客户端自报身份；默认允许已认证用户配置 Agent，产品宿主应按需设置 `canManageAgent`。

应用以本地文件路径安装 SQLite 组件，Harness 启动时缺少 `llm` 或 SQLite 服务会报出所缺服务名。所选大模型 API 组件在密钥缺失时仍提供 `llm`，Harness 和 Web 可以启动；未配置 Key 的 Run 以 `credential-missing` 失败。项目、Session、Run、Prompt 与绑定的写入均为异步操作，成功返回表示事务已提交。SQLite 组件用同目录的 `.lock` 目录阻止两个活跃实例同时持有数据库；异常退出遗留的锁需确认原进程停止后手动清理。`harness.close()` 先阻止新调用，再卸载应用根上的全部组件，取消并等待在途调用，最后关闭数据库并释放锁。重新装配后，项目、Session、Run、幂等键、Run 快照及 Prompt 数据可从 SQLite 恢复；遗留的在途 Run 结算为 `interrupted`，不会自动重放。若需从旧 JSON 存储迁入，可首次启动时另传 `legacyPromptStorePath: './data/prompts.json'`；Prompt 与 Agent Prompt 各自在一个事务内导入自己的数据并记录来源。

## 凭据组件

应用只安装一种凭据组件，它提供 `credentials.read`（`read(id, signal?)`，缺失时返回 `undefined`）。DeepSeek 组件读取 `deepSeekCredentialId`（`llm/deepseek-chat-completions/default`）；OpenAI Responses 组件读取 `openAIResponsesCredentialId`（`llm/openai-responses/default`）。两者只安装一个。

- **系统凭据库** `createSystemKeyringComponent({ namespace })`：通过 `@napi-rs/keyring` 使用 macOS Keychain、Windows Credential Manager 和 Linux Secret Service（gnome-keyring、KWallet 等）。Linux 上明确要求 Secret Service，没有时组件启动失败，不会退回到重启即失的内核 keyring。`namespace` 是条目的 service 名，标识是条目的账户名；不同安装（开发、正式、测试）必须用不同命名空间，否则共用同一条目。它另提供 `credentials.manage`（`write(id, secret)`、`delete(id)`；`delete` 只在条目不存在时返回 `false`，删除失败会拒绝）。
- **外部来源** `createExternalCredentialSourceComponent({ read })`：给无桌面环境的部署方使用，只注册 `credentials.read`，把宿主的异步读取函数接进来。它不落盘、不缓存、不提供管理服务；读取函数抛错会以 `store-unavailable` 报告。行为测试也用它充当假凭据组件。

**录入与轮换。** 可移植的 `packages/api-key-manager` 包提供自包含的 `createApiKeyService({ namespace, definitions })`：它自己持有系统凭据库存储，同时提供读取、状态、写入、删除和关闭方法，不依赖 Anybox 的其他组件。Anybox 的 `createApiKeyServiceComponent(options)` 只是无注入依赖的 Nya 适配层。受信宿主注册可管理的凭据 ID、名称和类别。Web 只允许操作已注册的 ID，状态和写入响应只返回公开元数据与是否已配置，不返回 Key。现有 DeepSeek ID 不变；将来视频模型或其他服务可按相同方式注册。每个 Run 在首次 `llm.call()` 读取一次 Key；已取得 Key 的 Run 继续使用该值。写入完成后的新读取取得新 Key，删除完成后的新 Run 以 `credential-missing` 失败；无须重启 LLM、Harness 或 Web。同一 ID 的读取、写入、删除按凭据组件接收顺序执行。读取失败以 `credential-unavailable` 结算 Run。取消等待读取的 Run 时，`result` 可先拒绝，`done` 等底层读取实际退出。

例如，宿主可把视频服务也加入管理清单，而不修改设置组件或 Web 协议：

```js
await root.installComponent(createApiKeyServiceComponent({
  namespace: 'anybox',
  definitions: [
    { id: deepSeekCredentialId, label: 'DeepSeek Chat', category: '大语言模型' },
    { id: 'video/example/default', label: 'Video API', category: '视频模型' },
  ],
}))
```

使用这段示例时，从 `./dist/credentials/settings.js` 导入 `createApiKeyServiceComponent`，并用它替代单独的系统凭据库组件。服务实际读取时使用注册的 ID；设置页只管理 Key，不替服务发起调用。

**跨项目复用。** 在 `packages/api-key-manager` 目录运行 `npm pack`，另一个 Node.js 项目安装生成的 `.tgz` 后，直接导入 `createApiKeyService`。包本身不依赖 Anybox、Nya 或 Web 框架；目标项目只需提供自己的命名空间、服务清单，并把管理操作接到它自己的受信入口。包内 [README](packages/api-key-manager/README.md) 给出完整示例。现有 Anybox Web 页面和 Nya 适配层仍属于本项目，不作为跨项目包的一部分。

**安全边界。** 系统凭据库只保护静态存储；模型请求期间密钥仍在进程内存和该次调用的闭包中，JavaScript 无法擦除字符串。`credentials.manage` 与 `credentials.read` 分开注册只是命名约定：Nya 服务按名称寻址，根上任何组件都能注入它，Harness 门面不转发它。凭据错误只有固定类别 `store-unavailable`、`operation-failed`、`closed`、`cancelled`，不携带系统信息、条目名或密钥。卸载凭据组件会撤销依赖服务、取消在途调用，并等待已接受的凭据库读取实际退出。macOS 的 Keychain 条目访问权绑定创建它的可执行文件，换用其他路径的 Node 二进制读取时系统可能弹出授权提示。

## DeepSeek 组件

`createDeepSeekChatCompletionsComponent(config, transport?)` 在构造时校验配置：每个 profile 只允许 `id`、`model`、`maxOutputTokens`、`temperature`、`timeoutMs`。组件注入 `credentials.read`，每次 `llm.call()` 读取一次密钥，缺失或读取失败则使该次调用失败；`transport.baseUrl` 可指向兼容端点，`transport.fetch` 可替换传输。组件把 `system`、`user`、`assistant` 文本消息以非流式方式发送到 `/chat/completions`，只接受 `finish_reason` 为 `stop` 的完整文本回复；超时、HTTP 错误、传输失败和无效响应都归一为固定的失败类别，响应内容和密钥不会进入 Run。轮换密钥写入成功后自动影响后续调用；修改配置仍需替换组件。

尚未支持：流式输出、工具调用、`developer` 角色（绑定该角色的 Prompt 会让新 Run 以 `unsupported-request` 失败）、`reasoning_content`、`usage` 统计、`top_p` 等其他采样参数、重试与限流处理。真实 API 尚未联网验收；行为测试用本地 HTTP 服务和可控的 `fetch` 验证请求格式、鉴权头、错误类别、超时、取消、关闭和组件撤销。

## OpenAI Responses 组件

`createOpenAIResponsesComponent(config, transport?)` 是另一个提供相同 `llm` 服务的 API 格式组件，和 DeepSeek 组件二选一安装。它固定从 `credentials.read` 读取 `openAIResponsesCredentialId`（`llm/openai-responses/default`）；受信宿主可用 `credentials.manage` 写入 OpenAI API key；组件在每次调用内读取，轮换无需重启。每个 profile 需要 `id`、`model`、`maxOutputTokens`、`timeoutMs`，可选 `temperature`；省略温度可兼容不接受该参数的模型。模型名称由宿主配置，不在组件中硬编码。

组件向 `/v1/responses` 发送完整的 `system`、`developer`、`user`、`assistant` 文本消息，使用非流式请求并设置 `store: false`。它从已完成响应的 `output` 中收集最终助手文本，可跳过 reasoning 项；未完成响应、拒绝内容和工具调用不会伪装成成功文本。响应失败、超时、取消与清理仍使用 `src/llm/port.ts` 的固定类别及 `result`/`done` 语义。当前不支持流式输出、工具循环、多模态和服务端会话；Session 历史仍由 Harness 作为文本消息逐次发送。真实 OpenAI API 尚未联网验收，本地 HTTP 与可控传输测试覆盖请求、解析、密钥、Run、取消和等待。`npm run web` 宿主目前仍选择 DeepSeek 组件；使用 OpenAI Responses 的宿主需在装配 Harness 前安装本组件并提供其凭据。

## 本机 Web 界面

第一版提供可替换的薄客户端参考实现。Web 前端是单独的 Nya 组件，注入 Agent、Session、Run 和通用凭据设置服务，拥有 HTTP 监听器及静态页面。运行 `npm run web` 后打开终端打印的 `http://127.0.0.1:<port>` 地址；首次启动无需 Key，可在侧栏 API Key 管理中选择已注册的服务并保存、替换或删除。写入成功即生效。

页面可登记本地项目目录、切换项目和会话、选择 Agent、提交消息、查看历史与完整回答或失败状态，以及取消在途 Run。当前没有流式输出；页面通过 `/api/v1` 查询服务端状态。浏览器按 Session 保存当前标签页的待提交幂等键与输入，用于刷新或丢失响应后的安全重试。项目、Session 和 Run 历史由服务端持久化，重启后可恢复。宿主只监听 `127.0.0.1`，不支持远程访问或账号。协议及边界见 [薄 Web 客户端设计](docs/web-client-design.md)。

## 本地验证

将 NyaCore 与本仓库放在同一目录。先在 NyaCore 中运行 `npm ci` 和 `npm run build`，然后在本仓库执行：

```sh
npm ci
npm run check
```

`npm test` 只用假凭据组件验证凭据行为。真实凭据库测试需要在目标系统上另行运行（先 `npm run build`）：`ANYBOX_KEYRING_TESTS=1 node --test tests/system-keyring.test.mjs` 会用一次性命名空间写入、跨进程读取并删除条目；在没有 Secret Service 的 Linux 上再加 `ANYBOX_KEYRING_EXPECT_NO_STORE=1` 验证组件拒绝启动。哪个平台的测试通过，才算该平台的凭据存储已验收。

| 平台 | 凭据库 | 验收状态 |
| --- | --- | --- |
| macOS | Keychain | 2026-09-25 在 macOS 15（Darwin 24.6）、Node 24.16 上通过写入、跨进程读取、删除，未弹出授权提示，未遗留条目 |
| Windows | Credential Manager | 未验收 |
| Linux 桌面 | Secret Service | 未验收 |
| Linux 无桌面 | 外部来源组件；系统组件应拒绝启动 | 未验收 |

当前通过本地包目录依赖 `../NyaCore/packages/core`；lockfile 不固定 NyaCore 的 Git 提交。Node.js 最低版本为 22.13，以便直接使用内置的 `node:sqlite`。

| 路径 | 用途 |
| --- | --- |
| `src/contracts.ts`、`src/validation.ts` | 可取消调用、运行时输入与共用校验，不依赖 Nya |
| `src/agent/` | Agent 定义、校验与服务组件，以及 Agent Prompt 绑定、解析与存储 |
| `packages/api-key-manager/` | 可安装的通用服务端 Key 管理包：系统凭据库、注册清单、状态与写删操作；不依赖 Anybox 或 Nya |
| `src/credentials/` | Anybox 的凭据服务契约、Nya 适配层、外部来源组件及其操作接收与等待 |
| `src/llm/port.ts` | `llm` 服务契约：调用计划、消息与失败类别；Run 和 AgentLoop 只依赖它 |
| `src/llm/deepseek-chat-completions/` | DeepSeek Chat Completions API 组件：`domain.ts` 是配置校验、原生请求组装与响应解析的纯函数，`component.ts` 每次调用读取密钥、HTTP 传输、超时、取消与清理 |
| `src/llm/openai-responses/` | OpenAI Responses API 组件：同样提供 `llm`，支持 `developer` 文本消息及非流式最终文本，独立拥有原生协议和资源清理 |
| `src/project/` | 项目目录规范化、可用性检查与 Projects 服务组件 |
| `src/run/` | Session 与 Run 值、纯函数，以及 Session、Run 准入、AgentLoop 和 SQLite 状态组件 |
| `src/prompt/domain.ts`、`src/prompt/component.ts` | Prompt 草稿与版本的纯函数，以及权限、规则和管理服务 |
| `src/prompt/sqlite-storage.ts` | Prompt 表迁移、文档与版本的读写投影及旧 JSON 导入 |
| `src/prompt/legacy-json-import.ts` | 旧 JSON 格式读取与校验，仅供显式迁入使用 |
| `src/storage/port.ts` | 项目自有的本地存储端口、按领域迁移与错误契约 |
| `src/storage/sqlite.ts` | SQLite 提供方：连接、按领域迁移、事务、排他与清理 |
| `src/harness.ts` | 受信组合根与调用入口 |
| `src/web/`、`web/` | 本机 HTTP 宿主、模型 Key 设置入口，以及可替换的原生 Web 参考页面 |
| `src/resource-probe.ts` | 直接使用 NyaCore 的最小资源归属探针 |
| `tests/*.test.mjs` | Run、组件撤销、取消、等待、关闭接收门、凭据组件、DeepSeek 与 OpenAI Responses 请求的行为测试；`tests/helpers/controlled-llm.mjs` 是实现 `llm` 契约的可控测试替身，`tests/helpers/memory-credentials.mjs` 是内存假凭据组件；`tests/system-keyring.test.mjs` 是需环境变量启用的真实凭据库测试 |
| `docs/agent-harness-plan.md` | 后续阶段与验收边界 |
| `docs/harness-components.md` | 各组件的职责、服务、依赖与清理行为 |

通用配置文件格式、远程产品宿主和账号体系留待后续阶段决定；本机 Web 宿主处理 SIGINT 与 SIGTERM，通过 `harness.close()` 卸载应用根并等待 Web 监听器及 Harness 清理。同键请求始终返回原 Run，显式重试需新幂等键。SQLite 同时供 Prompt、Projects 和 Run 状态使用；异常退出的在途 Run 在重启时结算为 `interrupted`。
