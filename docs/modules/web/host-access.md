# Host Access 组件

[宿主与客户端模块](README.md)

`src/host/access.ts` 的 `createHostAccessComponent(name?)` 创建 `host-access`，通过 `host.access: HostAccessPort` 提供实例信息、认证、令牌发行/元数据/撤销与离线身份重置。只 inject `local-storage`，复用执行端业务连接；`apply` 登记 `host-access` v1 后读取稳定 UUID 与有效摘要并返回，不运行长期循环。

独占 `host_identity`、`host_access_tokens` 表和内存认证索引；随机令牌由 UUID 和 256 位随机秘密组成，仅发行返回完整值，持久化 SHA-256 摘要。使用常量时间比较；普通日志、元数据、历史不含完整令牌。`resetIdentity()` 是受信离线入口，HTTP 不暴露该方法。设备令牌均为拥有者权限，不作为新的业务用户。

认证拒绝返回 `authentication-failed`，实例校验在 API 边界；关闭后拒绝新操作。撤销提交后移除认证索引并通知监听者，API 关闭对应观察响应，但不取消已接受 Run。Effect 停止准入并等待在途数据库写入，最后清除索引和观察者。Nya 在 API 退出后才卸载该依赖。

业务数据迁移账本与已有 Session 格式不变。`init`、`recover-access`、`new-identity` 均须取得数据库锁；复制为独立实例使用后者。行为测试见 `tests/remote-harness.test.mjs`、`tests/deployment-boundaries.test.mjs`，执行 `npm run check`。
