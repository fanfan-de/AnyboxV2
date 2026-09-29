# Gemini Interactions 原生协议

[返回 Models 模块](README.md)

## 定位与装配

源码：[protocols/gemini-interactions.ts](../../../packages/models/src/protocols/gemini-interactions.ts)。工厂 `createGeminiInteractionsProtocolComponent(options?)`，组件名 `models-protocol-gemini-interactions`，注入 `models.protocols`，注册 `gemini-interactions`（版本 `2.1.0`），不新增其他命名服务。独立工厂 `createGeminiInteractionsProtocol(options?)` 只接受 `fetch` 替换项。

驱动负责原生 Interactions 状态、请求、流和恢复；[Gemini Agent](../execution/gemini-agent.md)处理 requires_action、函数结果和停止结论。它不使用其他 Gemini 消息 API 来模拟 Interactions。

## 连接与配置

生成端点为 POST `/interactions`，API Key 使用 `x-goog-api-key`，无认证连接不发送该头。连接表单为 API 根地址、认证方式和正整数超时。

参数使用 `{ protocolId: 'gemini-interactions', formatVersion: 1, value }`，value 只允许 `generation_config`：

| 子字段 | 约束 |
| --- | --- |
| `max_output_tokens` | 1–2,147,483,647 的整数 |
| `thinking_level` | `minimal/low/medium/high`，需显式支持推理并列在配置 efforts 中 |
| `thinking_summaries` | `auto/none`，需声明支持推理 |

省略选项保留服务端默认。未实现参数（包含任意覆盖模型、input、store、stream、认证的字段）被拒绝。本地函数工具与流式基于显式能力，图片依赖显式 supported 声明，服务端搜索不开放。

## 输入、结果与恢复

intent 包含新增 `input`、可选初始 `system_instruction` 字符串与 `tools`。input 接受 `user_input` 文本/图片和 `function_result`，后者必须携带 `call_id`、`name` 与文本 result。本地工具格式为 `{ type: 'function', name, parameters }`；缺少有效工具能力则拒绝。

`prepare()` 将新增步骤与私有历史合并，固定 `model`、`store: false`、有效 stream。历史建立后 system_instruction 与工具声明保持不变；不用服务端 conversation ID 或 background agent。

最终 response 的 `steps` 按时间顺序保留，含 model_output、thought/signature/summary、function_call 及未知原生字段。允许 `completed/requires_action/incomplete/budget_exceeded`；failed/cancelled/errors 为失败。正常 completed/requires_action 的函数参数必须为对象，ID 唯一；requires_action 必须有函数调用。incomplete/budget_exceeded 可保留截断片段，是否继续和是否执行由 Loop 决定。

`commit()` 追加完整原生 steps；`restore()` 从同协议、格式 1/2、严格成对的请求/响应记录重建私有 input。宿主只保存本次 execution 的增量，thought 签名和工具 ID 留在受信记录中，不能从展示文本恢复。

## 流式行为

SSE 识别 interaction.created、interaction.status_update、step.start/delta/stop 及 interaction.completed。按 index 保存步骤，合并文本、text annotations、arguments 分片、thought signature 与 summary。在完整终态要求步骤连续且已停止；有权威 terminal steps 时保留其内容，否则由分片组装。

step 重复、缺少前置 start、已 stop 后再 delta、未知 delta 类型、错误终态和提前 `[DONE]` 都失败。原生事件只交给受信投影器；终态必须通过与 JSON 相同的结构校验才能提交。未知 response 字段会保留，不意味着任意请求字段也获允许。

## 发现与资源生命周期

`discover()` 从 GET `/models?pageSize=1000` 开始，用原样编码的 `nextPageToken` 继续；去掉远端 `name` 的 `models/` 前缀获得 remoteModelId，显示名采用 displayName 或 ID。`check()` 只检查第一页。分页操作整体拥有所有页面，拒绝重复身份/游标循环，不写配置或猜测模型能力。

共用 [transport.ts](../../../packages/models/src/protocols/transport.ts) 拥有 fetch、reader、取消与锁释放，严格 UTF-8，响应 32 MiB、SSE 缓冲 8 MiB 上限，无自动网络重试。驱动 done 等 reader 实际退出；公共 Models result 再等上下文提交。取消、超时与关闭均保留这一退出边界，清理失败不能产生可恢复成功链。

组件 `apply` 只注册并通过 Effect 注销协议代，卸载等待该代所有 initialization、execution、发现和检查；固定公共错误不透出 Key 或后端异常详情。要扩大媒体、搜索或其他参数支持，需要独立修改验证、能力与测试。

## 测试与关联文档

[gemini-interactions.test.mjs](../../../packages/models/tests/gemini-interactions.test.mjs) 覆盖 thought/注解/多函数分片、未知字段、无效终态、初始 system 固定、分页、取消/清理失败和组件依赖快照；[models-directory-web.test.mjs](../../../tests/models-directory-web.test.mjs) 覆盖保存配置至 Session 原生工具运行的链路。参见 [Models 协调服务](models.md) 与 [原生框架设计](../../native-protocol-agent-framework-design.md)。

## 图片资源与格式兼容

`user_input.content` 的 `image.uri` 保存内部资源 URI，发送时生成 `{ type: "image", mime_type, data }`。MIME、长度与 SHA-256 取自受信的顶层 resourceRefs；不接受外部 URL、内联 base64、文件 ID 或未开放的图片参数。只转换用户图片位置，系统指令和工具结果继续使用文本契约。

[images.ts](../../../packages/models/src/protocols/images.ts) 是驱动内部共享函数，不是独立组件。start 后顺序读取去重资源，等待每次读取实际退出并校验摘要；同一图片在完整历史中多次出现时逐次计算 base64 体积，读取前及发送前均检查 32 MiB 请求上限。取消、超时与协议卸载同时覆盖图片和 HTTP；清理失败不创建成功上下文。网络终态已返回但随后取消/清理失败时，仍保留受信原生诊断，经 execution 脱敏持久化。

新驱动 2.1.0 写记录 v2，读取旧驱动 2.0.0 的 v1 文本与 v1/v2 混合链。旧合法文本形状继续可读，v1 不接受图片；只有完整无图片父链允许有效图片能力 false→true。其他身份、账户和参数约束保持严格，旧 JSON 不改写。base64 只存在于临时 HTTP 请求，不写入意图、上下文或记录。

[multimodal-protocols.test.mjs](../../../packages/models/tests/multimodal-protocols.test.mjs) 验证 JSON/SSE 图片编码、三种 MIME、资源校验、超限、取消/超时/注销退出、失败诊断和混合版本恢复；[native-protocol-agents.test.mjs](../../../tests/native-protocol-agents.test.mjs) 验证图片工具续轮、重启、分支及接受后的失败保留。
