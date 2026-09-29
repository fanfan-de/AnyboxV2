# Run 状态转换设计（H2）

状态：2026-09-28，Harness 已接入通用 Models execution、文本/工具/流式协议和 Web 配置。此次验证使用受控模型和临时存储，真实服务与系统凭据验收单独记录。

## 执行边界

Run 服务负责准入、快照和取消入口；AgentLoop 独占执行期间的模型与工具调用；Session 组件持有 Run、执行阶段和事件。AgentLoop 从已固定的 Prompt、Session 历史和本次 Run 的工具轨迹组装模型消息。模型返回最终文本或一批工具请求，整批参数校验通过后才逐项执行。Bash 接收项目 ID 与命令，Apply Patch 接收项目 ID 与补丁；两者均通过 Projects 取得路径基准，项目目录不构成文件系统沙箱。

`src/harness/run/execution.ts` 的 `advanceExecution(current, event)` 是纯函数。它根据已提交的事件推进阶段、调用次数、当前批次索引和修订号。Session 组件在一个 SQLite 事务中提交新阶段与事件；模型和工具的启动事件必须先提交，外部调用才可开始。调用退出后再提交工具观察或固定类别的失败。终态事件、Run 状态和成功时新增的完整轮次节点也在一个事务中提交。

| 内部阶段 | 含义 |
| --- | --- |
| `ready-model` | 可以登记下一次模型调用 |
| `model-in-flight` | 模型启动意图已提交，等待结果与退出 |
| `ready-tool` | 整批工具请求已校验，等待当前项启动 |
| `tool-in-flight` | 当前工具启动意图已提交，等待结果与退出 |
| `terminal` | Run 已结算，不能再推进 |

对外 Run 状态仍为 `running`、`cancelling`、`completed`、`cancelled`、`failed`、`interrupted`。内部阶段记录执行位置；对外状态表达调用者需要的结算结果。`modelCalls` 与 `toolCalls` 用于记录进度，不设固定次数上限；循环持续到模型给出最终回答、用户取消或发生失败。最终回答最多 65536 字节，累计工具输出最多 131072 字节：Bash 计 stdout/stderr，Apply Patch 计结果 JSON 的 UTF-8 字节。Bash 组件单次保留的 stdout 与 stderr 合计最多 65536 字节。

## 模型与工具协议

`@anybox/models` 提供 `ModelExecution` 与 `ModelResult`：结果包含 `status`、文本、工具请求及可选用量，文本与多个工具请求可以同时返回。Run 在准入时解析模型 ID，通过 `open()` 固定配置与凭据；具备有效工具能力时传入 Bash/Apply Patch 定义，否则执行纯文本请求。AgentLoop 首轮发送 Prompt、祖先历史与本轮用户输入，后续只提交新增工具结果。

Models 解析工具参数 JSON，并检查工具名称、调用 ID 与结果对应关系；AgentLoop 校验具体业务参数并执行。`incomplete` 和 `refused` 分别使 Run 以 `incomplete-response` 和 `refused-response` 失败，不执行其中的工具片段。原生 reasoning、phase 与续轮数据由协议私有保存，不进入 Session。DeepSeek 扩展显式关闭 thinking；Responses 使用 `store: false`。

模型公共 `result` 在实际退出、上下文提交与解锁后才返回。同一 execution 拒绝重叠调用，不同 execution 可以并发。AgentLoop 不自动重试，结算前必须 `execution.close()`；清理失败覆盖业务成功，不能创建节点。新 Run 从成功节点文本重新开始，不恢复跨进程原生上下文。临时流式事件只用于展示，不作为状态转换输入。

当前有 `bash` 与 `apply_patch`，使用有效工具能力模型的 Agent 可调用，不设置 Agent 工具允许列表。纯函数 `validateToolBatch` 在执行任何工具前校验整个批次的 ID、名称和参数结构；未知名称、重复 ID 或参数形状错误使整批零执行。Bash 命令须为非空字符串且不含 NUL，不按命令字节数拒绝合法的长文件写入；Apply Patch 接收字符串，补丁语法和文件冲突在执行时作为观察反馈。请求和结果使用两个已知工具的判别联合，AgentLoop 直接注入服务，无动态注册层。

Bash 非零退出码是包含退出码与有界输出的普通观察。Apply Patch 返回 `applied/rejected/partial/cancelled`，附带已完成 `changes`、未完成 `pending` 和可选诊断；语法拒绝、匹配冲突及预期文件系统失败可回传模型修正，执行器故障仍按固定类别结束 Run。`partial` 不是完整成功，可能已经修改文件；移动可能只创建目标而未删除源。下一次模型调用只能在当前批次每个已启动工具的 `result` 与 `done` 都观察并记录后开始，取消或执行器故障后不启动下一项。

`OwnedCall.result` 表示业务结果，`done` 表示实际退出。用户取消请求写入 `cancelling`、通知当前调用并等待 `done`；此后不启动下一项。依赖撤销同样取消并等待，按 `dependency-unavailable` 结算；清理失败优先记为失败。Bash 的命令副作用和 Apply Patch 已提交的文件均不回滚。Apply Patch 组件持有跨项目串行队列，先全量预检再逐文件提交；取消在检查点停止后续文件，已开始的单文件提交与临时资源清理须真正退出。多文件补丁没有事务原子性，队列也不约束 Bash 或外部文件写入。

每次工具启动写 `tool-started`，结果写 `tool-observed`，执行器或清理失败写 `tool-failed`；观察和失败显式带工具名。清理失败时，失败事件可附已经取得的 Apply Patch 结果，以保留已知变更事实，但 Run 仍失败。`advanceExecution` 同时检查请求 ID 和工具名，观察后才推进批次索引。

## 持久化与恢复

`run-state` v4 迁移保存会话所选 `modelId`、Run 的实际模型与显式请求模型 ID，以及非秘密的 `ExecutionSnapshot`。旧 `llm_snapshot_json` 迁为 `model_snapshot_json`，历史 profile/configVersion 仅以 `legacyModelSnapshot` 读取，不伪造 Models 版本。

`run-state` 第 2 版迁移给旧 Run 表增加执行快照，并建立事件表。旧终态 Run 标为内部 `terminal`；旧在途 Run 在启动时结算为 `interrupted`。每次启动意图、工具观察与终态有递增序号，`SessionRunPort.getRunExecution` 和 `SessionPort.getRunEvents` 可供受信组件读取。Session 服务与 Harness 门面提供事件读取，Web 通过 `GET /api/v1/runs/:id/events` 返回公开事件及有界输出摘要。

工具扩展不新增表或列。新执行 JSON 只写 `toolCalls`，事件只写通用 `tool-*`；`parseRunExecution` 将旧 `bashCalls` 映射为工具总数，`parseRunEvent` 将旧 `bash-*` 映射为带 `name: 'bash'` 的事件。兼容只在读取边界保留，原序号、时间及 `afterSeq` 不变，不维护旧格式写入器，也不全量重写已结算历史。

异常退出后，已记录的 `tool-started` 可能对应“工具尚未启动”或“已经产生副作用但观察未落盘”，包括部分补丁提交。重启统一把未终结 Run 标为 `interrupted` 并写入恢复事件，不重放命令或补丁。原幂等键仍指向旧 Run；Session 可用新键开始新的 Run。

本地行为测试覆盖工作目录与环境、长文件完整写入、混合工具串行批次、无效批次零执行、非零退出码、补丁拒绝与部分提交、超过原有调用次数限制后的正常完成、输出上限、取消竞态、依赖撤销等待、旧 SQLite 数据及 Bash 事件读取兼容，以及记录工具意图后的异常重启不重放。补丁专项还验证文本类型、精确匹配、文件预检与资源清理；真实服务验收不由这些模拟测试代替。
