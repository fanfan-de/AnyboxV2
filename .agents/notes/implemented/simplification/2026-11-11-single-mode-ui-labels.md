# Agent Note: 统一自有界面的文字与图标表达

Status: implemented

## 问题

用户指出“分支”按钮同时显示图标与文字，并要求排查当前项目，尽量让每个入口选择文字或图标一种表达。

## 决策

已排查宿主、Anybox Harness、Claude Agent 的自有 Web 界面及受版本控制的贪吃蛇页面。有明确文案的导航、菜单和操作采用纯文字，紧凑的关闭、发送、侧栏等按钮保留单独图标及可访问名称和提示。保留承担展开、路径层级、选中和运行状态等独立信息的标记，以及用户/模型原文、图片和品牌空态插图。

“分支”、七个设置分类、会话操作菜单、目录选择工具栏、宿主应用菜单与管理动作移除重复图标；文件树名称及文件标签移除类型图标，搜索/筛选框移除装饰搜索图形。宿主应用名旁的首字母图块、安装入口的装饰符号和发送按钮旁重复的快捷提示移除；Enter 快捷键仍在发送按钮提示中说明。Claude Agent 未发现重复语义图标，补齐已有纯符号关闭/移除按钮提示；贪吃蛇标题与状态文字移除装饰 emoji，方向按钮补齐名称。

删除失效样式、首字母与文件类型辅助函数、无引用 symbol 及六个图标文件和对应静态登记。更新 Web 设计与相关组件说明，记录同一入口选择文字或图标一种主表达的规则。

## 备选方案

未以 CSS 全局隐藏 SVG，避免破坏纯图标按钮与图形内容；未将所有入口统一转为无文字图标，以免增加功能识别成本。通过删除实际装饰 DOM、图形数据和失效资源收敛实现。

## 影响与代价

本轮为同一个可独立评审的界面简化目标，按宿主、应用导航与内容展示并行检查；已有工作区其他改动不计入本轮。宿主卡片在删除图块后调整桌面/窄屏列数，文字入口更紧凑；真实状态和折叠提示保留。没有新增组件或修改业务协议、持久数据与资源生命周期。

## 验证

- 使用 Node 24 执行 `npm run build --workspace packages/app-harness --workspace packages/app-claude-agent --workspace packages/host`，三包全部通过；`node scripts/verify-web-assets.mjs` 通过。
- 三组现有定向测试共 260 项通过、0 失败、0 跳过：会话菜单/文件栏/目录选择/导航 70 项；会话视图/工具展示/原生协议展示/对话树 88 项；宿主界面与包管理/Claude Agent 界面、模型选择和项目面板 102 项。没有为装饰删除新增镜像测试。
- Chrome 实际 Session 控制器与面板的内存样本确认“分支”无图标，打开总览与 Escape 关闭正常；轨迹搜索只保留文字输入提示，约 320px 面板无横向溢出，页面无脚本错误。临时入口补齐公共 import map，未修改仓库夹具或生产安全设置。
- 实际设置模板实例化后七个分类均为纯文字，关闭仍为具备名称的纯图标；1280px 与 390px 弹窗无横向溢出。宿主实际 HTML/CSS 的卡片样本在 1024px 与 360px 下无横向溢出，菜单动作无 SVG，独立悬浮入口保留 SVG。
- 贪吃蛇内联脚本通过语法编译；源码引用检查、`git diff --check` 与记录链接检查通过。未进行贪吃蛇完整游戏流程、运行中桌面的真实会话或跨平台验收；定向测试不代表全仓测试。

## 关联

- 前项：[删除会话标题栏的装饰气泡图标](2026-11-11-remove-session-heading-icon.md)。
- 设计：[Web 客户端设计](../../../../docs/web-client-design.md)、[客户端 Shell](../../../../docs/modules/web/client-shell.md)。
- 实现：[会话视图](../../../../packages/app-harness/src/web/session-view.ts)、[设置模板](../../../../packages/app-harness/web/template.html)、[文件栏](../../../../packages/app-harness/src/web/file-sidebar.ts)、[宿主界面](../../../../packages/host/src/web/client.ts)、[静态资源图](../../../../packages/app-harness/src/assets.ts)。
- 验证入口：[会话视图测试](../../../../tests/session-view.test.mjs)、[导航测试](../../../../tests/harness-navigation.test.mjs)、[宿主界面测试](../../../../tests/application-shell.test.mjs)、[Claude Agent 界面测试](../../../../tests/claude-agent-web.test.mjs)。
