# 环境提供工具

[返回文档首页](README.md) · [工具模块](modules/tools/README.md)

## 当前边界

Anybox Harness 的工具由受信装配插入的环境提供。`AgentDefinition.environmentIds` 选择环境，环境声明工具身份、契约版本、模型描述与参数，并拥有实际执行入口。Agent Loop 负责原生协议编码与推理；RunRuntime 负责耐久意图、取消传播、观察与结算。

本能力不使用 MCP，不运行任意路径、远端 schema 或模型提供的插件代码。首期是程序化受信装配；Web 的既有工具选择仍管理 Computer 工具偏好。Browser、Database 等没有因本轮接入而新增生产实现。

## 独立包

- [`@anybox/tool-api`](../packages/tool-api/README.md)：JSON、工具描述、`ToolCall`、图片引用及 `ToolEnvironment`，不依赖 Harness、Models、Nya、SQL 或 HTTP。
- [`@anybox/computer-tools`](../packages/computer-tools/README.md)：四个真实 Nya 资源组件、来源契约适配、原生进程后端和搜索资源。可以安装在其他消费者自己的 Nya 根上。

Computer 工具描述通过纯 `/contracts` 入口提供，参数与结果适配通过 `/adapters` 提供。模型、Session 与描述查询不导入执行组件。工具包接收受信的工作目录和不透明 scope，不查询 Project、Session 或 Run。

## 插入与选择

`HarnessServerCoreOptions.toolEnvironments`、`HarnessServerRuntimeOptions.toolEnvironments` 接收 `ToolEnvironment[]`。Agent 的 `environmentIds` 缺省为 `['computer']`，显式 `[]` 表示不插入任何工具环境。`computer` 为内置保留身份，其具体执行位置继续由项目的 Computer 附着决定。

可运行的[资料库环境示例](../examples/tool-environments/notes/README.md)提供 `notes_search`、`notes_read`，实际读取 Markdown，并用既有原生协议与 Agent 验证工具往返。只需新增提供方与装配配置：

```js
import { installHarnessServerCore } from '@anybox/app-harness/core/index'
import { createNotesEnvironment } from './environment.mjs'

const notes = createNotesEnvironment(documents)
await installHarnessServerCore(root, {
  agents: [{ ...existingAgent, environmentIds: ['notes'] }],
  toolEnvironments: [notes],
})
```

这里的 `root` 与 `existingAgent` 沿用当前装配，`documents` 是环境拥有的资料。Agent 实现、instructions、协议 Loop 与 RunRuntime 不加入环境专属分支。需要同时使用 Computer 时选择 `['computer', 'notes']`。完整示例以离线模型验证实际执行链，无需 API Key；它不声称验证真实模型的决策质量。

运行 `npm run build` 后执行 `node examples/tool-environments/notes/demo.mjs`，可以看到无环境会话工具为空，新会话声明并调用 `notes_search`、`notes_read`，旧会话仍为空。

环境之间的工具 ID 与模型调用名必须唯一；含糊绑定在创建快照时明确拒绝。通用参数校验支持的 JSON Schema 子集与拒绝边界见 tool-api README。所有工具先完成整批参数预检，再允许任何工具副作用。

## 会话快照与兼容

创建 Session 的同一业务事务保存环境身份、环境契约版本、工具 ID/版本和完整模型定义；Agent 的 Computer 工具偏好只进一步缩小 Computer 环境提供的工具。环境未提供的工具不能通过 Agent 设置获得。

环境装配在应用本代内固定。更改配置并重新装配后，新 Session 采用新环境；已有 Session 的 `toolEnvironments` 和 `toolSelection` 不修改。新增的环境工具不会自动进入旧会话，移除环境或不兼容版本不会将旧会话重绑到其他环境；历史仍可阅读，后续执行明确拒绝。

`run-state` v12 新增不可变 `tool_environments_json`；没有该字段的旧 Session 保留旧 Computer 路径。新初始化使用 `NativeInitialization` v3 / `tool-environments-v1`，v1/v2 和已退役计划工具的旧冻结快照继续兼容。升级前停止应用并备份业务库；回退代码需要恢复升级前备份。

## 执行、取消与恢复

环境通过 `openScope({scopeId, ownerEpoch, signal})` 建立执行 scope，通过 `execute({operationId, toolId, version, arguments, resuming})` 返回 `ToolCall`。公开接口不接收模型原生对象、业务 SQL 或完整应用 Context。

- `result` 是业务结果；`cancel()` 请求退出；`done` 证明本次调用资源实际退出。结果先返回不能替代退出证明。
- 环境 scope 的 `cancel()` 必须取消并等待已接受工作；`close()` 在 signal 已中止时也必须执行，并等待所有保留资源退出。RunRuntime 会及时启动环境取消，并汇总全部环境的退出屏障。
- 工具结果以通用 JSON 保存和回填，图片使用不可变引用。环境的持久资源及全局连接由其真正的 Nya 组件拥有，不在纯注册表中另建资源生命周期。
- Session 在副作用前保存稳定 operation ID 和调用意图；已提交观察直接复用，不重新调用环境。
- 有意图但没有观察的恢复，默认以未知结果拒绝执行。只有声明 `recovery: 'observe-existing'` 的环境才能收到 `resuming: true`；该分支必须查询原 operation，缺失或未知不能重新执行副作用。声明标记不替代提供方的实际耐久实现。
- 清理失败保留已有部分事实，不能发布成功节点；恢复中新的清理失败也不能被之前保存的成功结算覆盖。

内置 Computer 适配器继续使用原 Computer Operations、固定 worker/目录代次、owner epoch、使用引用、图片事务保留与 scope 关闭回执。工具拆包没有将其执行账本或通信改成通用网络协议。

## 实现与验证

受信注册表和适配是 [RunRuntime](modules/execution/run-runtime.md) 的内部提供方，不额外注册 Nya 组件：

- [`tool-environments/`](../packages/app-harness/src/core/tool-environments/)：结构快照、注册、路由和 Computer 适配。
- [`tool-environments.test.mjs`](../tests/tool-environments.test.mjs)：环境来源、精确绑定、取消、恢复拒绝和部分清理。
- [`tool-environment-runtime.test.mjs`](../tests/tool-environment-runtime.test.mjs)：真实 Agent 调用非 Computer 环境、混合环境、取消与实际退出、清理失败不成功结算。
- [`tool-environment-example.test.mjs`](../tests/tool-environment-example.test.mjs)：独立资料库提供方、真实 Markdown、原生模型工具往返，以及插入前后的新旧会话。
- [`agent-tools.test.mjs`](../tests/agent-tools.test.mjs)：会话事务快照、仅新会话生效、旧会话兼容和通用操作账本。
- [`package-consumer.test.mjs`](../packages/computer-tools/tests/package-consumer.test.mjs)：隔离生产闭包内执行文件和原生进程，无 Harness、Models、Host 依赖。

完整检查为根 `npm run check`。本机多 worker/隔离消费者验证不替代其他操作系统、真实跨机器网络和桌面签名成品的实测。
