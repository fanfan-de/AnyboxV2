# AnyboxV2

从 NyaCore 直接构建 Agent Harness。本分支已完成 [H1 无网络闭环](docs/agent-harness-plan.md)，并加入 [Prompt 管理模块](docs/prompt-management-design.md)：用户可编辑草稿、发布版本，将不同用途和消息角色的 prompt 绑定到 Agent。Prompt 文档、版本和绑定通过 [SQLite 存储组件](docs/local-sqlite-storage.md)持久化；大模型调用由应用安装的唯一一个 API 组件承担，当前实现是 DeepSeek 非流式 Chat Completions。工具循环、Run 状态持久化、流式输出和工具调用仍在后续阶段。

应用只使用一个 Nya 根 Context：大模型 API 组件、本地 SQLite、Agent、Prompt、Agent Prompt、内存状态、Session、Run 和 AgentLoop 都直接安装在根上。组件通过 `inject` 声明依赖，由 Nya 负责就绪、重启和清理顺序。大模型 API 组件按 API 格式划分，不再有单独的供应商适配器层：它提供 `llm` 服务，直接拥有原生请求格式、HTTP 传输、密钥、响应解析、超时、取消和清理；Run 和 AgentLoop 只依赖 `src/llm/port.ts` 中的最小契约 `prepare(profileId)` 与 `call({ plan, messages })`。Run 负责准入、固定配置快照与对外控制；AgentLoop 注入 `llm` 和状态服务，独占在途调用、取消和退出等待。Session 服务负责创建与查询，Session 和 Run 数据仍由同一个内存状态组件持有。Prompt 组件只依赖 SQLite，负责文档所有权、草稿、版本及已提交数据的读投影；Agent Prompt 组件依赖 Agent、Prompt 和 SQLite，负责绑定权限、默认指令、绑定持久化与 Run 使用的版本解析。SQLite 组件排他持有连接和事务，并按领域记录迁移版本；各领域组件启动时登记自己的表迁移。调用的 `result` 是业务结果，`done` 表示调用及资源实际退出；取消或卸载会等待 `done` 完成。

## 最小调用

```js
import { Context } from '@nya/core'
import { createHarness } from './dist/harness.js'
import { createDeepSeekChatCompletionsComponent } from './dist/llm/deepseek-chat-completions/component.js'
import { createLocalSqliteComponent } from './dist/storage/sqlite.js'

const root = new Context()
const llm = root.installComponent(createDeepSeekChatCompletionsComponent({
  version: 'model-config-1',
  profiles: [{ id: 'default', model: 'deepseek-chat', maxOutputTokens: 256, temperature: 0, timeoutMs: 30000 }],
}, {
  // Read once at startup and kept inside the component; the key never enters Run state.
  apiKey: () => process.env.DEEPSEEK_API_KEY,
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
  const session = harness.createSession('demo')
  const run = harness.startRun({ sessionId: session.id, input: 'Hello', idempotencyKey: 'request-1' })
  console.log(await harness.waitRun(run.id))
} finally {
  await harness.close()
}
```

首版用途类型为 `agent-instruction`、`task-template` 和 `context`。消息角色与用途类型分别校验；`task-template` 须且仅须包含一个 `{{input}}`。用户编辑的是草稿，发布后还需显式绑定，新 Run 才会使用新版本。已接受的 Run 在内存状态中保存 Prompt 内容与 LLM 调用计划；对外 `llmSnapshot` 只包含 profile ID 和配置版本，不暴露 Prompt 内容、模型参数或凭据。传给 Prompt API 的 `actorId` 必须由受信宿主认证，不能直接信任客户端自报身份；默认允许已认证用户配置 Agent，产品宿主应按需设置 `canManageAgent`。

应用以本地文件路径安装 SQLite 组件，Harness 启动时缺少 `llm` 或 SQLite 服务会报出所缺服务名。创建、编辑、发布和绑定为异步操作，成功返回表示事务已提交。SQLite 组件用同目录的 `.lock` 目录阻止两个活跃实例同时持有数据库；异常退出遗留的锁需确认原进程停止后手动清理。`harness.close()` 先阻止新调用，再卸载应用根上的全部组件：Nya 先停止 Run 和 AgentLoop 并等待在途调用退出，等待 Prompt 写入，然后中止剩余的 DeepSeek 请求并关闭数据库连接，释放锁。该 Harness 门面关闭后不可复用；重新装配组件和 Harness 后，Prompt 文档、版本与绑定可从 SQLite 恢复，Session、Run、幂等键和 Run 快照仍只在内存中。若需从旧 JSON 存储迁入，可首次启动时另传 `legacyPromptStorePath: './data/prompts.json'`；Prompt 与 Agent Prompt 各自在一个事务内导入自己的数据并记录来源，源文件保持不变，后续带同一路径重启不会重复导入。

## DeepSeek 组件

`createDeepSeekChatCompletionsComponent(config, transport)` 在构造时校验配置：每个 profile 只允许 `id`、`model`、`maxOutputTokens`、`temperature`、`timeoutMs`。`transport.apiKey()` 在组件启动时读取一次，为空则启动失败；`baseUrl` 可指向兼容端点，`fetch` 可替换传输。组件把 `system`、`user`、`assistant` 文本消息以非流式方式发送到 `/chat/completions`，只接受 `finish_reason` 为 `stop` 的完整文本回复；超时、HTTP 错误、传输失败和无效响应都归一为固定的失败类别，响应内容和密钥不会进入 Run。轮换密钥或修改配置时替换整个组件：Nya 会依次停止 Run 与 AgentLoop，等旧组件的请求退出后再用新组件重启它们。

尚未支持：流式输出、工具调用、`developer` 角色（绑定该角色的 Prompt 会让新 Run 以 `unsupported-request` 失败）、`reasoning_content`、`usage` 统计、`top_p` 等其他采样参数、重试与限流处理。真实 API 尚未联网验收；行为测试用本地 HTTP 服务和可控的 `fetch` 验证请求格式、鉴权头、错误类别、超时、取消、关闭和组件撤销。

## 本地验证

将 NyaCore 与本仓库放在同一目录。先在 NyaCore 中运行 `npm ci` 和 `npm run build`，然后在本仓库执行：

```sh
npm ci
npm run check
```

当前通过本地包目录依赖 `../NyaCore/packages/core`；lockfile 不固定 NyaCore 的 Git 提交。Node.js 最低版本为 22.13，以便直接使用内置的 `node:sqlite`。

| 路径 | 用途 |
| --- | --- |
| `src/contracts.ts`、`src/validation.ts` | 可取消调用、运行时输入与共用校验，不依赖 Nya |
| `src/agent/` | Agent 定义、校验与服务组件，以及 Agent Prompt 绑定、解析与存储 |
| `src/llm/port.ts` | `llm` 服务契约：调用计划、消息与失败类别；Run 和 AgentLoop 只依赖它 |
| `src/llm/deepseek-chat-completions/` | DeepSeek Chat Completions API 组件：`domain.ts` 是配置校验、原生请求组装与响应解析的纯函数，`component.ts` 持有密钥、HTTP 传输、超时、取消与清理 |
| `src/run/` | Session 与 Run 值、纯函数，以及 Session、Run 准入、AgentLoop 和内存状态组件 |
| `src/prompt/domain.ts`、`src/prompt/component.ts` | Prompt 草稿与版本的纯函数，以及权限、规则和管理服务 |
| `src/prompt/sqlite-storage.ts` | Prompt 表迁移、文档与版本的读写投影及旧 JSON 导入 |
| `src/prompt/legacy-json-import.ts` | 旧 JSON 格式读取与校验，仅供显式迁入使用 |
| `src/storage/port.ts` | 项目自有的本地存储端口、按领域迁移与错误契约 |
| `src/storage/sqlite.ts` | SQLite 提供方：连接、按领域迁移、事务、排他与清理 |
| `src/harness.ts` | 受信组合根与调用入口 |
| `src/resource-probe.ts` | 直接使用 NyaCore 的最小资源归属探针 |
| `tests/*.test.mjs` | Run、组件撤销、取消、等待、关闭接收门和 DeepSeek 请求的行为测试；`tests/helpers/controlled-llm.mjs` 是实现 `llm` 契约的可控测试替身 |
| `docs/agent-harness-plan.md` | 后续阶段与验收边界 |
| `docs/harness-components.md` | 各组件的职责、服务、依赖与清理行为 |

配置文件格式、进程信号和产品宿主留待后续阶段决定。同键请求始终返回原 Run，显式重试需新幂等键。SQLite 组件已接入 Prompt，尚未接入 State；当前 Run 状态不提供重启恢复保证。
