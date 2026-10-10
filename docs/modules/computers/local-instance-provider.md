# 本机实例提供方组件

[返回 Computer 模块](README.md) · [Computers](computers.md) · [本机 Worker](local-worker-client.md)

createWorkerInstanceProviderComponent() 在 Authority 根安装 computer-local-instance-provider，提供 computer.instance-provider。inject computer.worker，Computers 消费本轮服务快照。源码：[worker-instance-provider.ts](../../../src/applications/harness/core/computer/worker-instance-provider.ts)、[提供方契约](../../../src/applications/harness/core/computer/port.ts)。

安装不启动 worker。activate({resource,activationId,previousInstance?}) 返回 OwnedCall，通过 worker.info() 按需连接或启动独立本机执行器，校验平台/架构，返回 providerRef=workerId:bootId。workerId 保持稳定，bootId 区分执行器重启；相同引用复用原 ComputerInstance，不同引用必须通过 Computers 的 pin/generation 安全检查。

此提供方不创建或销毁用户计算机，不读取 Session，也不拥有业务表。网络观察归本机 Worker 客户端的 Effect，激活 result/done 由 Computers 等待；取消本次确认不会杀死已接受工具或其他激活等待者。组件无额外机器、挂载或定时器，因此不虚构清理资源。

环境不匹配返回 computer-unavailable，观察取消返回 computer-cancelled。worker 根继承 Unix Bash/管道工具的装配检查，整体要求 macOS/Linux，包括文件计算工具；本次真实验收仅 Linux，不支持 Windows worker 激活。providerRef 只是受信实例事实，不是跨机器认证或发现凭证。

阶段 1 固定宿主提供方及 Runtime 进程内执行适配器已删除，测试替身位于 tests/helpers，不进入正式组件目录。实际接纳/派发仍由 Operations 固定 binding；worker 不随 Runtime SIGKILL 退出，但 worker 自身崩溃无法证明 OS 进程时保留 unknown，不靠新 boot 重放旧命令。

验证：[资源契约](../../../tests/computer-resources.test.mjs)、[Worker 行为](../../../tests/computer-worker.test.mjs)与[真实 Runtime 重启](../../../tests/computer-worker-resume.test.mjs)。完整入口为 npm run check。
