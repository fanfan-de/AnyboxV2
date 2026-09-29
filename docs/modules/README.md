# 模块与组件手册

[返回文档首页](../README.md)

本手册按当前源码的实际组件边界组织。模块是职责与协作边界，不是 Nya 子 Context；本机应用的所有组件安装在同一个根上。完整本机装配有 29 个运行期组件，另保留 1 个不参与正式执行的 H0 探针。按本机默认安装的五种协议统计；定制宿主可只安装需要的协议与应用绑定。

## 模块目录

| 目录 | 内聚职责 | 独立组件文档数 |
| --- | --- | --- |
| [models/](./models/README.md) | 可复用模型配置、凭据、原生驱动及可选公开目录 | 11 |
| [execution/](./execution/README.md) | Run 准入、运行资源、原生协议 Agent 绑定与循环 | 8 |
| [sessions/](./sessions/README.md) | 项目身份、会话树、Run 持久事实及恢复 | 2 |
| [images/](./images/README.md) | 图片导入、不可变字节、草稿续期与事务保留 | 1 |
| [prompts/](./prompts/README.md) | 可复用 Prompt 内容与 Agent 的版本选择 | 2 |
| [tools/](./tools/README.md) | 本地进程和文本文件变更 | 2 |
| [infrastructure/](./infrastructure/README.md) | 业务数据库与可替换存储端口 | 1 |
| [web/](./web/README.md) | 本机 HTTP/浏览器入口与原生目录选择 | 2 |
| [diagnostics/](./diagnostics/README.md) | 资源归属探针 | 1 |

## 完整组件索引

组件名是 Nya `name`，服务名是 `provide`/`inject` 使用的标识；两者不一定相同。登记型组件通过依赖的注册服务发布能力，不需要另建一个服务名。

| 模块 | 独立文档 | Nya 组件名 | 提供服务或登记能力 |
| --- | --- | --- | --- |
| Models | [协调服务](./models/models.md) | `models` | `models`、`models.settings`、`models.protocols`、`models.source-data` |
| Models | [配置存储](./models/store.md) | `models-store` | `models.store` |
| Models | [系统凭据](./models/vault.md) | `models-vault` | `models.vault` |
| Models | [目录来源](./models/catalog-source.md) | `models-catalog-source` | `models.catalog-source` |
| Models | [目录缓存](./models/catalog-cache.md) | `models-catalog-cache` | `models.catalog-cache` |
| Models | [目录调度](./models/catalog.md) | `models-catalog` | `models.catalog` |
| Models | [Responses 驱动](./models/responses.md) | `models-protocol-responses` | 在 `models.protocols` 登记 `responses` |
| Models | [Chat Completions 驱动](./models/chat-completions.md) | `models-protocol-chat-completions` | 登记 `chat-completions` |
| Models | [Anthropic Messages 驱动](./models/anthropic-messages.md) | `models-protocol-anthropic-messages` | 登记 `anthropic-messages` |
| Models | [Gemini Interactions 驱动](./models/gemini-interactions.md) | `models-protocol-gemini-interactions` | 登记 `gemini-interactions` |
| Models | [DeepSeek 驱动](./models/deepseek.md) | `models-protocol-deepseek` | 登记 `deepseek-chat-completions`，宿主扩展 |
| 执行 | [Run](./execution/run.md) | `harness-runs` | `harness.runs` |
| 执行 | [RunRuntime](./execution/run-runtime.md) | `harness-run-runtime` | `harness.run-runtime` |
| 执行 | [协议应用注册](./execution/protocol-agent-registry.md) | `harness-protocol-agents` | `harness.protocol-agents` |
| 执行 | [Responses 应用绑定](./execution/responses-agent.md) | `harness-protocol-agent-responses` | 将该驱动代与 Responses Loop 绑定 |
| 执行 | [Chat Completions 应用绑定](./execution/chat-completions-agent.md) | `harness-protocol-agent-chat-completions` | 将该驱动代与 Chat Loop 绑定 |
| 执行 | [Anthropic 应用绑定](./execution/anthropic-agent.md) | `harness-protocol-agent-anthropic-messages` | 将该驱动代与 Anthropic Loop 绑定 |
| 执行 | [Gemini 应用绑定](./execution/gemini-agent.md) | `harness-protocol-agent-gemini-interactions` | 将该驱动代与 Gemini Loop 绑定 |
| 执行 | [DeepSeek 应用绑定](./execution/deepseek-agent.md) | `harness-protocol-agent-deepseek-chat-completions` | 将该驱动代与非推理 Chat Loop 绑定 |
| 项目与会话 | [Projects](./sessions/projects.md) | `harness-projects` | `harness.projects` |
| 项目与会话 | [Session](./sessions/session.md) | `harness-sessions` | `harness.sessions`、`harness.session-runs` |
| 图片资源 | [Image Assets](./images/image-assets.md) | `harness-image-assets` | `harness.image-assets` |
| Prompt | [Prompt](./prompts/prompts.md) | `harness-prompts` | `harness.prompts` |
| Prompt | [Agent Prompt](./prompts/agent-prompts.md) | `harness-agent-prompts` | `harness.agent-prompts` |
| 工具 | [Bash](./tools/bash.md) | `bash-tool` | `tools.bash` |
| 工具 | [Apply Patch](./tools/apply-patch.md) | `apply-patch-tool` | `tools.apply-patch` |
| 基础存储 | [业务 SQLite](./infrastructure/local-sqlite.md) | `local-sqlite` | `local-storage` |
| Web | [Web 前端宿主](./web/web-frontend.md) | `web-frontend` | `web.frontend` |
| Web | [本机目录选择器](./web/directory-picker.md) | `host-directory-picker` | `host.directory-picker` |
| 验证 | [H0 资源探针](./diagnostics/resource-probe.md) | `h0-resource-probe` | `h0.runs`；仅验证使用 |

## 从一次请求理解模块协作

1. [Web](./web/web-frontend.md) 或 [Harness 门面](../../src/harness.ts) 接收请求，通过当前服务进行调用。
2. [Run](./execution/run.md) 先检查已接受幂等键，再读取 [Session/Projects](./sessions/README.md)、[Prompt 绑定](./prompts/agent-prompts.md) 和模型选择。
3. [协议应用注册](./execution/protocol-agent-registry.md) 固定驱动代与对应 Loop，通过 [Models](./models/models.md) 准备独立 execution/program；Session 在接受事务复核协议及父恢复引用。
4. [RunRuntime](./execution/run-runtime.md) 同步接管 program，管理操作意图、实际启动、取消、退出和观察提交。对应协议 Loop 消费原生结果，经 Runtime 使用 [本地工具](./tools/README.md)。
5. program 与工具退出后，Session 原子提交成功节点、记录、结果引用和终态。Web 通过安全投影及持久查询呈现结果。

Models 配置库、目录缓存库和业务 SQLite 是三套独立连接，不共享文件。系统凭据留在 Vault，原生恢复记录留在受信 Session，浏览器只接收允许展示的投影。生命周期细节见 [Harness 协作总览](../harness-components.md)。

## 组件之外的代码

[src/harness.ts](../../src/harness.ts) 和 [src/web/serve.ts](../../src/web/serve.ts) 是组合根/宿主入口；AgentDefinition 是只读配置；`execution`、`PreparedRunProgram`、协议 Loop、内部 SQLite 提供方及浏览器视图是所属组件持有或调用的实现。它们在相关文档中说明，不独立计作组件。`packages/api-key-manager` 保留独立工具包和旧凭据读取用途，说明见 [包 README](../../packages/api-key-manager/README.md)，不是当前应用的额外 Nya 凭据组件。

新增或调整组件时，按 [文档维护约定](../README.md#维护约定) 同步更新本清单和模块目录。组件文档描述当前实现，设计文档保存跨模块决策和迁移背景。
