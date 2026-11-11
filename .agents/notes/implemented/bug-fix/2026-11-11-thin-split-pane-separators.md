# Agent Note: 将会话分屏分隔条收为细线

Status: implemented

## 问题

用户指出相邻会话面板之间的灰色分隔条显得粗重，并让顶部深灰活动标记的边界出现宽缺口。原实现为 8px 布局槽、灰色底和中间 2px 线，悬停时整条槽进一步变深。

## 决策

分屏的真实布局占位改为 1px，并仅用该像素绘制现有主题的细分界线；透明伪元素向两侧各延伸 4px，保留 9px 鼠标抓取范围。横向、纵向及嵌套分屏共用原有布局常量、比例计算和事件代理，悬停及键盘聚焦仅加深细线。顶部活动标记保留在所属会话面板，分隔线与其边缘相接，不再留下原来的宽灰槽。同步现有尺寸测试与 Web 设计说明。

## 备选方案

未采用“保留 8px 布局槽，只缩细中央线”的做法，因为真实空隙仍会割裂标题栏顶部；也未给分隔条或未激活面板补画活动色横线，避免将活动标记延伸到不属于当前面板的区域。

## 影响与代价

面板最小尺寸仍为 320×260px，递归最小空间只减少实际分隔占位；既有布局继续使用已保存的比例，无需迁移。保留指针捕获、方向键每次 5% 调整与资源生命周期。透明抓取区会覆盖紧邻边缘的 4px；这是保留易抓取范围所需的交互占用。

## 验证

- 使用现有 Node 24 工具链执行 `npm run build --workspace packages/app-harness`，通过。
- `node --test packages/app-harness/tests/workspace-layout.test.mjs` 的 5 项现有测试全部通过，覆盖四方向分屏、跨项目移动、上限、关闭收拢、递归最小尺寸、比例钳制、布局恢复与路由。
- `node scripts/verify-web-assets.mjs` 通过。
- 临时 Chrome 浏览器样本原样加载宿主和应用 CSS，并读取已构建的 `separatorSize`：实际横向间隙与纵向间隙均为 1px，透明命中区域为 9px；中心及两侧扩展区的 `elementFromPoint()` 均命中所属分隔条。验证了悬停色、Tab 聚焦色，以及嵌套分屏的方向与热区尺寸；截图确认顶部已无原有宽灰槽，活动标记仍仅属于活动面板。
- `git diff --check` 通过。浏览器验证使用临时样本，未在运行中的桌面真实会话验收；未实拖生产面板、未执行全仓测试或跨平台验收。

## 后续调整

2026-11-11，[标题圆点方向](2026-11-11-active-pane-title-indicator.md)替代了本记录保留的顶部活动横条呈现；1px 分隔线与透明拖拽热区决定继续有效。

## 关联

- 前项：[统一会话区与两侧栏的背景色](2026-11-11-unify-session-background.md)。
- 当前设计：[分屏布局与资源归属](../../../../docs/web-client-design.md#分屏布局与资源归属)。
- 实现：[会话样式](../../../../packages/app-harness/web/style.css)、[布局计算](../../../../packages/app-harness/src/web/workspace-layout.ts)、[分屏事件与装配](../../../../packages/app-harness/src/web/workspace-client.ts)。
- 验证：[既有布局测试](../../../../packages/app-harness/tests/workspace-layout.test.mjs)。
