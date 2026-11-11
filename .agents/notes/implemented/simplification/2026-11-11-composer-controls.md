# Agent Note: 简化 Composer 并下移模型选择

Status: implemented

## 问题

Composer 顶部常驻显示会话工具清单及“创建时固定”，占据输入区并暴露不参与当次输入的配置细节。用户要求移除该展示，同时将模型选择移到 Composer 靠下的位置。

## 决策

移除工具清单 DOM、渲染逻辑、专属样式及仅服务该展示的名称转换函数和断言。消息输入放在上方，模型选择移至底部左侧，附件和发送控件位于底部右侧；窄面板允许底部换行。同步现行 Web 文档。

## 备选方案

不将工具清单改为 Composer 内的折叠区或图标入口，避免增加与本次消息无关的控件；现有工作区“Agent 工具”继续负责配置。

## 影响与代价

仅调整 Web 展示与控件位置，保留 Agent 工具配置、Session 不可变工具快照、真实工具调用卡片及轨迹。底部空间不足时控件换行，模型选择原有选项与可用性规则继续使用现有实现；不涉及业务数据或资源生命周期。

## 验证

`npm run build --workspace packages/app-harness` 通过。`node --test tests/session-view.test.mjs tests/tool-call-view.test.mjs tests/model-selection-client.test.mjs tests/tools-client.test.mjs` 的 72 项测试全部通过，覆盖会话展示、工具调用卡片、模型选择持久化和 Agent 工具设置；使用已有 Node 24 工具链。`git diff --check` 通过。

Chrome 宽屏验证使用临时回环 HTTP 页面，直接挂载已构建的 `createSessionPanel` 并原样加载宿主与应用 CSS，模型和 Session 来自内存替身。实际 DOM 与截图确认无工具摘要，模型位于文本框下方左侧，附件与发送位于右侧；长模型名省略显示，页面无横向溢出。验证完成后临时服务已停止。

窄屏仅核对了 CSS 换行和收缩规则；尝试 360px 浏览器视口时控制调用超时，未完成窄屏实际浏览器验证。运行中应用新页返回 `forbidden-origin`，未更改其安全设置或重启服务；未完成该页面或真实模型验证。以上 72 项测试为定向测试，不代表全仓或跨平台验收。

## 关联

- 当前说明：[Web 客户端设计](../../../../docs/web-client-design.md)、[Web 前端](../../../../docs/modules/web/web-frontend.md)。
- 实现：[会话视图](../../../../packages/app-harness/src/web/session-view.ts)、[样式](../../../../packages/app-harness/web/style.css)、[工具卡片](../../../../packages/app-harness/src/web/tool-call-view.ts)。
- 验证：[会话视图测试](../../../../tests/session-view.test.mjs)、[工具展示测试](../../../../tests/tool-call-view.test.mjs)。
