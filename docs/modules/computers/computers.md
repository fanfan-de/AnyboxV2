# Computers 组件

[返回 Computer 模块](README.md) · [模块导航](../README.md) · [Computer 资源设计](../../computer-resource-design.md)

## 职责、工厂与依赖

`createComputersComponent(inputs)` 安装根上的 `harness-computers`，提供 `harness.computers: ComputersPort`。组件 inject 本轮 `local-storage` 和 `computer.instance-provider`，登记稳定逻辑资源、按需共享实例激活及持久固定引用。实例提供方实现留在独立端口内，不把 SDK、认证或进程句柄写入业务库。

源码：[component.ts](../../../src/applications/harness/core/computer/component.ts)、[port.ts](../../../src/applications/harness/core/computer/port.ts)、[domain.ts](../../../src/applications/harness/core/computer/domain.ts)。本机提供方见[本机实例提供方](local-instance-provider.md)。

实例激活按需确认独立本机 worker 的固定 workerId/bootId；命令执行与重启接续由 Operations、Session 和 worker 协作，Computers 本身不执行命令。Computers 不消费 Session、RunRuntime 或 Computer Operations，不反查操作队列。当前不提供跨机器迁移。

## 接口与固定身份

| 接口 | 行为 |
| --- | --- |
| `reserveIn(tx,{computerId,spec})` | 同步登记逻辑资源；同 ID/规格返回既有资源，规格冲突拒绝；不激活实例 |
| `get(computerId)`、`list()` | 查询持久资源，不触发激活 |
| `activate(computerId): OwnedCall<ComputerInstance>` | 同一组件代、同一资源共享提供方激活；提供方实际退出后才提交实例 |
| `requireInstance({computerInstanceId,instanceGeneration})` | 只接受逻辑资源当前 ready 实例及确切代次 |
| `pinIn(tx,{pinId,ownerId,computerInstanceId,instanceGeneration})` | 同步建立固定引用；重复同一活动引用幂等，归属或实例冲突拒绝 |
| `releasePinIn(tx,pinId,ownerId)` | 只允许所属 owner 幂等释放；不终止其他使用者 |
| `getPin(pinId)` | 返回固定引用及可空 releasedAt |

`ComputerResource` 保存 computerId、固定规格（providerId/platform/architecture）、activationRevision 和 createdAt；登记不要求当前存在实例。`ComputerInstance` 保存独立 computerInstanceId、computerId、instanceGeneration、providerId/providerRef、平台、架构、activatedAt 和 ready/retired 状态。它与 harness server 的 instanceId 分开。

本机在组件重启后重新按需确认：提供方引用仍相同则复用原实例 ID 和代次；提供方引用变化，且旧实例没有活动 pin，才保存新实例并增加 instanceGeneration。旧代无法被 requireInstance 或新 pin 接纳。确认本身不恢复进程，进程仍归既有工具 scope。

## 存储与事务归属

组件在 apply 中登记 `computers` 迁移域 v1，拥有 `harness_computers`、`harness_computer_instances` 和 `harness_computer_pins`。连接与序列化事务归 local-storage；不建立额外 SQLite、项目 Context 或机器 Context。

资源规格、当前实例和代次是持久事实。activationRevision 表示本次按需确认修订；提供方调用始终在事务外。激活结果只有在 `result` 成功且 `done` 实际退出后才固定，提交时复核修订。首次实例为 generation=1，后续替代实例递增；失败不创建 ready 实例。

调用方必须在同一业务事务中提交操作/workspace binding 与 `pinIn`，同样在确切 scope 退出后同事务释放相关归属。Computers 只写自己拥有的表，固定引用不由异步 acquire/release 模拟。释放记录保留，不能以同一 pinId 再次建立引用，防止迟到释放影响新归属。活动 pin 阻止替换当前实例；释放固定设备引用不关闭用户机器。

## 取消、关闭与失败

activate 的调用取消只结束本地观察，其他等待者和共享激活继续。激活拥有者是组件；观察 `done` 仅表示该观察退出。正常结果会等待提供方的实际退出，随后返回耐久实例。

Effect 先关闭新准入，再取消本代未退出的提供方调用，等待已接受激活和数据库工作完成。close 不删除已提交资源、实例或 pin，不把已确认本机当作需要销毁的云实例。提供方 `done` 清理失败返回 computer-cleanup-failed，组件关闭同样报告清理失败。

公开失败使用 ComputerError 的固定 code：computer-invalid、computer-conflict、computer-missing、computer-unavailable、computer-cancelled、computer-generation-mismatch、computer-pinned、computer-cleanup-failed。适配器原始错误不穿透端口。无效规格、不存在资源、旧代次和错误 pin owner 不产生执行副作用。

## 验证

[computer-resources.test.mjs](../../../tests/computer-resources.test.mjs) 使用真实临时 SQLite 和受控提供方验证无激活登记、事务回滚、并发共享、单观察取消、实际退出屏障、持久实例身份、换代栅栏、pin 归属与关闭等待。测试不依赖 Unix Shell，Windows 可运行。根验证入口为 `npm run check`。
