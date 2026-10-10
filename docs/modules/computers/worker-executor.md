# Computer Worker 执行器组件

[返回 Computer 模块](README.md) · [本机客户端](local-worker-client.md) · [固定项目绑定](worker-project-bindings.md)

`createComputerWorkerExecutorComponent({workerId,bootId})` 在独立 worker 进程的唯一 Nya 根安装 `computer-worker-executor`，提供该根的 `computer.worker`。源码：[执行器](../../../src/applications/harness/core/computer/worker-component.ts)、[执行适配器](../../../src/applications/harness/core/computer/worker-execution.ts)、[服务生命周期](../../../src/applications/harness/core/computer/worker-server.ts)。Authority 根中的同名服务是 HTTP 代理，两个进程不直接 inject 彼此。

执行器 inject worker 独占的 `local-storage`、`tools.bash`、`tools.apply-patch`、`tools.processes`、`tools.files` 和 `harness.image-assets`。每个 Run scope 固定工具依赖代及精确 WorkspaceBinding；所有调用传入 binding.path，不读取 Authority 项目目录或 Session 表。worker 自己安装 Bash、补丁、管道进程、文件与图片组件，资源仍由各组件 Effect 持有。内部 `createWorkerExecution` 是闭包适配器，不另注册组件。

此根继承 Bash/Processes 的 Unix 平台检查：当前 Linux/macOS 可装配，真实验收在 Linux 完成；Windows 的纯模型与受控契约测试不代表 Windows worker 已可用。文件工具同样需要完整 worker 根，因此也受此限制。

## 账本与执行提交

`computer-worker` 迁移域归执行器，使用独立 `worker.sqlite` 保存 Run owner、不可变 binding、scope 状态，以及 operation 声明、摘要、接纳 receipt、实际 dispatch 次数、结果、错误、ProcessRef 与图片引用。SQLite 使用跨事务排他 OS 锁；Runtime 无权打开此连接。workerId 跨启动稳定，bootId 每次启动更新；进程恢复凭证不能只由 PID 构成。

接纳先校验 owner、工具契约及完整声明摘要，固定 Run placement，再同一 worker 事务创建 receipt/queued 记录。同 ID、同摘要及同 binding 返回原 receipt；冲突拒绝。启动前先耐久记录 starting 和 executeCount，再同步取得工具资源，保存 running；等 result/done 实际退出后保存终态及原始结果。重复领取返回原结果，包括固定输出范围、截断、部分补丁事实和调用时间，不再次执行或 drain 输出。

`claimRun` 只允许 owner epoch 单调提升；旧 owner 的接纳、查询、stdin、取消和关闭被拒绝。提升 owner 不取消原已接纳执行；新 owner 可观察原事实。instanceGeneration、workspaceEpoch 以及整个 Run binding 也在 worker 接纳端校验，不重新解析当前机器。

Codex exec 的数字 session_id 映射到包含 worker boot、Run 与确切实例代次的 ProcessRef。长进程仍在原 worker scope 中；每次 write_stdin/poll 是独立稳定 operation，重复同 ID 返回原结果。此阶段保证 worker 存活时 Runtime 换代接续；worker 自身崩溃不能据账本恢复原 OS 管道。

## 取消、清理与故障边界

取消是独立去重声明，绕过工具串行队列，先持久登记目标取消，再终止已运行调用或阻止未启动调用。取消不回滚已发生的 Shell/文件副作用，仍保存真实结果和部分变更。close-scope 有稳定 ID，等待所有相关调用、进程组及临时资源实际退出，耐久保存关闭结果后才允许 Authority 释放 pins。

Effect 停止接纳，取消本机 scope/调用，等待执行和实际清理，再保存可证明的退出事实。停止 worker 服务会关闭该根；整套应用关闭只取消并等待所属 Run，独立 idle worker 继续运行。Runtime 的 HTTP 观察消失不会触发 worker 的 Effect。显式撤销 Runtime 的 Nya 依赖仍会通过 Run 控制取消工具，不能等同于进程 SIGKILL 的接续窗口。

worker 异常重启将可能开始的 starting/running 操作转为 outcome-unknown，对其 Run 保留 uncertain。既有 queued 记录只有在可证明尚未启动且 scope 可用时才能继续。未知操作不重新 spawn/写入；无法证明 scope 已退出时拒绝新副作用和关闭成功，不释放原绑定。Apply Patch 的部分结果在 worker 存活时可回传；worker 在未保存事实的逐文件窗口崩溃时保留未知范围，不能把未记录部分宣称回滚。

不承诺任意 Shell 外部副作用 exactly-once，不迁移正在运行的进程，不支持远端执行、portable-managed、checkpoint 或独立模型 exchange。这些边界详见[设计](../../computer-resource-design.md)。

## 验证

[Worker 行为](../../../tests/computer-worker.test.mjs)与[故障注入](../../../tests/computer-worker-resume.test.mjs)验证真实独立进程、接纳去重、owner 栅栏、排队取消、固定 scope、stdin/output 重复领取、worker 故障未知事实及 Runtime SIGKILL 后接续。补丁逐文件事实及取消屏障继续由 [Apply Patch 测试](../../../tests/apply-patch-component.test.mjs)验证。完整入口为 `npm run check`。
