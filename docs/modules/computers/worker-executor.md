# Computer Worker 执行器组件

[返回 Computer 模块](README.md) · [本机客户端](local-worker-client.md) · [固定项目绑定](worker-project-bindings.md)

`createComputerWorkerExecutorComponent({workerId,bootId})` 在独立 worker 进程的唯一 Nya 根安装 `computer-worker-executor`，提供该根的 `computer.worker`。源码：[执行器](../../../src/applications/harness/core/computer/worker-component.ts)、[执行适配器](../../../src/applications/harness/core/computer/worker-execution.ts)、[服务生命周期](../../../src/applications/harness/core/computer/worker-server.ts)。Authority 根中的同名服务是 HTTP 代理，两个进程不直接 inject 彼此。

执行器 inject worker 独占的 `local-storage`、`tools.bash`、`tools.apply-patch`、`tools.processes`、`tools.files`、`harness.image-assets` 和 [`computer.worker-attachments`](worker-attachments.md)。每个 Run scope 固定工具依赖代及精确 WorkspaceBinding；所有调用传入 binding.path，不读取 Authority 项目目录或 Session 表。worker 自己安装 Bash、补丁、管道进程、文件与图片组件，资源仍由各组件 Effect 持有。内部 `createWorkerExecution` 是闭包适配器，不另注册组件。

此根继承 Bash/Processes 的 Unix 平台检查：当前 Linux/macOS 可装配，真实验收在 Linux 完成；Windows 的纯模型与受控契约测试不代表 Windows worker 已可用。文件工具同样需要完整 worker 根，因此也受此限制。

## 账本与执行提交

`WorkerOperation` 事实带工具操作的 `sessionId`（来自固定声明），拨出循环据此读取并推送该操作的图片字节。`computer-worker` 迁移域归执行器，当前 v2：v1 使用独立 `worker.sqlite` 保存 Run owner、不可变 binding、scope 状态，以及 operation 声明、摘要、接纳 receipt、实际 dispatch 次数、结果、错误、ProcessRef 与图片引用；v2 在 Run 表增加 `attachment_id`，旧行默认 `local:computer`。SQLite 使用跨事务排他 OS 锁；Runtime 无权打开此连接。workerId 跨启动稳定，bootId 每次启动更新；进程恢复凭证不能只由 PID 构成。

接纳先校验 owner、工具契约及完整声明摘要，固定 Run placement，再同一 worker 事务创建 receipt/queued 记录。同 ID、同摘要及同 binding 返回原 receipt；冲突拒绝。启动前先耐久记录 starting 和 executeCount，再同步取得工具资源，保存 running；等 result/done 实际退出后保存终态及原始结果。重复领取返回原结果，包括固定输出范围、截断、部分补丁事实和调用时间，不再次执行或 drain 输出。

`claimRun` 只允许 owner epoch 单调提升；旧 owner 的接纳、查询、stdin、取消和关闭被拒绝。提升 owner 不取消原已接纳执行；新 owner 可观察原事实。instanceGeneration、workspaceEpoch 以及整个 Run binding 也在 worker 接纳端校验，不重新解析当前机器。

`query({ attachmentId, query })` 是只读查询面：`stat` 解析绝对路径并报告是否目录，`list` 返回项目目录一页有界条目与目录身份，`search` 与 `read` 复用 Project Files 的文件系统规则（符号链接、越界、文本限制与错误码相同）。查询要求附着 approved 且根路径落在其目录上限内（`worker-scope-rejected`），不写账本、不占用 Run scope，可自由重试；worker 关闭中止进行中的查询。

每个授权还带 `attachmentId`：`claimRun` 在事务内经附着账本要求该附着为 approved（回环 `local:computer` 恒为 approved，不存在或已撤销返回 `worker-attachment-rejected`），Run 首次 claim 固定其附着，之后其他附着对同一 Run 的 claim、submit 与 get 一律 `worker-owner-rejected`。工具接纳在同一事务里用设备拥有者设定的上限检查固定的 `binding.path` 与工具契约 ID，越界返回 `worker-scope-rejected`，不产生副作用。附着被撤销时执行器取消并排空该附着尚未关闭的 Run：置位取消、终止活动调用、关闭 scope 并保存清理结果，无法证明退出的 Run 保留 uncertain；其他附着的 Run 不受影响。

Codex exec 的数字 session_id 映射到包含 worker boot、Run 与确切实例代次的 ProcessRef。长进程仍在原 worker scope 中；每次 write_stdin/poll 是独立稳定 operation，重复同 ID 返回原结果。此阶段保证 worker 存活时 Runtime 换代接续；worker 自身崩溃不能据账本恢复原 OS 管道。

## 取消、清理与故障边界

取消是独立去重声明，绕过工具串行队列，先持久登记目标取消，再终止已运行调用或阻止未启动调用。取消不回滚已发生的 Shell/文件副作用，仍保存真实结果和部分变更。close-scope 有稳定 ID，等待所有相关调用、进程组及临时资源实际退出，耐久保存关闭结果后才允许 Authority 释放 pins。

Effect 停止接纳，取消本机 scope/调用，等待执行和实际清理，再保存可证明的退出事实。停止 worker 服务会关闭该根；整套应用关闭只取消并等待所属 Run，独立 idle worker 继续运行。Runtime 的 HTTP 观察消失不会触发 worker 的 Effect。显式撤销 Runtime 的 Nya 依赖仍会通过 Run 控制取消工具，不能等同于进程 SIGKILL 的接续窗口。

worker 异常重启将可能开始的 starting/running 操作转为 outcome-unknown，对其 Run 保留 uncertain。既有 queued 记录只有在可证明尚未启动且 scope 可用时才能继续。未知操作不重新 spawn/写入；无法证明 scope 已退出时拒绝新副作用和关闭成功，不释放原绑定。uncertain 的 Run 在本 worker 上不可能再执行，因此不参与“同一 workspace 的其他活动 Run 必须同代次”的栅栏，新 boot 上的后续 Run 以新 instanceGeneration 接纳；旧 boot 的孤儿进程不由新 boot 终止或接管，其后续文件改动属于未知外部副作用。Apply Patch 的部分结果在 worker 存活时可回传；worker 在未保存事实的逐文件窗口崩溃时保留未知范围，不能把未记录部分宣称回滚。

不承诺任意 Shell 外部副作用 exactly-once，不迁移正在运行的进程，不支持 portable-managed、checkpoint 或独立模型 exchange。远端 harness server 的请求经[拨出](worker-dialout.md)循环到达同一端口，执行器不区分传输。这些边界详见[设计](../../computer-resource-design.md)。

## 验证

[Worker 行为](../../../tests/computer-worker.test.mjs)与[故障注入](../../../tests/computer-worker-resume.test.mjs)验证真实独立进程、接纳去重、owner 栅栏、排队取消、固定 scope、stdin/output 重复领取、worker 故障未知事实及 Runtime SIGKILL 后接续；[worker 附着测试](../../../tests/computer-worker-attachments.test.mjs)验证按附着授权与上限拒绝。补丁逐文件事实及取消屏障继续由 [Apply Patch 测试](../../../tests/apply-patch-component.test.mjs)验证。完整入口为 `npm run check`。
