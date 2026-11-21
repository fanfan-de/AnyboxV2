# Agent Note: 去掉模型管理的重复页眉

Status: implemented

## 问题

设置导航已经标出“模型管理”。内容区再次显示同名标题和用途说明，占用 Provider 列表上方的空间。

## 决策

两款应用的模型管理内容区省去可见标题和用途说明。分类名称保留为屏幕阅读器标签，设备选择器留在紧凑的顶部行。

## 备选方案

只移除说明仍会重复导航里的标题，因此将截图中的两行都从视觉布局移除。

## 影响与代价

涉及模型管理分类的页眉排版。设备切换、不可用提示和两列目录通过现有控件工作。

## 验证

- 两款应用通过 TypeScript 编译，`node --test tests/models-client.test.mjs` 22 项全部通过。
- macOS Chrome 在 1280px、400px 和 320px 验证两款应用。内容区没有重复的可见标题和说明，可访问区域名称为“模型管理”。设备选择器、首次展示 Provider、选中后显示模型及常规设置的独立说明均可用。

## 关联

- [移除模型管理内的设备选择器](2026-11-21-remove-model-settings-device-picker.md) 更新了内容区顶部的展示方式。
- [模型管理直接展示完整 Provider 目录](2026-11-21-show-provider-directory-in-model-management.md)
- [Web 客户端设计](../../../../docs/web-client-design.md)
