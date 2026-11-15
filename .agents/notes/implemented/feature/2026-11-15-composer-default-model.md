# Agent Note: Composer 双击设置默认模型

Status: implemented

## 问题

新会话默认模型只能进入设置修改。用户希望直接在 Composer 选模，并明确要求单击只切换当前会话、双击同时设为新会话默认，不增加独立操作按钮。

## 决策

已将原生模型下拉替换为轻量模型列表，复用现有分组、可用性及协议限制。单击立即选择并保持列表打开以接收双击，点击外部或 Escape 收起；双击通过已有按设备与 Agent 的默认模型接口保存，显示默认标记和保存反馈。方向键与 Enter 选择，Shift+Enter 同时设为默认。选项 DOM、字体尺寸与默认标记占位在第一次点击及异步保存期间保持稳定；保存期间 Escape 仍可把焦点交还触发器。

## 备选方案

原先考虑在选模器旁增加“设为默认”按钮，用户认为交互复杂并明确否决。原生 select 的系统弹出选项无法可靠接收跨平台双击，因此使用应用内列表，不用定时延迟判定单击。

## 影响与代价

默认设置仍由执行设备 Session 组件持有，不新增服务、表或浏览器权威存储；单击不会修改默认，修改默认只影响以后创建的 Session。写入固定原设备、Agent、模型和最新修订，冲突或未知结果不自动重放。自绘列表需要维护焦点、键盘、弹层位置和关闭清理。

## 验证

`npm run build --workspace packages/app-harness` 与该包类型检查通过。最终定向执行 `node --test --test-timeout=30000 --test-reporter=spec tests/session-view.test.mjs tests/composer-default-model.test.mjs`，73 项全部通过；覆盖单击隔离、双击等待选模确认、固定设备/Agent/修订、不可用与只读限制、冲突/未知结果不重发、退出边界、键盘及列表关闭。最终 `npm run check` 通过，2348 项中 2331 项通过、17 项跳过、0 失败，包含全仓类型构建及静态资源闭包验证；`git diff --check` 与测试文件语法检查通过。验证环境为 macOS、Node 24.16.0。

Chrome 使用临时回环 HTTP 页面挂载已构建的真实 SessionController、SessionPanel 与宿主/应用 CSS，API 注入内存替身，选模保存延迟 350ms。实际单击确认当前会话变化而默认写入为零，实际双击确认默认恰好写入一次并出现标记；360px 面板内长模型名双击、Shift+Enter 设置默认及 Escape 恢复焦点均通过。临时标签页及服务已关闭；未读取或修改用户工作区数据、真实默认设置、凭据或远端模型。未完成 Windows/Linux 原生浏览器及触屏设备实测。

## 关联

- [前次 Composer 布局调整](../../implemented/simplification/2026-11-11-composer-controls.md)
- [Web 客户端设计](../../../../docs/web-client-design.md#新会话默认模型)
- [Web 前端](../../../../docs/modules/web/web-frontend.md)
- [Session 默认模型](../../../../docs/modules/sessions/session.md#新会话默认模型)
- [会话控制器](../../../../packages/app-harness/src/web/session-client.ts)
- [模型列表](../../../../packages/app-harness/src/web/model-picker.ts)
- [控制器行为测试](../../../../tests/composer-default-model.test.mjs)、[会话视图测试](../../../../tests/session-view.test.mjs)
