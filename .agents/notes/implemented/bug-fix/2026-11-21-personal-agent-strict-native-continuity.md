# Agent Note: Personal Agent 连续会话保留完整原生父链

Status: implemented

## 问题

连续会话在模型配置、工作目录或预算触及续接边界时，曾自动用近期问答文本开启新段。可见对话仍然连续，服务端请求却失去了原生推理、工具结果和完整的历史前缀。

## 决策

Personal Agent 的连续会话按当前成功末端承接完整的原生父链。四种协议继续由各自的 Models 驱动恢复记录。模型或连接恢复身份、指令、工具和目录有不兼容变化时，接纳前返回 `history-incompatible`。完整输入超过模型上下文或图片上限时返回 `context-too-large`。用实际预算替代固定的 32 个 Run 和 4 MiB 历史额度。

SQLite `run-state` v17 保存本轮原生初始化并约束新 Run 的父引用。既有根和上下文保留给读取和恢复。旧历史中曾断开的父链无法完整还原时拒绝继续接纳，已接受的旧 Run 保留原有恢复路径。

## 备选方案

按窗口淘汰旧轮次、用问答背景组包以及按新配置开启上下文段都会改变同一可见历史的原生前缀，因此取消。强行拼接旧独立请求也无法补回缺失的原生父关系，并可能跨越凭据及工作目录边界。

## 影响与代价

旧会话的轨迹、原始响应和附件继续可读。完整续接依赖原配置及真实预算，历史越长，每次重建的成本越高。范围限于 Personal Agent 连续会话，沿用原凭据恢复边界。Personal Agent 项目会话和 Anybox Harness 沿用各自契约。

## 验证

- 117 项定向测试通过，覆盖四种协议的跨 Run 请求前缀和重启、Chat Completions 连续 35 个 Run 保留完整前缀、模型或 Key 或目录不兼容、完整历史超出预算时拒绝并保持当前末端，以及旧轨迹的展示。
- v15 旧记录样本升级到 v17 后仍可读取准确的续接历史，带旧召回片段的链会拒绝新 Run。独立 SQLite 验证覆盖保留旧记录、约束准确父引用及冻结本轮初始化。
- 根 `npm run check` 的类型检查和构建通过。全库测试 2,402 项，2,378 项通过、17 项按门控跳过、7 项失败。失败均在本轮范围之外的 `tests/settings-client.test.mjs`，其 Harness 设置面板夹具缺少 `data-models-device-slot`，单独运行也复现。 `git diff --check` 通过。
- 使用临时数据库、内存 Vault 和模型替身验证，未调用真实模型接口。

## 关联

- [按实测输入估算续接](2026-11-21-personal-agent-context-estimate.md)替代本项按本地估算决定模型上下文准入的做法。
- [更换 Key 后继续原会话](../simplification/2026-11-21-personal-agent-continue-after-key-rotation.md)允许新 Run 在原生上下文的连接身份变化后重新组包。
- [会话历史支持切换 API](../feature/2026-11-21-personal-agent-cross-protocol-history.md)沿用本项的会话父链约束，采用应用历史支持跨协议及旧分段续接。
- [Personal Agent 连续历史手册](../../../../docs/modules/personal-agent/history.md)
- [Chat Completions 原生续接](../feature/2026-11-21-personal-agent-native-chat-continuation.md)
- [四种协议原生续接](../feature/2026-11-21-personal-agent-native-protocol-continuation.md)
- [网关测试](../../../../packages/app-personal-agent/tests/http.test.mjs)
- [历史数据库测试](../../../../packages/app-personal-agent/tests/continuous-history.test.mjs)
