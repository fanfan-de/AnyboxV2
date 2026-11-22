# 环境提供工具

[返回文档首页](README.md) · [工具模块](modules/tools/README.md)

## 当前边界

Personal Agent 和 Anybox Harness 分别在自己的执行端装配共享包 `@anybox/execution-environments`。函数工具来自受信的执行提供方，模型托管搜索绑定到确切的提供方与协议。保存偏好后，Run 仍须持有对应目标、工具版本及签发代次的授权。撤权会封闭新准入并等待原调用和 scope 退出。连接和凭据由两款应用及各自提供方保存。设置与历史兼容见[执行环境授权组件](modules/tools/execution-environments.md)。

两款应用在各自组合根通过共享工具注册表装配提供方。每份注册同时声明工具目录、可选的目标查询和执行绑定。Session 和 Run 从注册读取纯目录，RunRuntime 绑定本轮 Nya 依赖提供的执行能力。Computer 提供项目附着目标，MCP 提供连接目标，管理接口使用同一份目标目录。Agent Loop 继续通过统一接口编码工具和提交调用。RunRuntime 负责耐久意图、取消传播、观察与结算。

应用可以通过受信装配插入自定义环境，也可以在「Agent 工具」中管理 [MCP 执行环境](modules/tools/mcp-environment.md)。MCP 在应用执行端校验工具声明，通过选定的 Streamable HTTP 或 stdio 连接调用。Agent 仍按连接和具体工具取得授权。模型调用参数只参与既定工具的参数校验。

## 独立包

- [`@anybox/tool-api`](../packages/tool-api/README.md)：JSON、工具描述、`ToolCall`、图片引用、纯 `ToolEnvironmentDescriptor` 和带执行入口的 `ToolEnvironment`，不依赖 Harness、Models、Nya、SQL 或 HTTP。
- [`@anybox/computer-tools`](../packages/computer-tools/README.md)：四个真实 Nya 资源组件、来源契约适配、原生进程后端和搜索资源。可以安装在其他消费者自己的 Nya 根上。

Computer 工具描述通过纯 `/contracts` 入口提供，参数与结果适配通过 `/adapters` 提供。模型、Session 与描述查询不导入执行组件。工具包接收受信的工作目录和不透明 scope，不查询 Project、Session 或 Run。

## 插入与选择

两款应用的 Core 和 Runtime 选项接收 `registerTools(tools)`。在组合阶段调用 `tools.register(...)`，重复提供方 ID 会被拒绝。注册结束后，目录和执行绑定分别读取各自组件的 Nya 依赖快照。`toolEnvironments` 数组入口也进入同一个注册表。Agent 的 `environmentIds` 缺省为 `['computer']`，显式 `[]` 使用空集合，也可以按 ID 选择单工具或有资源的提供方。

工具只有一次调用的作用域时，可以直接用 `defineTool` 声明 schema 和执行函数。这个例子的提供方 ID 由 `toolId` 确定，Agent 可以选择 `example.echo`。

```js
import { defineTool } from '@anybox/tool-api'

const echo = defineTool({
  toolId: 'example.echo',
  version: '1',
  definition: {
    name: 'echo',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  },
  execute: ({ text }) => text,
})

// Core 或 Runtime 选项
const registerTools = tools => tools.register(echo)
```

持有复用连接或其他跨调用资源的组件注册完整提供方。带多个可配置目标的组件提供 `kind: 'targeted'` 注册，目录回调 `targets(deps, reader)` 只读当前目标及工具。在授权事务中仍使用该回调，以确切工具身份复核新授权。`runtime.bind(deps)` 将实际作用域绑定到当前执行依赖。Computer 的项目目标解析、成对工具约束和旧工具兼容由其适配器负责。

可运行的[资料库环境示例](../examples/tool-environments/notes/README.md)提供 `notes_search`、`notes_read`，实际读取 Markdown，并用既有原生协议与 Agent 验证工具往返。只需新增提供方与装配配置：

```js
import { installHarnessServerCore } from '@anybox/app-harness/core/index'
import { createNotesEnvironment } from './environment.mjs'

const notes = createNotesEnvironment(documents)
await installHarnessServerCore(root, {
  agents: [{ ...existingAgent, environmentIds: ['notes'] }],
  registerTools: tools => tools.register(notes),
})
```

这里的 `root` 与 `existingAgent` 沿用当前装配，`documents` 是环境拥有的资料。Agent 实现、instructions、协议 Loop 与 RunRuntime 不加入环境专属分支。需要同时使用 Computer 时选择 `['computer', 'notes']`。完整示例以离线模型验证实际执行链，无需 API Key；它不声称验证真实模型的决策质量。

运行 `npm run build` 后执行 `node examples/tool-environments/notes/demo.mjs`，可以看到无环境会话工具为空，新会话声明并调用 `notes_search`、`notes_read`，旧会话仍为空。

环境之间的工具 ID 与模型调用名必须唯一；含糊绑定在创建快照时明确拒绝。通用参数校验支持的 JSON Schema 子集与拒绝边界见 tool-api README。所有工具先完成整批参数预检，再允许任何工具副作用。

内部 `createToolEnvironmentCatalog()` 提供纯描述与显式选择策略，用于创建和校验 Session 快照。目录项可枚举同一环境的多个目标。`snapshot(environmentIds, toolIdsByEnvironment?, toolIdsByTarget?, reader?)` 通过环境和目标偏好筛选。多目标工具需要显式选中。Computer 的成对工具依赖和仅供旧历史使用的退役描述由 Computer 目录项声明。`catalog.bind(providers, targetedProviders?)` 校验提供方的身份、版本和定义并生成本代执行注册表。绑定不打开 scope，缺失、重复或不匹配的绑定明确拒绝。`createToolEnvironmentRegistry(providers)` 为普通受信提供方保留描述与执行合用的便利入口。

## 会话快照与兼容

创建 Session 的同一业务事务保存环境身份、环境契约版本、工具 ID/版本和完整模型定义；Session 只消费纯环境目录，不持有执行提供方。Agent 的 Computer 工具偏好由受信组合显式转换为该环境的工具筛选，只进一步缩小 Computer 环境提供的工具。环境未提供的工具不能通过 Agent 设置获得。

同一应用代的受信提供方固定，MCP 的目标与工具目录可以显式刷新。普通 Session 的 `toolEnvironments` 和 `toolSelection` 在创建后保持原样。带多目标环境的 v2 快照为选中的工具保存确切 `targetId`，先前的 v1 快照继续读取。目标不可用或工具版本失配时拒绝后续执行，历史仍可阅读。Personal Agent 连续会话可显式采用新的环境或目标集合。

`run-state` v12 新增不可变 `tool_environments_json`；没有该字段的旧 Session 保留旧 Computer 路径。新初始化使用 `NativeInitialization` v3 / `tool-environments-v1`，v1/v2 和已退役计划工具的旧冻结快照继续兼容。升级前停止应用并备份业务库；回退代码需要恢复升级前备份。

退役工具只能通过目录项显式声明的 `historyTools` 验证已有快照，不能进入新选择；不会因为环境叫作 `computer` 就获得兼容权限。旧初始化到 Computer 描述的转换、旧清理操作身份和原始回执表示集中在历史读取适配中，不加入通用注册表的新写入路径。

## 执行、取消与恢复

单目标提供方通过 `openScope({scopeId, ownerEpoch, signal})` 建立执行 scope，多目标提供方使用 `openTargetScope(targetId, context)`。两者通过 `execute({operationId, toolId, version, arguments, resuming})` 返回 `ToolCall`。工具执行入口接收中立参数、调用身份和版本。

- `result` 是业务结果；`cancel()` 请求退出；`done` 证明本次调用资源实际退出。结果先返回不能替代退出证明。
- 首次派发前，RunRuntime 按确切目标登记并打开作用域。同一目标的工具复用作用域。仅声明工具的目标不打开作用域。运行结束时，环境的 `cancel()` 取消并等待已接受工作，`close()` 等待所有保留资源退出，信号已中止也须执行关闭。
- 关闭回执以 `{ environments: [...] }` 汇总执行作用域。旧环境条目保存 `environmentId` 和 `result`，多目标条目额外保存 `targetId`。注册表分别保留部分关闭结果与实际退出失败。
- 工具结果以通用 JSON 保存和回填，图片使用不可变引用。环境的持久资源及全局连接由其真正的 Nya 组件拥有，不在纯注册表中另建资源生命周期。
- Session 在副作用前保存稳定 operation ID 和调用意图；已提交观察直接复用，不重新调用环境。
- 有意图但没有观察的恢复，默认以未知结果拒绝执行。只有声明 `recovery: 'observe-existing'` 的环境才能收到 `resuming: true`；该分支必须查询原 operation，缺失或未知不能重新执行副作用。声明标记不替代提供方的实际耐久实现。
- 已登记目标的作用域恢复使用独立的 `restoreScope` 或 `restoreTargetScope`。它只连接原资源的观察、取消和关闭，逐目标记录实际退出。已有 `observe-existing` 静态提供方兼容通过 `openScope` 接回原作用域。提供方缺少恢复入口或证据时，该目标继续保留未知占用。Computer 可用原 Operations 与 worker 回执证明退出。
- 清理失败保留已有部分事实，不能发布成功节点；恢复中新的清理失败也不能被之前保存的成功结算覆盖。

内置 Computer 适配器继续使用原 Computer Operations、固定 worker/目录代次、owner epoch、使用引用、图片事务保留与 scope 关闭回执。工具拆包没有将其执行账本或通信改成通用网络协议。

新关闭操作统一使用 `<runId>:tool-environment-scope-close` 与 `intent.kind=tool-environment-cleanup`。恢复遇到已有 `computer-scope-close` 或旧 `tool-process-cleanup` 意图时复用原操作，不另建一个关闭操作或重写不可变事实；旧原始 `{ processes: ... }` 回执继续按历史表示保存和投影。已保存成功回执也不能替代本次恢复的真实退出证明，新的 `done` 失败仍阻止成功结算。

## 实现与验证

受信注册表和适配是 [RunRuntime](modules/execution/run-runtime.md) 的内部提供方。MCP 连接资源由[应用执行端的 MCP 组件](modules/tools/mcp-environment.md)独立管理。

- [`tool-environments/`](../packages/app-harness/src/core/tool-environments/)：结构快照、注册、路由和 Computer 适配。
- [`tool-environments.test.mjs`](../tests/tool-environments.test.mjs)：纯目录与执行绑定、普通同名 Computer 环境、显式历史工具策略、取消、恢复拒绝和部分清理。
- [`tool-environment-runtime.test.mjs`](../tests/tool-environment-runtime.test.mjs)：真实 Agent 调用非 Computer 环境、混合环境、取消与实际退出、旧清理操作恢复及清理失败不成功结算。
- [`computer-unit-faults.test.mjs`](../tests/computer-unit-faults.test.mjs) 使用真实 SIGKILL 验证 Computer 与 Notes 混用时，仅恢复已接纳的 Computer 目标，并在清理后继续使用该设备。
- [`tool-environment-example.test.mjs`](../tests/tool-environment-example.test.mjs)：独立资料库提供方、真实 Markdown、原生模型工具往返，以及插入前后的新旧会话。
- [`agent-tools.test.mjs`](../tests/agent-tools.test.mjs)：会话事务快照、仅新会话生效、旧会话兼容和通用操作账本。
- [`package-consumer.test.mjs`](../packages/computer-tools/tests/package-consumer.test.mjs)：隔离生产闭包内执行文件和原生进程，无 Harness、Models、Host 依赖。

完整检查为根 `npm run check`。本机多 worker/隔离消费者验证不替代其他操作系统、真实跨机器网络和桌面签名成品的实测。
