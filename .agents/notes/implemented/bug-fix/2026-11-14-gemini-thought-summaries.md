# Agent Note: Gemini 默认启用摘要并隐藏结束后的空白块

Status: implemented

## 问题

实际 Gemini 4 Argon 会话的模型参数为空，五个 thought 展示块均为 `summary: []`；Web 仍创建可展开的“推理摘要”，造成正文空白。用户要求默认启用 Gemini 摘要，并隐藏已经结束但没有正文的摘要块。

## 决策

对新建且声明支持推理的 Gemini 配置显式保存 `generation_config.thinking_summaries: auto`。协议的 `initialParameters` 额外接收可选能力声明，基础配置和新建表单均在明确支持推理时启用，未知/不支持能力仍可使用原有文本配置。保留用户选择的 `none` 及旧配置参数，不在运行期暗补。通过现有带修订 CAS 的设置 API，为本次问题所用且尚未配置摘要的 Gemini 4 Argon 单独启用摘要。Gemini Web 组件在 exchange 返回或投影提交后隐藏无非空白正文的 thought；生成中保留占位，收到正文后保留折叠行为及稳定组件身份。

## 备选方案

未采用在请求发送时强制注入 auto：它会绕过配置快照，并可能覆盖显式 none 或为未声明推理能力的模型发送不支持的参数。未批量改写已有配置：已保存的参数及历史快照应保持原意。空块只在展示层隐藏，不删除私有签名、原生记录或改变恢复行为。

## 影响与代价

新配置默认请求可读摘要；模型仍可能返回空摘要。既有历史不补造正文，刷新后空白块隐藏。其他协议、工具事实、取消/退出与资源所有权不变。工作区现有上下文用量与 RunRuntime 等变更不属于本轮。

## 验证

- `npm run build --workspace packages/models`、`npm run build --workspace packages/app-harness` 通过；初次构建发现默认值返回联合类型不满足 `NativeObject`，补明确返回类型后通过。
- `node --test --test-concurrency=4 tests/protocol-web-modules.test.mjs tests/models-client.test.mjs tests/native-projection.test.mjs tests/gemini-agent.test.mjs packages/models/tests/gemini-interactions.test.mjs`：85/85 通过，覆盖两种展示、全部 Gemini 返回状态、仅签名历史、空白正文、生成中占位、收到正文后复用组件和展开状态、投影与协议续轮。
- `node --test --test-concurrency=4 packages/models/tests/gemini-defaults.test.mjs packages/models/tests/streaming-defaults.test.mjs packages/models/tests/unified-models.test.mjs packages/models/tests/native-migration.test.mjs packages/models/tests/json-storage.test.mjs`：40/40 通过，覆盖新配置默认值的实际存盘与请求、未知/不支持推理的基线、已有 none/省略值、其他协议默认值及 JSON 存储兼容。
- `node scripts/verify-web-assets.mjs` 与 `git diff --check` 通过。
- 本机设置 API 以当前修订 CAS 将 Gemini 4 Argon 从 revision 1 更新为 2，只添加 `generation_config.thinking_summaries: auto`；回读确认其他业务字段均保留。首次写请求因缺少 Origin 被接口拒绝，补同源 Origin 后重新读取并提交，未绕过校验或重放未知写入。
- 实际打开用户给出的会话并选择已有分支：五个历史推理块均为 hidden，工具组与完整回答继续显示，页面可访问树已无空白“推理摘要”按钮。使用当前编译后的静态资源验收，执行服务未重启；该当前模型设置已影响后续 execution，新基础配置默认值在服务下次加载新构建后生效。
- 未发起新的真实 Gemini 计费请求，未运行全仓测试或跨平台验收；历史摘要不作补写。

## 关联

- [Gemini 驱动](../../../../docs/modules/models/gemini-interactions.md)
- [Gemini Agent](../../../../docs/modules/execution/gemini-agent.md)
- [Gemini Web](../../../../packages/app-harness/src/web/protocols/gemini.ts)
- [协议 Web 回归](../../../../tests/protocol-web-modules.test.mjs)
- [Gemini 默认配置回归](../../../../packages/models/tests/gemini-defaults.test.mjs)
