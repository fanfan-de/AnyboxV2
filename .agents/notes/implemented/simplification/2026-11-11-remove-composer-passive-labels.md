# Agent Note: 删除 Composer 左下角无交互标记

Status: implemented

## 问题

Composer 左下角显示 Agent ID（如 `assistant`）和“继续此分支”，用户要求确认其是否有交互意义，没有则删除。检查发现两项均为普通 span：前者仅呈现会话 Agent ID，后者仅更新当前位置文字与 title，没有点击、键盘或发送行为。

## 决策

删除两项标记、承载它们的 `composer-meta`、对应渲染更新和专属样式，包括窄屏样式。Footer 使用 `justify-content: flex-end`，使项目文件引用、图片和发送操作继续靠右；保留实际分支导航与 `.actions` 操作容器。

## 备选方案

比较了仅隐藏两项的做法；既然不再展示，保留 DOM、每轮渲染和样式只会增加维护成本，因此直接删除。未将展示文字改造成新交互入口。

## 影响与代价

输入框不再重复显示 Agent ID 和“新分支 / 继续此分支 / 只读历史”标记。实际分支位置仍由上方导航呈现，归档提示和旧会话只读限制继续由原有控件处理。没有更改会话、Run、提交父节点、资源所有权或生命周期。

## 验证

- `npm run build --workspace packages/app-harness` 通过，包含 TypeScript 编译及应用构建。
- `node --test tests/session-view.test.mjs tests/session-client.test.mjs tests/model-selection-client.test.mjs`：123 项全部通过，无失败、取消或跳过；覆盖既有分支导航、草稿、模型选择、提交和只读边界。
- 浏览器使用现有内存会话样本，分别检查常规宽度和 320px 窄屏：三项已删除 class 的 DOM 数量为零，操作区右边缘与 Footer 对齐，窄屏操作区位于 Composer 边界内。现有样本缺少公共浏览器模块的 import map，本次仅在临时内存入口补齐映射后验收，未修改样本文件。
- 本轮源文件与记录的 `git diff --check` 通过。未运行全仓测试、真实模型调用或桌面打包；本轮仅为本机 Web 展示删除。

## 关联

- [会话面板](../../../../packages/app-harness/src/web/session-view.ts)、[应用样式](../../../../packages/app-harness/web/style.css)。
- [Web 外壳与应用边界](../../../../docs/modules/web/client-shell.md)。
- [会话面板行为测试](../../../../tests/session-view.test.mjs)、[会话控制器测试](../../../../tests/session-client.test.mjs)、[模型选择测试](../../../../tests/model-selection-client.test.mjs)。
- [内存浏览器样本](../../../../tests/helpers/conversation-tree-browser-host.mjs)。
