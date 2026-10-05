# Gemini Interactions 原生协议

[返回 Models 模块](README.md)

## 定位与装配

源码：[protocols/gemini-interactions.ts](../../../packages/models/src/protocols/gemini-interactions.ts)。工厂 `createGeminiInteractionsProtocolComponent(options?)`，组件名 `models-protocol-gemini-interactions`，注入 `models.protocols`，注册 `gemini-interactions`（版本 `2.2.0`），不新增其他命名服务。独立工厂 `createGeminiInteractionsProtocol(options?)` 只接受 `fetch` 替换项。

驱动负责原生 Interactions 状态、请求、流和恢复；[Gemini Agent](../execution/gemini-agent.md)处理 requires_action、函数结果和停止结论。它不使用其他 Gemini 消息 API 来模拟 Interactions。

## 连接与配置

生成端点为 POST `/interactions`，API Key 使用 `x-goog-api-key`，无认证连接不发送该头。连接表单为 API 根地址、认证方式和正整数超时。

参数使用 `{ protocolId: 'gemini-interactions', formatVersion: 1, value }`，value 只允许 `generation_config`：

| 子字段 | 约束 |
| --- | --- |
| `max_output_tokens` | 1–2,147,483,647 的整数 |
| `thinking_level` | `minimal/low/medium/high`，需显式支持推理并列在配置 efforts 中 |
| `thinking_summaries` | `auto/none`，需声明支持推理 |

省略选项保留服务端默认。未实现参数（包含任意覆盖模型、input、store、stream、认证的字段）被拒绝。本地函数工具与图片依赖显式 supported 声明；流式默认开启，配置 streaming 为 unknown/supported 时发送 `stream: true`，显式 unsupported 时发送 false。已有 unknown 配置无须迁移。服务端搜索不开放。

## 输入、结果与恢复

intent 包含新增 `input`、可选初始 `system_instruction` 字符串与 `tools`。input 接受 `user_input` 文本/图片和 `function_result`，后者必须携带 `call_id`、`name` 与文本 result。本地工具格式为 `{ type: 'function', name, parameters }`；缺少有效工具能力则拒绝。

`prepare()` 将新增步骤与私有历史合并，固定 `model`、`store: false`，stream 按本轮 responseMode 选择，省略时使用有效 streaming。descriptor 声明 stream/complete，显式 stream 仍要求有效流式能力，complete 使用 JSON 路径；回调不改变选择。mode 不进入配置、快照、意图或恢复记录。历史建立后 system_instruction 与工具声明保持不变；不用服务端 conversation ID 或 background agent。

最终 response 的 `steps` 按时间顺序保留，含 model_output、thought/signature/summary、function_call 及未知原生字段。允许 `completed/requires_action/incomplete/budget_exceeded`；failed/cancelled/errors 为失败。正常 completed/requires_action 的函数参数必须为对象，ID 唯一；requires_action 必须有函数调用。incomplete/budget_exceeded 可保留截断片段，是否继续和是否执行由 Loop 决定。

`commit()` 追加完整原生 steps；`restore()` 从同协议、格式 1/2、严格成对的请求/响应记录重建私有 input。宿主只保存本次 execution 的增量，thought 签名和工具 ID 留在受信记录中，不能从展示文本恢复。

## 单次文本适配

`textGeneration` 纯函数适配器把可选 instruction 映射到 system_instruction，把原样 input 放入 user_input 的 text 块；validateParameters 保留已保存 generation_config，不隐式关闭推理。readText 要求 completed，只读取 model_output 中的 text 块，按原生顺序以换行连接并保留格式，忽略 thought、签名和摘要。

响应顶层 error/errors 或步骤 error 中明确的安全阻止 error.code 返回 refused-response；普通传输及服务端失败仍为 provider-failure。incomplete/budget_exceeded 等需续轮结果返回 incomplete-response，function_call 返回 capability-unsupported，未知输出结构或无有效文本返回 invalid-response。`models.generateText()` 使用全新 execution 与一次 complete 请求；原生 Agent Loop 继续处理 requires_action、工具结果与续轮。

## 流式行为

SSE 识别 interaction.created、interaction.status_update、step.start/delta/stop 及 interaction.completed，也接纳[官方迁移指南](https://ai.google.dev/gemini-api/docs/interactions-breaking-changes-may-2026)中的 interaction.in_progress 与 interaction.requires_action 状态通知；状态通知不要求 step index，也不代替 interaction.completed 终态。按 index 保存步骤，合并文本、text annotations、arguments 分片、thought signature 与 summary。在完整终态要求步骤连续且已停止；有权威 terminal steps 时保留其内容，否则由分片组装。

`store: false` 的实际流式终态可能省略服务器 interaction.id 与 steps：不要求服务器 ID，也不生成替代 ID；与 JSON 相同，使用已校验的原生步骤和本地 exchange/record 引用提交并恢复。function_call.id、函数名与完整参数仍严格校验。文本和函数调用的无 ID 终态均覆盖续轮与恢复测试。

step 重复、缺少前置 start、已 stop 后再 delta、未知 delta 类型、错误终态和提前 `[DONE]` 都失败。原生事件只交给受信投影器；终态必须通过与 JSON 相同的结构校验才能提交。未知 response 字段会保留，不意味着任意请求字段也获允许。

JSON/SSE 解析失败通过已有 diagnostic 记录保存固定解析阶段、已知事件类型、合法 step index 与已知 step/delta 类型，不保存原始失败帧、正文、签名、认证头或后端错误消息。公共错误仍使用固定分类，浏览器仍只接收既有白名单投影；诊断不是可恢复响应，失败不提交候选上下文。

## 发现与资源生命周期

`discover()` 从 GET `/models?pageSize=1000` 开始，用原样编码的 `nextPageToken` 继续；去掉远端 `name` 的 `models/` 前缀获得 remoteModelId，显示名采用 displayName 或 ID。`check()` 只检查第一页。分页操作整体拥有所有页面，拒绝重复身份/游标循环，不写配置或猜测模型能力。

共用 [transport.ts](../../../packages/models/src/protocols/transport.ts) 拥有 fetch、reader、取消与锁释放，严格 UTF-8，响应 32 MiB、SSE 缓冲 8 MiB 上限，无自动网络重试。驱动 done 等 reader 实际退出；公共 Models result 再等上下文提交。取消、超时与关闭均保留这一退出边界，清理失败不能产生可恢复成功链。

仅 Interactions 请求向 transport 提供内部 HTTP 错误分类函数：非 2xx 响应按同一受管 reader 与体积上限读取 JSON，依据[官方错误码](https://ai.google.dev/gemini-api/docs/api-errors)中的明确阻止生成 code 返回 refused-response；其他或损坏正文返回 provider-failure。读取、取消与清理仍被等待，原始错误正文不公开或持久化。发现、检查和其他协议保持既有 HTTP 错误处理。

组件 `apply` 只注册并通过 Effect 注销协议代，卸载等待该代所有整次文本生成、initialization、execution、发现和检查；固定公共错误不透出 Key 或后端异常详情。要扩大媒体、搜索或其他参数支持，需要独立修改验证、能力与测试。

## 测试与关联文档

[gemini-interactions.test.mjs](../../../packages/models/tests/gemini-interactions.test.mjs) 覆盖无服务器 ID 的文本/工具终态和恢复、状态通知、解析位置诊断及脱敏、thought/注解/多函数分片、未知字段、无效终态、初始 system 固定、分页、取消/清理失败和组件依赖快照；[models-directory-web.test.mjs](../../../tests/models-directory-web.test.mjs) 覆盖保存配置至 Session 原生工具运行的链路。参见 [Models 协调服务](models.md) 与 [原生框架设计](../../native-protocol-agent-framework-design.md)。

[response-modes.test.mjs](../../../packages/models/tests/response-modes.test.mjs) 验证默认与显式 JSON/SSE 请求、模式切换和旧版本恢复；[anthropic-gemini-generation.test.mjs](../../../packages/models/tests/anthropic-gemini-generation.test.mjs) 与 [generation-anthropic-gemini-errors.test.mjs](../../../packages/models/tests/generation-anthropic-gemini-errors.test.mjs) 验证单次文本、thought 过滤、拒绝/预算耗尽/工具、未知结构及空白正文。

## 图片资源与格式兼容

`user_input.content` 的 `image.uri` 保存内部资源 URI，发送时生成 `{ type: "image", mime_type, data }`。MIME、长度与 SHA-256 取自受信的顶层 resourceRefs；不接受外部 URL、内联 base64、文件 ID 或未开放的图片参数。只转换用户图片位置，系统指令和工具结果继续使用文本契约。

[images.ts](../../../packages/models/src/protocols/images.ts) 是驱动内部共享函数，不是独立组件。start 后顺序读取去重资源，等待每次读取实际退出并校验摘要；同一图片在完整历史中多次出现时逐次计算 base64 体积，读取前及发送前均检查 32 MiB 请求上限。取消、超时与协议卸载同时覆盖图片和 HTTP；清理失败不创建成功上下文。网络终态已返回但随后取消/清理失败时，仍保留受信原生诊断，经 execution 脱敏持久化。

新驱动 2.2.0 写记录 v2，明确读取 2.0.0/2.1.0/2.2.0 与 v1/v2 混合链。旧合法文本形状继续可读，v1 不接受图片；只有完整无图片父链允许有效图片能力 false→true。streaming 仅改变传输方式，恢复允许双向改变，包括从旧非流式成功父链继续流式执行或逐次选择 complete；其他身份、账户、参数及执行语义约束保持严格，旧 JSON 不改写。base64 只存在于临时 HTTP 请求，不写入意图、上下文或记录。

[multimodal-protocols.test.mjs](../../../packages/models/tests/multimodal-protocols.test.mjs) 验证 JSON/SSE 图片编码、三种 MIME、资源校验、超限、取消/超时/注销退出、失败诊断和混合版本恢复；[native-protocol-agents.test.mjs](../../../tests/native-protocol-agents.test.mjs) 验证图片工具续轮、重启、分支及接受后的失败保留。
