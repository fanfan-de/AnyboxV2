# Claude Agent 独立服务访问管理组件

[Claude Agent 模块](README.md) · [Host Access](../web/host-access.md) · [独立业务服务](../../application-standalone-services.md)

`packages/app-claude-agent/src/server-access.ts` 的 `createClaudeAgentAccessComponent(name?)` 创建 `claude-agent-access`，独立服务在自己的唯一 Nya 根安装它；仅注入该根的 `local-storage`。认证实现由 Claude Agent 包拥有，不导入 `@anybox/host`，Anybox 集成使用宿主原访问组件，业务装配不要求事先存在它。

公开服务沿用 `host.access: HostAccessPort` 兼容键和 `application-api/node` 的端口类型；这只表示兼容契约，不表示依赖 host 包或安装宿主组件。独立服务与 Anybox 托管组合分别选用一个实际所有者。

组件保留既有 `host-access` v2 迁移域、`host_identity` / `host_access_tokens` 表、实例 UUID、令牌格式与 `managed_owner` 语义。随机秘密只在发行本次返回，持久化 SHA-256 摘要，以常量时间比较；列表不暴露秘密、摘要或 owner。原托管实例的身份与令牌在正常关闭后可由独立入口继续使用；独立服务不能与托管实例或另一个独立服务同时打开同一数据文件。

端口负责实例信息、拥有者 Bearer 认证、发行/列表/撤销令牌、受信托管令牌收敛与离线身份重置。这里的设备访问令牌与用户 Claude 环境的 OAuth/API 凭据分开；不读取或复制 Claude 凭据，也不接入 Models Vault。

撤销与身份重置先提交数据库并移除旧认证索引，再通知并等待全部观察者实际退出；观察者失败不回滚认证事实。应用监听器关闭该令牌所属响应和 SSE，已接受 Run 继续由 Runs 管理。Effect 停止新操作，等待在途数据库写入与观察清理后释放索引和订阅，SQLite 提供方随后关闭。

`server-http.ts` 的[独立监听组件](listener.md)注入此访问服务，负责认证请求、实例绑定、请求与流式资源关闭；依赖撤销由 Nya 关闭并重绑。`server.ts` 的服务关闭同步停止新 HTTP 与 Run 准入，再并行等待根清理与请求排空，避免 `retainUntil(waitRun)` 阻止 Run 取消。

验证入口：应用独立服务与隔离安装测试、`tests/claude-agent-http.test.mjs`、`tests/claude-agent-runs.test.mjs` 及根 `npm run check`。受控 SDK 测试覆盖认证、SSE、取消、SIGTERM 和端口/数据库锁释放；真实 `claude` 验证仍由 `ANYBOX_CLAUDE_AGENT_TESTS=1` 单独门控。
