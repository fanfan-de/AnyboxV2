# Agent Note: Personal Agent 连续历史续接全部原生协议

Status: implemented

## 问题

连续会话跨 Run 仅对 Chat Completions 尝试原生父链。Responses、Anthropic Messages 和 Gemini Interactions 会把已有问答组为文本，丢失模型请求中的原生推理和工具往返结构。

## 决策

Responses、Anthropic Messages 和 Gemini Interactions 进入同一条原生父链选择路径。每个 Models 驱动从自己的原始记录恢复上下文，再按其 API 编码本轮请求。工具结果沿用父链中已记录的观察，工具执行归原 Run。

## 备选方案

在首轮编码器内手工合成历史消息会丢失签名、有序输出项及工具关联。现有驱动已经能按各自协议恢复保存的原始记录。

## 影响与代价

范围是 Personal Agent 连续会话。沿用现有存储、配置兼容、工作目录、原生预算和临时召回边界。遇到这些续接边界时按已有规则从文本背景开启新段。

## 验证

- 使用改动前的执行代码运行三个新增场景。回环模型服务收到的第二个 Run 请求均包含文本历史，三项完整请求体断言均失败。
- Personal Agent TypeScript 编译通过。`node --test packages/app-personal-agent/tests/*.test.mjs` 通过 15 项。三个新场景在应用重启后捕获第二个 Run 的实际 HTTP 请求，对比完整请求体，核对原生消息顺序、加密推理或签名、工具 ID 和保存的原始文件读取结果。既有 Chat Completions Key 变更回退用例也通过。
- `node --test packages/models/tests/{protocols,anthropic-messages,gemini-interactions}.test.mjs` 通过 56 项，包含 JSON、SSE 和驱动级恢复覆盖。此次跨 Run 的实际 HTTP 验证使用本地模型替身，供应商生产接口未实测。

## 关联

- 本项中的文本背景回退、上下文分段和固定历史额度由[完整原生父链](../bug-fix/2026-11-21-personal-agent-strict-native-continuity.md)替代。
- [连续历史与记忆](../../../../docs/modules/personal-agent/history.md)
- [Chat Completions 原生续接起点](2026-11-21-personal-agent-native-chat-continuation.md)
- [HTTP 网关测试](../../../../packages/app-personal-agent/tests/http.test.mjs)
