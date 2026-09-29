# DeepSeek 非推理 Agent 绑定组件

[返回执行模块](README.md) · [返回组件文档](../README.md)

该组件把宿主的 DeepSeek 非推理驱动代绑定到共享 `runChat`。它是独立的协议绑定实例，拥有自己的协议 ID 和取消代；[DeepSeek 驱动适配器](../models/deepseek.md) 负责线上的参数差异，Loop 复用标准 Chat 的原生 choices/tool_calls 流程。

## 实现与装配

- 源码：[绑定工厂及请求编码](../../../src/protocol-agents/registry.ts)、[共享 Chat Loop](../../../src/protocol-agents/chat.ts)、[宿主 DeepSeek 协议适配器](../../../src/web/deepseek-protocol.ts)。
- 工厂实例：`createProtocolAgentBindingComponent('deepseek-chat-completions')`。
- 组件名：`harness-protocol-agent-deepseek-chat-completions`；配置类型：`void`；不单独提供服务或选项。
- 注入 `harness.protocol-agents` 与 `models.protocols`；apply 获取 DeepSeek 对应驱动代租约，再注册同 ID 的配对。
- `models-protocol-deepseek` 是 Models 侧驱动组件，职责及文档与本 Agent 绑定区分；项目没有额外 DeepSeek Loop 组件。

## 输入、参数与接口

Run 通过[协议注册表](protocol-agent-registry.md) prepare 创建 program。首次请求使用 messages 和 function 工具声明，与标准 Chat 相同；若初始化 Prompt 包含 developer 角色，在创建网络交换前拒绝。恢复时仅提供本次新增消息。

Loop 接口为 `runChat(runner, initial)`，通过 runner.call 与 runner.tools 返回 ProtocolConclusion。DeepSeek 原生策略明确固定 protocolId、`maxTokensField: 'max_tokens'`、`disableThinking: true`、`allowDeveloper: false`。这些策略由驱动适配器配置，绑定和 Runtime 不依据 hostname 推断。模型执行参数必须是本协议的已保存原生参数；不接受需要 reasoning 的配置。

## 工具与停止行为

每次结果必须恰有一个 choice。length 视为不完整，content_filter 或 refusal 视为拒绝。tool_calls 必须为 function，具有非空唯一 ID、名称以及 JSON 对象 arguments；整个批次通过已知 Bash/Apply Patch 信封校验后才串行执行。

finish_reason=tool_calls 必须有调用，随后只发送 `{ role: 'tool', tool_call_id, content }`，content 为工具结果 JSON。finish_reason=stop 不允许遗留 tool_calls，返回当前 message.content 文本或空字符串及其 response 记录引用。其他 finish_reason 拒绝为 invalid-response。原生历史由 execution 保管，不在 Loop 拼接完整数组。

## 资源、取消与清理

本绑定长期持有 DeepSeek 驱动代租约；每个 program 再获得同代租约和独立 execution。Session 保存原生请求/响应增量与恢复链，Runtime 保存活跃句柄，绑定不存 Key。服务端参数字段和原生工具 ID 不能退化为不透明普通文本再恢复。

Effect 先 unregister 本代，停止新准备、撤销其所有 program，再等待资源退出和持久结算后的 release，最终释放长期租约。注销 DeepSeek 的绑定不会直接注销标准 Chat 的另一个绑定；两者共用函数代码不意味着共享 execution。用户取消、依赖撤销和清理失败遵守共享 Runtime 的退出和失败优先级。

## 兼容与验证

Session 一旦固定 deepseek-chat-completions 就不能改成标准 chat-completions 继续历史。恢复接受 Loop 1.0.0/1.1.0、记录格式 1/2、有效 checkpoint，以及 Models 校验通过的连接/历史作用域/参数；旧 dialogue-v1 只读。当前范围为非推理文本、显式声明的图片输入和本地工具；图片沿共享 Chat 资源引用及请求编码路径执行。

[DeepSeek 驱动测试](../../../tests/deepseek-protocol.test.mjs) 验证 max_tokens/非推理映射、碎片流和工具解析、拒绝 reasoning/developer；[五协议原生测试](../../../tests/native-protocol-agents.test.mjs) 验证该独立协议的工具历史、跨 Run/重启恢复和分支隔离；[工具循环测试](../../../tests/tool-loop.test.mjs) 验证共享执行的取消和退出屏障。统一执行 `npm run check`。
