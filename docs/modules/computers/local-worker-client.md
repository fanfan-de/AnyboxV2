# 本机 Worker 客户端组件

[返回 Computer 模块](README.md) · [Worker 执行器](worker-executor.md)

`createLocalComputerWorkerComponent(options)` 在 Authority 根安装 `computer-local-worker-client`，提供 `computer.local-worker: ComputerWorkerPort` 与 `computer.local-worker-control: LocalComputerWorkerControl`；核心组件消费的 `computer.worker` 由 [Worker 路由](worker-router.md)提供，`local:computer` 的调用经路由到达这里。它只拥有本代 HTTP 请求、超时和观察连接；不拥有 worker 的工具进程。源码：[客户端](../../../packages/app-harness/src/core/computer/worker-client.ts)、[受信端口](../../../packages/app-harness/src/core/computer/worker-port.ts)、[独立入口](../../../packages/distribution/src/entrypoints/computer-worker-main.ts)。

组件没有 inject。受信装配固定 `directory`，生产默认目录为业务库路径附加 `.computer-worker`，一个目录只归一个 worker，受信本机管理端共享同一 endpoint；可选 executable、startupTimeoutMs、requestTimeoutMs 用于指定启动设备的 Node 和连接期限。创建组件或查询 Session 不启动 worker。第一次实例激活/计算调用才检查独占目录的 endpoint，查回存活 worker，或 detached 启动独立进程；之后每次调用先检查已连接 worker 的 PID 仍存活，worker 异常退出后下一次本地调用即重新查回或启动，而不是先失败一次。客户端只在有本地调用时才会这样做，不监督空闲 worker：仅为远端 harness server 服务的设备上，异常退出的 worker 直到下一次本地调用（例如执行端激活本机计算资源）才会重启，生产部署应由 systemd 等外部监督。worker 的 stdio 和进程组不依附 Runtime，Runtime 进程 PID 的 SIGKILL 不终止它。detached 不脱离 systemd cgroup，生产接续需预先启动独立 worker unit，见[部署说明](../../harness-server-deployment.md)。

`connectLocalComputerWorker(options)` 是内部客户端工厂，返回同一端口、`control`、`status(signal?)`、`start()` 及 `closeObserver()`。`info` 返回稳定 workerId、本次 bootId、平台和架构；`claimRun` 设置单调 owner epoch；`submit` 持久接纳工具、取消或 scope 关闭声明；`get` 查询同一次执行事实；`query` 是不经账本的只读查询（stat、列目录、搜索、读取文本）。每个授权都带 `attachmentId`，本机 harness server 固定使用 `local:computer`；请求固定原 endpoint，不跨机器重试。声明 ID、摘要和 placement 由 Authority 固定，授权 owner 与附着都不进入不可变摘要。

回环返回的工具图片仍以 base64 内嵌在 `WorkerOperation.images` 中，Operations 校验摘要后导入本机资源组件；这是回环传输的既有形态，拨出传输改用字节通道（见[worker 拨出](worker-dialout.md)）。

`control` 是设备拥有者对本机 worker 附着的控制面，经回环转发到 worker 的 `/attachments/list`、`/attachments/consume`、`/attachments/revoke`、`/attachments/permissions`：列出附着及连接状态、消费其他 harness server 的附着码并设定目录与工具上限、撤销。这些调用会按需启动 worker，因为单元必须运行才能服务远端；HTTP 层在 `/units/local-computer/attachments` 路由暴露它们。远端形态（U1 第 2 步）没有本机 worker，该服务不存在时路由返回 503。

Effect 关闭本代准入、取消本地 HTTP 并等待请求实际退出，不调用 worker shutdown，也不把已接受操作标 cancelled。启动锁等待可在观察关闭时取消；本代已生成子进程时，关闭须等待有限的启动移交或失败清理，内部启动确认不受公共 HTTP 观察取消影响。明确 `shutdown()` 请求 worker 停止准入、取消和排空实际工具，等待服务退出；这与 Runtime 换代及客户端观察关闭是不同控制意图。请求断开、超时或确认丢失只表示当前观察失败，不能证明工具未执行。

独占 worker 目录保存私有 endpoint 元数据、workerId、执行账本与输出/图片数据。endpoint 使用回环地址和每次启动生成的本机令牌，文件按私有权限写入；令牌不进入 Session、模型历史或浏览器 API。worker 不持有模型 Key，也不直连 Authority 业务库。该实现仅为本机受信连接，远端认证/TLS、托管工作区和弹性实例留待后续阶段。

worker 根装配继承 Bash/进程工具的 Unix guard，适用于 Linux/macOS，本次真实 daemon 及 SIGKILL 验收仅在 Linux 完成。Windows 可验证纯模型、资源契约和受控 worker；真实 worker 激活尚未支持，此限制覆盖需要此根的文件工具，不能假称 Windows Files 可单独执行。

验证：[真实 Runtime 强杀与故障注入](../../../tests/computer-worker-resume.test.mjs)、[Worker 行为](../../../tests/computer-worker.test.mjs)、[启动并发与清理](../../../tests/computer-worker-startup.test.mjs)。完整入口为 `npm run check`。

## 独立管理形态

客户端与 CLI 使用 `autoStart: false`：附着、修改权限、撤销要求已运行，`status()` 无条件保持只读，不创建目录、不启动／重启 worker，最多等待状态 HTTP 5 秒。`start()` 才明确启动或复用实例。既有执行端适配器保留按需启动行为。管理观察支持 AbortSignal，关闭只终止 HTTP 等待，已被 worker 接纳的变更仍由 worker 完成。完整入口见 [独立管理](../../computer-worker-management.md)。

被动连接与显式启动不共享失败结果；同一观察端的并发启动合并为一次。跨进程启动使用目录内独立 `startup.sqlite` 的短期 SQLite 排他事务，取得锁后重新读取 endpoint，避免多个客户端或 CLI 同时生成 worker。协调文件限制为私有权限，不打开 worker 业务库；文件存在不表示锁，进程退出由操作系统释放锁，不删除或猜测残留 PID 文件。只有显式或执行端按需启动才创建这些资源。锁等待与启动共用 `startupTimeoutMs` 期限，仅 BUSY/LOCKED 异步重试，其他锁错误立即失败。endpoint 发布前生成的子进程属于本次启动，超时或失败须终止并等待其真实退出后才释放锁；endpoint 发布后由独立 worker 自己持有资源，观察关闭不会停止它。


## 安装包的独立角色启动

`ComputerWorkerOptions.launch(directory)` 是应用私有的可选启动适配。客户端应用包与执行端应用包从 `ApplicationPackageRuntimeContext.startRole` 构造该回调，把 `['serve', directory]` 作为不透明参数交给通用生命周期入口；宿主不解释 endpoint、Computer 附着、工具或 Run。执行端由 `HarnessServerCoreOptions.localWorkerLaunch` 传到同一本机观察客户端。未提供回调的独立应用服务与静态组合继续使用既有直接启动入口。

回调在取得 `startup.sqlite` 排他锁、二次确认没有存活 endpoint 后才调用，并发启动仍合并为一次；启动后的 endpoint 发布、认证、`/info` 确认与错误处理继续由应用拥有。观察关闭等待已接受的启动移交，不停止已经发布的独立 worker，也不取消其远端工作。

正式加载带 worker 的安装包要求签名清单声明 `lifecycleVersion: 1`。固定宿主 bootstrap 在导入 worker 前持有该包的独立使用凭证和实际 SHARED 锚；就绪后断开父 IPC，worker 仍持有进程级代码使用锁。客户端、执行端及生命周期管理者退出均不释放这个子进程的锁。worker 实际退出后才可由注册库排他证明并撤销；仍运行的独立 worker 会阻止相关版本切换，宿主不自动停止它。旧签名包仍可查看与安装，但缺少该声明时需要更新后才能正式加载，不把它归为损坏。

行为验证：[应用启动适配](../../../packages/app-harness/tests/worker-package-lifecycle.test.mjs)、[独立角色与真实使用锁](../../../packages/host/tests/package-independent-role.test.mjs)、[加载器生命周期门禁](../../../packages/host/tests/package-loader.test.mjs)。
