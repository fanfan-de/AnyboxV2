# Anthropic Messages 原生协议

[返回 Models 模块](README.md)

## 定位与装配

源码：[protocols/anthropic-messages.ts](../../../packages/models/src/protocols/anthropic-messages.ts)。`createAnthropicMessagesProtocolComponent(options?)` 创建 `models-protocol-anthropic-messages`，注入 `models.protocols`，注册 `anthropic-messages`、版本 `2.2.0`；没有额外服务键。`createAnthropicMessagesProtocol(options?)` 可返回独立驱动，选项仅有替换 `fetch`。

驱动保存完整有序原生块、thinking 签名与恢复语义；[Anthropic Agent](../execution/anthropic-agent.md)解释 `tool_use/pause_turn` 等停止原因并调度工具。自动 pause 续轮是 Agent Loop 的责任。

## 认证与原生参数

生成端点为 POST `/messages`，API Key 通过 `x-api-key` 发送，固定 `anthropic-version: 2023-06-01`；使用适用于该工作区的 Key。无认证连接不发送凭据头。连接表单提供 API 根地址、认证方式与请求超时。

参数封套的 protocolId 为 `anthropic-messages`、formatVersion 为 1，允许字段如下：

| 字段 | 条件 |
| --- | --- |
| `max_tokens` | 必填正安全整数；新基础配置/表单默认 4096，基础配置按定义输出上限取较小值 |
| `temperature` | 0–1 |
| `thinking.type` | `disabled/adaptive/enabled`，必须声明支持推理及该 mode |
| `thinking.budget_tokens` | 仅 enabled；必填整数 ≥1024、严格小于 max_tokens，并满足声明 budget |
| `thinking.display` | `summarized/omitted`，只允许 adaptive/enabled |
| `output_config.effort` | `low/medium/high/xhigh/max`，必须属于声明 efforts |
| `tools` | 可选空数组或唯一 `{ type: 'web_search_20250305', name: 'web_search' }`，要求显式搜索能力 |

adaptive/enabled 时温度必须省略或为 1。disabled 关闭有效推理，但依然必须通过配置中的 mode 声明；缺失 mode 不推断。`max_tokens` 默认是初始化时显式保存的值，不在运行时为漏填配置补齐。未实现字段和覆盖认证/模型/历史的参数被拒绝。图片输入要求配置显式声明 supported。

流式默认开启，配置 streaming 为 unknown/supported 时发送 `stream: true`，显式 unsupported 时发送 false；已有 unknown 配置无须迁移。这项传输默认不改变工具、图片、搜索或推理能力的显式声明要求。

## 输入与上下文

intent 为本轮 user `messages`、可选初始 `system` 和 `tools`。内容接受字符串，或 text/image/tool_result 块；tool_result 用 `tool_use_id` 关联并携带文本结果。本地工具声明使用 `{ name, input_schema }`，不带服务端工具的 type；有效工具能力不足时拒绝声明。

`prepare()` 将新增 user 消息与私有原生历史拼接，保留 assistant 的完整有序 content，将配置的服务端搜索工具与本地工具合并。已有历史后 system 和 tools 必须保持相同。请求体固定模型，stream 按本轮 responseMode 选择，省略时使用有效 streaming。descriptor 声明 stream/complete，显式 stream 仍要求有效流式能力，complete 使用 JSON 路径；回调不改变选择。mode 不进入配置、快照、意图或恢复记录，不建立服务端会话。

`commit()` 追加 `{ role: 'assistant', content: message.content }`；恢复按请求/响应记录重放，保留 thinking、signature、redacted_thinking、server_tool_use、搜索结果、引用和本地 tool_use 顺序。这些受信内容不直接公开给浏览器。

## 单次文本适配

`textGeneration` 纯函数适配器把可选 instruction 映射为 system 文本块，把 input 原样放入用户 text 块。validateParameters 在预设实际启用 web_search_20250305 时以 capability-unsupported 拒绝；仅声明搜索能力仍可用。已保存 max_tokens、thinking 和其他原生参数不改写，运行时不暗补或关闭推理。

readText 只接受 end_turn/stop_sequence，按原生顺序提取 content 的 text 块并以换行连接，保留格式，忽略 thinking、redacted_thinking 和签名。refusal 返回 refused-response，max_tokens、model_context_window_exceeded、pause_turn 等需续轮结果返回 incomplete-response，tool_use 或服务端工具结果返回 capability-unsupported，未知结构或无有效文本返回 invalid-response。`models.generateText()` 只请求一次 complete；自动 pause 续轮仍由原生 Agent Loop 负责。

## JSON 与 SSE 结果

终态要求原生 message/assistant，接受 `end_turn`、`stop_sequence`、`tool_use`、`max_tokens`、`model_context_window_exceeded`、`pause_turn`、`refusal`。保留原生停止原因，未归一化为共享 success/failed。thinking 在非截断结果必须有非空 signature；工具 ID 必须唯一。截断工具 input 可以保持原生片段，不能作为完整工具参数执行。

SSE 严格处理 message_start、content_block_start/delta/stop、message_delta、message_stop，按 index 还原内容块。文本、thinking、签名、工具 JSON 和 citation 增量分别匹配对应块类型；ping 忽略，错误事件保存已有块的脱敏诊断。不完整块、重复或乱序终结、delta 类型错配、`[DONE]` 都被拒绝。

## 发现、资源与生命周期

发现从 GET `/models?limit=1000` 开始，用 `has_more/last_id/after_id` 分页；检查只请求 `/models?limit=1`。发现可返回模型名及远端明确声明的 thinking modes、efforts、imageInput 建议，未知能力不猜测；建议不改写已保存的配置能力。重复模型、空页续游标和游标循环会失败；不写入本地定义或配置。

共用 [transport.ts](../../../packages/models/src/protocols/transport.ts) 拥有 fetch、reader、控制器与取消清理，响应 32 MiB、SSE 缓冲 8 MiB，严格 UTF-8、无自动重试。原始 result 可先于 done，公共 Models result 等实际退出和上下文提交。终态收到后仍可能处于 reader 清理，期间取消或清理失败不能生成成功上下文。

Effect 注销所属协议代，停止新准入并等待该代的整次文本生成、initialization、execution、发现/检查；其他协议不受影响。原生错误信息经固定 ModelsError 与诊断脱敏处理，签名/加密块只留受信记录。后续支持新工具/参数时须同步校验、descriptor、恢复与测试，不能任意透传原生字段。

## 测试与关联文档

[anthropic-messages.test.mjs](../../../packages/models/tests/anthropic-messages.test.mjs) 覆盖 pause/search、分片签名与引用、参数边界、初始上下文固定、取消清理、分页和组件注销；[unified-models.test.mjs](../../../packages/models/tests/unified-models.test.mjs) 验证默认 max_tokens 持久化并按输出上限约束。参见 [Models 协调服务](models.md) 和 [原生框架设计](../../native-protocol-agent-framework-design.md)。

[response-modes.test.mjs](../../../packages/models/tests/response-modes.test.mjs) 验证默认与显式 JSON/SSE 请求、模式切换和旧版本恢复；[anthropic-gemini-generation.test.mjs](../../../packages/models/tests/anthropic-gemini-generation.test.mjs) 与 [generation-anthropic-gemini-errors.test.mjs](../../../packages/models/tests/generation-anthropic-gemini-errors.test.mjs) 验证单次文本、搜索预设、thinking 过滤、拒绝/截断/暂停/工具、未知结构及空白正文。

## 图片资源与格式兼容

`image.source = { type: "url", url: 内部资源URI }` 保存引用，发送时生成 `{ type: "base64", media_type, data }`。MIME、长度与 SHA-256 取自受信的顶层 resourceRefs；不接受外部 URL、内联 base64、文件 ID 或未开放的图片参数。只转换用户图片位置，系统指令和工具结果继续使用文本契约。

[images.ts](../../../packages/models/src/protocols/images.ts) 是驱动内部共享函数，不是独立组件。start 后顺序读取去重资源，等待每次读取实际退出并校验摘要；同一图片在完整历史中多次出现时逐次计算 base64 体积，读取前及发送前均检查 32 MiB 请求上限。取消、超时与协议卸载同时覆盖图片和 HTTP；清理失败不创建成功上下文。网络终态已返回但随后取消/清理失败时，仍保留受信原生诊断，经 execution 脱敏持久化。

新驱动 2.2.0 写记录 v2，明确读取 2.0.0/2.1.0/2.2.0 与 v1/v2 混合链。旧合法文本形状继续可读，v1 不接受图片；只有完整无图片父链允许有效图片能力 false→true。streaming 仅改变传输方式，恢复允许双向改变，包括从旧非流式成功父链继续流式执行或逐次选择 complete；其他身份、账户、参数及执行语义约束保持严格，旧 JSON 不改写。base64 只存在于临时 HTTP 请求，不写入意图、上下文或记录。

[multimodal-protocols.test.mjs](../../../packages/models/tests/multimodal-protocols.test.mjs) 验证 JSON/SSE 图片编码、三种 MIME、资源校验、超限、取消/超时/注销退出、失败诊断和混合版本恢复；[native-protocol-agents.test.mjs](../../../tests/native-protocol-agents.test.mjs) 验证图片工具续轮、重启、分支及接受后的失败保留。
