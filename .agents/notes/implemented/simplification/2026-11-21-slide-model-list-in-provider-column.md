# Agent Note: 在 Provider 栏内滑动切换模型列表

Status: implemented

## 问题

Provider 列表和模型列表占据左右两栏。用户希望两个列表共用原来的 Provider 栏，点击进入时向左滑动，返回时反向滑动。

## 决策

两款应用在原 Provider 栏使用同一宽度展示两层列表。选中 Provider 后向左滑到它的模型，返回时向右滑回。右栏展示当前提供方的操作或选中模型的参数编辑。返回恢复 Provider 列表的滚动位置和焦点，并保留非秘密草稿。减少动态效果偏好下直接切换。

模型搜索随列表放在左栏。未配置项可筛选公开目录模型并从右栏进入 API 配置，取消返回原模型列表。已配置项沿用模型状态筛选及编辑流程。

## 备选方案

沿用左右同时展示两个列表会继续让列表占据右栏。把布局改成左栏分层导航，可以留出右栏给配置。

## 影响与代价

目录和已配置项的分组、模型库存请求与草稿归属沿用当前规则。两个滑动面板仅让当前面板接收交互。

## 验证

- 两款应用通过 TypeScript 编译及浏览器静态资源检查。`node --test --test-concurrency=2 tests/models-client.test.mjs tests/models-directory-web.test.mjs` 33 项全部通过。
- macOS Chrome 使用临时 Web 宿主实测两款应用。浏览器逐帧确认两次切换方向相反且占用同一列。验证键盘返回的焦点和滚动恢复、已配置与公开模型搜索、模型草稿恢复、配置取消和新进入模型列表时的滚动复位。320px 和 400px 视口无水平裁切，系统启用减少动态效果时跳过动画。

## 关联

- [从 Provider 列表直接配置](2026-11-21-configure-provider-from-list.md) 将未配置项的模型预览改为直接配置。
- [模型管理直接展示完整 Provider 目录](2026-11-21-show-provider-directory-in-model-management.md)
- [Web 客户端设计](../../../../docs/web-client-design.md)
