# Computer Operations 组件

[返回 Computer 模块](README.md) · [资源设计](../../computer-resource-design.md)

## 职责、工厂与依赖

createComputerOperationsComponent(inputs, options?) 安装 Authority 根的 harness-computer-operations，提供 harness.computer-operations。inject 本轮 local-storage、harness.computers、harness.workspaces、computer.worker、harness.image-assets 和 harness.unit-attachments，拥有声明、待派发事实、执行回收及 scope 固定引用。Session 与本代 Computer 环境绑定消费它；RunRuntime 只通过该绑定声明的依赖接入 Computer，不强制其他环境安装它。组件不反向依赖 Session/Runtime，不写 Session 表。

源码：[组件](../../../packages/app-harness/src/core/computer/operations-component.ts)、[端口](../../../packages/app-harness/src/core/computer/operations-port.ts)、[声明和摘要](../../../packages/app-harness/src/core/computer/operations-domain.ts)、[worker 接口](../../../packages/app-harness/src/core/computer/worker-port.ts)。inputs 提供 now/newId，options 固定 computerId/spec，默认本机 local 及当前平台/架构。远端 Computer 的身份和平台由已批准附着提供。

## 接纳与接口

| 方法 | 当前语义 |
| --- | --- |
| acceptIn(tx,input) | Session 同事务提交固定声明、摘要、owner、accepted 及逻辑 computer/workspace 需求；`input.unit` 为 Run 固定的 Computer 附着：本机附着或缺省用 options 的 computerId/spec，远端附着用 `unit:<attachmentId>` 与附着记录里单元声明的平台/架构，缺失时 `computer-operation-unavailable` |
| claimRunIn(tx,runId,epoch) | 同 Session 接管事务提升 scope/operation 授权，不修改声明摘要 |
| requestCancelIn(tx,runId) | 同 Session 取消事务登记 scope 取消，不发送网络 |
| observeIn(tx,id,observation) | 同消费事务保存 observed/结果；相同重复复用，冲突拒绝 |
| get(id) | 查询声明、状态、binding、原始结果、worker receipt、ProcessRef 和消费标记 |
| hasRunResources(runId,workspaceBindingId?) | 查询持久 scope 归属，不以内存 Map 推断退出 |
| authorizeRun(runId,epoch,signal) | 恢复准备之前，在已经使用的 worker 安装新 owner 栅栏 |
| recoverCancelledRuns(excludeRunIds) | 协调终态 Run 的耐久取消及清理，排除 RunRuntime 已接手的目标作用域 |
| openRun({runId,runOwnerEpoch?,imageInput?,unit?,workspaceBindingId?}) | 同步建立本代观察 scope，不激活实例；`unit` 是 Run 固定的 Computer 附着引用，缺省按本机附着 `local:computer` 解释 |

scope 提供 execute(id)、cancel()、close()。cancel 先提交持久取消，再协调实际退出；即使协议恢复失败也可终止原 worker scope。资源类型由 Computer 自己管理，不向通用环境注册表暴露 hasProcesses() 探测。OwnedCall.done 证明本地观察退出；worker 实际退出另由耐久事实证明。整批工具先按接受时声明校验；Session 接纳时再次复核 ID、版本及 definition。模型 operation 和旧会话兼容的计划工具不创建 computer 声明。

声明保存 operation/session/run/project、工具契约/参数、workspaceId/revision 和资源规格；显式字段规范化 JSON 后计算 SHA-256。v1 声明的摘要不含授权与实际 WorkspaceBinding。v2 摘要还包含固定的项目工作区及附着身份。新旧声明的 owner epoch 均随所有权提升独立更新。同 ID 同摘要复用原声明，冲突拒绝。首次置位时把 Run 的 Computer 附着引用写入 scope；每个新工具声明进入 starting 前在同一事务经单元附着账本复核引用仍为 approved、epoch 相同且批准的 `scope.tools` 包含该 toolId，空工具选择拒绝全部新工具。项目目录身份由 worker 用自身文件系统解析，同时核对批准 scope 与设备 ceiling，允许显式授权别名对应的 canonical 目录；Authority 不按自己的平台或 lexical 路径重复推断。撤销、收紧或超出批准工具范围的新声明以 `tool-unavailable` 失败，已置位的操作、取消与 close-scope 继续到退出。恢复的 authorizeRun、recoverCancelledRuns 与控制声明都使用 scope 保存的附着。

## 独立执行与结果回收

1. Runtime 先持久固定完整恢复批次与 operation ID；单工具启动时，Session 意图、执行声明和资源需求同业务事务提交，引用已保存游标，事务内没有网络和文件准备。
2. 按需激活 worker、准备 pinned-local，再同事务 bind/pin 并固定 placement。providerRef 包含 workerId/bootId，workerBootId 固定首次派发，不能改发新启动代。
3. 确认丢失时先向原 worker 查询。旧 v1 协调路径支持重传同 ID/摘要；新 v2 工具在结果未知时只查原操作。每次协调复核持久 owner。暂时失联继续协调，不直接判失败或未执行。远端单元报告 `worker-unreachable`（请求从未到达）时按账本区分：该 Run 已有 worker receipt、关闭 receipt，或本次提交可能已被领取，则视为普通失联继续等待；随后 owner/get/control 的请求没被领取也不能推翻此前的投递不确定性。重建后的 starting/running/outcome-unknown placement 即使没有 receipt 也保守视为可能已发送；先查回原 worker，再依据原耐久事实协调。本代明确尚未调用 submit 的新 placement 单独保留未发送事实，离线取消不会等待不存在的远端 scope；明确从未投递时工具声明以不可用失败、取消与 close-scope 可完成，恢复授权直接返回。每次传输失败后还复核 Run 固定的附着仍为 approved 且 epoch 相同：附着被撤销或收紧后该单元不会再回答，已置位的操作记为 outcome-unknown、scope 关闭报告清理失败且 pins 不释放，不向替代单元重发。
4. worker 保存原 observation、错误、ProcessRef、图片和实际退出后，Authority 回收耐久事实。回环返回的工具图片带 base64，先导入 Authority 资源组件；经单元拨出返回的图片带 `pushed` 回执（单元已把字节推到本 harness server 的字节通道），Operations 校验回执与 ref 的摘要/长度一致，并经 `describe` 确认该会话草稿资源存在且摘要相同，不再导入。两种情况都由 Session 同事务永久保留；worker 引用不充当 Authority 事务凭证。
5. Session 消费同事务保存 observation、资源、observed 和额度。提交后才交协议 Loop；重复领取不执行、不新增事件或额度。

binding 和 pins 持有到 worker scope 真正关闭，包含 Codex 提前返回后的长进程。cancel/close-scope 使用稳定控制 ID/摘要，丢确认重查原 receipt。关闭成功保存后同事务释放 reservation/pin；未知执行和清理失败保留引用，禁止成功节点。

Computer 环境适配器用该组件的原 scope 及 worker 回执核对目标退出。此证明用于释放精确 Computer 目标的工具授权占用，其他环境的持有情况由各自提供方核对。 [RunRuntime](../execution/run-runtime.md)

scope 关闭失败但已保存原清理观察时，result 保留部分输出/退出事实，done 仍拒绝。Authority 保存原 close receipt/result，维持 closed=false，不释放 pins；Runtime 把真实事实归档为 cleanup-failed，不能用局部结果证明整个 scope 安全退出。

## 在同一 Run 中使用多个项目工作区

应用接纳工具时，`acceptIn` 接收父 Run ID、已选工作区的 `workspaceBindingId` 和修订、确切 Computer 附着，以及转换到原工具名的请求。Session 与 Computer Operations 同一事务保存意图。Operations 从父 Run、工作区和附着身份生成稳定的 worker scope ID，用它分别登记操作归属、保留工作区、固定 Computer 实例和保存关闭回执。只在实际需要设备时激活它。旧单目标调用省略工作区绑定时沿用父 Run ID。

`openRun({ runId, workspaceBindingId, unit, runOwnerEpoch })` 只持有该工作区的资源。父 Run 提升所有权或登记取消时，事务更新其已经取得的全部 scope。每个 scope 分别检查既有操作是否已派发，等待自身进程与控制操作退出并释放已证明可释放的工作区和实例。如果一个目标失联或退出未知，其他已关闭目标仍可释放自身占用。恢复按原目标、原 scope 和原操作 ID 查回。新工作区声明丢失回执且 worker 查无原记录时保留未知结果。

在多工作区 Run 中，执行端把模型使用的 `session_id` 与该工作区的原始 worker 进程编号持久关联。调用 `codex.write_stdin` 时在同一作用域查找映射。同一进程编号出现在两台设备时分别解析。正常关闭与清理失败的部分回执均使用相同的句柄。首次在退出回执出现的进程也取得独立句柄，重新观察时沿用已保存的身份。旧单目标进程句柄继续按原编号使用。

## 迁移、取消与关闭

组件独占 computer-operations v4。v1 的 harness_computer_operations 保存声明、状态、绑定、结果、消费和 ProcessRef；v2 增加 worker receipt/错误及 harness_computer_scopes 的 owner、取消、关闭 receipt/结果；v3 在 scope 增加 `unit_binding_json`，旧 scope 为空时按本机附着解释。v4 增加父 Run、项目工作区绑定与进程句柄映射。原有 scope 保留原 run_id、声明摘要、控制操作 ID 和回执，按原身份恢复。沿用 Authority 连接；worker 是另一账本，没有跨库事务。

阶段 1 starting/running 且没有新 scope 凭证的操作仍 outcome-unknown，旧 Run interrupted。新 scope/worker 凭证存在时按游标查回；worker 故障无法证明执行则 outcome-unknown，不重放 Shell、stdin 或补丁，不释放未确认退出的引用。

Effect 停止本地准入、取消观察并等待本代网络/数据库，保留已接受 worker 执行。Run 取消先持久接纳，再协调 worker 终止。Runtime 进程 SIGKILL 后新进程从原业务库和 worker 目录接续；显式卸载 Runtime 组件或撤销依赖仍执行既有 Run 取消及排空。整套应用关闭取消并等待所属 Run 的工具与 scope，独立 idle worker 保持运行；停止 worker 服务才关闭其根。观察断开不充当执行取消。

状态写入失败关闭新准入并停止后续操作，仍保留真实结果/部分补丁。不承诺任意 Shell 副作用 exactly-once，没有 portable-managed/checkpoint 或模型 exchange owner；远端 worker 以同名 `computer.worker` 代理接入，本组件不感知传输。

## 验证

[资源](../../../tests/computer-resources.test.mjs)、[工作区](../../../tests/computer-workspaces.test.mjs)、[操作事务](../../../tests/computer-operations.test.mjs)覆盖原子接纳、固定引用、无回执恢复保守性和 placement 后首次 submit 前的取消窗口。[真实故障注入](../../../tests/computer-worker-resume.test.mjs)覆盖 SIGKILL、两端确认丢失、取消断网、部分补丁、owner、stdin/output 和未知事实；[取消准入窗口](../../../tests/computer-runtime-cancel-window.test.mjs)验证意图提交至取得句柄、持久批次及激活等待中的取消不会派发副作用。[Session](../../../tests/computer-session-resume.test.mjs)与[四协议](../../../tests/computer-protocol-resume.test.mjs)验证游标和结果编码。[单元故障](../../../tests/computer-unit-faults.test.mjs)还验证空工具授权拒绝、canonical 项目授权，以及首次 submit 回执丢失后 boot 换代取回原成功事实。完整入口为 npm run check。
