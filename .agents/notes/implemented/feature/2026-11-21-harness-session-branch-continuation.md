# Agent Note: Anybox Harness 按分支续接模型上下文

Status: implemented

## 问题

Anybox Harness 从指定父节点恢复完整原生记录，但每次都重放历史，已固定的 Session 协议或旧 Key 也会阻止切换后续聊。轨迹缺少逐次缓存用量和首包输入估算。

## 决策

已接入轨迹 JSON 格式化、逐次调用缓存用量、轻量恢复游标、首包估算、原生上下文缓存和应用历史组包。成功提交后按 Session 和不可变父上下文引用发布缓存。每个 Run 独立打开 execution。切换模型或 API，或者在同一提供方的同一地址和认证方式下换 Key 时，沿所选祖先链逐项转换已完成的轮次。选择不同协议仍沿既有同父并发模式执行。

## 备选方案

讨论时考虑过先抽取通用 RunRuntime。迁移直接在 Harness 接入已有 Models 端口，避免让执行内核重构成为功能依赖。Personal Agent 的单末端约束属于其产品交互，Harness 使用不可变父上下文引用。

## 影响与代价

各应用保留自己的数据库和 Session 管理。Harness 的首次接纳固定指令和实际工具声明。`run-state` v13 为新 Run 保存组包方式与可空首包估算，应用事件从原生增量记录按需生成。已接纳 Run 恢复原快照和组包方式。缓存失配或重启时按持久记录重建。恢复身份、地址或认证方式变化时保护旧提供方范围，跨协议只带入公开引用信息，私有续接数据留在源记录。模型上下文上限仍由提供方判断。

## 验证

- `npm run check` 通过。2403 项通过，18 项按既有条件跳过，0 项失败。`git diff --check` 通过。
- 本地替身核对四 API 切换、换 Key、同父并发、缓存跳过父记录读取、重启前后请求一致、图片及工具结果隔离、公开引用和拒绝变更后的旧连接地址。另覆盖旧库迁移、在途认领、待发送协议锁定及轨迹显示。
- 整仓验证同步修正了旧 HTTP 响应字段断言和已有模型设置侧栏的测试夹具。未调用真实提供方或部署到在用环境。

## 关联

- [Harness 对话树](../../../../docs/session-conversation-tree.md)
- [四协议分支验收](../../../../tests/native-protocol-agents.test.mjs)
- [恢复游标验收](../../../../tests/computer-session-resume.test.mjs)
- [Personal Agent 连续历史](../../../../docs/modules/personal-agent/history.md)
- [Personal Agent 跨 API](2026-11-21-personal-agent-cross-protocol-history.md)
