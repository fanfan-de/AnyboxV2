# Agent Note: MCP stdio 连接

Status: implemented

## 问题

MCP 环境已经支持多连接和逐工具授权。两款应用还需要运行本地 stdio Server，并跟踪取消后的真实进程退出。

## 决策

两款应用的 MCP 环境新增 stdio 连接，沿用目标绑定和逐工具授权。显式发现使用临时进程并在其退出后发布目录。实际调用按 Run 和目标按需启动、复用并关闭子进程，复用已有原生进程监督器确认受管进程树及管道实际退出。取消发送关联通知、关闭 stdin，必要时由监督器终止受管树。Streamable HTTP 与 stdio 共享协议发现和请求处理。

## 备选方案

按连接常驻共享子进程会让一次需要终止进程的撤权影响同连接的其他 Run。按 Run 和目标持有进程可以把这一影响收窄。

## 影响与代价

stdio Server 从执行端显式配置的绝对路径与参数数组启动。启动前登记持有记录。退出证据缺失时保留同一启动配置的准入限制，普通退出在真实确认并提交后释放记录。旧 HTTP 连接的持久身份保留。应用版本提升到 Harness 0.1.9、Personal Agent 0.2.3，共享 MCP 包为 0.2.0。

## 验证

`npm run check` 完成类型检查、构建和测试，2453 项通过、18 项跳过、0 项失败。两款应用都通过正常网关和 Run 流程调用真实 stdio Server，覆盖同名工具隔离、未授权调用未启动进程、发现及成功 Run 后退出，以及取消、撤权和停用后确认抗 SIGTERM 的子进程及孙进程退出。包级测试覆盖旧 HTTP 数据迁移和重启后未确认持有记录。两个 macOS arm64 本地应用目录均已临时构建，并用包内 stdio 客户端启动、调用和关闭真实子进程。模型响应由测试夹具生成，其他平台及签名发布未验证。

## 关联

- [MCP 执行环境组件](../../../../docs/modules/tools/mcp-environment.md)
- [MCP 多连接首版](2026-11-22-mcp-execution-environment.md)
- [stdio 进程及 HTTP 兼容测试](../../../../packages/mcp-environment/tests/stdio-lifecycle.test.mjs)
- [两款应用端到端测试](../../../../tests/mcp-execution-environment.test.mjs)
