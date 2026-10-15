# Worker 路由组件

[返回 Computer 模块](README.md) · [单元传输](../units/unit-transport.md) · [本机 worker 客户端](local-worker-client.md) · [Computers](computers.md)

`createWorkerRouterComponent({ local, claimTimeoutMs?, replyTimeoutMs? })` 在 harness server 根安装 `computer-worker-router`，提供 `computer.worker: ComputerWorkerPort` 与 `computer.instance-provider: ComputerInstanceProvider`。inject `harness.unit-transport`；本机形态（`local: true`）另 inject `computer.local-worker`。它是核心代码看到的唯一 Computer 契约：每个调用按授权中的附着路由——`local:computer` 经回环交给本 harness server 自己的 worker，其他附着经单元传输投递到拨出的远端 worker。Computer Operations、Computers、Projects、Project Files 与 RunRuntime 不感知差别。源码：[组件](../../../src/applications/harness/core/computer/worker-router.ts)。

## 配置与接口

`local` 由组合根按 `ANYBOX_COMPUTER_UNIT` 决定：本机形态有回环 worker，远端形态没有，`local:computer` 的调用返回 `worker-attachment-rejected`。`claimTimeoutMs`/`replyTimeoutMs` 覆盖传输默认的领取窗口（10 秒）与回执窗口（60 秒），经组合根的 `computerUnit` 选项传入；领取窗口决定单元离线时准入多久后报告不可用。

| 方法 | 行为 |
| --- | --- |
| `info()` | 本机 worker 的身份、平台与架构；远端形态拒绝 |
| `claimRun` / `submit` / `get` / `query` | 按 `attachmentId` 路由。远端：同一单元 boot 上已成功的 claim 不重复投递；`get` 附带上次状态让单元在本地等待变化；`query` 原样投递 |
| `shutdown()` | 只停止自己拥有的本机 worker；远端固定拒绝 `worker-remote-control` |
| `activate({ resource, previousInstance })` | `spec.providerId` 为 `local` 时向本机 worker 取身份；为 `unit` 时按 `resource.computerId = unit:<attachmentId>` 向该单元请求 `info`。校验平台/架构后返回 `providerRef = workerId:bootId`；上一实例属于同一提供方且 workerId 相同、bootId 不同时附带 `previousExited: true`（同一 worker 目录只有一个存活进程，旧 boot 必已退出），让 Computers 在旧实例仍有未释放 pin 时也能换代。不可达返回 `computer-unavailable`，取消返回 `computer-cancelled`。`providerIds` 列出本组合服务的提供方 ID，Computers 按它接受资源 |

错误映射（远端）：领取窗口内没有单元领取的请求从未到达单元，转为 `worker-unreachable`；已被领取而回执丢失的请求可能已执行，它和之后对同一 `operationId` 的重试都转为可重试的 `worker-unavailable`；本代关闭转为 `worker-observer-closed`。单元自己的拒绝保留原 `name`、`code` 与 `category`（如 `worker-owner-rejected`、`worker-scope-rejected`、文件读取的 `ProjectFileError`），Operations 与 Project Files 的既有规则不变。

## 数据与资源归属

组件没有账本、文件或网络监听；只持有 claim 缓存、`get` 提示、已投递提交的内存表，以及本代在途请求的中止信号。远端单元的逻辑计算机由 Computer Operations 在声明时以 `unit:<attachmentId>` 保留，规格取附着记录里单元声明的平台与架构；本机 worker 的逻辑计算机仍是 `local`。

## 执行、取消与清理

`apply` 立即返回，不等待远端可达；单元不在线表现为激活/声明失败，不是组件 FAILED。Effect 中止本代所有在途远端请求并拒绝新调用；远端单元已接受的操作继续到各自退出，重新装配后按原 ID 查回。本机 worker 的观察由本机客户端自己的 Effect 关闭，worker 进程继续运行。

## 失败与兼容边界

切换形态需要重新装配 harness server；旧 Run 的 scope 没有附着引用时按本机附着解释。本机形态可以同时服务本机项目与绑定到远端附着的项目；远端形态没有本机 worker，`computer.local-worker-control` 不存在，本机附着控制路由返回 503。路由不限定远端附着数量，一个附着一条邮箱。

## 验证

[worker 路由测试](../../../tests/computer-worker-router.test.mjs)覆盖配置解析、无单元时的安装与准入失败、按附着路由与查询面、Effect 只放弃本地观察、远端形态下真实 worker 执行 Bash/Apply Patch 与项目文件读取、单元离线结算与重启后以新代次继续；单元进程 SIGKILL 后带未释放 pin 的换代见[单元故障测试](../../../tests/computer-unit-faults.test.mjs)。完整入口为 `npm run check`。
