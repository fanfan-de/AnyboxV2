# Harness 独立服务访问管理组件

[Web 与服务接入](README.md) · [Host Access](host-access.md) · [独立业务服务](../../application-standalone-services.md)

`packages/app-harness/src/server-access.ts` 的 `createHarnessServerAccessComponent(name?)` 创建 `harness-access`，提供 `harness.access: HarnessServerAccessPort`，只注入 `local-storage`。它由 Harness 独立服务安装；Anybox 集成仍由宿主的 `host-access` 提供该组合实例身份，不在同一数据连接重复安装两种所有者。

组件拥有稳定实例 UUID、设备令牌摘要和内存认证索引。`apply` 在既有业务连接登记 `host-access` v2 迁移，读取 `host_identity` 与 `host_access_tokens` 后返回，不运行长期循环。保持原表、迁移账本、`managed_owner` 元数据、令牌 `UUID.secret` 格式及 SHA-256 常量时间比较；原 v1/v2 数据、实例和已发行令牌可供独立入口继续使用。新服务键不改变持久标识。

端口提供 `instance`、`authenticate`、令牌发行/列表/撤销、受信托管令牌收敛和离线身份重置。完整令牌只在发行本次返回，列表不包含秘密、摘要或 owner；设备令牌沿用拥有者权限。Computer 单元凭据由单元组件独立认证，不进入本组件令牌索引。

撤销与重置先提交并更新内存索引，再通知并等待撤销观察者；观察清理失败不回滚已提交认证事实。独立监听器关闭该 actor 的响应，Harness HTTP 适配器取消并等待其目录请求、文件游标和 SSE，不因观察关闭取消已接受 Run。Effect 停止准入，等待已接受数据库操作与撤销观察者，清空索引和订阅；业务 SQLite 在依赖退出后关闭。

业务 HTTP 在 `http/harness-http.ts` 中通过集成来源声明 `harness.access` 依赖，使用本轮 `deps` 捕获身份与撤销端口；依赖撤销会关闭旧适配器，不能把旧请求转给新代。[独立监听组件](harness-listener.md) 同样注入此服务，由 Nya 在访问依赖撤销时关闭并重绑。

验证入口：独立服务与隔离安装测试、`tests/host-access-lifecycle.test.mjs`、`tests/remote-harness-server.test.mjs` 及根 `npm run check`。必须验证托管关闭后独立重开旧身份/令牌、撤销观察等待和同数据文件排他失败；真实系统 Vault 或模型未由此证明通过。
