# Models 协调服务

[返回 Models 模块](README.md)

## 定位与源码

该组件协调模型定义、账户配置、凭据变更、协议注册代和原生 execution。入口是 [component.ts](../../../packages/models/src/component.ts)，execution 状态机在 [execution.ts](../../../packages/models/src/execution.ts)，公共契约见 [types.ts](../../../packages/models/src/types.ts) 与 [native-types.ts](../../../packages/models/src/native-types.ts)。

工厂 `createModelsComponent()` 无配置参数；组件名 `models`，注入 `models.store` 与 `models.vault`，一次提供四个服务。它不依赖目录组件、Session、Run、工具或浏览器。

## 服务接口

| 服务 | 主要接口 | 责任 |
| --- | --- | --- |
| `models` | `list(query?)`、`get(modelId)`、`openNative(input)` | 查询实际配置及开启独立 execution |
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

## Key 与连接删除

新 Key 先创建随机 Vault 槽及持久清理意图，再写系统凭据，最后事务提交新连接引用、移除新槽意图并登记旧槽清理。清理失败保留日志，启动或下一次该连接的凭据变更会重试；历史引用不使旧密钥继续存活。

成功更换/删除 Key、修改地址或认证方式会更新非秘密 `historyScopeEpoch`。名称、超时、启停、目录同步及失败 Key 写入不更新 epoch。读取 Key 与同一连接编辑串行，`openNative()` 只读取一次；执行之后复用捕获值。

`deleteConnection(id, expectedRevision)` 在连接队列内以事务删除当前连接、配置和同步状态，同时登记旧槽清理；保留不可变历史与定义，删除后的 ID 不可重用。已经打开的 execution 仍持有原配置与凭据，新打开操作失败；来源刷新不重建已删账户。

## 来源接纳

`accept()` 只接受已验证的 `SourceSnapshot` schema 2，不接收原始 models.dev JSON。它原子提交来源定义、来源账本和连接同步目标，再等待已接纳的各连接补齐结束。来源条目删除表现为 `missing`，不会改写已固定配置。

旧快照不能覆盖较新的已接纳内容；同时间不同内容默认保留旧值，完整网络响应可用 `{ confirmed: true }` 确认。接纳前捕获并冻结输入与选项。核心关闭后拒绝新接纳，但已准入事务及随后派生的补齐必须完成后才释放存储依赖。

## 原生 execution 流程

1. `models.protocols.acquire(id)` 或注册返回值的 `acquire()` 固定协议版本、代 ID 与撤销信号。外来、已释放、已撤销租约不可用于新准入。
2. `openNative({ modelId, lease, restore?, requirements?, signal? })` 在连接队列内检查启停、协议、原生参数及必需的工具/流式/推理能力，构造 schema 3 快照，校验恢复身份，然后读取凭据。
3. `prepareExchange(intent)` 只准备 immutable 增量意图、请求记录 ID、前驱记录 ID 和私有请求体，不发网络请求。同一 execution 只允许一个待启动或在途交换。
4. 单次 `start(onEvent?)` 返回 `{ result, done, cancel }`。Models 同时观察驱动结果和退出，只有资源实际退出、候选结果校验和上下文提交完成后，公共 `result` 才成功。
5. `close()` 幂等停止准入、取消在途操作并等待实际退出，返回仅本 execution 新增的 `records`、可选 `restoreState` 与 `cleanup`，随后释放私有凭据和上下文引用。

每次请求记录只保存本轮增量 intent，响应保存原生结果。宿主按所选成功父路径提供展开的恢复记录；Models 验证协议、格式、配置 ID、连接、模型定义版本、远端 ID、epoch、参数和有效能力，再由协议 codec 重建内存上下文。名称与对象键顺序不影响恢复，跨账户、跨协议及任意参数转换不受支持。

## 生命周期、取消与失败

`apply` 先登记 Effect，再恢复孤立槽清理和连接同步，随后提供服务，不在启动中运行长期网络循环。组件关闭同步停止新调用、取消初始化与查询操作，注销全部拥有的协议代，等待 execution、操作以及已准入写入任务。

`unregister()` 同步撤销该代准入和租约，关闭该代 execution，并等待该代的凭据初始化、发现和检查退出。旧代不会删除替代代或取消其他协议。该保障只覆盖 Models 拥有的资源，宿主仍需等待 Run 工具与结算。

取消不是退出，超时后仍等待 transport 清理。驱动 `done` 失败时记录 `cleanup-failure` 并终止损坏的待决结果；迟到输出不能改写冻结退出报告。任何交换失败都使该 execution 的完整记录链不可恢复，即使随后重试成功。失败诊断保留可用原生终态与已收内容，但清除认证字段和捕获凭据值；诊断不能生成成功节点。事件观察者抛错或异步拒绝只使该观察者脱离，不改变执行结果。

## 限制与扩展

有效图片输入始终为 `false`。能力必须显式声明，缺失推理模式不猜测。配置和 Key 修改只影响新 execution。公共错误使用固定 `ModelsError.code`；非秘密查询不因系统凭据不可用而被全部关闭。原生记录和原生事件均属于受信边界，不能原样推送浏览器。

可替换 [Store](store.md)、[Vault](vault.md) 或注册其他 `NativeProtocol`；协调层保持与协议停止语义无关。`createNativeEventQueue` 是可选有界订阅帮助函数，不是新组件，也不是恢复存储。

## 测试与关联文档

[runtime.test.mjs](../../../packages/models/tests/runtime.test.mjs) 验证独立执行、实际退出、恢复身份和 epoch；[lifecycle-review.test.mjs](../../../packages/models/tests/lifecycle-review.test.mjs) 验证注销、清理失败与迟到结果；[unified-models.test.mjs](../../../packages/models/tests/unified-models.test.mjs) 和 [source-definitions.test.mjs](../../../packages/models/tests/source-definitions.test.mjs) 验证补齐与来源并发；[connection-deletion.test.mjs](../../../packages/models/tests/connection-deletion.test.mjs) 验证删除及恢复日志；[boundary.test.mjs](../../../packages/models/tests/boundary.test.mjs) 验证输入边界。

参见 [原生框架设计](../../native-protocol-agent-framework-design.md) 与 [Models 包使用说明](../../../packages/models/README.md)。
