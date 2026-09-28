# Responses 原生协议

[返回 Models 模块](README.md)

## 定位与装配

源码：[protocols/responses.ts](../../../packages/models/src/protocols/responses.ts)，共用 [shared.ts](../../../packages/models/src/protocols/shared.ts) 与 [transport.ts](../../../packages/models/src/protocols/transport.ts)。`createResponsesProtocolComponent(options?)` 创建组件 `models-protocol-responses`，注入 `models.protocols`，注册 ID `responses`、版本 `2.0.0` 的驱动；不额外提供命名服务。

`createResponsesProtocol(options?)` 返回独立 `NativeProtocol`。唯一工厂选项为可替换 `fetch`。驱动实现参数/连接验证、有效能力、`restore/prepare/exchange/commit` 和发现/检查。它保留 Responses 语义，工具执行与停止决策见 [Responses Agent](../execution/responses-agent.md)。

## 连接与参数

连接使用 API 根 `baseUrl`、`auth: 'none' | 'api-key'` 与正整数 `timeoutMs`；API Key 用 Bearer 头。POST 路径为 `/responses`。连接地址禁止 URL 凭据、query 和 fragment；公共设置层还负责完整连接验证。

参数保存为 `{ protocolId: 'responses', formatVersion: 1, value }`。`value` 仅接受：

| 字段 | 约束 |
| --- | --- |
| `temperature` | 0–2 |
| `max_output_tokens` | 正安全整数 |
| `reasoning.effort` | `none/minimal/low/medium/high/xhigh`，必须在配置声明的 efforts 中 |
| `reasoning.summary` | `auto/concise/detailed`；要求声明支持推理且 effort 不为 `none` |
| `tools` | 可选空数组或唯一 `{ type: 'web_search' }`；要求显式 `webSearch.support: 'supported'` |

可选字段省略即保留服务端默认，无运行时暗补。表单 descriptor 暴露温度、最大输出及推理项，搜索工具仍通过已验证的原生参数保存。参数不能覆盖模型 ID、输入、凭据、流式设置或服务端会话。有效工具/流式能力依赖声明，图片始终关闭；`effort: 'none'` 会使有效推理能力关闭。

## 输入、请求与结果

增量 intent 为 `input` 加可选初始 `instructions`、`tools`。输入接受 system/developer/user 文本或 `function_call_output { call_id, output }`；本地工具采用 `{ type: 'function', name, parameters }`。历史建立后不得变更初始 instructions/tool 声明，也不得追加 system/developer 消息。

`prepare()` 将私有历史与本轮 input 合并，合并本地函数工具和已配置搜索工具，固定 `store: false`、有效 streaming 和 `include: ['reasoning.encrypted_content']`。宿主每轮只交新增输入，完整 HTTP 上下文由驱动在内存重建；不使用服务端 conversation 或 previous-response 链。

JSON 与 SSE 最终都返回完整原生 response。允许原生 `completed/incomplete`；failed/cancelled/error 为失败。验证 assistant message、文本/拒绝块、唯一 `call_id`、函数名与参数字符串；完成的函数参数必须是 JSON 对象。保留未知 JSON 字段、reasoning/encrypted content、phase、搜索动作与引用，不压平为统一文本。

SSE 转发原生事件给受信投影器，以 `response.completed` / `response.incomplete` 的完整 response 为权威；输出增量仅用于展示与失败诊断。终态缺失、状态不匹配及提前 `[DONE]` 为 `invalid-response`。失败终态可携带已收块形成脱敏诊断。

## 恢复、资源与生命周期

`commit()` 将本轮 intent 与完整 response.output 按顺序追加到私有上下文。`restore()` 按请求/响应记录配对重放同一提交规则，校验协议、格式、记录 ID、exchange ID 和完整配对；encrypted reasoning、phase、函数续轮信息得以保留。Session 存储的是增量原生记录，不是每节点重复的历史数组。

transport 独占 fetch、reader、AbortController 和取消监听器，严格 UTF-8，响应总量上限 32 MiB，SSE 缓冲上限 8 MiB，无隐藏网络重试。cancel 先请求 reader 退出再 abort；原始驱动 result 可早于 done，Models 的公共 result 会等两者及上下文提交。超时由 execution/Settings 控制。

组件 `apply` 只注册协议并通过 Effect 注销；卸载同步停止该代准入，取消并等待其 execution、初始化、发现与检查。普通 HTTP 错误脱敏为固定错误；reader 清理失败使 execution 不能成功恢复。原生记录和事件仅给受信宿主，浏览器使用白名单投影。

## 发现、限制与验证

`discover()` 和 `check()` 都使用认证 GET `/models`。发现要求唯一、非空模型 ID，并返回候选，不写设置；检查只验证目录响应结构。这不等价于完成一次文本生成授权验证。

当前仅支持文本与本地函数结果、显式服务端搜索；没有图片、任意内置工具和任意 Responses 参数透传。要增加字段须同步修改验证、表单/能力、恢复要求及行为测试。

[protocols.test.mjs](../../../packages/models/tests/protocols.test.mjs) 覆盖 JSON/SSE 的 reasoning、phase、搜索、工具 ID、恢复、失败诊断和真实清理等待；[native-boundaries.test.mjs](../../../packages/models/tests/native-boundaries.test.mjs) 覆盖异常流边界；[runtime.test.mjs](../../../packages/models/tests/runtime.test.mjs) 验证共享 execution 所有权。参见 [Models 协调服务](models.md) 与 [原生框架设计](../../native-protocol-agent-framework-design.md)。
