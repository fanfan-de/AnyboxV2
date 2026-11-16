# Agent Note: 删除设置侧栏的“工作区”标题

Status: implemented

## 问题

Anybox Harness 设置侧栏的“工作区”只是静态分组文字，没有对应的选择或切换功能，容易让用户误以为下方设置限定在某个工作区。用户确认直接删除。

## 决策

删除设置导航中的标题段落，并清理其普通与窄屏专用样式。设置侧栏直接从“会话设置”开始，沿用现有菜单顺序与导航布局。

## 备选方案

讨论过将标题改为“设置”；窗口已有“Anybox Harness 设置”标题，重复标签没有额外信息，因此按用户选择直接移除。

## 影响与代价

减少侧栏顶部一行文字及其间距；各设置入口、实际生效范围和设备提示保持原行为。不涉及业务数据、资源归属或取消退出流程。

## 验证

- 检索确认 `settings-nav-label` 在应用及测试中已无引用，模板导航首项为“会话设置”。
- 使用本机 Node 24.16.0 执行 `node --test packages/app-harness/tests/package-assets.test.mjs`，2 项通过；执行 `node scripts/verify-web-assets.mjs`，静态资源及浏览器依赖图验证通过。
- `git diff --check` 通过。本轮只调整静态 HTML/CSS，未新增测试、未重新构建 TypeScript、未执行全仓测试或浏览器视觉验收，未重启运行中的实例。

## 关联

- [设置模板](../../../../packages/app-harness/web/template.html)
- [设置样式](../../../../packages/app-harness/web/style.css)
- [资源验证测试](../../../../packages/app-harness/tests/package-assets.test.mjs)
