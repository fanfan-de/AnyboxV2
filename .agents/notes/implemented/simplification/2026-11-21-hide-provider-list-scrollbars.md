# Agent Note: 隐藏 Provider 和模型列表的滚动条

Status: implemented

## 问题

用户补图指出要隐藏的是左栏列表右侧的滚动条。上一轮误将目标识别为设备选择器并将其隐藏。

## 决策

恢复模型管理的设备选择器。Provider 列表与模型列表复用同一左栏，两者都隐藏滚动条并使用原生滚动。

## 备选方案

将列表溢出设为不可滚动会阻碍浏览完整目录。仅隐藏滚动条外观即可达到用户要求。

## 影响与代价

样式作用于模型管理左栏。设置导航重新提供原有的设备选择与焦点恢复。

## 验证

- 两款应用均通过 TypeScript 编译、浏览器静态资源检查及 `git diff --check`。`node --test tests/models-client.test.mjs` 12 项全部通过。
- macOS Chrome 使用临时 Web 实例验证两款应用。加载 29 个 Provider 和 28 个模型使各自列表产生溢出。在桌面、400px 和 320px 确认滚动条隐藏且未保留槽位，真实滚轮可继续滚动。滚动后可打开模型编辑、返回并关闭。恢复的设备选择器显示同一台设备。

## 关联

- [移除模型管理内的设备选择器](2026-11-21-remove-model-settings-device-picker.md)
- [在 Provider 栏内滑动切换模型列表](2026-11-21-slide-model-list-in-provider-column.md)
- [Web 客户端设计](../../../../docs/web-client-design.md)
