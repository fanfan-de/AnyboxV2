# 模块与组件手册

[返回文档首页](../README.md)

本手册按实际组件与资源边界组织。模块不对应 Nya 子 Context；每个 Harness 与本机客户端分别拥有一个根。执行、会话、图片、Prompt 和工具位于 `src/harness/`，Models 保持独立包，宿主与浏览器分别位于 `src/host/` 和 `src/client/`。详见[模块边界](../harness-module-boundary.md)与[部署说明](../harness-deployment.md)。

## 模块目录

| 目录 | 内聚职责 | 独立组件文档数 |
| --- | --- | --- |
| [models/](./models/README.md) | 可复用模型配置、凭据、原生驱动及可选公开目录 | 11 |
| [execution/](./execution/README.md) | Run 准入、运行资源、原生协议 Agent 绑定与循环 | 8 |
| [sessions/](./sessions/README.md) | 项目身份、文件快照、会话树、归档、Run 持久事实及恢复 | 3 |
| [images/](./images/README.md) | 图片导入、不可变字节、草稿续期与事务保留 | 1 |
| [prompts/](./prompts/README.md) | 可复用 Prompt 内容与 Agent 的版本选择 | 2 |
| [tools/](./tools/README.md) | 本地进程和文本文件变更 | 2 |
| [infrastructure/](./infrastructure/README.md) | 业务数据库与可替换存储端口 | 1 |
| [web/](./web/README.md) | 执行 API、访问管理、客户端连接与网关、目录选择 | 5 |
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
| 项目与会话 | [Project Files](./sessions/project-files.md) | `harness-project-files` | `harness.project-files` |
| 项目与会话 | [Session](./sessions/session.md) | `harness-sessions` | `harness.sessions`、`harness.session-runs` |
| 图片资源 | [Image Assets](./images/image-assets.md) | `harness-image-assets` | `harness.image-assets` |
| Prompt | [Prompt](./prompts/prompts.md) | `harness-prompts` | `harness.prompts` |
| Prompt | [Agent Prompt](./prompts/agent-prompts.md) | `harness-agent-prompts` | `harness.agent-prompts` |
| 工具 | [Bash](./tools/bash.md) | `bash-tool` | `tools.bash` |
| 工具 | [Apply Patch](./tools/apply-patch.md) | `apply-patch-tool` | `tools.apply-patch` |
| 基础存储 | [业务 SQLite](./infrastructure/local-sqlite.md) | `local-sqlite` | `local-storage` |
| 宿主 | [Harness API](./web/web-frontend.md) | `host-harness-api` | `host.harness-api` |
| Web | [本机目录选择器](./web/directory-picker.md) | `host-directory-picker` | `host.directory-picker` |
| 宿主 | [访问管理](./web/host-access.md) | `host-access` | `host.access` |
| 客户端 | [连接管理](./web/client-connections.md) | `client-connections` | `client.connections` |
| 客户端 | [同源网关](./web/client-gateway.md) | `client-gateway` | `client.gateway` |
| 验证 | [H0 资源探针](./diagnostics/resource-probe.md) | `h0-resource-probe` | `h0.runs`；仅验证使用 |

## 从一次请求理解模块协作

1. [Web](./web/web-frontend.md) 或 [Harness 门面](../../src/harness/index.ts) 接收请求，通过当前服务进行调用。
2. [Run](./execution/run.md) 先检查已接受幂等键，再检查 [Session](./sessions/session.md) 的归档状态、项目、Prompt 与模型选择；新请求经 Session 受管读取已准备的[文件快照](./sessions/project-files.md)。
3. [协议应用注册](./execution/protocol-agent-registry.md) 在模板后附加文件资料并编码图片引用，固定驱动代与对应 Loop，通过 [Models](./models/models.md) 准备独立 execution/program；Session 在接受事务复核归档状态、协议及父恢复引用，同时永久保留图片与文件引用。
4. [RunRuntime](./execution/run-runtime.md) 同步接管 program，管理操作意图、实际启动、取消、退出和观察提交。对应协议 Loop 消费原生结果，经 Runtime 使用 [本地工具](./tools/README.md)。
5. program 与工具退出后，Session 原子提交成功节点、记录、结果引用和终态。Web 通过安全投影及持久查询呈现结果。

Models 配置库、目录缓存库和业务 SQLite 是三套独立连接，不共享文件。系统凭据留在 Vault，原生恢复记录留在受信 Session，浏览器只接收允许展示的投影。生命周期细节见 [Harness 协作总览](../harness-components.md)。

## 当前持久格式

这些版本属于不同边界，不能互相替代：

| 边界 | 当前写入 | 读取与兼容 |
| --- | --- | --- |
| Models 配置库 / 原生参数 | 配置库 v3；参数 `{ protocolId, formatVersion: 1, value }` | 未知扩展保留待迁移状态；历史 JSON 不改写 |
| Session 迁移账本 | `run-state` v7 | v5 原生记录、v6 图片资源引用、v7 `archivedAt`；旧 `dialogue-v1` 只读 |
| Run 原始输入 | `NativeRunInput` v3，保存 raw/text/template/images/files | v1 无附件，v2 只有图片；文件正文另存快照并进入本轮原生请求 |
| 五协议驱动 / 应用绑定 | 驱动 2.1.0、Loop 1.1.0、原生记录 v2 | 双读旧文本 v1 与混合父链，仍检查账户、模型和执行语义兼容 |
| 资源迁移域 | `image-assets` v1、`project-files` v1 | 使用既有业务连接，与接受 Run 同事务保留；失败和取消不释放已接受引用 |
| 浏览器待提交记录 | `PendingSubmission` v3 | 兼容 v1/v2；先查已接受幂等结果，不自动重放未确认的旧提交 |

## 组件之外的代码

[src/harness/index.ts](../../src/harness/index.ts) 和 [src/host/serve.ts](../../src/host/serve.ts) 是组合根/宿主入口；AgentDefinition 是只读配置；`execution`、`PreparedRunProgram`、协议 Loop、内部 SQLite 提供方及浏览器视图是所属组件持有或调用的实现。它们在相关文档中说明，不独立计作组件。`packages/api-key-manager` 保留独立工具包和旧凭据读取用途，说明见 [包 README](../../packages/api-key-manager/README.md)，不是当前应用的额外 Nya 凭据组件。

新增或调整组件时，按 [文档维护约定](../README.md#维护约定) 同步更新本清单和模块目录。组件文档描述当前实现，设计文档保存跨模块决策和迁移背景。
