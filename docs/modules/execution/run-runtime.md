# RunRuntime 运行期组件

[返回执行模块](README.md) · [返回组件文档](../README.md)

RunRuntime 独占每个已接管 Run 的 program、在途操作、取消控制、临时展示和清理等待。它通过应用自有的 `RunHost` 操作契约执行协议程序，不解释原生响应或协议停止原因。

## 实现与装配

- 源码：[组件](../../../src/applications/harness/core/run/runtime-component.ts)、[RunHost / PreparedRunProgram](../../../src/applications/harness/core/run/program.ts)、[OwnedCall](../../../src/applications/harness/core/contracts.ts)、[工具校验和限制](../../../src/applications/harness/core/run/domain.ts)。
- 工厂：`createRunRuntimeComponent(inputs)`；组件名：`harness-run-runtime`；配置类型：`void`；`inputs` 提供 `now()` 和 `newId()`。
- 提供 `harness.run-runtime: RunRuntimePort`。
- 注入 [Session](../sessions/session.md) 的 `harness.session-runs`、[Bash](../tools/bash.md) 的 `tools.bash`、[Apply Patch](../tools/apply-patch.md) 的 `tools.apply-patch`、[进程工具](../tools/processes.md) 的 `tools.processes` 和 [文件工具](../tools/files.md) 的 `tools.files`。

## 服务与程序契约

| 接口 | 语义 |
| --- | --- |
| `start({ runId, program })` | 在任何异步读取前同步取得 program 所有权；同步拒绝不取得所有权；返回启动 Promise |
| `cancel(runId, reason)` | 请求取消；reason 为 `user-requested`、`owner-disposed` 或 `dependency-unavailable` |
| `wait(runId, signal?)` | 等待该 Run 的结束和清理；无活跃所有者时读取持久记录 |
| `getView(runId)` | 返回临时视图的结构化克隆，避免调用者修改内部状态 |

同 ID、同 program 的重复 `start` 复用已有 Promise；同 ID、不同 program 被拒绝。Runtime 区分 `started` 与 `finished`：第一次实际启动操作后可以返回 started；尚未启动即失败时由 finished 决定返回值。调用方通过 `wait` 等待完成。

程序收到的 `RunHost` 包含取消 `signal`、`perform(descriptor, start)`、`executeTools(requests, 'serial')`、`publish(frame)`。`OperationDescriptor` 指定 ID、`model | operation` 类型、序列化 intent、可选初始记录，以及必需的结果转换函数 `observe`。`OwnedCall` 的 `result` 是业务结果，`done` 是资源实际退出，两者必须都被观察。

## 操作屏障与工具循环

每次 `perform` 都按固定顺序执行：检查停止状态；持久化 `startOperation`；再次检查停止状态；同步启动并登记调用句柄；等待业务结果和实际退出；持久化 observation；再允许下一操作。启动句柄与登记之间没有 await，避免取消落在无主资源窗口。

状态写入失败立即关闭新操作准入并中止内部 signal。取消后仍提交已经发生的真实 observation，包括 Apply Patch 部分变更。若 `done` 提前失败，即使 `result` 永不返回也能识别清理失败；如果已有工具结果，还会尽量保留它。

工具从受信静态目录按 program 固定声明进行分派，涵盖三个来源的命令、文件读写、搜索、图片和计划契约，以及保留的 Bash/Apply Patch。整个批次的名称、ID 与来源参数 schema 必须先验证通过，随后按模型给出的顺序串行执行。调用 ID 必须非空、唯一且不超过 256 字符；未声明的工具在任何副作用前拒绝。旧 Bash/Apply Patch 参数仍必须恰有对应的一个字段。补丁文本语法错误是工具结果，允许模型修正；信封错误则在任何工具启动前拒绝整个批次。没有动态工具注册中心。

最终文本最多 65,536 UTF-8 字节；累计工具输出最多 131,072 字节，旧 Bash 计 stdout/stderr，其他工具计结果 JSON；图片原字节不进入工具文本结果。当前不设置固定模型轮次或工具次数上限。`publish` 每个活跃 Run 只保存一份不超过 1,048,576 UTF-8 字节的克隆快照，广播 `harness.run-view`；展示监听和不可序列化帧不能破坏执行，结束时删除快照。

协议 program 发布展示 v2 的有界完整快照，Runtime 不解释其原生内容类型、停止状态或诊断。模型工具请求保留其来源 exchange；本地工具事实仍只写入 `tool-started`、`tool-observed`、`tool-failed` 事件。前端按 Run、来源模型 exchange、请求 ID、名称和事件位置关联事实，不发布额外 `tools-N` 临时 exchange，也不以请求快照推断工具完成。取消和清理失败时，已经保存的真实工具结果及部分补丁事实继续可查询。

## 结算、取消与关闭

启动后先读取 Session 保存的 Run 和项目归属，验证原生上下文模式、绑定代与完整模型快照和 program 一致。执行结束时中止新操作，取消仍在途句柄，等待每个 `done` 和所有受管 Promise。若已打开进程 scope，先保存 `intent.kind=tool-process-cleanup` 的通用 operation，调用 scope.close() 终止并等待全部进程组，持久化真实退出、剩余输出与清理结果，再 `program.close()`，等待取消状态写入，然后请求 Session 原子结算。正常模型完成同样关闭进程，但不设置用户取消原因；存储失败也必须继续清理。最终 `program.release()` 在清理和持久结算之后释放绑定租约。

清理错误优先成为 `cleanup-failed`；状态写入失败成为 `state-write-failure`；依赖撤销成为 `dependency-unavailable`；普通用户取消或 owner 关闭成为 cancelled。清理失败与状态故障不能被普通取消掩盖，也不能生成成功节点。持久结算仍失败时 `wait` 拒绝，并保留失败 Promise 供重复查询；下次启动由 Session 标记 interrupted，不重放操作。

Effect 先停止接收，再取消并等待所有活跃 Run，清空临时视图，最后传播累计清理错误。中止 `wait` 的 signal 只移除这个等待者，不取消 Run。

## 验证

[harness server 核心测试](../../../tests/harness-server-core.test.mjs) 覆盖早期取消、结果/退出分离、清理异常、Runtime 替换；[工具循环](../../../tests/tool-loop.test.mjs) 覆盖串行批次、输出限额、退出等待；[Apply Patch 循环](../../../tests/apply-patch-loop.test.mjs) 覆盖部分变更与取消；[会话树](../../../tests/conversation-tree.test.mjs) 覆盖状态故障、结算原子性和等待者语义。统一执行 `npm run check`。

图片读取和 data URL 编码属于模型 operation 的内部工作，与网络请求共享取消和实际退出屏障。文件工具使用图片组件导入原字节；Runtime 将图片引用与工具观察交给 Session 同事务保留，只在提交后交 program 私有许可表接纳，不接触原图字节；图片读取/校验失败阻止发出模型请求，清理失败不创建成功节点。
