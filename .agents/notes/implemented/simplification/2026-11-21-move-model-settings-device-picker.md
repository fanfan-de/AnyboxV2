# Agent Note: 将模型管理的设备选择器移到底部

Status: implemented

## 问题

模型管理的设备选择器占用了内容区顶部的一行。用户希望把它移到更安静的位置。

## 决策

桌面端把选择器放在设置分类侧栏底部，窄屏放在弹窗底部。模型管理从 Provider 列表开始，并复用同一个设备选择器及已有切换行为。

## 备选方案

继续放在内容区顶部会占用 Provider 与模型的浏览空间。底部位置既保持控件可见，也能避免和列表标题争夺空间。

## 影响与代价

两款应用调整设置布局和选中分类时的控件挂载点。设备范围、切换保护、关闭和焦点恢复走现有逻辑。

## 验证

- 两款应用均通过 TypeScript 编译、浏览器静态资源检查和 `git diff --check`。`node --test tests/models-client.test.mjs` 12 项全部通过。
- macOS Chrome 实测两款应用。桌面选择器位于设置侧栏底部，320px 和 400px 下位于弹窗底部。用两个独立的本地测试执行端实测往返切换，模型管理随所选设备更新。常规与连接分类的设备范围显示、可访问名称和关闭按钮均可用。

## 关联

- [隐藏 Provider 和模型列表的滚动条](2026-11-21-hide-provider-list-scrollbars.md)
- [合并设置弹窗的布局](2026-11-21-integrate-settings-dialog-chrome.md)
- [Web 客户端设计](../../../../docs/web-client-design.md)
