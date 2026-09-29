# DeepSeek 非推理协议扩展

[返回 Models 模块](README.md)

## 定位与装配

源码：[src/web/deepseek-protocol.ts](../../../src/web/deepseek-protocol.ts)。工厂 `createDeepSeekProtocolComponent(options?)`，组件名 `models-protocol-deepseek`，注入 `models.protocols`，注册 `deepseek-chat-completions`（复用版本 `2.1.0`）。该文件处于 Web 宿主，按职责归入模型接入模块；通用 `packages/models` 不反向依赖它。

独立工厂 `createDeepSeekProtocol(options?)` 调用通用 `createChatCompletionsProtocol`，不包装第二套 HTTP 或流解析器。它只确定明确的线上参数差异。工具循环由 [DeepSeek Agent](../execution/deepseek-agent.md)绑定到相同协议 ID，驱动本身不执行工具。

## 固定策略与配置

| 策略 | 值及效果 |
| --- | --- |
| `protocolId` | `deepseek-chat-completions`，与标准 Chat 配置分开 |
| `name` | `DeepSeek 非推理` |
| `maxTokensField` | `max_tokens`，不发送标准的 max_completion_tokens |
| `disableThinking` | `true`，生成请求固定 thinking.type = disabled |
| `allowDeveloper` | `false`，发请求前拒绝 developer 消息 |
| `sourceMappings` | 来源 models.dev、原始 Provider deepseek、源提示 chat-completions |

映射只适用于明确来源身份和协议提示，不按 hostname/名称猜测。工厂唯一选项为 `fetch`。连接使用 API 根地址、none/api-key 认证与超时，Key 为 Bearer；生成 POST `/chat/completions`。

原生参数保存为 `{ protocolId: 'deepseek-chat-completions', formatVersion: 1, value }`，只允许 `temperature`（0–2）和 `max_tokens`（正安全整数）。不开放 reasoning_effort、max_completion_tokens、任意 thinking 配置或其他原生字段，表单也不显示推理选项。即使模型声明支持推理，该扩展的有效 reasoning 仍为 unsupported；`openNative({ requirements: { reasoning: true }, ... })` 会在网络请求前失败。模型配置明确声明 imageInput supported 时支持图片资源输入；服务端搜索不支持。

## 主要流程与恢复

增量 intent 和工具声明遵循 [标准 Chat 驱动](chat-completions.md)：user/system/tool 文本、仅 user 的有序 text/image_url 图片资源、`tool_call_id` 和 function 工具 schema。图片传包内资源 URI 与顶层 resourceRefs，由 execution 捕获宿主 reader 后在 start 内物化；不新增 DeepSeek 专属上传、Files API 或 URL 抓取路径。共享 prepare 在本地拒绝 developer，并注入固定非推理请求字段；流式时请求 include_usage。

JSON/SSE 解析、分片 UTF-8、多个工具调用 arguments 合并、finish_reason、usage 和未知原生字段均由通用 Chat 实现处理。原生 assistant 消息写入私有上下文，增量恢复记录使用本扩展 protocolId 和 v2 顶层 resourceRefs，因此不可直接跨到标准 Chat 记录。明确兼容旧 2.0.0/v1 文本，父链允许 v1/v2 混合，旧 JSON 不改写。Run 是否成功、length/content_filter 怎么处理仍归 Agent Loop。

发现与连接检查使用认证 GET `/models`，不附生成参数，不创建本地配置。发现只给候选，不证明模型具备特定推理能力。

## 旧参数迁移

`convertLegacyDeepSeekParameters(value)` 是纯读取/迁移函数：只接受旧 `temperature`、`maxOutputTokens` 和可选空对象 `protocol`，映射 `maxOutputTokens → max_tokens`，保留省略项，不暗补默认。未知字段或非空 protocol 扩展拒绝转换，不能静默丢弃。

宿主 [installWebModels](../../../src/web/models-startup.ts) 把该转换器传给 `createModelsStoreComponent` 的 `legacyParameterConverters`。这是旧配置兼容边界，不保留旧统一执行 API 或旧格式写入路径。

## 生命周期、资源与限制

组件通过当前 `deps` 注册，Effect 返回 `registration.unregister()`，确保等待该代 initialization、execution、发现/检查退出。图片读取与 SHA-256/长度验证、base64 物化、32 MiB 请求上限、实际 fetch、reader、取消与资源上限沿用通用 Chat 实现；Models 公共 result 等 done 和上下文提交。取消不代替退出，清理失败不能生成成功可恢复记录；凭据只在私有 execution 中捕获一次。

本扩展当前明确提供非推理能力。新增 DeepSeek 功能应修改此显式策略或增加相应协议实现、校验及测试，不能因来源模型名称或配置支持推理就自动切换运行语义。

## 测试与关联文档

[deepseek-protocol.test.mjs](../../../tests/deepseek-protocol.test.mjs) 验证 max_tokens/thinking、分片工具流、发现与检查、推理要求提前拒绝、developer 拒绝和非流式文本；[protocols.test.mjs](../../../packages/models/tests/protocols.test.mjs) 验证通用扩展策略；[native-migration.test.mjs](../../../packages/models/tests/native-migration.test.mjs) 验证含 DeepSeek 的原生参数迁移。

[native-images.test.mjs](../../../packages/models/tests/native-images.test.mjs) 验证复用 DeepSeek 策略时的图片 JSON/SSE、工具续轮与恢复。

参见 [标准 Chat 驱动](chat-completions.md)、[配置存储](store.md) 和 [Models 协调服务](models.md)。
