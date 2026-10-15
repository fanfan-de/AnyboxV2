# 本机 Worker 客户端组件

[返回 Computer 模块](README.md) · [Worker 执行器](worker-executor.md)

`createLocalComputerWorkerComponent(options)` 在 Authority 根安装 `computer-local-worker-client`，提供 `computer.local-worker: ComputerWorkerPort` 与 `computer.local-worker-control: LocalComputerWorkerControl`；核心组件消费的 `computer.worker` 由 [Worker 路由](worker-router.md)提供，`local:computer` 的调用经路由到达这里。它只拥有本代 HTTP 请求、超时和观察连接；不拥有 worker 的工具进程。源码：[客户端](../../../src/applications/harness/core/computer/worker-client.ts)、[受信端口](../../../src/applications/harness/core/computer/worker-port.ts)、[独立入口](../../../src/entrypoints/computer-worker-main.ts)。

组件没有 inject。受信装配固定 `directory`，生产默认目录为业务库路径附加 `.computer-worker`，一个目录只归一个 worker，受信本机管理端共享同一 endpoint；可选 executable、startupTimeoutMs、requestTimeoutMs 用于指定启动设备的 Node 和连接期限。创建组件或查询 Session 不启动 worker。第一次实例激活/计算调用才检查独占目录的 endpoint，查回存活 worker，或 detached 启动独立进程；之后每次调用先检查已连接 worker 的 PID 仍存活，worker 异常退出后下一次本地调用即重新查回或启动，而不是先失败一次。客户端只在有本地调用时才会这样做，不监督空闲 worker：仅为远端 harness server 服务的设备上，异常退出的 worker 直到下一次本地调用（例如执行端激活本机计算资源）才会重启，生产部署应由 systemd 等外部监督。worker 的 stdio 和进程组不依附 Runtime，Runtime 进程 PID 的 SIGKILL 不终止它。detached 不脱离 systemd cgroup，生产接续需预先启动独立 worker unit，见[部署说明](../../harness-server-deployment.md)。

`connectLocalComputerWorker(options)` 是内部客户端工厂，返回同一端口、`control`、`status(signal?)`、`start()` 及 `closeObserver()`。`info` 返回稳定 workerId、本次 bootId、平台和架构；`claimRun` 设置单调 owner epoch；`submit` 持久接纳工具、取消或 scope 关闭声明；`get` 查询同一次执行事实；`query` 是不经账本的只读查询（stat、列目录、搜索、读取文本）。每个授权都带 `attachmentId`，本机 harness server 固定使用 `local:computer`；请求固定原 endpoint，不跨机器重试。声明 ID、摘要和 placement 由 Authority 固定，授权 owner 与附着都不进入不可变摘要。

回环返回的工具图片仍以 base64 内嵌在 `WorkerOperation.images` 中，Operations 校验摘要后导入本机资源组件；这是回环传输的既有形态，拨出传输改用字节通道（见[worker 拨出](worker-dialout.md)）。

`control` 是设备拥有者对本机 worker 附着的控制面，经回环转发到 worker 的 `/attachments/list`、`/attachments/consume`、`/attachments/revoke`、`/attachments/permissions`：列出附着及连接状态、消费其他 harness server 的附着码并设定目录与工具上限、撤销。这些调用会按需启动 worker，因为单元必须运行才能服务远端；HTTP 层在 `/units/local-computer/attachments` 路由暴露它们。远端形态（U1 第 2 步）没有本机 worker，该服务不存在时路由返回 503。

Effect 关闭本代准入、取消本地 HTTP 并等待请求实际退出，不调用 worker shutdown，也不把已接受操作标 cancelled。明确 `shutdown()` 请求 worker 停止准入、取消和排空实际工具，等待服务退出；这与 Runtime 换代及客户端观察关闭是不同控制意图。请求断开、超时或确认丢失只表示当前观察失败，不能证明工具未执行。

独占 worker 目录保存私有 endpoint 元数据、workerId、执行账本与输出/图片数据。endpoint 使用回环地址和每次启动生成的本机令牌，文件按私有权限写入；令牌不进入 Session、模型历史或浏览器 API。worker 不持有模型 Key，也不直连 Authority 业务库。该实现仅为本机受信连接，远端认证/TLS、托管工作区和弹性实例留待后续阶段。

worker 启动与 `status().supported` 按当前平台的原生进程后端可用性判断；Windows、macOS、Linux 使用相同 worker 根与执行账本，缺少匹配的后端时返回 `worker-platform-unsupported`。平台代码存在不代表该平台成品与真实故障验收已完成，验收记录需分别列出。

创建 worker 目录和日志前先执行私有目录边界：Unix 使用 `0700`；Windows 使用受保护 DACL，仅允许当前运行账户和 SYSTEM，并复核实际 ACL。不能创建或核验时返回 `worker-directory-unavailable`，不发布 endpoint。系统服务应与共享该目录的桌面使用同一账户；另一账户的服务使用自己的目录及 Vault。

Windows 目录已由当前账户拥有时只修改 DACL，不重复请求 `WRITE_OWNER`；因此父目录仅授予 Modify 的普通工作区也可创建私有 worker 目录。现有 owner 不同时仍显式尝试转为当前账户并核验，缺少权限则拒绝，不保留可被其他 owner 改写的 endpoint 目录。

后台进程通过 `src/platform/runtime-path.ts` 选择独立 Node：源码 Node 模式使用当前 Node；源码 Electron 的启动脚本显式传递 `ANYBOX_DEVELOPMENT_NODE_EXECUTABLE`，worker 使用启动脚本自身的 Node 与源码构建入口。Electron 成品忽略该开发变量，使用 `resources/runtime/node[.exe]` 和 `resources/runtime/app/dist/entrypoints/computer-worker-main.js`，部署可由 `ANYBOX_RUNTIME_DIRECTORY` 指定整套目录。不依赖 Electron RunAsNode；缺失运行时或入口时拒绝启动。`status()` 仅检查后端与既有 endpoint，不创建目录或修改 ACL。

系统服务 runner 为 harness server 设置内部 `ANYBOX_SYSTEM_SERVICE_ROLE=harness-server`。这种宿主只能复用已独立启动的 worker；缺少 worker 时连显式 `start()` 也返回 `worker-service-start-required`，且不创建目录。这样不会把 idle worker 放入 harness server 的 Windows Job 或 systemd cgroup，避免停止 harness server 时误杀应独立存活的 worker。桌面与普通 CLI 仍按原有生命周期启动。

验证：[真实 Runtime 强杀与故障注入](../../../tests/computer-worker-resume.test.mjs)、[Worker 行为](../../../tests/computer-worker.test.mjs)、[原生目录权限、路径身份与后台入口](../../../tests/platform-worker-files.test.mjs)、[原生 worker 启停、观察关闭与强杀恢复](../../../tests/native-worker-lifecycle.test.mjs)。完整入口为 `npm run check`。

## 独立管理形态

客户端与 CLI 使用 `autoStart: false`：附着、修改权限、撤销要求已运行，`status()` 无条件保持只读，不创建目录、不启动／重启 worker，最多等待状态 HTTP 5 秒。`start()` 才明确启动或复用实例。既有执行端适配器保留按需启动行为。管理观察支持 AbortSignal，关闭只终止 HTTP 等待，已被 worker 接纳的变更仍由 worker 完成。完整入口见 [独立管理](../../computer-worker-management.md)。
