# Tool API

与 Agent、模型、Nya 和通信无关的工具契约。该包仅包含 JSON、工具身份与定义、参数校验，以及明确区分 `result`、`cancel` 和 `done` 的执行句柄；环境由调用方注入。

参数 schema 支持 `type`（含联合类型）、`enum`、`const`、对象属性/必填/额外属性、数组元素/数量/唯一性、字符串长度/正则、数值范围/倍数、`allOf` / `anyOf` / `oneOf` / `not`。支持 `$schema`、标题、描述、默认值、示例和弃用展示注解；展示注解不改变执行值。未支持的关键词（含 `$ref`、`format`）在定义注册时明确拒绝，不能静默忽略约束。输入必须为无 NUL 的有界嵌套 JSON；结果契约保留普通 JSON 字符串。

环境提供方负责资源、授权与副作用的真实执行语义。工具 API 不创建进程、不保存业务历史、不推断恢复或自动重试。测试运行 `npm test --workspace @anybox/tool-api`。

`ToolEnvironment` 通过 `environmentId/version/tools` 声明能力，并以 `openScope({scopeId, ownerEpoch, signal})` 提供执行 scope。调用使用稳定 `operationId` 与工具身份，结果和实际退出分别通过 `result/done` 返回；`cancel` 和 `close` 必须覆盖所有已接受工作及保留资源。环境接口不接收 Agent、Session 或 Project 对象。

恢复默认禁止重新调用未知操作。只有实现了原操作查询的环境才声明 `recovery: 'observe-existing'`，并在 `resuming: true` 时查回原结果；缺失或未知不能当成首次调用重放。调用方负责固定环境与工具快照，并在配置不兼容时明确拒绝继续。Anybox 的受信装配示例见[环境提供工具](../../docs/tool-environments.md)。
