# Agent Note: 悬浮应用菜单与独立应用管理

Status: implemented

## 问题

本篇在 2026-11-11 审计交付时补录当前未提交工作区中的独立目标。原变更时间和完整讨论无法从当前证据确认；依据为当前 Git diff、实现、测试及现行 `client-shell` 文档。改动将宿主常驻左侧导航改为悬浮入口，让应用占满挂载区域，并将较长的安装和管理内容放进独立窗口。

## 决策

宿主保留一个可拖动图标，单击展开按目录排列的应用菜单；拖动使用阈值、指针捕获与点击抑制，坐标按窗口边界约束并保存在当前标签页的 `sessionStorage`。菜单根据图标及窗口尺寸调整位置，终止页面生命周期时移除监听和尺寸观察。

“管理应用”打开原生 modal dialog，保留当前应用挂载和草稿。“安装应用”入口位于管理标题区，按需展开来源选择，收起或退出管理释放本地文件引用。恢复操作保留在应用行详情以外，确保折叠详情后仍能看到启动重试和界面重载。应用切换、关闭、停止及版本生效继续使用已有工作区与界面生命周期协调，不新增业务状态或组件。

审计确认当前 Shell 说明已采用新入口，但产品设计、Web 设计、模块边界、测试应用安装指引及部分包管理文档仍指导使用旧侧栏或“我的应用”浮层。本轮统一当前接口与用法，保留日期明确的历史决策和历史界面审计原文，避免把当前 UI 当作旧验收的事实。

## 备选方案

本次补录未复原原始设计讨论，未比较其他方案；不根据最终代码推测作者曾否决的方向。

## 影响与代价

宿主不再占据固定侧栏和顶栏，当前应用标记在悬浮图标提示和菜单中展示。安装管理进入独立 dialog，展开状态不跨关闭保留。现有 `anybox.apps.workspace.v1` 的 tabs 数据、应用内部路由、前端 dispose、后台目标及完整页面生效保护保持原有契约。位置偏好仅属于浏览器标签页，不构成应用或安装事实。

## 验证

审计沿 `enterApplication`、`closeApplicationPageWork`、`stopApplicationWork` 与 `prepareInterfaces` 的真实调用路径检查控制条件和清理等待；未发现本目标引入的可证实生命周期回归。现有 `floating-application-menu` 测试覆盖拖动阈值、点击与键盘、位置恢复、边界、内容尺寸变化、取消和退出清理；`application-shell` 测试覆盖多应用切换、草稿保护、管理开关、失败恢复、卸载及版本生效；包管理测试覆盖安装入口折叠与独立标题区清理。

本轮根 `npm run check` 完整通过，包括全仓类型检查、构建和全部测试：2206 项中 2185 项通过、21 项按门控跳过，0 失败、0 取消。`git diff --check` 通过。本轮未重新执行真实浏览器拖动、触屏、原生 dialog 或桌面跨平台实测；Node DOM 替身不能证明这些环境下的实际布局和原生事件顺序。

## 关联

- 当前说明：[客户端 Shell](../../../../docs/modules/web/client-shell.md)、[Web 客户端设计](../../../../docs/web-client-design.md)、[产品设计](../../../../docs/anybox-product-design.md)、[宿主模块边界](../../../../docs/harness-module-boundary.md)。
- 实现：[宿主 Shell](../../../../packages/host/src/web/client.ts)、[悬浮菜单](../../../../packages/host/src/web/floating-application-menu.ts)、[包管理界面](../../../../packages/host/src/web/package-management.ts)。
- 验证：[悬浮菜单测试](../../../../packages/host/tests/floating-application-menu.test.mjs)、[宿主界面测试](../../../../tests/application-shell.test.mjs)、[包管理界面测试](../../../../packages/host/tests/package-management-web.test.mjs)。
- 相关方向：[统一自有界面的文字与图标表达](../simplification/2026-11-11-single-mode-ui-labels.md)。Claude Agent 提示和贪吃蛇图标简化已由该篇记录，本篇不重复归入。
