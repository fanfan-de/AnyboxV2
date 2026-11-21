# Agent Note: 修复 Provider 搜索框焦点描边被裁切

Status: implemented

## 问题

Provider 搜索框在滑动导航栏内距左右边界各 2px，宿主焦点描边向外占 5px，导致聚焦时描边的左右边缘被裁掉。

## 决策

将 Anybox Harness 和 Personal Agent 的 Provider 搜索框纳入模型导航已有的内收焦点样式。鼠标点击和键盘聚焦时，2px 描边均在输入框内完整显示。

## 备选方案

增加输入框的左右留白也能容纳向外绘制的描边，但会占用窄屏的输入空间。沿用导航内的描边偏移保留了输入宽度。

## 影响与代价

样式作用于两款应用的 Provider 搜索框焦点状态。导航栏继续裁切横向滑动的面板。

## 验证

- Chrome 在 1094px 和 480px 下对两款应用分别用 Tab 聚焦，复现原有裁切。修复后两种宽度的描边均完整显示，搜索和 Logo 冒烟检查通过。
- 重新启动 macOS 桌面开发版，在 Personal Agent「模型管理」点击搜索框，实测描边四边完整。桌面已安装发行包未测试。
- `node scripts/verify-web-assets.mjs` 和 `git diff --check` 通过。

## 关联

- [统一宿主的贴边焦点描边](2026-11-22-unify-focus-outline.md) 接管了本记录的局部焦点偏移。
- [在模型管理中搜索 Provider 并显示品牌 Logo](../feature/2026-11-22-search-and-brand-provider-list.md)
- [Anybox Harness 样式](../../../../packages/app-harness/web/style.css)
- [Personal Agent 样式](../../../../packages/app-personal-agent/web/style.css)
