# Gemini Interactions Agent 绑定组件

[返回执行模块](README.md) · [返回组件文档](../README.md)

该组件将 Gemini 原生 Interactions 驱动代绑定到 `runGemini`。Loop 直接解释 interaction.status 和 steps；[Gemini 驱动](../models/gemini-interactions.md) 负责私有 thought/签名、传输、流解析及恢复，不使用 Chat 兼容层。

## 实现与装配

- 源码：[绑定工厂与请求编码](../../../src/applications/harness/core/protocol-agents/registry.ts)、[Gemini Loop](../../../src/applications/harness/core/protocol-agents/gemini.ts)、[共享交换管道](../../../src/applications/harness/core/protocol-agents/shared.ts)。
- 工厂实例：`createProtocolAgentBindingComponent('gemini-interactions')`。
- 组件名：`harness-protocol-agent-gemini-interactions`；配置类型：`void`；无额外公开服务或配置。
- 注入 `harness.protocol-agents` 与 `models.protocols`；apply 获取 Gemini 驱动代租约并注册。runGemini 是循环函数，不另注册 Nya 服务。

## 输入与主要接口

[注册表](protocol-agent-registry.md) prepare 接收 initialization、当前 input、文件正文和可选 history。首次请求把 system/developer Prompt 用两个换行合成 `system_instruction`；context/user Prompt 编为 `input` 的 user_input/text 块。本轮 user_input.content 先放模板文本及文件快照资料，再放有序 image 块，uri 保存内部资源引用；驱动在受管 start 后生成 data/mime_type。纯图片不添加空 text 块。工具声明使用 `{ type: 'function', name, description?, parameters }`。恢复时仅编码本轮 input，不重复祖先附件资料。

`runGemini(runner: ExchangeRunner, initial: NativeObject)` 返回 ProtocolConclusion。runner.call 提供原生 NativeReply，runner.tools 经 Runtime 串行执行本地工具。generation_config 等执行参数由 Models 保存并快照固定，Loop 不猜测 reasoning 模式或预算。

## 原生循环

1. status 为 incomplete 或 budget_exceeded 时归为 incomplete-response；只有 completed 或 requires_action 继续解析，其他状态归为 provider-failure。
2. 遍历 steps。function_call 读取非空 id、name 和对象 arguments；model_output 的 content 为可选字段，省略时按空内容处理，显式 null 或非数组仍是 invalid-response；数组内只接受 text。thought 允许保留。其他 step 或非文本输出块归为 unsupported-request。
3. 无函数调用时，requires_action 是 invalid-response；completed 则拼接当前回复文本并引用其 response 记录。
4. 有函数调用时先校验完整批次，再串行运行工具；下一轮发新增 function_result，包含 call_id、name 和 text result，text 为实际工具结果 JSON；随后追加工具图片的 user_input/image 块。

Loop 保留原生调用对应关系，不在共享 Runtime 中添加 Gemini 专属停止分支。新请求和工具结果保持增量，完整原生历史由同一 execution 持有和恢复。

## 原生展示

展示 v2 分别定义 model_output（含有序 text 子块）、thought 和 function_call 的 Gemini 专属类型、白名单投影及 Web 组件，保留 step 与内容的父子顺序。exchange 保留原生 interaction.status。已知 annotations 的安全引用关联原始正文，有效位置显示编号，无位置时显示块级来源。

thought 显示为“推理摘要”，默认折叠；当前面板的手动展开选择在流式更新和终态替换中保留。function_call 只表示原生工具请求，本地工具状态及结果通过持久事件关联。thought 签名和其他私有 continuation 不进入展示；旧原生记录读取时重新投影为展示 v2，不改写历史或改变恢复约束。

## 数据归属、取消与清理

绑定只拥有长期驱动租约与注册句柄；program 拥有自己的同代租约和 execution。thought、签名、步骤和 ID 被原样保留到受信原生记录；浏览器展示通过白名单投影，仅显示允许的摘要和内容。驱动使用 x-goog-api-key 与 store:false，不依赖服务端会话；Key 与认证头不进入历史。

Effect 先等待本注册代 unregister，撤销准入和活跃 program 的信号，等待资源实际退出和 Session 结算后的 release，再释放长期驱动租约。用户取消、驱动撤销或工具清理故障统一由 [RunRuntime](run-runtime.md) 结算；已经发生的工具事实保留，失败和取消没有可恢复成功节点。

## 兼容限制与验证

支持项目当前的原生 Interactions 文本、显式声明的用户图片输入和已知工具契约。恢复接受 Loop 1.0.0/1.1.0/1.2.0/1.3.0、记录格式 1/2、有效 checkpoint 和 Models 执行语义兼容；不能使用 previous_interaction_id 代替本地历史，也不能跨协议恢复。

[原生协议测试](../../../tests/native-protocol-agents.test.mjs) 覆盖原生工具、thought 签名、跨 Run/重启恢复、独立分支和截断；[Gemini Loop 测试](../../../tests/gemini-agent.test.mjs) 覆盖可选输出内容、空回复、工具续轮及坏内容在工具执行前拒绝；[Gemini 驱动测试](../../../packages/models/tests/gemini-interactions.test.mjs) 覆盖 steps 顺序、碎片流、预算状态、签名、实际退出和组件注销；[投影测试](../../../tests/native-projection.test.mjs) 覆盖多内容块和 thought 摘要。统一执行 `npm run check`。

## 工具库初始化与图片

当前绑定使用 Loop 1.3.0。活跃 Run 恢复游标由本协议 Loop 解释；恢复首轮回放最后耐久响应，工具结果从原 operation 领取，不重新调用原模型请求。NativeInitialization v2 / tool-library-v1 从 Session 不可变工具快照生成声明，来源前缀不限制模型协议；旧 v1 / known-tools-v1 与旧 Loop 初始化原样兼容。调用批次仅允许实际声明的工具，并在启动任何工具前完成来源参数校验。

图片工具的不可变字节引用先与实际观察同事务保留，program 私有 resolver 在提交后接纳；下一次增量 exchange 为对应用户图片块传入匹配 resourceRefs。驱动 2.1.0、原生记录 v2 和既有图片 codec 不升级，历史没有 base64。文本模型收到结构化不支持结果。正常模型结束也由 Runtime 关闭 Run 进程 scope、保存最终退出的通用清理观察后再结算；本 Loop 不管理进程句柄或决定清理顺序。验证见 native-tool-library.test.mjs。
