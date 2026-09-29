# Client Connections 组件

[宿主与客户端模块](README.md)

`src/host/client/connections.ts` 的 `createConnectionsComponent({namespace?,openEntry?,fetch?})` 创建 `client-connections`，提供 `client.connections: ConnectionsPort`。inject 客户端根的 `local-storage`，此根只打开独立 `client.sqlite`，不共用执行库。`namespace` 默认 `anybox.client`；`openEntry` 是测试/平台替身边界。

组件拥有 `client-connections` v1 的连接表和凭据意图日志，以及独立 system-keyring-store 句柄。公开 list/save/check/remove 不返回 token 或 credentialRef；只有受信网关 acquire 获得本次固定的配置版本与 token。连接包含本机 ID、名称、地址、固定 instanceId、revision；编辑使用 expectedRevision。相同 instanceId 不重复登记。

只允许 HTTPS 或显式 127.0.0.1 / ::1 HTTP，拒绝 URL 用户信息、query、fragment。配对调用认证后的实例信息接口，禁止重定向、限制响应大小与 15 秒超时，核对 API 版本；改地址须匹配原 instanceId。网络检查不占用串行配置/凭据队列，提交时重新检查版本，离线设备不阻塞其他设备读取。

写入新令牌先事务记录 intent，再等待原生系统凭据写入，再事务替换引用并登记旧条目清理。失败保留原连接，未清理 intent 下次编辑/启动重试。凭据不可用返回固定错误，元数据仍可查询；不使用明文或 SQLite 后备。移除仅删除连接及其凭据引用，不调用目标 Run 或进程控制。

Effect 停止准入、取消握手、等待全部已接受操作与 native keyring 实际完成，然后关闭凭据句柄；数据库由其提供方随后关闭。请求可通过 AbortSignal 提前退出网络检查。组件初始化后立即返回。

测试：`tests/remote-harness.test.mjs` 的失败写入、重启、身份变化、凭据不可用和元数据无秘密；真实平台测试由 `ANYBOX_DEPLOYMENT_TESTS=1` 门控，跳过不代表验收通过。根验证 `npm run check`。
