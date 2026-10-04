# 执行模块

[返回组件文档](../README.md)

本模块把一次用户请求变成可取消、可等待实际退出、可恢复历史的 Run。Run 管准入，RunRuntime 管资源和结算屏障，各协议 Agent 绑定管原生循环选择。持久事实归 [Session](../sessions/session.md)，网络、原生可变上下文与凭据归 Models execution；这些边界共同保证取消或重启不会误重放外部副作用。

## 组件目录

| 文档 | Nya 组件名 | 对外服务或作用 |
| --- | --- | --- |
| [Run](run.md) | `harness-runs` | `harness.runs`，启动、取消、等待和临时视图查询 |
| [RunRuntime](run-runtime.md) | `harness-run-runtime` | `harness.run-runtime`，运行期资源所有者 |
| [协议 Agent 注册表](protocol-agent-registry.md) | `harness-protocol-agents` | `harness.protocol-agents`，准备绑定到驱动代的程序 |
| [Responses Agent](responses-agent.md) | `harness-protocol-agent-responses` | 注册 Responses 驱动和 Loop 的配对 |
| [Chat Completions Agent](chat-completions-agent.md) | `harness-protocol-agent-chat-completions` | 注册标准 Chat 配对 |
| [Anthropic Agent](anthropic-agent.md) | `harness-protocol-agent-anthropic-messages` | 注册 Messages 配对 |
| [Gemini Agent](gemini-agent.md) | `harness-protocol-agent-gemini-interactions` | 注册 Interactions 配对 |

四个绑定组件由同一 `createProtocolAgentBindingComponent(protocolId)` 工厂创建，分别持有自己的注册和驱动代租约。`runResponses`、`runChat`、`runAnthropic`、`runGemini` 是协议循环函数，不是额外的 Nya 组件。Agent 定义是启动时验证的只读配置，也不是组件。

## 依赖与装配

[组合根](../../../src/applications/harness/core/index.ts) 在应用唯一的根 Context 上安装组件；没有 harness server 子 Context，也没有项目或任务 Context。它在尚无 `harness.protocol-agents` 服务时安装注册表，并为 `models.settings.protocols()` 已配置且本项目支持的协议安装绑定。

- Run 注入 Session 两个端口、[Agent Prompt](../prompts/agent-prompts.md)、`models`、协议 Agent 注册表、RunRuntime 和 [Projects](../sessions/projects.md)。
- RunRuntime 注入 `harness.session-runs`、[Bash](../tools/bash.md) 与 [Apply Patch](../tools/apply-patch.md)。它不解释原生协议状态。
- 协议注册表注入 `models`、`models.protocols` 和 [Image Assets](../images/image-assets.md)；每个绑定注入协议注册表与 `models.protocols`。文件正文由 Run 经 Session 读取后传入注册表，注册表不直接依赖 Project Files。

`apply` 只完成初始化和服务注册，不运行长期循环。组件使用本轮 `deps` 快照，通过 Effect 注册清理；Nya 负责依赖失效时的停止与重建。harness server API 每次请求重新获取当前服务，避免跨组件重启缓存引用。

## 一次 Run 的完整流程

1. 调用 `startRun({ sessionId, parentNodeId, input, images?, files?, idempotencyKey, modelId? })`。根分支显式传 `parentNodeId: null`；文本、图片、文件至少一项非空；先检查已接受幂等键，再解析当前配置。
2. 检查 Session 未归档、项目目录、Agent、模型与协议。模型按显式输入、Session 选择、Agent 默认的顺序确定；恢复只沿指定成功父节点的路径。
3. 首次接受固定 instruction/context 和工具声明；后续复用。当前 task-template 只处理本次原始输入一次。Run 受管读取文件快照并等待退出，注册表在模板后附加文件资料、编码图片引用，获取驱动代租约并准备独立 execution 和 `PreparedRunProgram`。
4. Session 接受事务再次验证归档状态、父上下文引用、协议与固定初始化，同事务永久保留图片及文件引用，保存 Run 和非秘密快照。首次接受原子固定 Session 协议。
5. RunRuntime 在首次异步读取前同步接管 program。每次操作先持久化 intent，再检查停止状态，同步启动并登记句柄，等待 `result` 和 `done`，最后提交实际 observation。
6. 协议 Loop 直接解释原生结果；需要本地工具时使用共享 Runtime 串行执行 Bash/Apply Patch，再只发送新增工具结果。后续协议轮次的完整上下文由 execution 管理。
7. Runtime 停止新操作、等待工具和模型实际退出、关闭 program 后，才请求 Session 结算。成功结算把 Run、原生记录、上下文链节、结果引用、完整节点和终态事件放在同一事务；失败和取消不创建节点。

`startRun()` 返回已启动或已结算的 Run；完成判断使用 `waitRun()`。取消请求并不代表资源已经退出。中止一个等待者只结束等待，不取消执行。

## 状态、兼容与验证

新 Run 仅使用 `native-local-v1` 与 schemaVersion 3 模型快照。旧 `dialogue-v1` Session 只读；旧 Bash 事件、旧模型快照的兼容位于 Session 读取边界。浏览器展示来自有界白名单投影，不是原生恢复事实。凭据、认证头、运行句柄不进入历史；签名和原生续接数据只保留在受信记录中。

[harness server 核心行为测试](../../../tests/harness-server-core.test.mjs)、[会话树测试](../../../tests/conversation-tree.test.mjs)、[原生协议测试](../../../tests/native-protocol-agents.test.mjs)、[原生 Session 测试](../../../tests/native-session.test.mjs) 和 [工具循环测试](../../../tests/tool-loop.test.mjs) 覆盖准入、交接、恢复、并发分支、取消、退出等待与事务失败。根目录的 `npm run check` 是统一验证入口。
