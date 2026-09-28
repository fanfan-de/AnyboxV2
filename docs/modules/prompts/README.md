# Prompt 模块

[返回组件手册](../README.md)

本模块把可复用提示词的内容管理与 Agent 的版本选择组合起来：Prompt 保存草稿和发布版本，Agent Prompt 保存绑定并解析运行快照。二者共享业务 SQLite 的物理连接，各自拥有领域表与写入队列。Agent 定义是组合根传入的只读配置，不是第三个组件。

| 组件 | 服务 | 负责的事实 |
| --- | --- | --- |
| [Prompt](./prompts.md) | `harness.prompts` | 文档归属、草稿修订、不可变发布版本 |
| [Agent Prompt](./agent-prompts.md) | `harness.agent-prompts` | 每个 Agent 各用途的版本绑定、默认指令和快照解析 |

## 协作流程

1. 受信宿主确认操作者身份，调用 Prompt 创建、编辑和发布文档。
2. Agent Prompt 校验 Agent 管理权限及发布版本归属，保存绑定。发布不会自动切换绑定。
3. [Run](../execution/run.md) 在接受新请求前解析快照；已接受幂等请求直接返回原 Run。
4. [Session](../sessions/session.md) 首次接受时固定初始 instruction/context，后续根分支及后代复用这些记录。当前 task-template 只处理每个新 Run 的原始输入一次。

因此，改草稿、发版本、改绑定是三个不同动作。绑定新 instruction/context 后，已接受过 Run 的 Session 继续使用首次固定内容；尚未接受过首个 Run 的 Session（包括新建会话）在首次接受时采用当前初始提示词。当前 task-template 可以影响后续新 Run，不会改写旧 Run 的输入或快照。

## 依赖与替换

先提供 [local-storage](../infrastructure/local-sqlite.md)，Prompt 通过 `migrate('prompt', ...)` 登记自己的表，Agent Prompt 通过 `migrate('agent-prompt', ...)` 登记绑定表。Nya 的注入关系保证 Agent Prompt 在 Prompt 就绪后初始化，卸载时消费者先退出；具体编排见 [组合根](../../../src/harness.ts)。

纯校验、草稿状态转换、发布和快照生成位于 [Prompt 领域函数](../../../src/prompt/domain.ts)。运行协议的消息编码由 [协议应用绑定](../execution/protocol-agent-registry.md) 负责，本模块不依赖原生协议类型、密钥或网络。

详细设计及旧 JSON 导入约束见 [Prompt 管理设计](../../prompt-management-design.md)。
