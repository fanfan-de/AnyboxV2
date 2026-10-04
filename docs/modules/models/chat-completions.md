# Chat Completions 原生协议

[返回 Models 模块](README.md)

## 定位与装配

源码：[protocols/chat-completions.ts](../../../packages/models/src/protocols/chat-completions.ts)，共用 [shared.ts](../../../packages/models/src/protocols/shared.ts) 与 [transport.ts](../../../packages/models/src/protocols/transport.ts)。内部 [images.ts](../../../packages/models/src/protocols/images.ts) 负责已知图片字段的资源映射、wire 大小预检与包含资源读取的 operation，不注册额外组件。工厂 `createChatCompletionsProtocolComponent(options?)`，组件名 `models-protocol-chat-completions`，注入 `models.protocols` 并注册 `chat-completions`（版本 `2.1.0`），无独立服务键。

驱动负责原生协议与恢复；[Chat Completions Agent](../execution/chat-completions-agent.md)负责解释 finish reason、执行工具与决定结论。独立工厂 `createChatCompletionsProtocol(options?)` 只接受可替换 `fetch`；DeepSeek 等兼容提供方共用此协议与绑定。

## 配置与原生参数

连接字段为 API 根 `baseUrl`、`auth` 和 `timeoutMs`，API Key 使用 Bearer；生成端点是 POST `/chat/completions`。标准参数封套为 `{ protocolId: 'chat-completions', formatVersion: 1, value }`：

- `temperature`：0–2。
- `max_completion_tokens` 或 `max_tokens`：正安全整数，两者互斥。
- `thinking.type`：可选 `disabled/enabled`；显式启用须符合模型声明的推理能力与模式，省略时保留服务商默认。
- `reasoning_effort`：`none/minimal/low/medium/high/xhigh`，必须属于声明的推理 efforts；`none` 关闭有效推理。`thinking.type: disabled` 不能同时保存 `reasoning_effort`；enabled 不能与 `reasoning_effort: none` 同时保存。

不补原生参数默认值，不允许模型、消息、认证、`n` 或任意扩展字段透传。工具与图片需配置明确声明 supported；流式默认开启，配置 streaming 为 unknown/supported 时发送 `stream: true`，显式 unsupported 时发送 false。已有 unknown 配置无须迁移。服务端 webSearch 不支持。连接/参数被 execution 固定后，后续设置改动仅影响新 execution。

连接、配置参数和原生 Run 记录统一使用 `chat-completions`，驱动与包内注册表不按提供方名称或 URL 增加语义。旧 DeepSeek 当前配置由停机时的一次性配置迁移改为标准协议，保留连接与配置 ID、凭据引用、epoch 和不可变历史；运行期不提供旧驱动、别名或隐式 disabled thinking。旧协议历史可查看但不能恢复执行，需要新建标准协议会话。

## 输入与请求

intent 包含本轮 `messages` 和可选初始 `tools`。消息角色接受 system/developer/user/tool；字符串输入保持兼容，只有 user 还接受有序 text/image_url 数组，tool 消息必须含 `tool_call_id`。图片的 `image_url.url` 必须是 `nativeImageResourceUri(id)` 生成的内部资源 URI，配合 `prepareExchange(intent, { resourceRefs })` 传入本轮精确引用集合。外部 URL、内联 data URL、file_id、detail、音视频和其他角色图片都被拒绝。函数声明格式为 `{ type: 'function', function: { name, parameters } }`，且必须具有有效本地工具能力。

`prepare()` 将私有 messages 历史与新增输入拼接；工具声明在有历史后保持固定，也不能追加 system/developer。请求固定模型 ID 和有效流式开关，流式时加入 `stream_options: { include_usage: true }`。生成参数直接来自已保存的原生参数，驱动不按 Provider 固定 thinking 或限制 developer。

## 原生结果与流式行为

非流式直接校验原生对象：必须只有一个 choice，message 为 assistant，允许 `stop/tool_calls/length/content_filter`。message 的 content 可空或字符串，refusal 保留；tool calls 必须为函数、ID 唯一、名字和 arguments 非空/字符串，正常 stop/tool_calls 下 arguments 必须可解析成对象。`tool_calls` 终态必须确实带调用，已停用的 `message.function_call` 被拒绝。

流式按 choice 0 重组 content、refusal、`reasoning_content`、工具 ID/函数名/arguments 分片，按工具 index 排序；上游返回的推理分片按顺序拼接到原生 assistant message。保留 envelope 与未知消息字段，允许终态后单独的 usage chunk；必须收到 finish reason 及 `[DONE]`。多 choice、重复终结、不完整 SSE 或缺少 `[DONE]` 都失败。返回的是完整原生 Chat 对象，不把长度截断或过滤结果自动变成 Run 成功。

新记录采用 v2，request 顶层 resourceRefs 只包含本轮图片，payload 仍为原生 intent。reader 明确兼容 2.0.0/2.1.0 驱动和 v1/v2 混合父链，v1 仅文本且不改写。只有旧文本历史的有效图片能力 false→true 可加法续接；streaming 仅改变传输方式，恢复允许双向改变，包括从旧非流式成功父链继续流式执行。其他执行语义继续严格验证。

`commit()` 将新消息与原生 assistant message 加入私有上下文；`restore()` 从成对增量记录重建同一状态，保留多工具调用、unknown fields 和原生 ID。公开结果与受信恢复数据由宿主解释，浏览器只接收安全投影。Anybox Harness 将最终和流式回复中的非空 `reasoning_content` 字符串投影为独立推理文本块；省略或空字段不展示，也不据此改变生成参数或增加调用。已有原生历史无需改写。

## 资源与生命周期

图片读取端口由每个 `openNative({ resources })` 捕获，资源 bytes 与路径不进入配置、快照和记录。`start()` 之后先等待资源读取 result/done，校验字节数与 SHA-256，再把内部 URI 物化成私有 data URL。完整请求 JSON 上限 32 MiB，计算 base64 膨胀和历史图片，在读资源前预检并在发网前复核；取消、缺失或损坏资源不能降级成纯文本。每次请求使用共用 transport，独占 fetch、reader、信号与取消清理；严格 UTF-8、响应 32 MiB 与 SSE 缓冲 8 MiB 上限，无隐藏重试。`cancel()` 请求结束但不等价于资源退出，驱动 done 等待 reader 取消和锁释放；Models 对外 result 再等待实际退出和上下文提交。取消或清理失败不会提交候选历史。

组件注册即完成启动，通过 Effect 等待协议代注销；该代初始化、发现、检查和 execution 都被取消并等待。HTTP/响应错误采用固定 ModelsError，密钥和原生后端异常不进入公共错误。

## 发现、测试与关联

`discover()`、`check()` 使用认证 GET `/models`；前者返回唯一模型 ID 候选，后者验证目录结构，均不创建配置、不发送生成参数。当前实现只增加静态图片输入，不支持任意多模态消息、多 choice 或旧 function_call 接口。

[protocols.test.mjs](../../../packages/models/tests/protocols.test.mjs) 覆盖文本、并行函数调用、unknown fields、原生恢复、SSE 与两种输出上限及显式 thinking；[runtime.test.mjs](../../../packages/models/tests/runtime.test.mjs) 覆盖取消、关闭及配置捕获。[native-images.test.mjs](../../../packages/models/tests/native-images.test.mjs) 覆盖引用与 JSON/SSE 物化、工具续轮、混合版本恢复、实际资源退出、损坏与 32 MiB wire 上限。参见 [Models 协调服务](models.md)。
