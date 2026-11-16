# Agent Note: Harness 显式目标 HTTP 客户端 CLI

Status: implemented

本篇于 2026-11-16 补录原预开发方向。原临时记录以 `2026-11-15` 命名，提交 `d481449` 于 2026-11-16 收录实现和记录；文件名不足以确定实际开发时间。正式记录替代原 `docs/cli-predev-notes/2026-11-15-harness-cli.md`，保留原验证限制并明确后续结果。

## 问题

Harness 需要与 `anybox` 框架共用实现的独立 CLI，通过显式服务地址与令牌连接已有服务，且 help 不打开业务资源。

## 决策

应用独占静态命令注册、私有目标配置和 HTTP/SSE 客户端，实现目标管理、Agent/模型/项目查询、会话查询与创建、Run 启动/查询/观察/取消/按请求键查找，以及 `anybox-harness` 独立入口。应用版本提升为 0.1.6，配方、distribution 依赖与 lock 同步。

令牌只经隐藏输入或 `token-stdin` 接纳，POSIX 目标存储校验归属、权限与直接符号链接，使用独占写锁及同步原子替换。请求固定 endpoint/instanceId，不跟随重定向或重试写入。Run 显式提供父节点及 request-id，未知提交结果只查原键。SSE 提示客户端补查服务器快照，取消观察不取消已接受的 Run；显式取消等待实际退出。请求、响应和错误投影保持有界并避免泄露目标令牌。

## 备选方案

未采用共享桌面 SQLite/Vault、在 CLI 中内嵌运行时或自动启动服务，保持已有服务客户端方向。未将 SSE 当作可重放事件日志或拼接输出事实。未以 POSIX mode 代替 Windows ACL；目标存储在 Windows 明确报告 unsupported，等待专门适配。

## 影响与代价

连接文件包含 token 原文，归应用 CLI 私有配置，路径与权限约定维护在当前手册。没有新增 Nya 组件或改变现有会话、工具快照与审批协议。会话创建暂无服务端幂等键，未知结果不得盲目重试；Run 可按原键查找。首版输出查询快照；服务端审批、按会话工具环境选择、桌面共享、自动启动服务及 Windows ACL 留待独立设计。

## 验证

- 原预开发轮次的 Harness 单元测试 17 项通过，覆盖临时目标存储、隐藏输入接纳、令牌脱敏、实例约束、会话/Run 请求、未知写入不重试、SSE 补查、终态码及取消清理；另 1 项 Windows 专用用例在 Linux 跳过。当时真实 HTTP 测试在监听回环地址时遇到沙箱 EPERM，业务断言尚未执行，完整检查也被框架依赖阻塞。
- 后续在 Linux Node v24.16.0 跑通真实 HTTP/SSE 集成 3 项，覆盖幂等提交与分支、显式取消等待模型退出、实际 SSE 字节读取，以及中断观察后 Run 继续并可再次观察到完成。使用临时 SQLite/Models JSON、内存凭据、禁止目录联网和受控模型，无真实付费模型调用。
- 最终根 `npm run check` 完整通过：类型检查、全量构建和 2386 项测试，2364 通过、22 项门控跳过、0 失败。CLI 目标查询和浏览器本机目标的实测范围见[后续修复记录](../bug-fix/2026-11-16-restore-nya-bindings-and-cli-integration.md)。
- Windows/macOS、Electron、真实模型、系统凭据与真实终端隐藏输入/信号未由本轮验收。

## 关联

- [CLI 当前契约与用法](../../../../docs/cli.md)
- [通用 CLI 框架方向](../architecture/2026-11-16-cli-framework.md)
- [独立业务服务](../../../../docs/application-standalone-services.md)
- [应用 CLI 实现](../../../../packages/app-harness/src/cli/commands.ts)
- [CLI 单元测试](../../../../packages/app-harness/tests/cli.test.mjs)
- [真实 HTTP/SSE 集成测试](../../../../packages/app-harness/tests/cli-server.test.mjs)
