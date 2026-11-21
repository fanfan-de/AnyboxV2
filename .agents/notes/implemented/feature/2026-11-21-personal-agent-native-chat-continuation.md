# Agent Note: Personal Agent 跨 Run 续接原生 Chat 消息

Status: implemented

## 问题

改动前，连续会话的每个新 Run 都重新组包。近期提问和最终答复编码为一条 `user` 角色的 `recent-conversation` 文本，召回旧问答时另加一条 `historical-memory`，最后放本轮输入。此方式让不同模型都能阅读历史问答，也能按预算滚动和召回。上游返回的推理、工具调用及工具结果留在各自 Run 的原生记录，只用于该 Run 内续轮及恢复。重组或窗口裁剪会缩短下一次请求可复用的前缀。

## 决策

兼容的 Chat Completions Run 沿原生 `messages` 追加，复用已保存的消息及工具往返。DeepSeek 返回的 `reasoning_content` 保留在原始助手消息里。通过现有上下文引用提交所选父链，恢复时读取已接纳的确切记录。配置不兼容、跨工作目录、上下文滚动或超预算、存在临时历史召回时，采用既有文本组包方式。

## 备选方案

持续使用文本背景便于换模型和召回，但旧推理、工具结果和原始消息角色无法接续。把所有独立生成的旧 Run 原样拼在一起，会重复各轮首包里的系统指令与背景文本。当前从兼容的已完成父链开始，只追加新输入。

## 影响与代价

同一兼容段内的请求前缀更稳定，实际缓存命中由提供方报告。`run-state` v15 更新插入约束，既有 Run 和原生记录按原格式读取。已保存的兼容末端可作为原生链起点，更早的历史以当时请求中实际发送的背景文本延续。跨配置和工作目录只使用文本背景，历史工具结果仍归原 Run。

## 验证

Personal Agent TypeScript 编译和浏览器资源校验通过。Personal Agent 测试 12 项通过，网关用例验证真实工具结果、受控 DeepSeek 推理字段、重启后原样保留请求前缀、持久恢复和 Key 轮换后的文本回退。原生协议、Session 及恢复回归 90 项通过。用临时 SQLite 验证 v15 接受正确的连续末端和重组入口，并拒绝错误引用。未重启当前本机实例或测量 DeepSeek 线上缓存命中率。

## 关联

- 本项中的文本组包回退与新分段由[完整原生父链](../bug-fix/2026-11-21-personal-agent-strict-native-continuity.md)替代。
- [连续历史与记忆召回](2026-11-19-personal-agent-continuous-session.md)
- [输入缓存命中统计](2026-11-21-personal-agent-trajectory-cache-usage.md)
- [历史及轨迹说明](../../../../docs/modules/personal-agent/history.md)
- [网关回归](../../../../packages/app-personal-agent/tests/http.test.mjs)
