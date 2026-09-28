# Anthropic Messages 原生协议

[返回 Models 模块](README.md)

## 定位与装配

源码：[protocols/anthropic-messages.ts](../../../packages/models/src/protocols/anthropic-messages.ts)。`createAnthropicMessagesProtocolComponent(options?)` 创建 `models-protocol-anthropic-messages`，注入 `models.protocols`，注册 `anthropic-messages`、版本 `2.0.0`；没有额外服务键。`createAnthropicMessagesProtocol(options?)` 可返回独立驱动，选项仅有替换 `fetch`。

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

adaptive/enabled 时温度必须省略或为 1。disabled 关闭有效推理，但依然必须通过配置中的 mode 声明；缺失 mode 不推断。`max_tokens` 默认是初始化时显式保存的值，不在运行时为漏填配置补齐。未实现字段和覆盖认证/模型/历史的参数被拒绝。图片输入始终关闭。

## 输入与上下文

intent 为本轮 user `messages`、可选初始 `system` 和 `tools`。内容接受字符串，或 text/tool_result 块；tool_result 用 `tool_use_id` 关联并携带文本结果。本地工具声明使用 `{ name, input_schema }`，不带服务端工具的 type；有效工具能力不足时拒绝声明。

`prepare()` 将新增 user 消息与私有原生历史拼接，保留 assistant 的完整有序 content，将配置的服务端搜索工具与本地工具合并。已有历史后 system 和 tools 必须保持相同。请求体固定模型与有效 stream，不建立服务端会话。

`commit()` 追加 `{ role: 'assistant', content: message.content }`；恢复按请求/响应记录重放，保留 thinking、signature、redacted_thinking、server_tool_use、搜索结果、引用和本地 tool_use 顺序。这些受信内容不直接公开给浏览器。

## JSON 与 SSE 结果

终态要求原生 message/assistant，接受 `end_turn`、`stop_sequence`、`tool_use`、`max_tokens`、`model_context_window_exceeded`、`pause_turn`、`refusal`。保留原生停止原因，未归一化为共享 success/failed。thinking 在非截断结果必须有非空 signature；工具 ID 必须唯一。截断工具 input 可以保持原生片段，不能作为完整工具参数执行。

SSE 严格处理 message_start、content_block_start/delta/stop、message_delta、message_stop，按 index 还原内容块。文本、thinking、签名、工具 JSON 和 citation 增量分别匹配对应块类型；ping 忽略，错误事件保存已有块的脱敏诊断。不完整块、重复或乱序终结、delta 类型错配、`[DONE]` 都被拒绝。

## 发现、资源与生命周期

发现从 GET `/models?limit=1000` 开始，用 `has_more/last_id/after_id` 分页；检查只请求 `/models?limit=1`。发现可返回模型名及远端明确声明的 thinking modes、efforts、imageInput 建议，未知能力不猜测，也不会打开图片执行。重复模型、空页续游标和游标循环会失败；不写入本地定义或配置。

共用 [transport.ts](../../../packages/models/src/protocols/transport.ts) 拥有 fetch、reader、控制器与取消清理，响应 32 MiB、SSE 缓冲 8 MiB，严格 UTF-8、无自动重试。原始 result 可先于 done，公共 Models result 等实际退出和上下文提交。终态收到后仍可能处于 reader 清理，期间取消或清理失败不能生成成功上下文。

Effect 注销所属协议代，停止新准入并等待该代的 initialization、execution、发现/检查；其他协议不受影响。原生错误信息经固定 ModelsError 与诊断脱敏处理，签名/加密块只留受信记录。后续支持新工具/参数时须同步校验、descriptor、恢复与测试，不能任意透传原生字段。

## 测试与关联文档

[anthropic-messages.test.mjs](../../../packages/models/tests/anthropic-messages.test.mjs) 覆盖 pause/search、分片签名与引用、参数边界、初始上下文固定、取消清理、分页和组件注销；[unified-models.test.mjs](../../../packages/models/tests/unified-models.test.mjs) 验证默认 max_tokens 持久化并按输出上限约束。参见 [Models 协调服务](models.md) 和 [原生框架设计](../../native-protocol-agent-framework-design.md)。
