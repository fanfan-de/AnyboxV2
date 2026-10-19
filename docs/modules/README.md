# 模块与组件手册

[返回文档首页](../README.md)

本手册按实际组件与资源边界组织，文档模块不必镜像源码目录。每个执行宿主与本机客户端分别拥有一个 Nya 根，应用不创建子 Context。D0a 已完成独立 workspace 边界：通用宿主与外壳位于 `packages/host/src/`，Anybox Harness 的核心、HTTP、客户端和浏览器实现位于 `packages/app-harness/src/`，Claude Agent 位于 `packages/app-claude-agent/src/`，默认组合入口位于 `packages/distribution/src/entrypoints/`；SQL 与目录归基础包，连接/凭据/配对/转发由各应用私有实现，Models 保持独立包。D0b 已完成按消费者装配，D1.1 的包管理账本独立保存安装与版本归属，D1.2 的[归档与产物工具](package-management/archives.md)提供签名校验和独立准备，不另建 Nya 组件；D1.3 的[本地文件安装](package-management/installation.md)接入受管暂存、目录提交与显式恢复。D1.4 的[正式加载与生效](package-management/activation.md)接入最小宿主、角色交接与全部页面保护。D1.5 复用原组件接入卸载、代码回收与显式恢复。默认静态组合仍位于 distribution，旧发行迁入和在线下载继续按后续阶段实施。完整产品名和服务端称呼见[命名规范](../naming.md)。详见[模块边界](../harness-module-boundary.md)与[部署说明](../harness-server-deployment.md)。

[D0a.1 独立业务服务](../application-standalone-services.md)由各应用提供自己的入口、HTTP 与认证；Anybox 接入复用同一业务装配。同进程不增加根，独立运行也不依赖宿主活动或应用管理。新增 Harness 与 Claude Agent 的访问、监听组件分别记录在手册；服务工厂和配置函数在所属组件及阶段文档说明。

Anybox Harness 的[原生 Computer 支持](../native-platform-support.md)由既有 Computer 与工具组件内部的 `packages/app-harness/src/core/platform/` 适配提供，不新增 Nya 组件或组件文档数；不归宿主与 Claude Agent。

## 模块目录

| 目录 | 内聚职责 | 独立组件文档数 |
| --- | --- | --- |
| [products/](./products/README.md) | 固定应用目录、按需装配与活动准入 | 2 |
| [package-management/](./package-management/README.md) | 独占安装注册库、耐久操作、版本快照、跨进程使用凭证、本地文件安装、正式加载、生效、卸载回收与恢复，以及归档/产物辅助工具 | 3 |
| [claude-agent/](./claude-agent/README.md) | Claude Agent：线程索引、SDK 适配器、Run 准入与审批、HTTP/SSE、本机角色通道、独立服务访问和监听、客户端远端连接与网关 | 9 |
| [models/](./models/README.md) | 可复用模型配置、凭据、原生驱动及可选公开目录 | 11 |
| [execution/](./execution/README.md) | Run 准入、运行资源、原生协议 Agent 绑定与循环 | 7 |
| [computers/](./computers/README.md) | 按需本机资源、独立 worker、固定工作区、耐久工具操作协调、单元拨出与按附着路由 | 9 |
| [sessions/](./sessions/README.md) | 项目身份与目录浏览、文件快照、会话树、归档、Run 持久事实及恢复 | 3 |
| [units/](./units/README.md) | 可部署单元的附着账本、本机自动附着、Run 固定的附着引用与单元拨出传输 | 2 |
| [images/](./images/README.md) | 图片导入、不可变字节、草稿续期与事务保留 | 1 |
| [prompts/](./prompts/README.md) | 可复用 Prompt 内容与 Agent 的版本选择 | 2 |
| [tools/](./tools/README.md) | 来源工具契约、进程会话、文件变更与搜索 | 4 |
| [infrastructure/](./infrastructure/README.md) | 业务数据库与可替换存储端口 | 1 |
| [web/](./web/README.md) | 执行 API、宿主及 Harness 独立访问管理和监听、客户端外壳与连接库、Anybox Harness 网关、目录选择 | 10 |
| [diagnostics/](./diagnostics/README.md) | 资源归属探针 | 1 |

## 完整组件索引

组件名是 Nya `name`，服务名是 `provide`/`inject` 使用的标识；两者不一定相同。登记型组件通过依赖的注册服务发布能力，不需要另建一个服务名。

| 模块 | 独立文档 | Nya 组件名 | 提供服务或登记能力 |
| --- | --- | --- | --- |
| 产品 | [产品控制](./products/products.md) | `app-products` | `app.products` |
| 产品 | [活动准入](./products/activity.md) | `app-activity` | `app.activity` |
| 包管理 | [安装事实与操作账本](./package-management/registry.md) | `host-package-registry` | `host.package-registry`；注入独立 `host.package-registry-storage` |
| 包管理 | [正式角色加载、生效与卸载](./package-management/activation.md) | `host-package-activation` | `host.package-activation`；注入注册库、Products 与 Activity |
| 包管理 | [本地文件安装](./package-management/installation.md) | `host-package-installer` | `host.package-installer`；注入 `host.package-registry` |
| Models | [协调服务](./models/models.md) | `models` | `models`、`models.settings`、`models.protocols`、`models.source-data` |
| Models | [JSON 配置存储](./models/json-store.md) | `models-json-store` | `models.store` |
| Models | [SQLite 配置替换提供方](./models/store.md) | `models-store` | `models.store` |
| Models | [系统凭据](./models/vault.md) | `models-vault` | `models.vault` |
| Models | [目录来源](./models/catalog-source.md) | `models-catalog-source` | `models.catalog-source` |
| Models | [目录缓存](./models/catalog-cache.md) | `models-catalog-cache` | `models.catalog-cache` |
| Models | [目录调度](./models/catalog.md) | `models-catalog` | `models.catalog` |
| Models | [Responses 驱动](./models/responses.md) | `models-protocol-responses` | 在 `models.protocols` 登记 `responses` |
| Models | [Chat Completions 驱动](./models/chat-completions.md) | `models-protocol-chat-completions` | 登记 `chat-completions` |
| Models | [Anthropic Messages 驱动](./models/anthropic-messages.md) | `models-protocol-anthropic-messages` | 登记 `anthropic-messages` |
| Models | [Gemini Interactions 驱动](./models/gemini-interactions.md) | `models-protocol-gemini-interactions` | 登记 `gemini-interactions` |
| 执行 | [Run](./execution/run.md) | `harness-runs` | `harness.runs`、`harness.run-admission` |
| 执行 | [RunRuntime](./execution/run-runtime.md) | `harness-run-runtime` | `harness.run-runtime` |
| 执行 | [协议应用注册](./execution/protocol-agent-registry.md) | `harness-protocol-agents` | `harness.protocol-agents` |
| 执行 | [Responses 应用绑定](./execution/responses-agent.md) | `harness-protocol-agent-responses` | 将该驱动代与 Responses Loop 绑定 |
| 执行 | [Chat Completions 应用绑定](./execution/chat-completions-agent.md) | `harness-protocol-agent-chat-completions` | 将该驱动代与 Chat Loop 绑定 |
| 执行 | [Anthropic 应用绑定](./execution/anthropic-agent.md) | `harness-protocol-agent-anthropic-messages` | 将该驱动代与 Anthropic Loop 绑定 |
| 执行 | [Gemini 应用绑定](./execution/gemini-agent.md) | `harness-protocol-agent-gemini-interactions` | 将该驱动代与 Gemini Loop 绑定 |
| Computer 资源 | [Worker 路由](./computers/worker-router.md) | `computer-worker-router` | `computer.worker`、`computer.instance-provider` |
| Computer 资源 | [Computers](./computers/computers.md) | `harness-computers` | `harness.computers` |
| Computer 资源 | [Workspaces](./computers/workspaces.md) | `harness-workspaces` | `harness.workspaces` |
| Computer 资源 | [Computer Operations](./computers/computer-operations.md) | `harness-computer-operations` | `harness.computer-operations` |
| Computer 资源 | [本机 worker 客户端](./computers/local-worker-client.md) | `computer-local-worker-client` | Authority 根的 `computer.local-worker` 回环代理与 `computer.local-worker-control` |
| Computer 资源 | [worker 执行器](./computers/worker-executor.md) | `computer-worker-executor` | worker 独立根的 `computer.worker` |
| Computer 资源 | [worker 附着账本](./computers/worker-attachments.md) | `computer-worker-attachments` | worker 根的 `computer.worker-attachments` |
| Computer 资源 | [worker 拨出](./computers/worker-dialout.md) | `computer-worker-dialout` | worker 根的 `computer.worker-dialout` |
| Computer 资源 | [worker 固定项目绑定](./computers/worker-project-bindings.md) | `computer-worker-project-bindings` | worker 根的 `harness.projects` 兼容工具路径端口 |
| 项目与会话 | [Projects](./sessions/projects.md) | `harness-projects` | `harness.projects` |
| 项目与会话 | [Project Files](./sessions/project-files.md) | `harness-project-files` | `harness.project-files` |
| 项目与会话 | [Session](./sessions/session.md) | `harness-sessions` | `harness.sessions`、`harness.session-runs` |
| 可组合单元 | [单元附着](./units/unit-attachments.md) | `harness-unit-attachments` | `harness.unit-attachments` |
| 可组合单元 | [单元传输](./units/unit-transport.md) | `harness-unit-transport` | `harness.unit-transport` |
| 图片资源 | [Image Assets](./images/image-assets.md) | `harness-image-assets` | `harness.image-assets` |
| Prompt | [Prompt](./prompts/prompts.md) | `harness-prompts` | `harness.prompts` |
| Prompt | [Agent Prompt](./prompts/agent-prompts.md) | `harness-agent-prompts` | `harness.agent-prompts` |
| 工具 | [Bash](./tools/bash.md) | `bash-tool` | `tools.bash` |
| 工具 | [Apply Patch](./tools/apply-patch.md) | `apply-patch-tool` | `tools.apply-patch` |
| 工具 | [进程工具](./tools/processes.md) | `process-tools` | `tools.processes` |
| 工具 | [文件工具](./tools/files.md) | `file-tools` | `tools.files` |
| 基础存储 | [业务与注册库 SQLite](./infrastructure/local-sqlite.md) | `local-sqlite` | 默认 `local-storage`；独立命名实例可提供 `host.package-registry-storage` |
| 宿主 | [Application HTTP](./web/web-frontend.md) | `host-application-api` | `host.http` |
| harness server 接入 | [harness server HTTP](./web/harness-http.md) | `harness-http` | `harness.http` |
| 可选目录适配 | [本机目录选择器](./web/directory-picker.md) | `host-directory-picker` | `host.directory-picker` |
| 宿主 | [访问管理](./web/host-access.md) | `host-access` | `host.access` |
| Harness 独立服务 | [访问管理](./web/harness-access.md) | `harness-access` | `harness.access` |
| Harness 独立服务 | [HTTP 监听](./web/harness-listener.md) | `harness-listener` | `harness.listener` |
| Anybox Harness 客户端 | [连接组件](./web/client-connections.md) | `client-connections` | `client.connections` |
| 客户端外壳 | [应用 HTTP](./web/client-shell.md) | `app-client-http` | `app.client-http` |
| Anybox Harness 客户端 | [Computer 管理](./web/client-computer.md) | `client-computer` | `client.computer` |
| Anybox Harness 客户端 | [同源网关](./web/client-gateway.md) | `client-gateway` | `client.gateway` |
| 验证 | [H0 资源探针](./diagnostics/resource-probe.md) | `h0-resource-probe` | `h0.runs`；仅验证使用 |
| Claude Agent | [Store](./claude-agent/store.md) | `claude-agent-store` | `claude-agent.store` |
| Claude Agent | [SDK 适配器](./claude-agent/sdk.md) | `claude-agent-sdk` | `claude-agent.sdk` |
| Claude Agent | [Runs](./claude-agent/runs.md) | `claude-agent-runs` | `claude-agent.runs`、`claude-agent.run-admission` |
| Claude Agent | [HTTP](./claude-agent/http.md) | `claude-agent-http` | `claude-agent.http` |
| Claude Agent 独立服务 | [访问管理](./claude-agent/access.md) | `claude-agent-access` | `host.access`（既有键兼容） |
| Claude Agent 独立服务 | [HTTP 监听](./claude-agent/listener.md) | `claude-agent-listener` | `claude-agent.listener` |
| Claude Agent | [本机执行](./claude-agent/local-execution.md) | `claude-agent-local-execution` | `claude-agent.local-execution` |
| Claude Agent | [客户端连接](./claude-agent/client-connections.md) | `claude-agent-client-connections` | `claude-agent.connections` |
| Claude Agent | [Client Gateway](./claude-agent/client-gateway.md) | `claude-agent-client-gateway` | `claude-agent.gateway` |

## 从一次请求理解模块协作

1. [Web](./web/web-frontend.md) 或 [harness server API](../../packages/app-harness/src/core/index.ts) 接收请求，通过当前服务进行调用。
2. [Run](./execution/run.md) 先检查已接受幂等键，再检查 [Session](./sessions/session.md) 的归档状态、项目、Prompt 与模型选择；新请求经 Session 受管读取已准备的[文件快照](./sessions/project-files.md)。
3. [协议应用注册](./execution/protocol-agent-registry.md) 在模板后附加文件资料并编码图片引用，固定驱动代与对应 Loop，通过 [Models](./models/models.md) 准备独立 execution/program；Run 解析本机 Models 与 Computer 的[单元附着](./units/unit-attachments.md)引用，Session 在接受事务复核归档状态、协议、父恢复引用及附着引用，同时永久保留图片与文件引用。
4. [RunRuntime](./execution/run-runtime.md) 同步接管 program，管理操作意图、实际启动、取消、退出和观察提交。计算工具声明和 resume cursor 由 Session 同事务接纳到 [Computer Operations](./computers/computer-operations.md)，后者按需准备确切实例和工作区，再交独立 [worker](./computers/worker-executor.md) 的工具执行器；纯模型和计划调用不激活 computer。进程异常退出后，新 Runtime 提升 owner，查回原操作与游标。
5. 工具图片观察与原字节引用同事务保留，随后按用户图片块进入下一次原生请求；进程 scope 退出事实经通用清理操作提交，program 与全部工具退出后，Session 才原子提交成功节点、记录、结果引用和终态。Web 通过安全投影及持久查询呈现结果。

Models 配置库、目录缓存库和业务 SQLite 是三套独立连接，不共享文件。系统凭据留在 Vault，原生恢复记录留在受信 Session，浏览器只接收允许展示的投影。生命周期细节见 [harness server 协作总览](../harness-server-components.md)。

## 当前持久格式

这些版本属于不同边界，不能互相替代：

| 边界 | 当前写入 | 读取与兼容 |
| --- | --- | --- |
| Models 配置库 / 原生参数 | 配置库 v3；参数 `{ protocolId, formatVersion: 1, value }` | 未知扩展保留待迁移状态；历史 JSON 不改写 |
| 应用目标迁移账本 | `app-products` v2；按注册 ID 保存打开目标 | 执行库首次按 run-state 保留 Agent；旧组合只迁入内置目标；客户端默认关闭 |
| 包管理注册库 | 独立 `registry.sqlite` 中的 `host-package-registry` v2 | 原地保留 v1；新增预身份文件安装任务、CAS 回执与工作锚历史；安装、操作、快照与使用凭证分表，与 Products 目标及应用业务库分开；未知退出阻塞恢复和回收 |
| Session 迁移账本 | `run-state` v11 | v11 在 `harness_runs` 增加固定的单元附着引用；v10 独立 Run 恢复游标与 owner；保留 v5 原生记录、v6 图片引用、v7 归档、v8 默认模型、v9 工具选择；旧 `dialogue-v1` 只读，没有引用的旧 Run 按本机形态解释 |
| 单元附着迁移域 | `unit-attachments` v1 | 附着记录与审计事件；附着码和单元凭证只存 SHA-256 摘要；本机附着 ID 固定为 `local:<kind>` |
| worker 附着迁移域 | `computer-worker-attachments` v1 | 独立 worker 服务的 harness server 记录、作用域上限与凭据意图；单元凭证只在系统凭据命名空间 |
| Run 根初始化 | `NativeInitialization` v2 / `tool-library-v1` | 复制 Session 工具快照；旧 v1 / `known-tools-v1` 定义与 JSON 保持原样 |
| Run 原始输入 | `NativeRunInput` v3，保存 raw/text/template/images/files | v1 无附件，v2 只有图片；文件正文另存快照并进入本轮原生请求 |
| 四协议驱动 / 应用绑定 | 驱动 2.1.0、Loop 1.3.0、原生记录 v2 | 读取 Loop 1.0/1.1/1.2/1.3；双读旧文本 v1，仍检查账户、模型和执行语义兼容 |
| 资源迁移域 | `image-assets` v1、`project-files` v1 | 使用既有业务连接，与接受 Run 同事务保留；失败和取消不释放已接受引用 |
| 项目迁移域 | `projects` v2 | 项目绑定一个 Computer 附着，同一路径可在不同单元各登记一次；旧项目迁入时绑定 `local:computer` |
| Computer 迁移域 | Authority：`computers` v1、`workspaces` v1、`computer-operations` v3；worker：`computer-worker` v2 | 两端独占连接与接纳/结果账本；v3 scope 与 worker v2 Run 各记录所属附着，旧行按 `local:computer` 解释；工具等待接续，不自动重放未知执行或跨机器迁移 |
| 浏览器待提交记录 | `PendingSubmission` v3 | 兼容 v1/v2；先查已接受幂等结果，不自动重放未确认的旧提交 |

## 组件之外的代码

[packages/app-harness/src/core/index.ts](../../packages/app-harness/src/core/index.ts) 和 [packages/distribution/src/entrypoints/serve.ts](../../packages/distribution/src/entrypoints/serve.ts) 是组合根/宿主入口；AgentDefinition 是只读配置；`execution`、`PreparedRunProgram`、协议 Loop、内部 SQLite 提供方及浏览器视图是所属组件持有或调用的实现。它们在相关文档中说明，不独立计作组件。`packages/api-key-manager` 保留独立工具包和旧凭据读取用途，说明见 [包 README](../../packages/api-key-manager/README.md)，不是当前应用的额外 Nya 凭据组件。

新增或调整组件时，按 [文档维护约定](../README.md#维护约定) 同步更新本清单和模块目录。组件文档描述当前实现，设计文档保存跨模块决策和迁移背景。
