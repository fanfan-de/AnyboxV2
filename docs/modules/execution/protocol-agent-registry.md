# 协议 Agent 注册表组件

[返回执行模块](README.md) · [返回组件文档](../README.md)

注册表把一个 Models 原生驱动注册代与对应协议 Loop 固定配对，按 Run 准备独立 `PreparedRunProgram`。它持有准备和 Run 的租约，不另建一份原生执行上下文，也不替代 Models 的协议注册服务。

## 实现与装配

- 源码：[注册与准备](../../../src/applications/harness/core/protocol-agents/registry.ts)、[公共契约](../../../src/applications/harness/core/run/program.ts)、[共享交换管道](../../../src/applications/harness/core/protocol-agents/shared.ts)、[展示投影](../../../src/applications/harness/core/protocol-agents/projection.ts)。
- 工厂：`createProtocolAgentsComponent()`；组件名：`harness-protocol-agents`；配置类型：`void`。
- 注入 `models`、`models.protocols` 和 `harness.image-assets`；提供 `harness.protocol-agents`，其运行接口为 `ProtocolAgentPort`，受信绑定接口为 `ProtocolAgentRegistry`。

## 接口与固定版本

| 接口 | 行为 |
| --- | --- |
| `protocolForModel(modelId)` | 从 Models 执行配置的原生参数协议取 ID；模型不存在时报 model-unavailable |
| `register(protocolId, driverLease)` | 注册受支持的驱动/Loop 配对，返回本绑定代 `generationId` 和异步 `unregister()` |
| `prepare(input)` | 获取同代驱动租约，打开原生 execution，返回只能执行一次的 program |

支持的协议为 `responses`、`anthropic-messages`、`chat-completions`、`gemini-interactions`。DeepSeek 使用标准 `chat-completions` 与 `runChat`，没有单独绑定或旧协议别名；旧协议历史可查看但不能准备或续接 Run。注册表不是任意脚本或 SDK 的动态加载器。

`PrepareRunInput` 包含 runId、sessionId、modelId、signal、initialization、input，以及可选 history 和 fileContents。新 initialization 使用 `schemaVersion: 2`、`tool-library-v1`、Prompt 快照、实际工具定义与 Session 不可变 toolSelection；声明必须属于已选择的稳定 ID/版本，且完整定义精确匹配。旧 schemaVersion 1/known-tools-v1 仅接纳原 Bash/Apply Patch 定义，原 JSON 不改写；均不允许重名。新 input v3 保存 raw、text、template、有序 images 和 files 引用；旧 v1 无附件，v2 按 files=[] 读取。fileContents 是受管读取的本轮文件正文，编码前核对其引用与 input.files 一致，仅忽略会变化的 expiresAt。

`ProtocolBindingSnapshot` 保存 protocolId、由绑定代和驱动代组成的 generationId、实际 driverVersion、Loop 版本（四种协议均为 1.2.0）、execution 实际记录格式（四种协议均为 2）和新 Run 的 `viewSchemaVersion: 2`。驱动、Loop 与记录格式用于恢复兼容判断；展示版本不是原生恢复的新门槛。旧 binding 的展示版本保留原值，旧原生记录在查询时重新投影为展示 v2，不改写历史 JSON。

## 准备与执行

prepare 先验证历史的协议、Loop 版本、记录格式和工具契约；checkpoint 必须是对象，其 protocolId、recordFormatVersion 与 modelSnapshot 必须与历史一致。随后获取 Models 协议租约并核对它仍等于绑定保存的驱动代，防止准备中途切到新驱动。

每个 program 合并调用方、绑定代、owner 与驱动的取消信号。历史被转换为 `NativeRestoreState` 交给 `models.openNative`；Models 负责连接、账户作用域和执行参数的恢复兼容检查。若固定工具不为空而实际 execution 不具备工具能力，则拒绝准备。

首次执行按协议编码固定 Prompt、当前输入与工具声明；有父历史时只编码新增输入，工具和原生上下文由恢复状态提供。program 的 `execute(host)` 最多调用一次，通过 `createExchangeRunner` 运行协议 Loop。共享管道只负责准备交换、把请求和结果交给 host.perform、串行工具及安全展示，不决定停止语义。

共享交换管道在 prepare 后立即发布白名单输入投影，响应增量及最终替换保留同一 exchange 的 inputs。持久记录投影按 exchange 合并 request/response，只有请求的失败也可展示。`projectNativeRequest` 只读取各协议明确的文本位置；确实包含初始化内容的首请求以接受时 Prompt 快照的 kind 区分 system/context，继承的 Prompt 不附加到后代的增量请求。工具返还、assistant 续轮、图片编码及未知内容块不成为用户文本；本轮 task-template 已执行一次，投影直接读取实际编码文本。没有快照的旧样本按明确原生 role 保守显示。

inputs 与响应共用既有 48KiB 展示预算和唯一截断提示，裁剪后移除无法定位到正文的引用。展示信封仍为 1，`viewSchemaVersion` 为 2；四个协议各自定义带协议前缀的内容类型、纯投影和流式归约，公共层只固定分派、管理 exchange 与预算，不把语义不同的内容归并为 text/reasoning/tool/status。实时与持久投影使用相同身份和结构，保留父子顺序、消息阶段和原生停止状态；诊断仅显示已保存的白名单部分输出或状态。原生完整事实及私有 continuation 仍归 execution/Session，展示不作为恢复依据，不升级驱动、Loop 或原生记录版本。

program 的 `close()` 缓存关闭 Promise，等待 execution 退出，返回原生记录、可序列化 checkpoint 和 cleanup 状态；`release()` 幂等释放 Run owner 及驱动租约。关闭和释放是两个步骤：资源退出与持久结算完成后才能 release。

## 绑定代撤销与失败

同协议再次 register 会停止旧代准入、撤销旧代信号，把旧代保留在 retired 集合等待其 owner 释放；新 prepare 使用新代。`unregister` 只移除它自己仍占有的当前条目，等待该代全部 owner 的 done。其他协议条目仍可服务。

组件 Effect 关闭所有当前和已退役条目的准入，取消并等待租约归还。每个 [协议绑定组件](README.md) 在清理时先等待 registration.unregister，再释放其长期驱动租约。即使 Run 正处于本地工具阶段，program.signal 也会立即通知 Runtime 取消。

准备失败时关闭已经创建的 execution 并归还 owner；Loop 错误映射为项目自有失败分类，取消期间的错误交给 Runtime 处理。注册表不保存 Key 或认证头。原生签名和续接数据只进入 Session 受信原生记录；临时/浏览器视图通过白名单投影生成。

## 验证与限制

[原生协议测试](../../../tests/native-protocol-agents.test.mjs) 对四协议验证历史恢复、重启、独立分支、无流式时的即时输入及实时/持久输入一致，拒绝错误 checkpoint；[原生投影测试](../../../tests/native-projection.test.mjs) 验证各原生类型、阶段、停止状态、引用、Prompt 分类、增量与继承边界、request-only 失败、旧原生记录 v1/v2、秘密排除及有界展示不修改恢复记录；[展示解码测试](../../../tests/protocol-view-client.test.mjs) 验证展示 v2 的协议白名单及明确拒绝旧/未知展示版本；[harness server 核心测试](../../../tests/harness-server-core.test.mjs) 验证依赖撤销和实际退出等待。Models 的[运行期测试](../../../packages/models/tests/runtime.test.mjs) 与[生命周期测试](../../../packages/models/tests/lifecycle-review.test.mjs) 验证驱动代、凭据初始化和注销等待。

旧文本统一执行路径和 `dialogue-v1` 不通过这里迁入执行。不支持跨协议、任意记录格式或任意参数转换。统一执行 `npm run check`。

## 图片资源与版本兼容

各协议把模板文本与图片资源 URI 编码为同一个用户 content 数组（Gemini 使用 user_input）；每个 exchange 携带其增量 intent 中图片的匹配 resourceRefs，工具续轮不重复声明无关祖先资源。注册表始终提供 execution 私有读取端口，初始许可仅包含本轮与所选成功父路径资源；工具图片必须先随 Session 工具观察同事务保留，再由 program 接纳引用。作用域固定为当前 Session。Models 在受管 start 后读取字节并生成实际请求。Session 不解释协议 URI，Runtime 不解释图片块。

四种协议均接受 Loop 1.0.0/1.1.0/1.2.0 与记录 v1/v2，checkpoint 与历史 binding/snapshot 必须自洽；驱动版本兼容由 Models 明确检查。旧链可包含 v1/v2 的不同 Run，本 Run 内仍固定一种记录格式。

## 项目文件资料

PrepareRunInput.fileContents 是 Run 从 Session 读取的本轮文件内容。注册表将相对路径、实际行范围和正文按 project-file-context v1 JSON 附加在本轮用户文本之后、图片之前。文件正文不参与 task-template，不成为系统提示词；NativeRunInput v3 只保存引用，原生请求记录保存实际资料文本。父链恢复直接复用原生记录，不读取源文件、不重复附加祖先文件。四种协议复用现有文本编码和 Models 图片 resourceRefs；工具库使新初始化升级为 v2、Loop 为 1.2.0，驱动 2.1.0 与原生记录 v2 不变。
