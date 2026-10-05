# Models 协调服务

[返回 Models 模块](README.md)

## 定位与源码

该组件协调模型定义、账户配置、凭据变更、协议注册代、原生 execution 与单次文本生成。入口是 [component.ts](../../../packages/models/src/component.ts)，execution 状态机在 [execution.ts](../../../packages/models/src/execution.ts)，公共契约见 [types.ts](../../../packages/models/src/types.ts) 与 [native-types.ts](../../../packages/models/src/native-types.ts)。内部 [resources.ts](../../../packages/models/src/resources.ts) 提供资源 URI、引用校验/合并和受信读取的摘要校验；[text-generation.ts](../../../packages/models/src/text-generation.ts) 提供生成编排，均不注册独立组件。

工厂 `createModelsComponent()`，组件名 `models`，注入 `models.store` 与 `models.vault`，一次提供四个服务。它不依赖目录组件、Session、Run、工具或浏览器。

Anybox Harness 在 [server-models.ts](../../../src/applications/harness/server-models.ts) 只装配 Responses、标准 Chat Completions、Anthropic Messages 和 Gemini Interactions 四种协议。DeepSeek 使用标准 `chat-completions`。旧 DeepSeek 当前配置由停机时的一次性配置迁移改为标准协议，保留连接与配置 ID、凭据引用、epoch 和不可变历史；运行期不提供旧驱动或协议别名。旧协议历史保留供查看，不能续接执行，需要新建标准协议会话。

通用配置格式迁移不能无损转换参数时，保留原始 `value` 并标记 `formatVersion: 0` 只读待迁移，不能执行或静默丢弃未知字段。受信恢复数据必须与已安装协议、配置、账户、记录格式和执行语义兼容，不转换协议身份。

## 服务接口

| 服务 | 主要接口 | 责任 |
| --- | --- | --- |
| `models` | `list(query?)`、`get(modelId)`、`openNative(input)`、`generateText(input)` | 查询实际配置、开启独立 execution 及生成单次纯文本 |
| `models.settings` | 定义、连接、配置、Key、发现与检查接口 | 受控配置管理与非秘密公共视图 |
| `models.protocols` | `register(protocol)`、`acquire(protocolId)` | 协议代及租约 |
| `models.source-data` | `accepted(sourceId)`、`accept(snapshot, options?)` | 受信来源原子接纳 |

Settings 的完整操作分组：

- 定义：`providers`、`models`、`providerHistory`、`modelHistory`、`createProvider`、`updateProvider`、`createModel`、`updateModel`。查询支持来源、Provider、文本搜索、缺失/弃用条目和文本契约筛选；用户写入只产生或修改 `user` 定义。
- 连接：`connections`、`connectionHistory`、`createConnection`、`updateConnection`、`deleteConnection`、`retryConnection`、`connectionModels`。创建固定 `providerDefinitionId` 和 `protocolId`；更新只允许名称、启停、地址、认证和超时。
- 配置：`configurations`、`configurationHistory`、`createConfiguration`、`updateConfiguration`。创建固定连接、定义、定义版本与远端 ID；更新只允许名称、启停、能力、参数。
- 凭据与协议：`setApiKey`、`deleteApiKey`、`protocols`、`discoverModels`、`checkConnection`。Key 读取只返回 `credentialConfigured`；发现与检查是显式、只读网络请求，不自动创建配置。

版本更新与删除要求 `expectedRevision`，过期编辑返回 `conflict`。协议尚未安装时可保存中性配置，后续注册会触发补齐和验证。`available` 只说明本地配置满足执行条件，不保证远端账户已授权。

## 配置与自动补齐

连接保存、Key 变更、显式重试、启动恢复、来源接纳和协议注册会协调连接初始化。每个连接有独立队列，配置编辑和 execution 初始化按准入顺序执行；定义写入另用 `@definitions` 队列。网络调用不占用配置队列。

补齐仅添加尚不存在的 baseline。适用条件包含定义存在、未弃用、文本输入/输出、已装协议、显式协议提示或 `sourceMappings`，以及模型特殊地址的一致性。未知协议、其他模态和不适用模型仍可通过 `connectionModels()` 查看原因。协议 `initialParameters()` 生成保存时默认值，例如 Anthropic 的有界 `max_tokens: 4096`。

连接同步以 `pending`、`ready`、`failed` 表示，不增加连接版本。补齐失败不删除已保存连接或 Key，`retryConnection(id)` 可幂等修复。来源目标守卫防止旧批次覆盖新来源的同步状态。当前没有单独删除配置或定义的 Settings 接口。

Anybox Harness 的模型设置只读展示配置的工具、流式、图片、搜索与推理能力，包括可声明的推理档位、模式和预算范围；原生生成参数仍可在界面修改。能力声明表示模型支持什么，生成参数才表达本次执行如何使用该能力。新自定义模型继承定义能力，参数预设继承原配置能力，浏览器不提供能力编辑字段。

人工修正能力需停止所属执行设备的 Agent，在 [JSON 配置文件](json-store.md)的 `configurations[].capabilities` 中修改，再重新装配 Agent。JSON 是当前 Models 配置的实际存储，管理接口提交也原子保存到同一文件。它不存密钥，不改变已打开 execution 或 Session/Run 历史；生成参数与能力仍由协议分别校验。运行中外部改文件会使后续保存返回冲突，避免覆盖人工修改。

## Key 与连接删除

新 Key 先创建随机 Vault 槽及持久清理意图，再写系统凭据，最后事务提交新连接引用、移除新槽意图并登记旧槽清理。清理失败保留日志，启动或下一次该连接的凭据变更会重试；历史引用不使旧密钥继续存活。

成功更换/删除 Key、修改地址或认证方式会更新非秘密 `historyScopeEpoch`。名称、超时、启停、目录同步及失败 Key 写入不更新 epoch。读取 Key 与同一连接编辑串行，`openNative()` 只读取一次；执行之后复用捕获值。

`deleteConnection(id, expectedRevision)` 在连接队列内以事务删除当前连接、配置和同步状态，同时登记旧槽清理；保留不可变历史与定义，删除后的 ID 不可重用。已经打开的 execution 仍持有原配置与凭据，新打开操作失败；来源刷新不重建已删账户。

## 来源接纳

`accept()` 只接受已验证的 `SourceSnapshot` schema 2，不接收原始 models.dev JSON。它原子提交来源定义、来源账本和连接同步目标，再等待已接纳的各连接补齐结束。来源条目删除表现为 `missing`，不会改写已固定配置。

旧快照不能覆盖较新的已接纳内容；同时间不同内容默认保留旧值，完整网络响应可用 `{ confirmed: true }` 确认。接纳前捕获并冻结输入与选项。核心关闭后拒绝新接纳，但已准入事务及随后派生的补齐必须完成后才释放存储依赖。

## 原生 execution 流程

1. `models.protocols.acquire(id)` 或注册返回值的 `acquire()` 固定协议版本、代 ID 与撤销信号。外来、已释放、已撤销租约不可用于新准入。
2. `openNative({ modelId, lease, restore?, requirements?, resources?, signal? })` 在连接队列内检查启停、协议、原生参数及必需的工具/流式/推理/图片能力，构造 schema 3 快照，校验恢复身份，然后读取凭据。
3. `prepareExchange(intent, { resourceRefs?, responseMode? }?)` 校验并捕获本轮精确资源引用集合及传输选择，只准备 immutable 增量意图、请求记录 ID、前驱记录 ID 和私有请求体，不发网络请求。同一 execution 只允许一个待启动或在途交换。
4. 单次 `start(onEvent?)` 返回 `{ result, done, cancel }`。Models 同时观察驱动结果和退出，只有资源实际退出、候选结果校验和上下文提交完成后，公共 `result` 才成功。
5. `close()` 幂等停止准入、取消在途操作并等待实际退出，返回仅本 execution 新增的 `records`、可选 `restoreState` 与 `cleanup`，随后释放私有凭据和上下文引用。

流式默认开启：配置中的 `streaming: 'unknown'` 与 `'supported'` 均允许流式，显式 `'unsupported'` 关闭；驱动返回的有效 `streaming: false` 仍会关闭流式。内置协议按这一规则构造原生 `stream` 字段。目录缺失的流式元数据继续保留为 `unknown`，不改写来源或已保存能力；已有 `unknown` 配置在下次开启 execution 时应用默认，无须刷新目录或迁移配置库。

`NativeResponseMode` 为 `stream | complete`。省略 `responseMode` 保持上述默认；显式 stream 要求有效流式能力，否则返回 `capability-unsupported`；complete 总是使用非流式完整响应，无须流式能力。驱动 descriptor 的可选 `responseModes` 声明显式模式，四种内置驱动均支持两种；旧扩展省略字段时默认调用仍可用，显式模式被拒绝。非法值以 `invalid-config` 拒绝，所有检查发生在请求准备成功前，不创建记录或发网，也不占用 execution 的待交换位置。回调存在与否不改变传输模式；同一 execution 可逐轮切换，选择不进入配置、参数、快照、意图或恢复记录，也不修改有效能力。驱动 `prepare()` 接收可选 mode，Chat 仅在流式时发送 `stream_options`。

每次请求记录只保存本轮增量 intent，v2 的 request 顶层附本轮 resourceRefs，响应保存原生结果。NativeImageResourceRef 只含 id、sha256、byteLength、mimeType；NativeResourceResolver 是每个 execution 的受信端口，不持久化 reader、图片 bytes 或路径。Models 私有重建父链资源目录，驱动只可读取当前请求使用的引用。宿主按所选成功父路径提供展开的恢复记录；Models 验证协议、格式、配置 ID、连接、模型定义版本、远端 ID、epoch、参数和执行语义能力，再由协议 codec 重建内存上下文。streaming 仅改变传输方式，不改变增量 intent、完整原生结果或记录 codec，恢复允许双向改变；旧非流式成功父链可继续为流式 execution，并逐轮选择 mode。名称与对象键顺序不影响恢复，跨账户、跨协议及任意参数转换不受支持。四种协议 writer 均为 2.2.0/v2，reader 明确支持 2.0.0/2.1.0/2.2.0 与 v1/v2 混合链；execution.recordFormatVersion 向宿主暴露当前 writer。仅旧文本历史允许 imageInput false→true，工具、搜索和推理能力仍严格匹配；旧 JSON 不重写。

## 单次纯文本生成

`generateText({ modelId, instruction?, input, signal? })` 同步返回 `ProtocolOperation<GenerateTextResult>`；验证与业务失败通过 result 拒绝，使用固定 ModelsError.code。modelId 必须指向显式配置，不自动选模或替换；input 与提供时的 instruction 必须是非空白字符串，校验不改写文本。

生成捕获输入与协议代，开启新 execution，使用其初始化时固定的配置、凭据及原生参数构造意图，以 complete 进行一次请求，提取文本后关闭 execution、释放租约并清理监听器，最后结算 result。公共结果仅有 `text/modelId/modelRevision/protocolId`，不公开原生响应、诊断、记录或恢复状态。每次调用相互独立，不接收历史、工具、图片、资源或参数覆盖，也不持久化临时历史。用途提示词、用途选模设置、标题和结果持久化归宿主。

`NativeProtocol.textGeneration` 是可选纯函数适配器，包含 createIntent、validateParameters、readText；注册时捕获并冻结方法，随已有协议代管理，不另建注册中心。扩展同时声明 complete 并提供适配器才可生成，否则返回 capability-unsupported。四种协议分别映射 instructions、system 消息、system 文本块、system_instruction；完成判断和原生输出解释只在相应驱动适配器内进行。

Responses 只接受 completed，Chat 只接受 stop，Anthropic 接受 end_turn/stop_sequence，Gemini 只接受 completed。只提取最终文本，多个文本块按原生顺序以换行连接，格式原样保留，以空白检查判断输出存在。私有 reasoning/thinking 不加入结果。拒绝返回 refused-response；截断、预算耗尽、暂停或其他续轮状态返回 incomplete-response；工具调用返回 capability-unsupported；未知结构或无有效文本返回 invalid-response。Responses/Anthropic 的预设实际启用原生搜索工具时在发网前拒绝，仅声明支持搜索不影响生成。保存参数不改写，不隐式关闭推理、不重试、不续轮、不截断文本，超时复用连接设置。

整次生成在首次异步调用前登记到 Models operations 和固定协议代 pending，所有权覆盖 execution 关闭、租约释放和监听器清理。result 无论成败均等实际清理完成；普通失败、取消和超时的清理成功时 done 成功，清理失败时 result/done 均拒绝 cleanup-failure，并登记现有 runtime/协议代清理失败状态。cancel 与外部 signal 幂等取消，注销和整根关闭取消并等待外层操作。首版不增加生成队列，各 Provider 可并行，宿主按用途控制并发；网络不占连接配置队列，Key 编辑不被请求阻塞，也不产生队列自等待。

## 生命周期、取消与失败

`apply` 先登记 Effect，再恢复孤立槽清理和连接同步，随后提供服务，不在启动中运行长期网络循环。组件关闭同步停止新调用、取消初始化与查询操作，注销全部拥有的协议代，等待 execution、操作以及已准入写入任务。

`unregister()` 同步撤销该代准入和租约，关闭该代 execution，并等待该代的整次生成、凭据初始化、发现和检查退出。旧代不会删除替代代或取消其他协议。该保障只覆盖 Models 拥有的资源，宿主仍需等待 Run 工具与结算。

取消不是退出，超时后仍等待资源 reader 与 transport 清理。各协议的资源读取、摘要/长度验证和 wire 物化都在 start 之后，done 包含两类资源退出。图片缺失/损坏分别报告固定 resource-unavailable/invalid-resource，32 MiB 序列化请求上限报告 request-too-large；不能忽略图片继续发网。驱动 `done` 失败时记录 `cleanup-failure` 并终止损坏的待决结果；迟到输出不能改写冻结退出报告。任何交换失败都使该 execution 的完整记录链不可恢复，即使随后重试成功。失败诊断保留可用原生终态与已收内容，但清除认证字段和捕获凭据值；诊断不能生成成功节点。事件观察者抛错或异步拒绝只使该观察者脱离，不改变执行结果。

## 限制与扩展

有效图片能力是配置声明与已实现驱动的交集；Responses、Anthropic、Gemini、Chat Completions 均已实现。工具、图片、搜索与推理能力仍要求显式声明，缺失推理模式不猜测；流式采用上述默认开启规则。配置和 Key 修改只影响新 execution。公共错误使用固定 `ModelsError.code`；非秘密查询不因系统凭据不可用而被全部关闭。原生记录和原生事件均属于受信边界，不能原样推送浏览器。

可替换 [JSON Store](json-store.md)、[SQLite Store](store.md)、[Vault](vault.md) 或注册其他 `NativeProtocol`；协调层保持与协议停止语义无关。`createNativeEventQueue` 是可选有界订阅帮助函数，不是新组件，也不是恢复存储。

## 测试与关联文档

[runtime.test.mjs](../../../packages/models/tests/runtime.test.mjs) 验证独立执行、实际退出、恢复身份和 epoch；[lifecycle-review.test.mjs](../../../packages/models/tests/lifecycle-review.test.mjs) 验证注销、清理失败与迟到结果；[unified-models.test.mjs](../../../packages/models/tests/unified-models.test.mjs) 和 [source-definitions.test.mjs](../../../packages/models/tests/source-definitions.test.mjs) 验证补齐与来源并发；[connection-deletion.test.mjs](../../../packages/models/tests/connection-deletion.test.mjs) 验证删除及恢复日志；[boundary.test.mjs](../../../packages/models/tests/boundary.test.mjs) 验证输入边界。

[streaming-defaults.test.mjs](../../../packages/models/tests/streaming-defaults.test.mjs) 覆盖目录省略 streaming、自动基础配置、原生请求默认流式及结果返回前的连续文本增量，并验证显式关闭；runtime 测试同时验证驱动禁用、既有 unknown 配置与双向 streaming 切换的原生恢复。

[response-modes.test.mjs](../../../packages/models/tests/response-modes.test.mjs) 覆盖四协议实际 JSON/SSE 请求、非法/不支持模式准备前拒绝、回调独立、同 execution 切换以及 2.0.0/2.1.0/2.2.0 历史恢复。[text-generation.test.mjs](../../../packages/models/tests/text-generation.test.mjs) 使用内存 Store/Vault 和假 transport 覆盖提示词映射、格式、隔离、配置捕获、取消及清理边界，不调用付费模型。各协议适配与公共错误矩阵见 [Responses/Chat 生成](../../../packages/models/tests/responses-chat-generation.test.mjs)、[Responses/Chat 错误](../../../packages/models/tests/generation-responses-chat-errors.test.mjs)、[Anthropic/Gemini 生成](../../../packages/models/tests/anthropic-gemini-generation.test.mjs)、[Anthropic/Gemini 错误](../../../packages/models/tests/generation-anthropic-gemini-errors.test.mjs)。

[native-images.test.mjs](../../../packages/models/tests/native-images.test.mjs) 验证资源引用、单 execution reader、v1 加法恢复、取消与实际清理和请求体积边界；[multimodal-protocols.test.mjs](../../../packages/models/tests/multimodal-protocols.test.mjs) 覆盖 Responses、Anthropic 和 Gemini 的图片物化、JSON/SSE、混合版本恢复与失败清理。

参见 [原生框架设计](../../native-protocol-agent-framework-design.md) 与 [Models 包使用说明](../../../packages/models/README.md)。
