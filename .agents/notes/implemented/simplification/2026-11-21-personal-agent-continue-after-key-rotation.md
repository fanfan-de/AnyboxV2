# Agent Note: Personal Agent 更换 Key 后继续原会话

Status: implemented

## 问题

连续 Session 可以将本地历史重新组包，但上一轮使用同一连接时，更换 Key 会让应用历史路径也拒绝新 Run。

## 决策

移除重新组包时对上一轮连接身份的比较，并删除应用历史返回值中只供该检查使用的模型快照。Models 仍在复用原生上下文时校验连接和凭据版本。换 Key、模型或提供方造成原生上下文不兼容时，新 Run 使用当前连接和 API 按顺序编码完整的本地应用历史，沿原会话末端追加。

## 备选方案

保留凭据限制并逐轮校验会阻断用户要求的换 Key 续聊。放宽原生恢复的凭据校验会允许复用可能属于旧连接的签名和推理状态。

## 影响与代价

变更限于 Personal Agent 连续 Session 的新 Run。历史和工具调用结果沿原父链保存，当前配置重新组包需要读取已完成的应用轮次。已接纳 Run 的原生恢复继续验证原执行身份。

## 验证

- 新增的工具历史场景在旧实现上复现 HTTP 409。修改后验证同一 Session 使用新 Key，并逐项保留旧问答、工具调用与原始结果。长对话回归也核对了重启后换 Key 的完整请求。
- Personal Agent TypeScript 编译通过。使用临时编译产物运行 Personal Agent 测试和 Models 的 `continuation.test.mjs`，共 20 项通过，覆盖四协议切换及原生缓存兼容性。`git diff --check` 通过。
- 验证使用临时执行库和模型替身，未调用真实提供方。

## 关联

- [会话历史支持切换 API](../feature/2026-11-21-personal-agent-cross-protocol-history.md)
- [完整原生父链](../bug-fix/2026-11-21-personal-agent-strict-native-continuity.md)
- [Personal Agent 连续历史](../../../../docs/modules/personal-agent/history.md)
- [网关集成测试](../../../../packages/app-personal-agent/tests/http.test.mjs)
