# Agent Prompt 组件

[返回 Prompt 模块](./README.md)

## 职责与组件契约

Agent Prompt 保存 Agent 对已发布 Prompt 版本的选择，并为 Run 解析不可变内容快照。内容、草稿和版本仍由 [Prompt](./prompts.md) 持有；本组件只拥有绑定和启动时的默认指令。

| 项目 | 定义 |
| --- | --- |
| 工厂 | `createAgentPromptComponent(inputs, agents, canManageAgent, legacyJsonPath?)` |
| Nya 组件名 | `harness-agent-prompts` |
| 提供服务 | `harness.agent-prompts`，接口 `AgentPromptPort` |
| 注入依赖 | `harness.prompts`、`local-storage` |
| 入口 | [prompt-binding-component.ts](../../../src/applications/harness/core/agent/prompt-binding-component.ts) |
| 内部存储 | [prompt-binding-storage.ts](../../../src/applications/harness/core/agent/prompt-binding-storage.ts) |

`inputs` 提供时间与 ID 契约，本组件绑定使用其中的 `now()`；`agents` 是宿主传入的只读 `AgentDefinition[]`，不通过独立 Agent 组件查询。Agent ID、非空初始指令和可选默认 modelId 由 [validateAgents](../../../src/applications/harness/core/agent/domain.ts) 在组合根启动时校验，修改定义需要重新装配。

`canManageAgent(actorId, agentId)` 是宿主提供的授权判定。`createHarnessServerPromptComponents` / `installHarnessServerCore` 未提供该选项时默认为允许，故嵌入具有用户隔离需求的宿主时应显式传入授权规则；该默认值不构成账号系统。

## 服务接口与授权

| 方法 | 行为与使用者 |
| --- | --- |
| `bindPrompt(actorId, agentId, versionId)` | 校验 Agent 存在、管理权限和版本属于该 actor，写入对应 kind 的绑定 |
| `getAgentPrompts(actorId, agentId)` | 校验 Agent 管理权限，返回解析后的版本快照 |
| `resolveRunPrompts(agentId)` | 受信读取：按 instruction、context、task-template 顺序解析全部快照 |
| `resolveInitialPrompts(agentId)` | 受信读取：只解析 instruction 与 context |
| `resolveTaskTemplate(agentId)` | 受信读取：返回当前 task-template，未绑定返回 `undefined` |

管理方法要求非空 actorId/agentId；版本必须已经发布，不能绑定草稿。绑定键是 `(agentId, kind)`，同一用途的新绑定替换旧选择，不影响另外两种用途。返回的 `PromptBinding` 保存 kind、versionId、updatedAt、updatedBy。

内部 resolve 方法不执行用户授权，只校验 Agent 与引用版本，由受信 Run 使用；harness server API 不暴露这三个方法。宿主应从可信身份上下文提供 actorId。

## 解析与运行中的生效规则

1. 读取该 Agent 的已提交绑定，按请求需要筛选 kind。
2. 经 `harness.prompts.getPublishedVersion()` 解析版本，验证存在且 kind 匹配；失效引用报错，不静默丢弃。
3. 未绑定 instruction 时，用 AgentDefinition.instructions 创建内建 `system` 指令。版本 ID 为 `builtin:<agentId>:<指令的 SHA-256>`，文档 ID 为 `builtin:<agentId>`；该默认项不写入用户文档库。
4. 按 instruction、context、task-template 固定顺序输出冻结的 `PromptSnapshot[]`。快照包含版本/文档 ID、用途、角色和内容。

[Run](../execution/run.md) 将当前 task-template 用于本次原始输入；[Session](../sessions/session.md) 则持有首次接受时固定的 instruction/context 和工具声明。已固定初始化的 Session 的其他根分支也复用其初始记录，不在每次 Run 重新套用新 instruction。更换绑定不会改写已接受 Run 或历史节点；要对这类会话应用新初始指令，需要新建 Session。尚未接受过 Run 的 Session 在首次接受时采用当前绑定。

图片与项目文件不参与模板替换。Run 保存 v3 原始输入及附件引用，协议注册表在模板结果之后追加文件快照资料，再编码图片；文件内容始终属于用户资料，不成为 instruction/context。编辑与重新生成仍只对原始文本套用当前 task-template 一次，默认复用已有附件快照。

## 数据、并发与恢复

组件在 `apply` 登记 `agent-prompt` 迁移，拥有 `agent_prompt_bindings` 和 `agent_prompt_json_import`；物理连接由 [local-storage](../infrastructure/local-sqlite.md) 持有。写入通过私有 Promise 队列串行执行，在事务前复核发布版本，使用 `(agent_id, kind)` UPSERT；提交成功后才替换内存绑定投影。

可选旧 JSON 导入在 Prompt 先完成版本导入后进行。导入要求绑定表为空，校验全部版本引用，事务内写绑定与导入标记，不修改原文件。同一路径只导入一次，不允许之后切换到另一文件。启动读取所有已存绑定时也检查引用与 kind，损坏引用会阻止初始化。

## 生命周期与限制

初始化完成即返回，不启动长时间循环。Effect 关闭绑定写入准入并等待已接受写入；Prompt 依赖在消费者清理完成之前保持可用。卸载 Agent Prompt 不删除 Prompt 文档和发布版本；卸载 Prompt 则会经 Nya 依赖关系让 Agent Prompt 和运行消费者退出。

组件没有网络请求、系统凭据或模型 execution。当前没有解绑接口，也不支持同一 Agent 同一种用途绑定多个版本。失败包括未知 Agent、`agent configuration access denied`、`prompt access denied`、引用不可用、存储关闭及事务错误。不能通过改表绕过发布版本及授权检查。

## 验证入口

[prompt-management.test.mjs](../../../tests/prompt-management.test.mjs) 覆盖发布后绑定、默认指令与角色组合、权限、重启、导入、卸载等待及 Prompt 依赖取消；[native-session.test.mjs](../../../tests/native-session.test.mjs) 覆盖 Session 首次固定与后续分支使用规则。根 `npm run check` 执行这些行为测试。
