# 协议 Agent 注册表组件

[返回执行模块](README.md) · [返回组件文档](../README.md)

注册表把一个 Models 原生驱动注册代与对应协议 Loop 固定配对，按 Run 准备独立 `PreparedRunProgram`。它持有准备和 Run 的租约，不另建一份原生执行上下文，也不替代 Models 的协议注册服务。

## 实现与装配

- 源码：[注册与准备](../../../src/protocol-agents/registry.ts)、[公共契约](../../../src/run/program.ts)、[共享交换管道](../../../src/protocol-agents/shared.ts)、[展示投影](../../../src/protocol-agents/projection.ts)。
- 工厂：`createProtocolAgentsComponent()`；组件名：`harness-protocol-agents`；配置类型：`void`。
- 注入 `models` 和 `models.protocols`；提供 `harness.protocol-agents`，其运行接口为 `ProtocolAgentPort`，受信绑定接口为 `ProtocolAgentRegistry`。

## 接口与固定版本

| 接口 | 行为 |
| --- | --- |
| `protocolForModel(modelId)` | 从 Models 执行配置的原生参数协议取 ID；模型不存在时报 model-unavailable |
| `register(protocolId, driverLease)` | 注册受支持的驱动/Loop 配对，返回本绑定代 `generationId` 和异步 `unregister()` |
| `prepare(input)` | 获取同代驱动租约，打开原生 execution，返回只能执行一次的 program |

支持的协议为 `responses`、`anthropic-messages`、`chat-completions`、`gemini-interactions`、`deepseek-chat-completions`。DeepSeek 使用 `runChat`；其他分别使用自己的循环函数。注册表不是任意脚本或 SDK 的动态加载器。

`PrepareRunInput` 包含 runId、sessionId、modelId、signal、initialization、input 和可选 history。initialization 固定 `schemaVersion: 1`、`known-tools-v1`、Prompt 快照与工具定义；只接受当前完整 Bash/Apply Patch 定义且不允许重名。input 保存 schemaVersion、raw、text、template。

`ProtocolBindingSnapshot` 保存 protocolId、由绑定代和驱动代组成的 generationId、实际 driverVersion、`loopVersion: '1.0.0'`、`recordFormatVersion: 1` 和 `viewSchemaVersion: 1`。这些值是历史兼容判断依据。

## 准备与执行

prepare 先验证历史的协议、Loop 版本、记录格式和工具契约；checkpoint 必须是对象，其 protocolId、recordFormatVersion 与 modelSnapshot 必须与历史一致。随后获取 Models 协议租约并核对它仍等于绑定保存的驱动代，防止准备中途切到新驱动。

每个 program 合并调用方、绑定代、owner 与驱动的取消信号。历史被转换为 `NativeRestoreState` 交给 `models.openNative`；Models 负责连接、账户作用域和执行参数的恢复兼容检查。若固定工具不为空而实际 execution 不具备工具能力，则拒绝准备。

首次执行按协议编码固定 Prompt、当前输入与工具声明；有父历史时只编码新增输入，工具和原生上下文由恢复状态提供。program 的 `execute(host)` 最多调用一次，通过 `createExchangeRunner` 运行协议 Loop。共享管道只负责准备交换、把请求和结果交给 host.perform、串行工具及安全展示，不决定停止语义。

program 的 `close()` 缓存关闭 Promise，等待 execution 退出，返回原生记录、可序列化 checkpoint 和 cleanup 状态；`release()` 幂等释放 Run owner 及驱动租约。关闭和释放是两个步骤：资源退出与持久结算完成后才能 release。

## 绑定代撤销与失败

同协议再次 register 会停止旧代准入、撤销旧代信号，把旧代保留在 retired 集合等待其 owner 释放；新 prepare 使用新代。`unregister` 只移除它自己仍占有的当前条目，等待该代全部 owner 的 done。其他协议条目仍可服务。

组件 Effect 关闭所有当前和已退役条目的准入，取消并等待租约归还。每个 [协议绑定组件](README.md) 在清理时先等待 registration.unregister，再释放其长期驱动租约。即使 Run 正处于本地工具阶段，program.signal 也会立即通知 Runtime 取消。

准备失败时关闭已经创建的 execution 并归还 owner；Loop 错误映射为项目自有失败分类，取消期间的错误交给 Runtime 处理。注册表不保存 Key 或认证头。原生签名和续接数据只进入 Session 受信原生记录；临时/浏览器视图通过白名单投影生成。

## 验证与限制

[原生协议测试](../../../tests/native-protocol-agents.test.mjs) 对五协议验证历史恢复、重启和独立分支，并拒绝错误 checkpoint；[原生投影测试](../../../tests/native-projection.test.mjs) 验证有界展示不修改恢复记录；[Harness 测试](../../../tests/harness.test.mjs) 验证依赖撤销和实际退出等待。Models 的[运行期测试](../../../packages/models/tests/runtime.test.mjs) 与[生命周期测试](../../../packages/models/tests/lifecycle-review.test.mjs) 验证驱动代、凭据初始化和注销等待。

旧文本统一执行路径和 `dialogue-v1` 不通过这里迁入执行。不支持跨协议、任意记录格式或任意参数转换。统一执行 `npm run check`。
