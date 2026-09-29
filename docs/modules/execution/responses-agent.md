# Responses Agent 绑定组件

[返回执行模块](README.md) · [返回组件文档](../README.md)

该组件把 Models 的 Responses 驱动注册代绑定到本项目 `runResponses` 循环。循环直接解释 Responses 的状态、output items 和函数调用；网络、流解析与原生续接由 [Responses 驱动](../models/responses.md) 管理。

## 实现与装配

- 源码：[绑定工厂与首次请求编码](../../../src/protocol-agents/registry.ts)、[Responses Loop](../../../src/protocol-agents/responses.ts)、[共享交换管道](../../../src/protocol-agents/shared.ts)。
- 工厂实例：`createProtocolAgentBindingComponent('responses')`。
- 组件名：`harness-protocol-agent-responses`；配置类型：`void`；没有额外组件选项和独立公开服务。
- 注入 `harness.protocol-agents` 与 `models.protocols`。apply 从后者获取 `responses` 驱动代租约，再调用前者的 `register('responses', lease)`。
- Loop 是函数，不是单独组件；受信调用入口为[注册表](protocol-agent-registry.md)的 `prepare`，运行入口为 program.execute(host)。

## 输入与主要契约

固定 initialization 提供 Prompt 快照和已知工具定义。当前用户文本由应用一次 task-template 的 text 与其后的文件快照资料组成；首次请求将 Prompt 编为 `{ role, content }`，追加 user 消息至 `input`。有图片时 user.content 为可选 input_text 加有序 input_image 块，image_url 保存内部资源 URI；原字节由驱动在受管 start 后编码，不进入持久输入。本地工具声明使用 `{ type: 'function', name, description?, parameters, strict: false }`。有父历史时只发送本轮 user input，不重复祖先文件资料或初始化工具。

循环签名为 `runResponses(runner: ExchangeRunner, initial: NativeObject): Promise<ProtocolConclusion>`。runner.call 返回实际退出且已提交原生上下文的 NativeReply；runner.tools 经 Runtime 校验并串行运行本地工具。成功 conclusion 包含 output 和本轮 response 记录 ID，不包含 SDK 对象。

## 原生循环

1. 调用 runner.call(intent)。response.status=incomplete 归为 incomplete-response，非 completed 的其他状态归为 provider-failure。
2. 顺序遍历 output。item 带 status 时必须 completed；function_call 读取 call_id/name 并解析 JSON arguments。message 的 content 只接受 output_text；refusal 归为 refused-response。reasoning 和 web_search_call 允许保留，其语义不转成文本执行状态；其他 item/block 被拒绝。
3. 没有函数调用时拼接当前回复的 output_text，返回完成，并要求当前 NativeReply 有 response 记录。
4. 有函数调用时先验证整个批次，再串行执行本地工具。下一轮只发送 `{ type: 'function_call_output', call_id, output }`，output 是工具结果 JSON 字符串。完整历史由同一 execution 衔接，循环不复制历史数组。

Responses 服务端 web_search 与本地 Bash/Apply Patch 分开：前者的声明、能力和结果属于原生驱动，不调用本地工具服务。搜索默认关闭，需在模型配置显式声明能力和原生参数。

## 数据、取消与清理

绑定保存长期驱动代租约和注册句柄；每个 program 另获同代租约与独立 execution。reasoning、phase、加密 continuation 和函数续接项留在 execution 与 Session 受信记录中；Models 使用 `store: false`，不依赖服务端会话。浏览器只接收安全投影，Key/认证头不进入记录。

Effect 清理先等待 registration.unregister()，停止本绑定代的新 program、撤销其信号并等待已有 program 释放，再归还长期驱动租约。准备失败也必须关闭已创建 execution。Runtime 即使在工具阶段也会响应 program.signal；取消、失败和清理故障不得创建成功节点。实际退出与结算顺序详见 [RunRuntime](run-runtime.md)。

## 兼容限制与验证

Session 固定 responses 协议；恢复接受 Loop 1.0.0/1.1.0、记录格式 1/2、匹配 checkpoint，并由 Models 验证连接、历史作用域和参数兼容。不能把 Chat 或旧 dialogue-v1 历史转换为 Responses；显式声明图片能力的配置支持用户图片输入，未知多模态输出明确拒绝。

[原生协议测试](../../../tests/native-protocol-agents.test.mjs) 验证工具续轮、加密续接跨 Run/重启保存、分支隔离、搜索引用、拒绝和截断；[Models 协议测试](../../../packages/models/tests/protocols.test.mjs) 与[原生边界测试](../../../packages/models/tests/native-boundaries.test.mjs) 验证驱动传输和原生边界；[投影测试](../../../tests/native-projection.test.mjs) 验证安全且有界的显示。统一执行 `npm run check`。
