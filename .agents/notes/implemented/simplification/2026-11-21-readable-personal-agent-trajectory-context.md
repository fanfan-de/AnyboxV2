# Agent Note: 改善 Personal Agent 轨迹上下文的可读性

Status: implemented

此处记录按轮次渲染文本的早期方向。当前展示采用 [轨迹上下文 JSON 格式化](2026-11-21-format-personal-agent-trajectory-context-json.md)。

## 问题

轨迹明细把近期对话和历史记忆显示为一整块 JSON。转义换行和内部字段让用户难以辨认每一轮的提问与答复，列表预览也以 JSON 开头。

## 决策

识别已知的近期对话和历史记忆结构。列表显示类别与条数，明细按原顺序分轮，标明用户和助手。用户消息保留换行，助手答复复用现有 Markdown 渲染器。原始展示文本可按需展开，同一条明细随轨迹更新时保留展开状态。

## 备选方案

为 JSON 缩进可以辅助核对字段。按轮排版可以直接阅读段落和列表，折叠入口兼顾核对原文的需要。

## 影响与代价

改动位于 Personal Agent 的 Web 轨迹展示层。搜索继续索引已加载的原始展示文本。普通上下文、未知格式和被展示上限截断的 JSON 使用纯文本呈现，能读到的范围取决于已有展示上限。

## 验证

- `npm run build --workspace packages/app-personal-agent` 和 `node scripts/verify-web-assets.mjs` 通过。
- `node --test tests/session-view.test.mjs` 通过 59 项，覆盖角色顺序、Markdown、原始文本展开状态、纯文本回退和搜索。
- `node --test packages/app-personal-agent/tests/http.test.mjs` 通过 4 项，包含连续历史、召回和原生续接。
- macOS Chrome 通过合成轨迹验证 313、290 和 238 像素宽的明细区，覆盖桌面并排和窄布局、原始内容展开与收起、长文本换行及横向溢出检查。浏览器验证使用测试记录。

## 关联

- [连续历史与记忆手册](../../../../docs/modules/personal-agent/history.md)
- [Personal Agent 轨迹明细](../../../../packages/app-personal-agent/src/web/trajectory-view.ts)
- [会话视图回归测试](../../../../tests/session-view.test.mjs)
- [原生 Chat Completions 续接记录](../feature/2026-11-21-personal-agent-native-chat-continuation.md)
