# RunRuntime 运行期组件

[返回执行模块](README.md) · [返回组件文档](../README.md)

RunRuntime 独占每个已接管 Run 的 program、在途操作、取消控制、临时展示和清理等待。它通过应用自有的 `RunHost` 操作契约执行协议程序，不解释原生响应或协议停止原因。

## 实现与装配

- 源码：[组件](../../../src/applications/harness/core/run/runtime-component.ts)、[RunHost / PreparedRunProgram](../../../src/applications/harness/core/run/program.ts)、[OwnedCall](../../../src/applications/harness/core/contracts.ts)、[工具校验和限制](../../../src/applications/harness/core/run/domain.ts)。
- 工厂：`createRunRuntimeComponent(inputs)`；组件名：`harness-run-runtime`；配置类型：`void`；`inputs` 提供 `now()` 和 `newId()`。
- 提供 `harness.run-runtime: RunRuntimePort`。
- 注入 [Session](../sessions/session.md) 的 `harness.session-runs` 与 [Computer Operations](../computers/computer-operations.md) 的 `harness.computer-operations`。四种工具服务只由独立 worker 执行器持有，Runtime 不持有 OS 进程。

## 服务与程序契约

| 接口 | 语义 |
| --- | --- |
| `start({ runId, program, resume? })` | 在任何异步读取前同步取得 program 所有权；resume 固定本代 owner 与已有游标；同步拒绝不取得所有权 |
| `cancel(runId, reason)` | 请求取消；reason 为 `user-requested`、`owner-disposed` 或 `dependency-unavailable` |
| `wait(runId, signal?)` | 等待该 Run 的结束和清理；无活跃所有者时读取持久记录 |
| `getView(runId)` | 返回临时视图的结构化克隆，避免调用者修改内部状态 |

同 ID、同 program 的重复 `start` 复用已有 Promise；同 ID、不同 program 被拒绝。Runtime 区分 `started` 与 `finished`：第一次实际启动操作后可以返回 started；尚未启动即失败时由 finished 决定返回值。调用方通过 `wait` 等待完成。

程序收到的 `RunHost` 包含取消 `signal`、`perform(descriptor, start)`、`executeTools(requests, 'serial')`、`publish(frame)`。`OperationDescriptor` 指定 ID、`model | operation` 类型、序列化 intent、可选初始记录，以及必需的结果转换函数 `observe`。`OwnedCall` 的 `result` 是业务结果，`done` 是资源实际退出，两者必须都被观察。

## 操作屏障与工具循环

每次 `perform` 都按固定顺序执行：检查停止状态；持久化 `startOperation`；再次检查停止状态；同步启动并登记调用句柄；等待业务结果和实际退出；持久化 observation；再允许下一操作。启动句柄与登记之间没有 await，避免取消落在无主资源窗口。

状态写入失败立即关闭新操作准入并中止内部 signal。取消后仍提交已经发生的真实 observation，包括 Apply Patch 部分变更。若 `done` 提前失败，即使 `result` 永不返回也能识别清理失败；如果已有工具结果，还会尽量保留它。

工具从受信静态目录按 program 固定声明进行分派，涵盖三个来源的命令、文件读写、搜索、图片和计划契约，以及保留的 Bash/Apply Patch。整个批次的名称、ID 与来源参数 schema 必须先验证通过，随后按模型给出的顺序串行执行。调用 ID 必须非空、唯一且不超过 256 字符；未声明的工具在任何副作用前拒绝。旧 Bash/Apply Patch 参数仍必须恰有对应的一个字段。补丁文本语法错误是工具结果，允许模型修正；信封错误则在任何工具启动前拒绝整个批次。没有动态工具注册中心。

Runtime 先保存完整恢复批次与 operation ID；单工具的 Session 意图、待派发声明及资源需求在同一业务事务同步接纳到 Computer Operations。Runtime 同步打开本代观察 scope；Operations 按需准备确切实例和工作区 binding，再提交独立 worker。所有工具使用固定 workspacePath，长进程存活期间 scope 保留实例 pin 和工作区 reservation。模型和计划工具不激活 computer。worker 保存接纳凭证、原结果与实际退出，确认丢失重查同 ID/摘要，不重复派发副作用。

最终文本最多 65,536 UTF-8 字节；累计工具输出最多 131,072 字节，旧 Bash 计 stdout/stderr，其他工具计结果 JSON；图片原字节不进入工具文本结果。当前不设置固定模型轮次或工具次数上限。`publish` 每个活跃 Run 只保存一份不超过 1,048,576 UTF-8 字节的克隆快照，广播 `harness.run-view`；展示监听和不可序列化帧不能破坏执行，结束时删除快照。

协议 program 发布展示 v2 的有界完整快照，Runtime 不解释其原生内容类型、停止状态或诊断。模型工具请求保留其来源 exchange；本地工具事实仍只写入 `tool-started`、`tool-observed`、`tool-failed` 事件。前端按 Run、来源模型 exchange、请求 ID、名称和事件位置关联事实，不发布额外 `tools-N` 临时 exchange，也不以请求快照推断工具完成。取消和清理失败时，已经保存的真实工具结果及部分补丁事实继续可查询。

## 结算、取消与关闭

启动后先读取 Session 保存的 Run 和项目归属，验证原生上下文模式、绑定代与完整模型快照和 program 一致。执行结束时中止新操作，取消仍在途句柄，等待每个 `done` 和所有受管 Promise。若 computer scope 已打开进程，先保存 `intent.kind=tool-process-cleanup` 的通用 operation，调用 computer scope.close() 终止并等待全部进程组、原子释放实例与工作区引用，持久化真实退出、剩余输出与清理结果；仅有文件/Bash 调用时也关闭 scope 并等待引用释放。之后 `program.close()`，等待取消状态写入，再请求 Session 原子结算。正常模型完成同样关闭进程，但不设置用户取消原因；存储失败也必须继续清理。最终 `program.release()` 在清理和持久结算之后释放绑定租约。

清理错误优先成为 `cleanup-failed`；状态写入失败成为 `state-write-failure`；依赖撤销成为 `dependency-unavailable`；普通用户取消或 owner 关闭成为 cancelled。清理失败与状态故障不能被普通取消掩盖，也不能生成成功节点。结算提案先保存到独立恢复状态；提交确认丢失时复用原终态、节点与事件，不重新创建节点。未知执行不会自动重放。

Effect 先停止接收，再取消并等待所有活跃 Run，清空临时视图，最后传播累计清理错误。中止 `wait` 的 signal 只移除这个等待者，不取消 Run。

## 进程重启接续

Run 接管 `run-state` v10 的独立 resume 状态，提升 runOwnerEpoch，并先在已使用 worker 安装栅栏，再准备程序。Runtime 的 response 阶段复用完整工具批次、operation ID 和已观察结果；Session 原子消费观察及累计额度。cleanup 阶段重查原 close-scope，settling 阶段重用已保存提案。协议 Loop 解释 opaque protocolCursor，先回放已保存原生响应，再固定下一增量请求；不恢复旧 Run phase 写入路径。

此阶段承诺 Runtime 进程 SIGKILL/异常退出后、worker 存活且模型响应已保存的接续。显式卸载组件、依赖撤销或整套应用正常关闭仍取消并等待所属 Run；idle worker 作为独立设备服务保持运行。model-pending 且响应未保存的 Run 结算 interrupted，不重发模型；若之前留有 Codex 长进程，仍独立取消并排空其 scope。账户/参数恢复不兼容也先排空原资源才结算失败。worker 自身故障的未知执行拒绝成功清理与节点创建。

## 验证

[harness server 核心测试](../../../tests/harness-server-core.test.mjs) 覆盖早期取消、结果/退出分离、清理异常、Runtime 组件替换；[工具循环](../../../tests/tool-loop.test.mjs) 覆盖串行批次、输出限额、退出等待；[Apply Patch 循环](../../../tests/apply-patch-loop.test.mjs) 覆盖部分变更与取消；[会话树](../../../tests/conversation-tree.test.mjs) 覆盖结算原子性；[真实故障注入](../../../tests/computer-worker-resume.test.mjs)覆盖独立 worker 与 Runtime 进程 SIGKILL、确认丢失、取消断网和清理接续。统一执行 `npm run check`。

图片读取和 data URL 编码属于模型 operation 的内部工作，与网络请求共享取消和实际退出屏障。文件工具使用图片组件导入原字节；Runtime 将图片引用与工具观察交给 Session 同事务保留，只在提交后交 program 私有许可表接纳，不接触原图字节；图片读取/校验失败阻止发出模型请求，清理失败不创建成功节点。
