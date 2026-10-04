# Host Access 组件

[宿主与客户端模块](README.md)

`src/host/access.ts` 的 `createHostAccessComponent(name?)` 创建 `host-access`，通过 `host.access: HostAccessPort` 提供实例信息、认证、令牌发行/元数据/撤销与离线身份重置。只 inject `local-storage`，复用执行端业务连接；`apply` 登记 `host-access` v2 后读取稳定 UUID 与有效摘要并返回，不运行长期循环。v2 为令牌增加可空 `managed_owner` 与索引，原 v1 令牌保持普通令牌，不根据名称推断归属。

独占 `host_identity`、`host_access_tokens` 表和内存认证索引；随机令牌由 UUID 和 256 位随机秘密组成，仅发行返回完整值，持久化 SHA-256 摘要。使用常量时间比较；普通日志、元数据、历史不含完整令牌。`resetIdentity()` 是受信离线入口，HTTP 不暴露该方法。设备令牌均为拥有者权限，不作为新的业务用户。

受信桌面配对通过 `issueManaged(owner,name)` 明确登记令牌归属，完整令牌只返回本次调用，不写明文文件；公开 HTTP 发行仍调用普通 `issue(name)`。`reconcileManaged(owner,retainedToken)` 在同一业务事务中验证保留令牌的完整秘密、有效状态与 owner，再撤销该 owner 的其余有效令牌；传 `undefined` 撤销该 owner 全部令牌。错误保留值返回 `invalid-managed-token`，整个事务不改变任何令牌；普通令牌和其他 owner 不受影响。普通 `list()` DTO 不暴露 owner、摘要或秘密。这两个管理方法没有公开 HTTP 路由，只供受信控制面使用。

认证拒绝返回 `authentication-failed`，实例校验在 API 边界；关闭后拒绝新操作。撤销先提交并移除认证索引，再同步通知全部监听者；`onRevoked` 可返回 `Promise<void>`，`revoke()` 等待全部观察者实际退出后返回。`resetIdentity()` 同样先固定新身份并清空认证索引，再等待全部旧令牌观察者。API 关闭对应观察响应，harness server HTTP 取消并等待该 actor 的目录请求与游标清理，但不取消已接受 Run。观察者失败不能撤销已提交的认证变更，也不能阻止其他观察者清理；失败记录固定日志，不暴露底层错误。Effect 停止准入并等待在途数据库写入及撤销观察者退出，最后清除索引和观察者。Nya 在 API 退出后才卸载该依赖。

实例 HTTP DTO 继续使用 API v1；Application API 对稳定产品控制入口宣告 `products.v2`，并根据实际 Projects 浏览支持动态添加 `projects.browse`；这两项由 HTTP 宿主判断，不由 Access 无条件宣称。浏览会话绑定认证令牌；设备拥有者权限仍受执行进程操作系统账户限制，不提供提权。

托管令牌收敛同样先提交和移除索引，再等待撤销观察者实际退出；Effect 等待该操作完成。Session 格式和其他业务迁移域不变。`init`、`recover-access`、`new-identity` 均须取得数据库锁；复制为独立实例使用后者。行为测试见 `tests/desktop-host-boundaries.test.mjs`、`tests/host-access-lifecycle.test.mjs`、`tests/project-file-tree-http.test.mjs`、`tests/remote-harness-server.test.mjs`、`tests/deployment-boundaries.test.mjs`，执行 `npm run check`。
