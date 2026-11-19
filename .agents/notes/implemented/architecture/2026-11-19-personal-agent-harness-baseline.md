# Agent Note: Personal Agent 从当前 Anybox Harness 开始演化

Status: implemented

## 问题

Personal Agent 的首版另行设计了工作区、任务与文本执行。用户希望以当前 Anybox Harness 的实际产品体验作为 Personal Agent 的开发起点。

## 决策

Personal Agent 0.2.0 以 `ab04844` 的 Anybox Harness 工作区、客户端和原生执行实现为源码起点。项目与会话、分屏、对话树、文件、模型、Prompt、工具和设备操作沿用这个基线。应用继续使用 `personal-agent` 身份，绑定自己的路由、浏览器状态、连接和业务资源，可在原有产品之外独立演化。

发行组合在现有执行根注册 Personal Agent，沿用一套宿主访问服务、应用目标管理和 HTTP 监听。本机配对通过独立的受管令牌域发放，应用网关只代理 Personal Agent 的产品控制和业务路由。Personal Agent 的 SQL、Models、图片、Worker 和 Run 事件有自己的归属。单应用命令启用同一实现，只组合 Personal Agent 的两个角色。

## 备选方案

只沿用界面样式会保留首版的任务与文本执行模型。直接调用已安装 Harness 会耦合安装、启停、凭据和数据。将两款产品改成一个业务框架也会同时改动当前 Harness，且两款产品此后的需求尚未确定。本次选择有明确来源的独立源码基线。

## 影响与代价

首版任务、对话、文本 Run、委派和成果留在原客户端库，新项目和原生 Session/Run 写入独立执行库。Personal Agent 的 Models JSON 和 Vault 命名空间继续使用。后续同步通用修复需要显式合入；应用包各自包含自己的运行闭包。

## 验证

- `npm run check` 在 Linux 上通过。2389 项测试中 2367 通过、22 按平台或集成条件跳过、0 失败，含全工作区类型检查、构建、浏览器资源图和应用依赖边界。
- Personal Agent 包测试与本机宿主测试通过，覆盖同根运行、项目/会话与 Chat Completions Run、已有 Models JSON 与 Key 复用、旧任务原记录保留及应用控制和数据隔离。隔离检查还验证了同根 SSE 的事件隔离、Computer worker 附着码与撤销。
- Linux Chromium 临时环境走通打开应用、新建项目和会话、设置与本机设备选择、真实 HTTP/SSE 接收受控模型响应、浏览项目文件及来回切换应用。浏览器无页面或控制台错误。测试使用受控模型和内存 Vault。
- Linux x64 本地应用目录通过 `anybox-host verify --trust-local`。Web、client、execution 均 prepared，Computer worker compatible。独立入口通过临时目录启动与 SIGTERM 清理验证。
- 本机开发服务已更新至 `http://127.0.0.1:3030/`，实际本机配对 ready，Personal Agent 执行产品 running，项目与模型连接接口 HTTP 200。未验收 Electron 窗口、macOS/Windows 或真实付费模型调用。

## 关联

- [Personal Agent 使用与组件手册](../../../../docs/modules/personal-agent/README.md)
- [本机宿主的角色隔离测试](../../../../tests/local-web-host.test.mjs)
- [Personal Agent 客户端与执行端集成测试](../../../../packages/app-personal-agent/tests/http.test.mjs)
- [Personal Agent 首版验证记录](../../implemented/feature/2026-11-13-personal-agent-mvp.md)
