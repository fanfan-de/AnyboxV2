# Claude Agent 独立服务 HTTP 监听组件

[Claude Agent 模块](README.md) · [访问管理](access.md) · [业务 HTTP](http.md) · [独立业务服务](../../application-standalone-services.md)

`packages/app-claude-agent/src/server-http.ts` 的 `createClaudeAgentListenerComponent(root,{port?,host?})` 创建 `claude-agent-listener`，提供 `claude-agent.listener`（`url` 与幂等 `close()`）。它只注入应用自己提供的兼容 `host.access` 端口，不注入 `claude-agent.http`；每个请求在首次异步工作前从根捕获当前业务适配器，缺失返回 503。

组件拥有 TCP socket、请求体读取、活动响应和任务集合、取消信号、保留操作及令牌撤销订阅。`apply` 启动监听后返回，默认回环地址，端口 `0` 允许系统分配。请求以设备 Bearer 令牌认证，除 `/api/v1/instance` 外校验 `X-Anybox-Instance-Id`；只提供实例、令牌管理和 `/api/v1/apps/claude-agent`，不提供宿主管理路由、页面、Harness 旧别名或 Computer 单元入口。

令牌撤销关闭其响应和 SSE；浏览器断开仅结束观察，已接受 Run 不随断流取消。`close()` 同步停止准入、取消观察与不完整请求体，等待 HTTP/SSE、socket 及 `retainUntil(waitRun)` 的保留操作真实退出。Effect 关闭相同资源，认证依赖撤销时由 Nya 关闭旧监听并使用新代访问端口重新建立，不能缓存跨组件重启的认证索引。

独立工厂按存储 → 访问 → 监听 → 业务顺序安装组件。监听器不依赖业务 HTTP，因此整根清理可以先取消并等待 Runs，再等待监听器保留的请求。`prepareClose()` 先停 Run 准入并启动监听排空，`close()` 并行等待整根与监听实际退出；Anybox 注册只使用业务 HTTP，不安装独立监听器。

验证入口：应用独立服务测试、`tests/application-standalone-isolation.test.mjs`、`tests/application-standalone-compatibility.test.mjs` 与根 `npm run check`。覆盖认证拒绝与撤销、SSE、取消、认证组件重启、关闭期间准入、SIGTERM、端口及数据库锁释放；真实 Claude 环境仍单独门控。
