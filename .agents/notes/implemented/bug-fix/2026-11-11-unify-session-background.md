# Agent Note: 统一会话区与两侧栏的背景色

Status: implemented

## 问题

会话区使用较浅的 `--canvas`（`#f2f2f2`），项目侧栏及文件目录栏使用 `--sidebar`（`#e8e8e8`）。用户要求中间背景与两侧相同。

## 决策

会话工作区、会话面板、活动及非活动面板标题栏、轨迹时间标记与明细吸顶标题统一使用现有的 `var(--sidebar)`。透明的对话正文和 Composer 随所在面板显示同一底色；同步 Web 设计说明。

## 备选方案

未在宿主全局或会话子树重定义 `--canvas`，避免同时改变通用画布、文件预览及其他后代对该变量的使用；直接调整本轮涉及的六处背景声明，范围清楚且继续复用主题变量。

## 影响与代价

仅调整会话区域底色，保留活动面板顶部指示、消息气泡和轨迹局部内容层次。文件预览仍使用现有通用画布。不改变业务数据、交互、组件或资源生命周期。

## 验证

- 使用现有 Node 24 工具链执行 `npm run build --workspace packages/app-harness`，通过。
- `node scripts/verify-web-assets.mjs` 通过，注册的浏览器资源及依赖完整。
- 临时本地 HTML 样本原样加载宿主与应用 CSS，Chrome 无头浏览器通过 `getComputedStyle()` 确认左右侧栏、会话工作区、会话面板、活动及非活动标题栏、轨迹时间标记与吸顶标题均为 `rgb(232, 232, 232)`；Composer 保持透明，文件预览及宿主 `--canvas` 保持 `#f2f2f2`。临时页面和浏览器配置随验证清理。
- `git diff --check` 通过。本轮只验证样式样本与应用构建，未重启运行中的桌面、未在真实会话页面验收，也未执行全仓测试或跨平台验收。

## 后续调整

2026-11-11，[标题圆点方向](2026-11-11-active-pane-title-indicator.md)替代了本记录保留的顶部活动横条呈现；本记录的背景配色决定继续有效。

## 关联

- 当前设计：[Web 客户端设计](../../../../docs/web-client-design.md)。
- 实现：[会话样式](../../../../packages/app-harness/web/style.css)、[宿主主题](../../../../packages/host/web/style.css)。
- 前项界面调整：[删除 Composer 无交互标记](../simplification/2026-11-11-remove-composer-passive-labels.md)、[简化 Composer 并下移模型选择](../simplification/2026-11-11-composer-controls.md)。
