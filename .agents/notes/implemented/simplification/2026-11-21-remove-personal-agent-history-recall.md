# Agent Note: 删除 Personal Agent 历史召回

Status: implemented

## 问题

Personal Agent 会根据本轮提问检索已经移出模型窗口的旧问答，将命中的片段放进 `historical-memory`。普通问候也能匹配。用户要求删除该机制。

## 决策

删除旧问答的自动检索、引用入口与模型组包，使用 `run-state` v16 迁移删除派生的全文索引表。连续历史继续按预算带入近期问答，并在条件相容时续接原生请求。新 Run 遇到曾带历史召回片段的原生链时，从近期问答重建上下文，避免旧片段再次进入请求。

## 备选方案

未比较其他方案。

## 影响与代价

原始对话、轨迹和附件引用仍可回看。旧轨迹显示当时实际发送的内容，已接纳的 Run 恢复时沿用其已保存的请求和原生父引用。

## 验证

- macOS Node v24.22.3 执行 `npm run build` 通过，包含浏览器资源校验。
- `node --test --test-timeout=180000 packages/app-personal-agent/tests/*.test.mjs` 通过 15 项。覆盖窗口滚动、原始轮次可读、旧引用标记按普通输入发送、v15 至 v16 迁移删除派生索引、旧轨迹可读，以及升级后的新请求从近期问答重建上下文。
- `node --test --test-timeout=180000 tests/session-view.test.mjs tests/context-usage-projection.test.mjs` 通过 70 项。未验证真实模型或活跃 Run 异常退出后的恢复。

## 关联

- [连续历史与上下文手册](../../../../docs/modules/personal-agent/history.md)
- [原连续历史与记忆召回决策](../feature/2026-11-19-personal-agent-continuous-session.md)
