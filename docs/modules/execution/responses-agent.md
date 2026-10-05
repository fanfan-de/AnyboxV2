# Responses Agent 绑定组件

[返回执行模块](README.md) · [返回组件文档](../README.md)

该组件把 Models 的 Responses 驱动注册代绑定到本项目 `runResponses` 循环。循环直接解释 Responses 的状态、output items 和函数调用；网络、流解析与原生续接由 [Responses 驱动](../models/responses.md) 管理。

## 实现与装配

- 源码：[绑定工厂与首次请求编码](../../../src/applications/harness/core/protocol-agents/registry.ts)、[Responses Loop](../../../src/applications/harness/core/protocol-agents/responses.ts)、[共享交换管道](../../../src/applications/harness/core/protocol-agents/shared.ts)。
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
4. 有函数调用时先验证整个批次，再串行执行本地工具。下一轮发送新增 `{ type: 'function_call_output', call_id, output }`，output 是工具结果 JSON 字符串；图片结果在这些文本回填之后附加 user/input_image 消息。完整历史由同一 execution 衔接，循环不复制历史数组。

Responses 服务端 web_search 与会话选择的本地工具 分开：前者的声明、能力和结果属于原生驱动，不调用本地工具服务。搜索默认关闭，需在模型配置显式声明能力和原生参数。

## 原生展示

展示 v2 为 `message`（包含有序 `output_text` / `refusal` 子块）、`reasoning`、`function_call` 和 `web_search_call` 分别提供带协议前缀的类型、白名单投影和 Web 组件。消息保留原生 `phase`，exchange 保留原生响应状态；这些字段不代替 Run 的成功、取消或失败状态。位置有效的 URL 引用关联原始正文，没有位置的安全引用显示为块级来源。

reasoning 显示为“推理摘要”，默认折叠；实时更新、最终替换和已提交历史使用相同展示身份，当前面板中的手动展开选择持续保留。函数请求只表达模型请求，本地工具的实际执行状态与结果通过持久工具事件关联，服务端搜索由独立原生组件展示。签名与加密 continuation 不进入浏览器。

## 数据、取消与清理

绑定保存长期驱动代租约和注册句柄；每个 program 另获同代租约与独立 execution。reasoning、phase、加密 continuation 和函数续接项留在 execution 与 Session 受信记录中；Models 使用 `store: false`，不依赖服务端会话。浏览器只接收安全投影，Key/认证头不进入记录。

Effect 清理先等待 registration.unregister()，停止本绑定代的新 program、撤销其信号并等待已有 program 释放，再归还长期驱动租约。准备失败也必须关闭已创建 execution。Runtime 即使在工具阶段也会响应 program.signal；取消、失败和清理故障不得创建成功节点。实际退出与结算顺序详见 [RunRuntime](run-runtime.md)。

## 兼容限制与验证

Session 固定 responses 协议；恢复接受 Loop 1.0.0/1.1.0/1.2.0、记录格式 1/2、匹配 checkpoint，并由 Models 验证连接、历史作用域和参数兼容。不能把 Chat 或旧 dialogue-v1 历史转换为 Responses；显式声明图片能力的配置支持用户图片输入，未知多模态输出明确拒绝。

[原生协议测试](../../../tests/native-protocol-agents.test.mjs) 验证工具续轮、加密续接跨 Run/重启保存、分支隔离、搜索引用、拒绝和截断；[Models 协议测试](../../../packages/models/tests/protocols.test.mjs) 与[原生边界测试](../../../packages/models/tests/native-boundaries.test.mjs) 验证驱动传输和原生边界；[投影测试](../../../tests/native-projection.test.mjs) 验证安全且有界的显示。统一执行 `npm run check`。

## 工具库初始化与图片

当前绑定使用 Loop 1.2.0。NativeInitialization v2 / tool-library-v1 从 Session 不可变工具快照生成声明，来源前缀不限制模型协议；旧 v1 / known-tools-v1 与旧 Loop 初始化原样兼容。调用批次仅允许实际声明的工具，并在启动任何工具前完成来源参数校验。

图片工具的不可变字节引用先与实际观察同事务保留，program 私有 resolver 在提交后接纳；下一次增量 exchange 为对应用户图片块传入匹配 resourceRefs。驱动 2.1.0、原生记录 v2 和既有图片 codec 不升级，历史没有 base64。文本模型收到结构化不支持结果。正常模型结束也由 Runtime 关闭 Run 进程 scope、保存最终退出的通用清理观察后再结算；本 Loop 不管理进程句柄或决定清理顺序。验证见 native-tool-library.test.mjs。
