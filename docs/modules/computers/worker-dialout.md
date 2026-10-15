# Worker 拨出组件

[返回 Computer 模块](README.md) · [worker 附着账本](worker-attachments.md) · [单元传输](../units/unit-transport.md) · [本机 worker 客户端](local-worker-client.md)

`createWorkerDialoutComponent({ fetch?, pollWaitMs?, getWaitMs?, requestTimeoutMs? })` 在独立 worker 根安装 `computer-worker-dialout`，提供 `computer.worker-dialout: WorkerDialoutPort`。inject 该根的 `computer.worker`、`computer.worker-attachments` 与 `harness.image-assets`（读取工具图片的原字节）。它是 Computer 单元的网络面：消费附着码、为每个 approved 附着维持一条到远端 harness server 的长轮询循环、把领取到的请求交给本地执行器并回传回执。源码：[组件](../../../src/applications/harness/core/computer/worker-dialout.ts)。

## 配置与接口

选项仅供测试缩短节奏：`pollWaitMs` 是每次轮询请求 harness server 等待的时长（默认取传输常量 20 秒），`getWaitMs` 是 `get` 请求在本地等待状态变化的上限（默认 5 秒），`requestTimeoutMs` 是单次 HTTP 的期限（默认 30 秒）。`fetch` 可替换为受控传输。

| 方法 | 行为 |
| --- | --- |
| `attach({ harnessUrl, code, ceiling })` | 校验地址与设备拥有者的上限，向 `<harnessUrl>/api/v1/apps/agent/units/unit/attach` 提交附着码、`unitId`（workerId）、契约版本 `computer-worker-1`、能力（平台、架构、workerId）与上限；成功后把记录和一次性凭证交给附着账本保存并立即开始轮询。harness server 返回的错误码原样抛出（如 `unit-code-invalid`、`unit-scope-exceeded`），不可达返回 `worker-attach-unreachable`。附着码只能消费一次，所以只重试能证明请求没有离开本机的连接失败（`ECONNREFUSED`、`ENOTFOUND`、`EAI_AGAIN`、`EHOSTUNREACH`、`ENETUNREACH`、`ENETDOWN`、`UND_ERR_CONNECT_TIMEOUT`，纯函数 `isConnectFailure`），最多 3 次、间隔 1 秒与 2 秒；连接重置、超时等发送后才出现的失败直接报告，不冒险重复消费 |
| `list()` | 附着记录加派生的连接状态：`connecting`、`connected`、`offline`、`instance-mismatch`、`revoked` 及最近一次错误码 |
| `revoke(attachmentId)` | 本地撤销：先读取凭证，经附着账本置为 revoked（循环随之停止、执行器排空该附着的 Run、凭证删除），再尽力用原凭证通知 harness server 撤销；通知失败不影响本地结果 |

## 轮询循环

每条循环以 `Unit <attachmentId>:<credential>` 和附着时固定的 `x-anybox-instance-id` 发 `GET …/poll`，查询串声明 workerId、bootId、平台、架构与等待时间。领取到的每个请求独立执行并各自 `POST …/replies` 回传，长 `get` 不阻塞后续 `submit`。请求种类只有 `info`、`claim`、`submit`、`get`、`query`；授权字段 `attachmentId` 一律由投递该请求的附着决定，载荷里的值被覆盖；`shutdown` 等其他种类回复 `worker-request-unsupported`。`get` 带 `known: { state, receipt }` 时在本地每 50 毫秒复查，直到状态或 receipt 变化、进入终态或超过 `getWaitMs` 才回复，减少跨网络往返。

轮询收到 401 或 `unit-attachment-state` 时视为 harness server 已撤销：循环停止，经附着账本转为本地 revoked 并删除凭证，不再通知远端。收到 `instance-mismatch` 时保留记录、30 秒后重试并把状态标为 `instance-mismatch`。其他失败按 1 秒起、最长 15 秒的退避重连，状态为 `offline`。

## 字节通道

`submit` 与 `get` 的回执里若有工具图片，先把每张图片的原字节推到 harness server：从本根 `harness.image-assets` 按操作的 `sessionId` 读取 worker 自己保留的资源，`POST …/bytes?scope=<sessionId>`，头部带图片 MIME、`x-anybox-sha256` 与 `x-anybox-byte-length`；harness server 以 201 返回 `{ assetId, sha256, byteLength, mimeType }`。回执中的 `images` 只携带 `{ ref, pushed }`，不带 base64。同一附着下同一 worker 资源只推送一次（内存记忆；worker 重启后再推一次，harness server 侧多出的草稿到期回收）。推送失败时该次回执报告 `worker-unavailable`，harness server 之后重新查询，事实不丢失。回执摘要与 ref 不符返回 `worker-bytes-mismatch`。

## 数据与资源归属

组件只拥有循环、在途 HTTP 请求、连接状态和已推送字节的回执缓存；附着记录与凭证归附着账本，接纳与执行事实归执行器，图片原字节归 worker 的图片组件。它不写任何表。

## 执行、取消与清理

`apply` 启动已存在 approved 附着的循环后立即返回，不等待远端可达。Effect 取消所有循环与在途请求并等待其退出；已经交给执行器的操作继续到各自退出，由 harness server 重连后按原 ID 查回。附着账本的撤销通知会同步停止对应循环并等待退出。

## 失败与兼容边界

拨出要求远端为 HTTPS，仅回环允许 HTTP；TLS 由外部代理或单元自身管理。循环不会自动把 `instance-mismatch` 的附着删掉，由设备拥有者撤销。worker 不被 harness server 主动连接，也不接受设备令牌。回环传输仍以 base64 内嵌返回图片，字节通道只用于拨出。

## 验证

[worker 附着测试](../../../tests/computer-worker-attachments.test.mjs)经真实认证监听器验证附着、领取执行、ceiling 拒绝、跨附着拒绝、两侧撤销、worker 重启后的续连以及附着的连接失败重试与模糊失败不重试。完整入口为 `npm run check`。

## 独立设备管理

`updatePermissions(id, ceiling)` 委托本机附着账本，等待工具排空后返回当前视图；既有拨出循环保留，实际接纳始终读取最新账本上限。设备管理不依赖 harness server 控制面，客户端与 CLI 直接经 worker 回环协议调用本服务。attach / list / revoke / updatePermissions 均登记在途管理操作；Effect 先停止新管理与拨出请求，再等待管理操作和循环退出，避免关闭期间写入已卸载的账本。参见 [独立管理](../../computer-worker-management.md)。
