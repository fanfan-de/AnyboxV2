# 本机 Worker 客户端组件

[返回 Computer 模块](README.md) · [Worker 执行器](worker-executor.md)

`createLocalComputerWorkerComponent(options)` 在 Authority 根安装 `computer-local-worker-client`，提供 `computer.worker: ComputerWorkerPort`。它只拥有本代 HTTP 请求、超时和观察连接；不拥有 worker 的工具进程。源码：[客户端](../../../src/applications/harness/core/computer/worker-client.ts)、[受信端口](../../../src/applications/harness/core/computer/worker-port.ts)、[独立入口](../../../src/entrypoints/computer-worker-main.ts)。

组件没有 inject。受信装配固定 `directory`，生产默认目录为业务库路径附加 `.computer-worker`，一个目录只归一个 Authority；可选 executable、startupTimeoutMs、requestTimeoutMs 用于指定启动设备的 Node 和连接期限。创建组件或查询 Session 不启动 worker。第一次实例激活/计算调用才检查独占目录的 endpoint，查回存活 worker，或 detached 启动独立进程。worker 的 stdio 和进程组不依附 Runtime，Runtime 进程 PID 的 SIGKILL 不终止它。detached 不脱离 systemd cgroup，生产接续需预先启动独立 worker unit，见[部署说明](../../harness-server-deployment.md)。

`connectLocalComputerWorker(options)` 是内部客户端工厂，返回同一端口及 `closeObserver()`。`info` 返回稳定 workerId、本次 bootId、平台和架构；`claimRun` 设置单调 owner epoch；`submit` 持久接纳工具、取消或 scope 关闭声明；`get` 查询同一次执行事实。请求固定原 endpoint，不跨机器重试。声明 ID、摘要和 placement 由 Authority 固定，授权 owner 不进入不可变摘要。

Effect 关闭本代准入、取消本地 HTTP 并等待请求实际退出，不调用 worker shutdown，也不把已接受操作标 cancelled。明确 `shutdown()` 请求 worker 停止准入、取消和排空实际工具，等待服务退出；这与 Runtime 换代及客户端观察关闭是不同控制意图。请求断开、超时或确认丢失只表示当前观察失败，不能证明工具未执行。

独占 worker 目录保存私有 endpoint 元数据、workerId、执行账本与输出/图片数据。endpoint 使用回环地址和每次启动生成的本机令牌，文件按私有权限写入；令牌不进入 Session、模型历史或浏览器 API。worker 不持有模型 Key，也不直连 Authority 业务库。该实现仅为本机受信连接，远端认证/TLS、托管工作区和弹性实例留待后续阶段。

worker 根装配继承 Bash/进程工具的 Unix guard，适用于 Linux/macOS，本次真实 daemon 及 SIGKILL 验收仅在 Linux 完成。Windows 可验证纯模型、资源契约和受控 worker；真实 worker 激活尚未支持，此限制覆盖需要此根的文件工具，不能假称 Windows Files 可单独执行。

验证：[真实 Runtime 强杀与故障注入](../../../tests/computer-worker-resume.test.mjs)、[Worker 行为](../../../tests/computer-worker.test.mjs)。完整入口为 `npm run check`。
