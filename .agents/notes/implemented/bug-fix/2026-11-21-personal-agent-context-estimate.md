# Agent Note: Personal Agent 用提供方实测输入估算续接

Status: implemented

## 问题

连续会话按已保存的协议记录大小估算输入时重复计入了系统指令和工具定义。估算超限能触发应用历史重编码，使兼容模型收到的原生历史发生变化。

## 决策

兼容原生续接采用最近一次提供方报告的完整输入 token 数，加上实际会回传的原生响应内容和后续请求增量的估算。缺少报告时按实际参与组包的协议内容估算，切换模型或 API 时按目标协议组包后重新估算。缓存保存末端的估算基准，重启可从原始记录恢复。新 Run 的首次请求估算随接纳事务保存并可在用量预览中查看。

本地 token 估算用于展示，模型上下文上限由提供方判断。图片批次及传输大小约束继续独立执行。

## 备选方案

用预留误差区间决定是否本地拒绝会引入依赖模型和内容的阈值。直接由提供方判断超限，可发送选定格式的完整上下文并观察真实结果。

## 影响与代价

范围限于 Personal Agent 连续 Session。没有实测值的新增文本和图片仍使用近似计量。执行库 `run-state` v19 增加可空估算字段。旧记录无需回填，提供方拒绝时按现有模型错误路径结算。

## 验证

- 临时构建通过 TypeScript 检查。Personal Agent 与用量投影合计 29 项通过，打包路径断言在同目录布局的临时包单独复核。
- 验证覆盖内存原生续接、重启恢复实测基准、四协议切换、旧库升级、运行中估算展示与提供方拒绝后保持原会话末端。
- 使用模拟提供方。真实模型接口未实测。

## 关联

- [连续会话原生父链](2026-11-21-personal-agent-strict-native-continuity.md)
- [跨协议会话历史](../feature/2026-11-21-personal-agent-cross-protocol-history.md)
- [Personal Agent 连续历史](../../../../docs/modules/personal-agent/history.md)
- [输入估算](../../../../packages/app-personal-agent/src/core/protocol-agents/context-estimate.ts)
- [网关集成测试](../../../../packages/app-personal-agent/tests/http.test.mjs)
