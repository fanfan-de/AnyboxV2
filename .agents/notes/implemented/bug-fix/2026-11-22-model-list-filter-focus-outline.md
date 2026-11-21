# Agent Note: 修复模型列表筛选栏的焦点描边

Status: implemented

## 问题

进入已配置 Provider 后，模型搜索框和可用状态下拉框同样位于裁切横向滑动面板的导航栏内。两边贴合导航栏，聚焦时向外绘制的描边左右被裁掉。

## 决策

Anybox Harness 和 Personal Agent 的模型管理导航栏统一为输入框和下拉框使用 2px 内描边。Provider 搜索框、模型搜索框和可用状态下拉框都使用这一规则。

## 备选方案

为筛选栏增加侧边留白可以容纳外描边，但会占用窄屏中有限的输入宽度。沿用导航内描边保留了控件尺寸。

## 影响与代价

焦点样式限于两款应用的模型管理导航栏。键盘仍可在两个搜索控件与列表之间切换。

## 验证

- Chrome 在 1094px 和 480px 下用 Tab 分别聚焦两款应用的模型搜索框与可用状态下拉框。修复前复现左右裁切，修复后两款控件均显示完整 2px 描边。Provider 搜索焦点和搜索、Logo 冒烟检查通过。
- macOS 桌面开发版重启后，在 Personal Agent 的 DeepSeek 模型列表打开搜索，确认 Tab 可在模型搜索和可用状态之间移动。模型搜索框描边四边完整，窗口停在该输入框。已安装发行包未测试。
- `node scripts/verify-web-assets.mjs` 和 `git diff --check` 通过。

## 关联

- [统一宿主的贴边焦点描边](2026-11-22-unify-focus-outline.md) 接管了本记录的局部焦点偏移。
- [Provider 搜索框焦点描边修复](2026-11-22-provider-search-focus-outline.md)
- [Anybox Harness 样式](../../../../packages/app-harness/web/style.css)
- [Personal Agent 样式](../../../../packages/app-personal-agent/web/style.css)
