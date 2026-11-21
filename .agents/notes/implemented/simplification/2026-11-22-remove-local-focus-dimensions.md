# Agent Note: 清理可继承宿主的局部焦点尺寸

Status: implemented

## 问题

宿主已提供 1px 贴边描边，工作区、对话、工具输出及部分列表仍自定义线宽、偏移或压掉宿主描边。可安装的 Anybox Test 也使用自己的外描边。

## 决策

让 Anybox Harness 和 Personal Agent 的普通按钮、列表行、工具详情、Markdown 链接等继承宿主描边尺寸。Markdown 和 Claude Agent 继续使用现有焦点颜色。复合筛选框的容器用现有边框显示焦点，Anybox Test 更新到 0.1.1 并沿用宿主尺寸。

## 备选方案

全部删除局部规则会削弱细小时间条的焦点信号，也会使分隔条和复合控件同时出现两套提示。保留对应控件自己的视觉提示。

## 影响与代价

两款应用的时间轴色条最窄可到 2px，因此保留外描边区分当前选中与键盘焦点。分隔条、编辑器外框和模型选择列表继续通过细线、容器边框或活动选项指示焦点。

## 验证

- 相关 Node 测试 135 项通过，覆盖侧栏、会话树、轨迹、文件、选择器与测试应用资源。
- Chrome 使用工作区控件夹具和两套应用实际样式，在 1094px 和 600px 分别用键盘验证清理前后。普通控件继承 1px、−1px，Markdown 保留焦点颜色，复合筛选框通过容器边界显示焦点。确认窄时间条选中与聚焦仍有不同描边，分隔线仍为 1px。
- `node scripts/verify-web-assets.mjs` 和 `git diff --check` 通过。浏览器验证使用测试夹具。

## 关联

- [统一宿主的贴边焦点描边](../bug-fix/2026-11-22-unify-focus-outline.md)
- [宿主公用样式](../../../../packages/host/web/style.css)
- [Anybox Harness 样式](../../../../packages/app-harness/web/style.css)
- [Personal Agent 样式](../../../../packages/app-personal-agent/web/style.css)
- [Anybox Test](../../../../docs/host-test-application.md)
