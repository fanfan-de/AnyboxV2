# Responses 原生协议

[返回 Models 模块](README.md)

## 定位与装配

源码：[protocols/responses.ts](../../../packages/models/src/protocols/responses.ts)，共用 [shared.ts](../../../packages/models/src/protocols/shared.ts) 与 [transport.ts](../../../packages/models/src/protocols/transport.ts)。`createResponsesProtocolComponent(options?)` 创建组件 `models-protocol-responses`，注入 `models.protocols`，注册 ID `responses`、版本 `2.2.0` 的驱动；不额外提供命名服务。

`createResponsesProtocol(options?)` 返回独立 `NativeProtocol`。唯一工厂选项为可替换 `fetch`。驱动实现参数/连接验证、有效能力、`restore/prepare/exchange/commit` 和发现/检查。它保留 Responses 语义，工具执行与停止决策见 [Responses Agent](../execution/responses-agent.md)。

## 连接与参数

连接使用 API 根 `baseUrl`、`auth: 'none' | 'api-key'` 与正整数 `timeoutMs`；API Key 用 Bearer 头。POST 路径为 `/responses`。连接地址禁止 URL 凭据、query 和 fragment；公共设置层还负责完整连接验证。

参数保存为 `{ protocolId: 'responses', formatVersion: 1, value }`。`value` 仅接受：

| 字段 | 约束 |
| --- | --- |
| `temperature` | 0–2 |
| `max_output_tokens` | 正安全整数 |
| `reasoning.effort` | `none/minimal/low/medium/high/xhigh`，必须在配置声明的 efforts 中 |
| `reasoning.summary` | `auto/concise/detailed`；要求声明支持推理且 effort 不为 `none` |
| `tools` | 可选空数组或唯一 `{ type: 'web_search' }`；要求显式 `webSearch.support: 'supported'` |

可选字段省略即保留服务端默认，无运行时暗补。表单 descriptor 暴露温度、最大输出及推理项，搜索工具仍通过已验证的原生参数保存。参数不能覆盖模型 ID、输入、凭据、流式设置或服务端会话。有效工具与图片能力依赖显式 supported 声明；流式默认开启，配置 streaming 为 unknown/supported 时发送 `stream: true`，显式 unsupported 时发送 false。已有 unknown 配置无须迁移。`effort: 'none'` 会使有效推理能力关闭。

## 输入、请求与结果

增量 intent 为 `input` 加可选初始 `instructions`、`tools`。输入接受 system/developer/user 文本、user 的 input_text/input_image 块或 `function_call_output { call_id, output }`；本地工具采用 `{ type: 'function', name, parameters }`。历史建立后不得变更初始 instructions/tool 声明，也不得追加 system/developer 消息。

`prepare()` 将私有历史与本轮 input 合并，合并本地函数工具和已配置搜索工具，固定 `store: false` 和 `include: ['reasoning.encrypted_content']`。stream 按本轮 responseMode 选择，省略时使用有效 streaming。descriptor 声明支持 stream/complete；显式 stream 仍要求有效流式能力，complete 使用 JSON 路径，回调不改变模式。宿主每轮只交新增输入，完整 HTTP 上下文由驱动在内存重建；不使用服务端 conversation 或 previous-response 链。mode 仅用于请求准备，不持久化到意图、快照或恢复记录。

## 单次文本适配

驱动提供 `textGeneration` 纯函数适配器：createIntent 将可选 instruction 映射到 instructions，并把原样 input 放入用户输入；validateParameters 在已保存 tools 实际启用 web_search 时以 capability-unsupported 拒绝，不改写参数或隐式关闭推理，仅声明搜索能力仍可使用。

readText 要求 completed，按 assistant 消息顺序读取 output_text 并以换行连接，保留块内格式；忽略私有 reasoning。拒绝块返回 refused-response，incomplete 等需续轮结果返回 incomplete-response，函数或搜索工具输出返回 capability-unsupported，未知输出或无有效文本返回 invalid-response。该适配仅供 `models.generateText()` 的全新 execution 使用；原生 Agent Loop 继续解释完整 Responses 结果。

JSON 与 SSE 最终都返回完整原生 response。允许原生 `completed/incomplete`；failed/cancelled/error 为失败。验证 assistant message、文本/拒绝块、唯一 `call_id`、函数名与参数字符串；完成的函数参数必须是 JSON 对象。保留未知 JSON 字段、reasoning/encrypted content、phase、搜索动作与引用，不压平为统一文本。

SSE 转发原生事件给受信投影器，以 `response.completed` / `response.incomplete` 的完整 response 为权威；输出增量仅用于展示与失败诊断。终态缺失、状态不匹配及提前 `[DONE]` 为 `invalid-response`。失败终态可携带已收块形成脱敏诊断。

## 恢复、资源与生命周期

`commit()` 将本轮 intent 与完整 response.output 按顺序追加到私有上下文。`restore()` 按请求/响应记录配对重放同一提交规则，校验协议、格式、记录 ID、exchange ID 和完整配对；encrypted reasoning、phase、函数续轮信息得以保留。Session 存储的是增量原生记录，不是每节点重复的历史数组。

transport 独占 fetch、reader、AbortController 和取消监听器，严格 UTF-8，响应总量上限 32 MiB，SSE 缓冲上限 8 MiB，无隐藏网络重试。cancel 先请求 reader 退出再 abort；原始驱动 result 可早于 done，Models 的公共 result 会等两者及上下文提交。超时由 execution/Settings 控制。

组件 `apply` 只注册协议并通过 Effect 注销；卸载同步停止该代准入，取消并等待其整次文本生成、execution、初始化、发现与检查。普通 HTTP 错误脱敏为固定错误；reader 清理失败使 execution 不能成功恢复。原生记录和事件仅给受信宿主，浏览器使用白名单投影。

## 发现、限制与验证

`discover()` 和 `check()` 都使用认证 GET `/models`。发现要求唯一、非空模型 ID，并返回候选，不写设置；检查只验证目录响应结构。这不等价于完成一次文本生成授权验证。

当前支持文本、用户图片与本地函数结果、显式服务端搜索；不支持任意内置工具和任意 Responses 参数透传。要增加字段须同步修改验证、表单/能力、恢复要求及行为测试。

[protocols.test.mjs](../../../packages/models/tests/protocols.test.mjs) 覆盖 JSON/SSE 的 reasoning、phase、搜索、工具 ID、恢复、失败诊断和真实清理等待；[native-boundaries.test.mjs](../../../packages/models/tests/native-boundaries.test.mjs) 覆盖异常流边界；[runtime.test.mjs](../../../packages/models/tests/runtime.test.mjs) 验证共享 execution 所有权。参见 [Models 协调服务](models.md) 与 [原生框架设计](../../native-protocol-agent-framework-design.md)。

[response-modes.test.mjs](../../../packages/models/tests/response-modes.test.mjs) 验证默认与显式 JSON/SSE 请求、模式切换和旧版本恢复；[responses-chat-generation.test.mjs](../../../packages/models/tests/responses-chat-generation.test.mjs) 与 [generation-responses-chat-errors.test.mjs](../../../packages/models/tests/generation-responses-chat-errors.test.mjs) 验证单次文本、搜索预设、拒绝/截断/工具、未知结构及空白正文。

## 图片资源与格式兼容

`input_image.image_url` 保存内部资源 URI，发送时生成 data URL。MIME、长度与 SHA-256 取自受信的顶层 resourceRefs；不接受外部 URL、内联 base64、文件 ID 或未开放的图片参数。只转换用户图片位置，系统指令和工具结果继续使用文本契约。

[images.ts](../../../packages/models/src/protocols/images.ts) 是驱动内部共享函数，不是独立组件。start 后顺序读取去重资源，等待每次读取实际退出并校验摘要；同一图片在完整历史中多次出现时逐次计算 base64 体积，读取前及发送前均检查 32 MiB 请求上限。取消、超时与协议卸载同时覆盖图片和 HTTP；清理失败不创建成功上下文。网络终态已返回但随后取消/清理失败时，仍保留受信原生诊断，经 execution 脱敏持久化。

新驱动 2.2.0 写记录 v2，明确读取 2.0.0/2.1.0/2.2.0 与 v1/v2 混合链。旧合法文本形状继续可读，v1 不接受图片；只有完整无图片父链允许有效图片能力 false→true。streaming 仅改变传输方式，恢复允许双向改变，包括从旧非流式成功父链继续流式执行或逐次选择 complete；其他身份、账户、参数及执行语义约束保持严格，旧 JSON 不改写。base64 只存在于临时 HTTP 请求，不写入意图、上下文或记录。

[multimodal-protocols.test.mjs](../../../packages/models/tests/multimodal-protocols.test.mjs) 验证 JSON/SSE 图片编码、三种 MIME、资源校验、超限、取消/超时/注销退出、失败诊断和混合版本恢复；[native-protocol-agents.test.mjs](../../../tests/native-protocol-agents.test.mjs) 验证图片工具续轮、重启、分支及接受后的失败保留。
