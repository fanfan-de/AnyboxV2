# Chat Completions Agent 绑定组件

[返回执行模块](README.md) · [返回组件文档](../README.md)

该组件把标准 Chat Completions 驱动代绑定到 `runChat`，用 choices、finish_reason 和原生 tool_calls 决定下一步。传输、流解析、参数和恢复由 [Chat Completions 驱动](../models/chat-completions.md) 负责。

## 实现与装配

- 源码：[绑定工厂和首次编码](../../../src/applications/harness/core/protocol-agents/registry.ts)、[Chat Loop](../../../src/applications/harness/core/protocol-agents/chat.ts)、[共享交换管道](../../../src/applications/harness/core/protocol-agents/shared.ts)。
- 工厂实例：`createProtocolAgentBindingComponent('chat-completions')`。
- 组件名：`harness-protocol-agent-chat-completions`；配置类型：`void`；没有独立公开服务或额外配置。
- 注入 `harness.protocol-agents` 和 `models.protocols`；apply 获取标准 Chat 的固定驱动代租约并注册配对。
- `runChat` 是函数；[DeepSeek 绑定](deepseek-agent.md) 复用它，但拥有另一个协议 ID、绑定代和驱动租约。

## 输入与接口

通过[协议注册表](protocol-agent-registry.md)的 prepare 接收当前 input、固定 initialization、文件正文和可选历史。文本由本次模板输出与其后的文件快照资料组成；无图片时编码为 `messages: [...prompts, { role: 'user', content: text }]`。有图片时 content 为可选 text 块加有序 image_url 块，url 保存内部资源 URI，驱动在受管 start 后转成 data URL。工具声明为 `{ type: 'function', function: { name, description?, parameters } }`。父历史恢复时只提供本轮新增消息，不重复祖先文件资料。

Loop 的签名为 `runChat(runner: ExchangeRunner, initial: NativeObject): Promise<ProtocolConclusion>`；runner.call 执行原生交换，runner.tools 执行应用已知工具，返回 conclusion 给 Runtime。模型参数不是 Loop 选项，由 Models 配置快照固定。

## 原生循环与失败

每次回复必须恰有一个 choice。finish_reason=length 归为 incomplete-response；content_filter 或非空 message.refusal 归为 refused-response。tool_calls 若存在，必须全部为 function，包含非空 ID、名称及可解析为对象的 JSON arguments。

| finish_reason | 行为 |
| --- | --- |
| `tool_calls` | 必须包含调用；验证完整批次，再串行执行工具，下一轮只提交 role=tool、tool_call_id 与结果 JSON 字符串 |
| `stop` | 不得同时含工具调用；content 为 null/缺省时输出空字符串，否则必须是字符串；返回当前回复的记录引用 |
| 其他 | invalid-response；不会猜测成正常完成 |

Loop 不把中间工具请求回复的 content 自动累积进最终答案；最终输出来自正常 stop 的那个回复。全量原生消息历史由独立 execution 保管，每轮 intent 保持增量。

## 所有权、取消和清理

绑定持有一个长期驱动代租约；每个 program 另持独立 execution 和同代租约。program 的绑定快照固定驱动/Loop/记录版本，防止运行期间切换驱动。Session 保存受信原生消息与恢复记录，Runtime 持有在途调用；绑定不保存凭据。

Effect 等待 unregister 撤销本代并加入所有已接受 program 的释放，再释放长期驱动租约。取消会通过 program.signal 传播到 Runtime，工具结果和已经发生的副作用仍被观察；只有 actual exit、program.close 和 Session 成功事务都完成，才生成可继续节点。

## 兼容限制与验证

这里只实现标准 Chat 原生语义；供应商差异必须显式适配，不能按 URL 推断成 DeepSeek。恢复使用同协议与兼容参数，新记录格式为 2，双读旧文本格式 1；旧 dialogue-v1 不执行。已声明图片能力的配置接受 user 文本/图片块，持久资源引用在受管调用内编码为 data URL，工具结果仍为文本。工具能力未声明时不提供本地工具，纯文本仍可执行。没有多 choice 合并、动态工具或任意输出块转换。

[原生协议测试](../../../tests/native-protocol-agents.test.mjs) 验证标准 Chat 的工具轨迹、跨 Run/重启恢复、分支隔离和范围变更拒绝；[工具循环测试](../../../tests/tool-loop.test.mjs) 验证工具批次与实际退出；[Models 协议测试](../../../packages/models/tests/protocols.test.mjs) 和[原生边界测试](../../../packages/models/tests/native-boundaries.test.mjs) 验证传输与原生结果边界。统一执行 `npm run check`。
