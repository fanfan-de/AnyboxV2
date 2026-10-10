# Computer Operations 组件

[返回 Computer 模块](README.md) · [资源设计](../../computer-resource-design.md)

## 职责、工厂与依赖

createComputerOperationsComponent(inputs, options?) 安装 Authority 根的 harness-computer-operations，提供 harness.computer-operations。inject 本轮 local-storage、harness.computers、harness.workspaces、computer.worker 和 harness.image-assets，拥有声明、待派发事实、执行回收及 scope 固定引用。Session/Runtime 消费它，它不反向依赖这两个组件，不写 Session 表。

源码：[组件](../../../src/applications/harness/core/computer/operations-component.ts)、[端口](../../../src/applications/harness/core/computer/operations-port.ts)、[声明和摘要](../../../src/applications/harness/core/computer/operations-domain.ts)、[worker 接口](../../../src/applications/harness/core/computer/worker-port.ts)。inputs 提供 now/newId，options 固定 computerId/spec，默认本机 local 及当前平台/架构；远端策略尚未安装。

## 接纳与接口

| 方法 | 当前语义 |
| --- | --- |
| acceptIn(tx,input) | Session 同事务提交固定声明、摘要、owner、accepted 及逻辑 computer/workspace 需求 |
| claimRunIn(tx,runId,epoch) | 同 Session 接管事务提升 scope/operation 授权，不修改声明摘要 |
| requestCancelIn(tx,runId) | 同 Session 取消事务登记 scope 取消，不发送网络 |
| observeIn(tx,id,observation) | 同消费事务保存 observed/结果；相同重复复用，冲突拒绝 |
| get(id) | 查询声明、状态、binding、原始结果、worker receipt、ProcessRef 和消费标记 |
| hasRunResources(runId) | 查询持久 scope 归属，不以内存 Map 推断退出 |
| authorizeRun(runId,epoch,signal) | 恢复准备之前，在已经使用的 worker 安装新 owner 栅栏 |
| recoverCancelledRuns(excludeRunIds) | 协调终态 Run 的耐久取消及清理，不重新打开历史执行 |
| openRun({runId,runOwnerEpoch?,imageInput?}) | 同步建立本代观察 scope，不激活实例 |

scope 提供 execute(id)、hasProcesses()、cancel()、close()。cancel 先提交持久取消，再协调实际退出；即使协议恢复失败也可终止原 worker scope。OwnedCall.done 证明本地观察退出；worker 实际退出另由耐久事实证明。整批工具先按接受时声明校验；Session 接纳时再次复核 ID、版本及 definition。计划和模型 operation 不创建 computer 声明。

声明保存 operation/session/run/project、工具契约/参数、workspaceId/revision 和资源规格；显式字段规范化 JSON 后计算 SHA-256。runOwnerEpoch 是授权，binding 单独首次固定，均不进入摘要。同 ID 同摘要复用原声明，冲突拒绝。

## 独立执行与结果回收

1. Runtime 先持久固定完整恢复批次与 operation ID；单工具启动时，Session 意图、执行声明和资源需求同业务事务提交，引用已保存游标，事务内没有网络和文件准备。
2. 按需激活 worker、准备 pinned-local，再同事务 bind/pin 并固定 placement。providerRef 包含 workerId/bootId，workerBootId 固定首次派发，不能改发新启动代。
3. 确认丢失向原 worker 查询或重传同 ID/摘要；每次协调复核持久 owner。暂时失联继续协调，不直接判失败或未执行。
4. worker 保存原 observation、错误、ProcessRef、图片和实际退出后，Authority 回收耐久事实。工具图片先导入 Authority 资源组件，Session 同事务永久保留；worker 引用不充当 Authority 事务凭证。
5. Session 消费同事务保存 observation、资源、observed 和额度。提交后才交协议 Loop；重复领取不执行、不新增事件或额度。

binding 和 pins 持有到 worker scope 真正关闭，包含 Codex 提前返回后的长进程。cancel/close-scope 使用稳定控制 ID/摘要，丢确认重查原 receipt。关闭成功保存后同事务释放 reservation/pin；未知执行和清理失败保留引用，禁止成功节点。

scope 关闭失败但已保存原清理观察时，result 保留部分输出/退出事实，done 仍拒绝。Authority 保存原 close receipt/result，维持 closed=false，不释放 pins；Runtime 把真实事实归档为 cleanup-failed，不能用局部结果证明整个 scope 安全退出。

## 迁移、取消与关闭

组件独占 computer-operations v2。v1 的 harness_computer_operations 保存声明、状态、绑定、结果、消费和 ProcessRef；v2 增加 worker receipt/错误及 harness_computer_scopes 的 owner、取消、关闭 receipt/结果。沿用 Authority 连接；worker 是另一账本，没有跨库事务。

阶段 1 starting/running 且没有新 scope 凭证的操作仍 outcome-unknown，旧 Run interrupted。新 scope/worker 凭证存在时按游标查回；worker 故障无法证明执行则 outcome-unknown，不重放 Shell、stdin 或补丁，不释放未确认退出的引用。

Effect 停止本地准入、取消观察并等待本代网络/数据库，保留已接受 worker 执行。Run 取消先持久接纳，再协调 worker 终止。Runtime 进程 SIGKILL 后新进程从原业务库和 worker 目录接续；显式卸载 Runtime 组件或撤销依赖仍执行既有 Run 取消及排空。整套应用关闭取消并等待所属 Run 的工具与 scope，独立 idle worker 保持运行；停止 worker 服务才关闭其根。观察断开不充当执行取消。

状态写入失败关闭新准入并停止后续操作，仍保留真实结果/部分补丁。不承诺任意 Shell 副作用 exactly-once，没有跨机器、portable-managed/checkpoint 或模型 exchange owner。

## 验证

[资源](../../../tests/computer-resources.test.mjs)、[工作区](../../../tests/computer-workspaces.test.mjs)、[操作事务](../../../tests/computer-operations.test.mjs)覆盖原子接纳及固定引用。[真实故障注入](../../../tests/computer-worker-resume.test.mjs)覆盖 SIGKILL、两端确认丢失、取消断网、部分补丁、owner、stdin/output 和未知事实；[取消准入窗口](../../../tests/computer-runtime-cancel-window.test.mjs)验证意图提交至取得句柄、持久批次及激活等待中的取消不会派发副作用。[Session](../../../tests/computer-session-resume.test.mjs)与[四协议](../../../tests/computer-protocol-resume.test.mjs)验证游标和结果编码。完整入口为 npm run check。
