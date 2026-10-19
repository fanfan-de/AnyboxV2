# Computer Worker 执行器组件

[返回 Computer 模块](README.md) · [本机客户端](local-worker-client.md) · [固定项目绑定](worker-project-bindings.md)

`createComputerWorkerExecutorComponent({workerId,bootId})` 在独立 worker 进程的唯一 Nya 根安装 `computer-worker-executor`，提供该根的 `computer.worker`。源码：[执行器](../../../packages/app-harness/src/core/computer/worker-component.ts)、[执行适配器](../../../packages/app-harness/src/core/computer/worker-execution.ts)、[服务生命周期](../../../packages/app-harness/src/core/computer/worker-server.ts)。Authority 根中的同名服务是 HTTP 代理，两个进程不直接 inject 彼此。

执行器 inject worker 独占的 `local-storage`、`tools.bash`、`tools.apply-patch`、`tools.processes`、`tools.files`、`harness.image-assets` 和 [`computer.worker-attachments`](worker-attachments.md)。每个 Run scope 固定工具依赖代及精确 WorkspaceBinding；所有调用传入 binding.path，不读取 Authority 项目目录或 Session 表。worker 自己安装 Bash、补丁、管道进程、文件与图片组件，资源仍由各组件 Effect 持有。内部 `createWorkerExecution` 是闭包适配器，不另注册组件。

此根支持 Harness 私有原生后端：Windows 工具进程由 Job Object 监督，Unix 使用进程组；Bash、Processes、Files 与图片仍由现有组件持有，不新增平台组件。Windows 目录授权在 canonical 路径检查之上核对真实目录身份，同时保留设备 ceiling 与批准 scope 的交集，junction 与大小写别名不能扩大范围。平台配置、宿主启动边界及分轮验证见[原生平台支持](../../native-platform-support.md)。

## 账本与执行提交

`WorkerOperation` 事实带工具操作的 `sessionId`（来自固定声明），拨出循环据此读取并推送该操作的图片字节。`computer-worker` 迁移域归执行器，当前 v2：v1 使用独立 `worker.sqlite` 保存 Run owner、不可变 binding、scope 状态，以及 operation 声明、摘要、接纳 receipt、实际 dispatch 次数、结果、错误、ProcessRef 与图片引用；v2 在 Run 表增加 `attachment_id`，旧行默认 `local:computer`。SQLite 使用跨事务排他 OS 锁；Runtime 无权打开此连接。workerId 跨启动稳定，bootId 每次启动更新；进程恢复凭证不能只由 PID 构成。

接纳先校验 owner、工具契约及完整声明摘要，固定 Run placement，再同一 worker 事务创建 receipt/queued 记录。同 ID、同摘要及同 binding 返回原 receipt；冲突拒绝。启动前先耐久记录 starting 和 executeCount，再同步取得工具资源，保存 running；等 result/done 实际退出后保存终态及原始结果。重复领取返回原结果，包括固定输出范围、截断、部分补丁事实和调用时间，不再次执行或 drain 输出。

`claimRun` 只允许 owner epoch 单调提升；旧 owner 的接纳、查询、stdin、取消和关闭被拒绝。提升 owner 不取消原已接纳执行；新 owner 可观察原事实。instanceGeneration、workspaceEpoch 以及整个 Run binding 也在 worker 接纳端校验，不重新解析当前机器。

`query({ attachmentId, query }, signal?)` 是只读查询面：`stat` 解析绝对路径并报告是否目录，`list` 返回项目目录一次有界列表与目录身份，`search` 与 `read` 复用 Project Files 的文件系统规则（符号链接、越界、文本限制与错误码相同）。查询要求附着 approved；worker 本机解析根及授权目录的 canonical 路径，同时复核设备 ceiling 与批准 scope 的 projects 交集，目录别名不能扩大读取范围（`worker-scope-rejected`），只读查询不受 tools 选择限制。后续读取使用校验后的 canonical 根，项目内条目仍不跟随符号链接。查询不写账本、不占用 Run scope，可自由重试。

`list` 最多扫描 1,000 个目录项（忽略项也计入），额外读取一个条目判断是否截断；恰好 1,000 项且已到结尾时仍为完整列表。返回 `truncated:true` 时 Project Files 明确拒绝该目录的树浏览，不把前缀分页伪装为完整目录；搜索和手工文件引用仍可读取未列出的文件。单次查询内打开并关闭句柄，不建立跨请求的远端目录游标。

每个授权还带 `attachmentId`：`claimRun` 在事务内经附着账本要求该附着为 approved（回环 `local:computer` 恒为 approved，不存在或已撤销返回 `worker-attachment-rejected`），Run 首次 claim 固定其附着，之后其他附着对同一 Run 的 claim、submit 与 get 一律 `worker-owner-rejected`。新工具接纳在同一事务里按 worker 本机 canonical 身份检查固定的 `binding.path` 是否同时落在设备 ceiling 与批准 scope 的 projects 内，并复核两者的工具契约 ID 许可；越界返回 `worker-scope-rejected`，不产生副作用。既有 operation 幂等读取及控制/恢复不重新套用新工作准入。附着被撤销时执行器取消并排空该附着尚未关闭的 Run：置位取消、终止活动调用、关闭 scope 并保存清理结果，无法证明退出的 Run 保留 uncertain；其他附着的 Run 不受影响。

Codex exec 的数字 session_id 映射到包含 worker boot、Run 与确切实例代次的 ProcessRef。长进程仍在原 worker scope 中；每次 write_stdin/poll 是独立稳定 operation，重复同 ID 返回原结果。此阶段保证 worker 存活时 Runtime 换代接续；worker 自身崩溃不能据账本恢复原 OS 管道。

## 取消、清理与故障边界

取消是独立去重声明，绕过工具串行队列，先持久登记目标取消，再终止已运行调用或阻止未启动调用。取消不回滚已发生的 Shell/文件副作用，仍保存真实结果和部分变更。close-scope 有稳定 ID，等待所有相关调用、进程组及临时资源实际退出，耐久保存关闭结果后才允许 Authority 释放 pins。

每个查询在首次异步读取前登记本代在途集合；执行器收到单次查询的取消信号后只中止该查询，仍等待 stat、文件打开/读取与句柄关闭实际退出。本机 HTTP 连接断开会中止对应查询；跨机器 HTTP/transport 取消目前只停止 Authority 观察，没有单次查询取消与退出确认协议，不能据观察结束证明 worker 资源退出。worker 始终独立拥有已接纳查询；附着撤销取消并等待该附着的查询，`shutdown()` 与 Effect 均先停止新准入，取消并等待全部查询。文件句柄清理失败停止准入，并使 worker 清理失败。

Effect 停止接纳，取消本机 scope/调用，等待执行和实际清理，再保存可证明的退出事实。即使取消标记写入失败，仍等待已登记的工具和查询退出。停止 worker 服务会关闭该根；整套应用关闭只取消并等待所属 Run，独立 idle worker 继续运行。Runtime 的 HTTP 观察消失不会触发 worker 的 Effect。显式撤销 Runtime 的 Nya 依赖仍会通过 Run 控制取消工具，不能等同于进程 SIGKILL 的接续窗口。

worker 异常重启将可能开始的 starting/running 操作转为 outcome-unknown，对其 Run 保留 uncertain。既有 queued 记录只有在可证明尚未启动且 scope 可用时才能继续。未知操作不重新 spawn/写入；无法证明 scope 已退出时拒绝新副作用和关闭成功，不释放原绑定。uncertain 的 Run 在本 worker 上不可能再执行，因此不参与“同一 workspace 的其他活动 Run 必须同代次”的栅栏，新 boot 上的后续 Run 以新 instanceGeneration 接纳；旧 boot 的孤儿进程不由新 boot 终止或接管，其后续文件改动属于未知外部副作用。Apply Patch 的部分结果在 worker 存活时可回传；worker 在未保存事实的逐文件窗口崩溃时保留未知范围，不能把未记录部分宣称回滚。

不承诺任意 Shell 外部副作用 exactly-once，不迁移正在运行的进程，不支持 portable-managed、checkpoint 或独立模型 exchange。远端 harness server 的请求经[拨出](worker-dialout.md)循环到达同一端口，执行器不区分传输。这些边界详见[设计](../../computer-resource-design.md)。

## 验证

[Worker 行为](../../../tests/computer-worker.test.mjs)与[故障注入](../../../tests/computer-worker-resume.test.mjs)验证真实独立进程、接纳去重、owner 栅栏、排队取消、固定 scope、stdin/output 重复领取、worker 故障未知事实及 Runtime SIGKILL 后接续；[worker 附着测试](../../../tests/computer-worker-attachments.test.mjs)验证按附着授权与上限拒绝。[只读查询测试](../../../tests/computer-worker-query.test.mjs)以真实 SQLite 和文件句柄验证关闭/取消/撤销等待、canonical 范围交集及远端目录上限。补丁逐文件事实及取消屏障继续由 [Apply Patch 测试](../../../tests/apply-patch-component.test.mjs)验证。完整入口为 `npm run check`。

本机权限修改与撤销均按附着取消并排空当前 Run。权限修改期间附着账本暂停新准入；执行器等待实际工具退出后才确认管理变更完成，scope 清理失败标 uncertain 并返回 `worker-cleanup-failed`。失败 scope 的本代句柄继续由执行器持有，后续权限通知、撤销、Run 的 cancel / close-scope 和根关闭均可再次等待它的实际退出，失败路径不得删除句柄。uncertain Run 的控制重试即使成功释放资源也仍报告 `outcome-unknown`，不能把先前的未知事实改写为成功清理证明。

权限清理失败的附着在同一 boot 内保持关闭新准入；重复修改权限不会解除失败栅栏，必须重启 worker。get 与已接纳声明的幂等读取、取消和关闭仍可进行。新 boot 沿用既有未知操作不重放规则，旧 uncertain Run 不栅栏新代 workspace。其他附着的 Run 不受影响。行为验证见 `tests/computer-worker-management.test.mjs` 与 `tests/computer-worker-permissions-failure.test.mjs`，后者以真实子进程验证失败后拒绝新工作、控制重试等待实际退出及重启后的新 Run。
