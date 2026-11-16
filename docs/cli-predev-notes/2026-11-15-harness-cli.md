# Agent Note: Harness 显式目标 HTTP 客户端 CLI

Status: proposed

实现已在工作区完成；完整检查与真实 HTTP 验证被环境阻塞。`.agents/` 只读，本文暂存应归入 `.agents/notes/proposed/feature/` 的方向记录；`.git/` 也只读，不能创建 index.lock 或提交。本轮没有新 commit。

## 问题

Harness 需要与 anybox 框架共用实现的独立 CLI，使用显式服务地址和令牌连接已有服务，且 help 不打开业务资源。

## 方向

应用独占静态命令注册、私有 CLI 目标配置和 HTTP/SSE 客户端。已实现 target add/list/use/check/remove、agents/models/projects list、session list/show/create、run start/show/watch/cancel/find，以及 anybox-harness 独立入口；版本提升为 0.1.6，应用配方、distribution 依赖和 lock 同步。

目标令牌只经隐藏输入或 token-stdin 接纳；POSIX 校验目录/文件归属、权限及直接符号链接，独占写锁与同步原子替换。固定 endpoint/instanceId，不跟随重定向，不重试写入。Run 显式父节点和 request-id，request 信封不冒充 accepted；丢失结果只用原键查询。SSE 只提示查询，订阅退出/重连和定时查询都用服务器快照补齐，取消观察不取消 Run。JSON 请求/响应有上限和超时，错误及反射 token 不泄露连接秘密。

## 备选方案

未采用桌面 SQLite/Vault 共享、CLI 内运行时或自动启动，遵守已有服务客户端方向。未把 SSE 当可重放事件日志或拼接输出事实。没有用 POSIX 文件 mode 冒充 Windows ACL：目标存储在 Windows 明确返回 unsupported，待专门适配。

## 影响与代价

连接文件存储 token 原文，属于应用 CLI 私有配置，默认路径和权限规则见当前手册。已有业务、连接、会话工具快照和审批协议没有改变；没有新增 Nya 组件。session create 暂无服务端幂等键，未知结果不得盲目重试；Run 用原键 find。首版只输出查询快照，没有逐 token 文本展示或完整会话树浏览。服务端审批、按会话工具环境选择、桌面零配置共享和自动启动均留待设计。

## 验证

- 同[框架记录](2026-11-15-cli-framework.md)中的定向 strict 编译及 24 项测试命令；其中 Harness 17 项全部通过，另 1 项 Windows 专用存储拒绝用例在 Linux 跳过；Windows 上依赖 POSIX 目标存储的正向用例明确跳过，使用临时配置目录与受控 fetch，覆盖目标管理/权限/链接/锁、隐藏输入接纳、token 脱敏、只读路由、状态码、实例冲突、会话/Run 写入、stdin、未知写入不重试、SSE EOF/失败后补查、终态码和取消清理、有界/身份错误响应。未接触实际 keychain、模型或外部服务。
- 新增 `packages/app-harness/tests/cli-server.test.mjs`，用 createStandaloneHarnessServer、临时 SQLite/JSON、内存凭据、禁止目录联网和假模型覆盖真实 HTTP/SSE 闭环、服务端幂等、分支和实际退出取消。实际运行 `node --test --test-isolation=none --test-timeout=20000 packages/app-harness/tests/cli-server.test.mjs`：2 项失败，均在监听 127.0.0.1 时被沙箱 EPERM 拒绝，尚未执行其业务断言，不能声称集成通过。现有 standalone-server 的独占库测试同样在 listen 处 EPERM。
- 统一与独立入口的 guarded help/版本/补全、token 参数拒绝已直接验证；子进程测试和 npm run check 的真实失败见框架记录。
- `node --check` 对新增集成和入口测试语法检查通过。没有访问真实密钥、真实模型或外部网络服务；没有运行真实 role 服务。

待具备监听权限的环境跑通真实服务集成并修复实测问题，等待完整全仓检查、真实终端隐藏输入/信号与 macOS/Windows 平台验证。原存储与服务关闭测试仍应随完整 suite 复验。

## 关联

- [CLI 使用与架构](../cli.md)
- [框架方向](2026-11-15-cli-framework.md)
- [独立服务](../application-standalone-services.md)
- [应用 CLI 模块](../../packages/app-harness/src/cli/commands.ts)
- [真实服务集成测试](../../packages/app-harness/tests/cli-server.test.mjs)
