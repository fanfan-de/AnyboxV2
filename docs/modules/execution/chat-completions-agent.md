# Chat Completions Agent 绑定组件

[返回执行模块](README.md) · [返回组件文档](../README.md)

该组件把标准 Chat Completions 驱动代绑定到 `runChat`，用 choices、finish_reason 和原生 tool_calls 决定下一步。传输、流解析、参数和恢复由 [Chat Completions 驱动](../models/chat-completions.md) 负责。

## 实现与装配

- 源码：[绑定工厂和首次编码](../../../src/applications/harness/core/protocol-agents/registry.ts)、[Chat Loop](../../../src/applications/harness/core/protocol-agents/chat.ts)、[共享交换管道](../../../src/applications/harness/core/protocol-agents/shared.ts)。
- 工厂实例：`createProtocolAgentBindingComponent('chat-completions')`。
- 组件名：`harness-protocol-agent-chat-completions`；配置类型：`void`；没有独立公开服务或额外配置。
- 注入 `harness.protocol-agents` 和 `models.protocols`；apply 获取标准 Chat 的固定驱动代租约并注册配对。
- `runChat` 是函数，不是额外组件；DeepSeek 等兼容提供方使用同一个标准 Chat 绑定和驱动代。

## 输入与接口

通过[协议注册表](protocol-agent-registry.md)的 prepare 接收当前 input、固定 initialization、文件正文和可选历史。文本由本次模板输出与其后的文件快照资料组成；无图片时编码为 `messages: [...prompts, { role: 'user', content: text }]`。有图片时 content 为可选 text 块加有序 image_url 块，url 保存内部资源 URI，驱动在受管 start 后转成 data URL。工具声明为 `{ type: 'function', function: { name, description?, parameters } }`。父历史恢复时只提供本轮新增消息，不重复祖先文件资料。

Loop 的签名为 `runChat(runner: ExchangeRunner, initial: NativeObject): Promise<ProtocolConclusion>`；runner.call 执行原生交换，runner.tools 执行应用已知工具，返回 conclusion 给 Runtime。模型参数不是 Loop 选项，由 Models 配置快照固定。

## 原生循环与失败

每次回复必须恰有一个 choice。finish_reason=length 归为 incomplete-response；content_filter 或非空 message.refusal 归为 refused-response。tool_calls 若存在，必须全部为 function，包含非空 ID、名称及可解析为对象的 JSON arguments。

| finish_reason | 行为 |
| --- | --- |
| `tool_calls` | 必须包含调用；验证完整批次，再串行执行工具，下一轮提交新增 role=tool、tool_call_id 与结果 JSON 字符串；工具图片随后附加 role=user/image_url 消息 |
| `stop` | 不得同时含工具调用；content 为 null/缺省时输出空字符串，否则必须是字符串；返回当前回复的记录引用 |
| 其他 | invalid-response；不会猜测成正常完成 |

Loop 不把中间工具请求回复的 content 自动累积进最终答案；最终输出来自正常 stop 的那个回复。全量原生消息历史由独立 execution 保管，每轮 intent 保持增量。

展示 v2 为 content、reasoning_content、refusal 和 tool_calls 分别提供 Chat 协议专属类型、白名单投影和 Web 组件，exchange 保留实际 finish_reason。`message.reasoning_content` 与流式 `delta.reasoning_content` 使用同一展示身份，标题为“推理内容”，默认折叠；字段缺省、为空或不是字符串时不创建内容。当前面板的手动展开选择在流式更新与终态提交中保留。这里只展示上游实际返回的内容，不启用推理或发起额外调用，也不声称展示完整内部思考。

tool_calls 保留工具请求与调用身份；本地工具的实际执行事实从持久工具事件关联，不能以 finish_reason=tool_calls 或请求块推断执行成功。既有原生历史保持原样，读取时重新投影为展示 v2；浏览器不接收其他未知原生字段。

## 所有权、取消和清理

绑定持有一个长期驱动代租约；每个 program 另持独立 execution 和同代租约。program 的绑定快照固定驱动/Loop/记录版本，防止运行期间切换驱动。Session 保存受信原生消息与恢复记录，Runtime 持有在途调用；绑定不保存凭据。

Effect 等待 unregister 撤销本代并加入所有已接受 program 的释放，再释放长期驱动租约。取消会通过 program.signal 传播到 Runtime，工具结果和已经发生的副作用仍被观察；只有 actual exit、program.close 和 Session 成功事务都完成，才生成可继续节点。

## 兼容限制与验证

这里只实现标准 Chat 原生语义；输出上限和 thinking 使用已保存参数，不能按 URL 推断提供方语义。绑定只接受 `chat-completions`，旧 DeepSeek 协议历史保留供查看，不能映射到本绑定或续接执行。恢复使用同协议与兼容参数，新记录格式为 2，双读标准 Chat 的旧文本格式 1；旧 dialogue-v1 不执行。已声明图片能力的配置接受 user 文本/图片块，持久资源引用在受管调用内编码为 data URL，工具结果本身仍为文本，工具图片通过其后新增 user/image_url 消息进入模型。工具能力未声明时不提供本地工具，纯文本仍可执行。没有多 choice 合并、动态工具或任意输出块转换。

[原生协议测试](../../../tests/native-protocol-agents.test.mjs) 验证标准 Chat 的工具轨迹、跨 Run/重启恢复、分支隔离和范围变更拒绝；[原生投影测试](../../../tests/native-projection.test.mjs) 验证最终回复与流式推理文本的白名单展示；[工具循环测试](../../../tests/tool-loop.test.mjs) 验证工具批次与实际退出；[Models 协议测试](../../../packages/models/tests/protocols.test.mjs) 和[原生边界测试](../../../packages/models/tests/native-boundaries.test.mjs) 验证传输与原生结果边界。统一执行 `npm run check`。

## 工具库初始化与图片

当前绑定使用 Loop 1.2.0。NativeInitialization v2 / tool-library-v1 从 Session 不可变工具快照生成声明，来源前缀不限制模型协议；旧 v1 / known-tools-v1 与旧 Loop 初始化原样兼容。调用批次仅允许实际声明的工具，并在启动任何工具前完成来源参数校验。

图片工具的不可变字节引用先与实际观察同事务保留，program 私有 resolver 在提交后接纳；下一次增量 exchange 为对应用户图片块传入匹配 resourceRefs。驱动 2.1.0、原生记录 v2 和既有图片 codec 不升级，历史没有 base64。文本模型收到结构化不支持结果。正常模型结束也由 Runtime 关闭 Run 进程 scope、保存最终退出的通用清理观察后再结算；本 Loop 不管理进程句柄或决定清理顺序。验证见 native-tool-library.test.mjs。
