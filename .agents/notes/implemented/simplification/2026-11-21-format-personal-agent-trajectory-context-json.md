# Agent Note: 格式化 Personal Agent 轨迹上下文 JSON

Status: implemented

## 问题

用户希望直接核对上下文 JSON。紧凑的一行显示让嵌套层级难以辨认，上一版按发言渲染改变了用户需要查看的表现形式。

## 决策

在上下文明细中直接显示 JSON。对有效对象和数组使用两空格缩进与换行，只调整记号之间的空白。字段顺序、重复键、数字写法、字符串转义及 Markdown 标记保留在原位。长行随明细宽度自动折行。

## 备选方案

解析后再序列化可能合并重复键、改变键顺序和数字写法。上一版对话排版适合阅读发言，已由格式化 JSON 的方向替代。

## 影响与代价

格式化发生在打开明细时，搜索使用已加载的原始文本。非 JSON、被展示上限截断的片段，以及超过 64 层非空对象或数组的记录直接显示已有文本。

## 验证

- `npm run build --workspace packages/app-personal-agent`、`node scripts/verify-web-assets.mjs` 和 `git diff --check` 通过。
- `node --test --test-reporter=spec tests/session-view.test.mjs` 通过 59 项，覆盖嵌套、空容器、重复键、大整数、转义、纯文本回退和搜索。
- macOS Chrome 使用合成记录验证近期对话、历史记忆与通用 JSON，明细宽度 313、290 和 238 像素时长行正常折行，面板无横向溢出。

## 关联

- [上一版上下文展示方向](2026-11-21-readable-personal-agent-trajectory-context.md)
- [连续历史与记忆手册](../../../../docs/modules/personal-agent/history.md)
- [轨迹明细实现](../../../../packages/app-personal-agent/src/web/trajectory-view.ts)
- [会话视图回归测试](../../../../tests/session-view.test.mjs)
