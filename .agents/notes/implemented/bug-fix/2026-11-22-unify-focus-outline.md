# Agent Note: 统一宿主的贴边焦点描边

Status: implemented

## 问题

Provider 配置表单的显示名称等字段沿用宿主默认的 2px 焦点描边和 3px 外偏移。聚焦时额外画出一圈，模型导航之前只能逐处调整偏移。

## 决策

直接将 Anybox 宿主的默认 `:focus-visible` 改为 1px 描边和 −1px 偏移。移除两款应用模型管理中的局部焦点偏移以及 Personal Agent 侧栏搜索的外描边。Claude Agent 的常规交互和工作区弹窗仅指定已有焦点颜色，宽度和偏移继承宿主默认值。

## 备选方案

本轮曾考虑给文本输入和下拉框增加单独的宿主规则。用户明确要求直接修改统一规则，避免按控件类型或位置叠加焦点尺寸。

## 影响与代价

输入框、按钮、下拉框、复选框等使用同一个宿主默认值。自绘组件可继续用自己的视觉提示。样式不改变控件尺寸或键盘焦点顺序。

## 验证

- Chrome 在 1094px 和 480px 下验证 Anybox Harness 和 Personal Agent 的 Provider 配置字段、搜索框、下拉框、按钮、复选框和 Prompt 文本区。键盘聚焦时计算样式为 1px 描边和 −1px 偏移。
- Chrome 用 Claude Agent 样式夹具验证常规控件与工作区弹窗继承焦点尺寸，并保留各自的焦点颜色。
- macOS 桌面开发版重启后，在 Personal Agent 的 AbliteratedLLM 表单实测显示名称的焦点线与原边界重合。测试范围为桌面开发版与 Chrome。
- `node scripts/verify-web-assets.mjs` 和 `git diff --check` 通过。

## 关联

- [清理可继承宿主的局部焦点尺寸](../simplification/2026-11-22-remove-local-focus-dimensions.md) 将默认值用于其他工作区控件和测试应用。
- [Provider 搜索框焦点描边修复](./2026-11-22-provider-search-focus-outline.md)
- [模型列表筛选栏焦点描边修复](./2026-11-22-model-list-filter-focus-outline.md)
- [宿主公用样式](../../../../packages/host/web/style.css)
