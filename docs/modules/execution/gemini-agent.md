# Gemini Interactions Agent 绑定组件

[返回执行模块](README.md) · [返回组件文档](../README.md)

该组件将 Gemini 原生 Interactions 驱动代绑定到 `runGemini`。Loop 直接解释 interaction.status 和 steps；[Gemini 驱动](../models/gemini-interactions.md) 负责私有 thought/签名、传输、流解析及恢复，不使用 Chat 兼容层。

## 实现与装配

- 源码：[绑定工厂与请求编码](../../../src/protocol-agents/registry.ts)、[Gemini Loop](../../../src/protocol-agents/gemini.ts)、[共享交换管道](../../../src/protocol-agents/shared.ts)。
- 工厂实例：`createProtocolAgentBindingComponent('gemini-interactions')`。
- 组件名：`harness-protocol-agent-gemini-interactions`；配置类型：`void`；无额外公开服务或配置。
- 注入 `harness.protocol-agents` 与 `models.protocols`；apply 获取 Gemini 驱动代租约并注册。runGemini 是循环函数，不另注册 Nya 服务。

## 输入与主要接口

[注册表](protocol-agent-registry.md) prepare 接收 initialization、当前 input 和可选 history。首次请求把 system/developer Prompt 用两个换行合成 `system_instruction`；context/user Prompt 与当前输入编为 `input` 的 user_input/text 块。工具声明使用 `{ type: 'function', name, description?, parameters }`。恢复时仅编码新增 input。

`runGemini(runner: ExchangeRunner, initial: NativeObject)` 返回 ProtocolConclusion。runner.call 提供原生 NativeReply，runner.tools 经 Runtime 串行执行本地工具。generation_config 等执行参数由 Models 保存并快照固定，Loop 不猜测 reasoning 模式或预算。

## 原生循环

1. status 为 incomplete 或 budget_exceeded 时归为 incomplete-response；只有 completed 或 requires_action 继续解析，其他状态归为 provider-failure。
2. 遍历 steps。function_call 读取非空 id、name 和对象 arguments；model_output 的 content 只接受 text；thought 允许保留。其他 step 或非文本输出块归为 unsupported-request。
3. 无函数调用时，requires_action 是 invalid-response；completed 则拼接当前回复文本并引用其 response 记录。
4. 有函数调用时先校验完整批次，再串行运行工具；下一轮只发 function_result，包含 call_id、name 和 text result，text 为实际工具结果 JSON。

Loop 保留原生调用对应关系，不在共享 Runtime 中添加 Gemini 专属停止分支。新请求和工具结果保持增量，完整原生历史由同一 execution 持有和恢复。

## 数据归属、取消与清理

绑定只拥有长期驱动租约与注册句柄；program 拥有自己的同代租约和 execution。thought、签名、步骤和 ID 被原样保留到受信原生记录；浏览器展示通过白名单投影，仅显示允许的摘要和内容。驱动使用 x-goog-api-key 与 store:false，不依赖服务端会话；Key 与认证头不进入历史。

Effect 先等待本注册代 unregister，撤销准入和活跃 program 的信号，等待资源实际退出和 Session 结算后的 release，再释放长期驱动租约。用户取消、驱动撤销或工具清理故障统一由 [RunRuntime](run-runtime.md) 结算；已经发生的工具事实保留，失败和取消没有可恢复成功节点。

## 兼容限制与验证

只支持项目当前的原生 Interactions 文本和已知工具契约；有效图片能力为 false。恢复需要 Loop 1.0.0、记录格式 1、有效 checkpoint 和 Models 执行语义兼容；不能使用 previous_interaction_id 代替本地历史，也不能跨协议恢复。

[原生协议测试](../../../tests/native-protocol-agents.test.mjs) 覆盖原生工具、thought 签名、跨 Run/重启恢复、独立分支和截断；[Gemini 驱动测试](../../../packages/models/tests/gemini-interactions.test.mjs) 覆盖 steps 顺序、碎片流、预算状态、签名、实际退出和组件注销；[投影测试](../../../tests/native-projection.test.mjs) 覆盖多内容块和 thought 摘要。统一执行 `npm run check`。
