# Anthropic Messages Agent 绑定组件

[返回执行模块](README.md) · [返回组件文档](../README.md)

该组件把 Anthropic Messages 驱动代与 `runAnthropic` 配对，区分客户端工具、服务端 pause_turn 和最终回答。原生 thinking/签名保存、鉴权、参数及流解析归 [Messages 驱动](../models/anthropic-messages.md)。

## 实现与装配

- 源码：[绑定工厂与初始化编码](../../../src/applications/harness/core/protocol-agents/registry.ts)、[Anthropic Loop](../../../src/applications/harness/core/protocol-agents/anthropic.ts)、[共享交换管道](../../../src/applications/harness/core/protocol-agents/shared.ts)。
- 工厂实例：`createProtocolAgentBindingComponent('anthropic-messages')`。
- 组件名：`harness-protocol-agent-anthropic-messages`；配置类型：`void`；不提供额外服务。
- 注入 `harness.protocol-agents` 和 `models.protocols`；初始化获取对应驱动代租约并向注册表注册。runAnthropic 是函数，不是独立组件。

## 输入和主要接口

Run 通过[注册表](protocol-agent-registry.md) prepare 建立 program。首次编码把 system/developer Prompt 合成顶层 system 文本块，将 context/user Prompt 与当前输入编码为 messages 中的 user content。当前输入先放模板文本及其后的文件快照资料，再放有序 image 块；其 source 为内部资源 URI，驱动在受管 start 后物化成 base64 source。纯图片输入不添加空 text 块。工具声明使用 name、description?、input_schema。父历史恢复时仅加入本轮 user 消息，不重新读取或附加祖先文件，固定初始化从原生恢复状态取得。

`runAnthropic(runner, initial)` 使用 `ExchangeRunner.call` 和 `.tools`，最终返回带 response 记录 ID 的 ProtocolConclusion。`max_tokens`、thinking、output_config 和原生搜索工具来自已保存模型参数，不由 Loop 临时补默认值。`max_tokens` 在配置中必填，新基础配置初始化默认值为 4096。

## Messages 状态转换

循环先检查 stop_reason 与 stop_details：refusal 归为 refused-response；max_tokens 和 model_context_window_exceeded 归为 incomplete-response。content 按原顺序读取：tool_use 产生本地调用，text 提供答案文本；thinking、redacted_thinking、server_tool_use 和 web_search_tool_result 允许经过，其他类型明确拒绝。

| stop_reason | 下一步 |
| --- | --- |
| `tool_use` | 必须有本地调用；整批校验后串行执行。先以一条 user message 的 tool_result blocks 返回并保留 tool_use_id，再追加工具图片的 user/image 消息 |
| `pause_turn` | 不得同时含本地调用；发送 `messages: []` 自动续轮。execution 已保存完整 paused assistant blocks，由它生成真实续接请求 |
| `end_turn` / `stop_sequence` | 不得含未处理工具调用；拼接当前回复 text blocks，返回成功 |
| 其他 | invalid-response |

服务端搜索不会进入 本地工具的操作队列。web_search_20250305 默认关闭，只有能力与原生参数都显式声明时才启用；pause_turn 不制造虚假的本地 tool-started 事件。

## 原生展示

展示 v2 分别定义 text、thinking、redacted_thinking、tool_use、server_tool_use 和 web_search_tool_result 的协议专属类型、白名单投影和 Web 组件，保留 content 原有顺序与服务端搜索的对应关系。exchange 显示实际 stop_reason / stop_details，pause_turn 表示协议自动继续，不代替 Run 结算状态。已知安全引用保留正文位置或作为块级来源呈现。

thinking 标题为“思考内容”，默认折叠；redacted_thinking 只显示隐藏占位，不暴露其 data。当前面板中手动展开选择在流式更新和终态提交中保留。tool_use 只表示请求；本地工具事实从持久事件关联，server_tool_use / web_search_tool_result 不冒充本地执行。思考签名与私有搜索数据仅保存在受信原生记录。

## 原生记录与生命周期

ordered thinking、签名、redacted 块、服务端搜索块及引用元数据留在独立 execution 和 Session 受信记录中。展示通过白名单投影移除签名和私有搜索数据。Key、认证头不进入记录；驱动使用 x-api-key、固定版本头和 workspace-scoped Key，绑定不处理凭据。

绑定持有长期驱动代租约，每个 program 另获同代租约。Effect 先 unregister 停止新准备并撤销本代，再等待 program 关闭、结算和 release，最后释放长期租约。驱动撤销、用户取消或工具取消均由 program.signal/Runtime 管理；暂停后也必须遵守实际退出屏障。清理或持久化失败不生成成功节点。

## 兼容与验证

恢复要求同协议、记录格式 1/2、Loop 1.0.0/1.1.0/1.2.0/1.3.0 和兼容的模型执行语义；不能把有签名的历史转成普通文本继续执行，也不支持旧 dialogue-v1。显式声明图片能力的配置支持用户 image 块，不认识的多模态输出块会拒绝。

[原生协议测试](../../../tests/native-protocol-agents.test.mjs) 覆盖 thinking/签名跨 Run 恢复、pause_turn 自动续轮、服务端搜索关联、重启、分支和拒绝/截断；[Messages 驱动测试](../../../packages/models/tests/anthropic-messages.test.mjs) 覆盖原生块顺序、流式签名、参数、清理和注销；[投影测试](../../../tests/native-projection.test.mjs) 覆盖安全显示与工具块身份。统一执行 `npm run check`。

## 工具库初始化与图片

当前绑定使用 Loop 1.3.0。活跃 Run 恢复游标由本协议 Loop 解释；恢复首轮回放最后耐久响应，工具结果从原 operation 领取，不重新调用原模型请求。NativeInitialization v2 / tool-library-v1 从 Session 不可变工具快照生成声明，来源前缀不限制模型协议；旧 v1 / known-tools-v1 与旧 Loop 初始化原样兼容。调用批次仅允许实际声明的工具，并在启动任何工具前完成来源参数校验。

图片工具的不可变字节引用先与实际观察同事务保留，program 私有 resolver 在提交后接纳；下一次增量 exchange 为对应用户图片块传入匹配 resourceRefs。驱动 2.1.0、原生记录 v2 和既有图片 codec 不升级，历史没有 base64。文本模型收到结构化不支持结果。正常模型结束也由 Runtime 关闭 Run 进程 scope、保存最终退出的通用清理观察后再结算；本 Loop 不管理进程句柄或决定清理顺序。验证见 native-tool-library.test.mjs。
