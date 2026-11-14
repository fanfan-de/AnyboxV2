# Agent Note: 原生工具请求在执行前有界纠错

Status: implemented

## 问题

模型返回 `update_plan`，而该 Session 实际声明的精确名称为 `codex_update_plan`，导致 Run 以 `invalid-tool-request` 中止。该次失败是工具请求名称不合法，不能仅靠无新内容超时修复；名称或参数的纯预检错误需要允许模型得到反馈后显式修正。

本记录于 2026-11-11 补录此前同一聊天已完成的修复，依据当前源码、行为测试和本机检查输出。

## 决策

四种协议 Loop 保持原生调用 ID，将解析后的调用交给共享交换管道做副作用前的整批预检。关联 ID 合法后，未知或未选择名称返回 `unknown-tool`，所选工具参数 schema 错误返回 `invalid-arguments`，同批原本合法的调用返回 `batch-rejected`；整批不执行、不获取工具资源、不登记对应工具操作。

反馈为原生工具结果，内容使用固定 `invalid-tool-request` 错误、`executed:false`、实际声明的精确名称，参数错误附对应 schema。Anthropic 同时设置 `is_error:true`。模型必须下一轮自行提交正确名称和参数；不设置别名、不模糊匹配、不静默改名。

每个 Run 累计最多反馈三批拒绝，第四批拒绝结束；中间成功批次不重置额度。既有不透明 protocolCursor 保存 `toolRequestCorrections`，旧游标缺省零，存在时必须为 0～3 的安全整数。计数随后续模型响应保存；恢复从最后耐久响应确定性重建对应反馈，不因 Runtime 重建获得新额度，未知 `model-pending` 不重发。

续轮语义对应 Loop 1.4.0，明确兼容读取 1.0.0～1.4.0；不新增数据库迁移、组件、服务或 HTTP 端点。

## 备选方案

**立即终止全部预检错误。** 模型无法利用服务端实际工具声明修正一次可纠正的请求，正常任务因名称或字段错误过早失败，因此采用有界反馈。

**为 `update_plan` 添加别名或自动猜测正确工具。** 会绕过 Session 精确声明并隐藏模型的错误选择，因此保持名称精确匹配，由模型显式修正。

**对任意工具失败重试或不设反馈上限。** 已进入执行阶段的失败可能伴随副作用，无界纠错也可能空转；只转换纯预检错误，限制整个 Run 的累计额度。

## 影响与代价

一次无效批次会增加模型续轮及相应调用成本，且整批合法同伴也要由模型重新提交。已经完成的其他批次副作用不回滚。缺失、重复、过长或损坏的调用 ID，损坏原生 JSON，以及在协议解析前失败的参数不进入该纠错路径。

真正的工具执行、存储、取消、超时或清理故障继续终止；即使执行器返回相同错误类别也不转换为预检反馈，不自动重试副作用。额度恢复仅覆盖既有已保存响应的接管边界，不扩大未知结果重放范围，也不保证真实模型一定能够修正成功。

## 验证

原生工具库测试覆盖四协议错误名称/参数反馈、原 ID 对应、修正后执行、混合批次全拒绝无副作用、累计额度、合法批次不重置、损坏 ID 致命，以及执行器先产生副作用再失败时不重试。原 Bash 与 Apply Patch 循环验证对应预检反馈及无副作用。

协议恢复测试模拟响应提交后的多次 Runtime 接管，验证计数依次保留 1、2、3，第四次拒绝不再请求模型，非法计数拒绝；该测试不是实际操作系统强杀验收。

2026-11-11 已完成的根 `npm run check` 结果为 2206 项测试、2185 通过、21 跳过、0 失败、0 取消；`git diff --check` 通过。测试使用确定性模型替身和本地执行集成，未新增真实提供方纠错成功率或跨平台实测。

## 关联

- 当前契约：[协议 Agent 注册表](../../../../docs/modules/execution/protocol-agent-registry.md)、[工具库](../../../../docs/modules/tools/README.md)。
- 实现：[共享预检与反馈](../../../../packages/app-harness/src/core/protocol-agents/shared.ts)、[版本和恢复](../../../../packages/app-harness/src/core/protocol-agents/registry.ts)、[四协议 Loop](../../../../packages/app-harness/src/core/protocol-agents/)。
- 验证：[原生工具库](../../../../tests/native-tool-library.test.mjs)、[协议恢复](../../../../tests/computer-protocol-resume.test.mjs)、[工具循环](../../../../tests/tool-loop.test.mjs)、[Apply Patch 循环](../../../../tests/apply-patch-loop.test.mjs)。
- 前项：[模型无新内容超时与失败输出保留](2026-11-11-stream-inactivity-and-failure-content.md)。
- 后续：[退役计划与待办工具](../simplification/2026-11-14-retire-planning-tools.md)移除示例中计划契约的新选择入口，保留旧 Session 兼容及本记录的整批预检、有界纠错方向。
