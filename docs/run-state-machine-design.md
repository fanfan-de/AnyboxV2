# Run 状态转换设计（H2）

状态：2026-09-26，受控 Bash 与 Apply Patch 工具循环、DeepSeek 与 OpenAI Responses 非流式原生工具协议、Web 过程展示已接入；真实服务验收与本地模拟验证分开记录，Apply Patch 尚未进行真实模型联网验收。

## 执行边界

Run 服务负责准入、快照和取消入口；AgentLoop 独占执行期间的模型与工具调用；SQLite 状态组件持有 Run、执行阶段和事件。AgentLoop 从已固定的 Prompt、Session 历史和本次 Run 的工具轨迹组装模型消息。模型返回最终文本或一批工具请求，整批参数校验通过后才逐项执行。Bash 接收项目 ID 与命令，Apply Patch 接收项目 ID 与补丁；两者均通过 Projects 取得路径基准，项目目录不构成文件系统沙箱。

`src/run/execution.ts` 的 `advanceExecution(current, event)` 是纯函数。它根据已提交的事件推进阶段、调用次数、当前批次索引和修订号。状态组件在一个 SQLite 事务中提交新阶段与事件；模型和工具的启动事件必须先提交，外部调用才可开始。调用退出后再提交工具观察或固定类别的失败。终态事件、Run 状态和成功时新增的完整轮次节点也在一个事务中提交。

| 内部阶段 | 含义 |
| --- | --- |
| `ready-model` | 可以登记下一次模型调用 |
| `model-in-flight` | 模型启动意图已提交，等待结果与退出 |
| `ready-tool` | 整批工具请求已校验，等待当前项启动 |
| `tool-in-flight` | 当前工具启动意图已提交，等待结果与退出 |
| `terminal` | Run 已结算，不能再推进 |

对外 Run 状态仍为 `running`、`cancelling`、`completed`、`cancelled`、`failed`、`interrupted`。内部阶段记录执行位置；对外状态表达调用者需要的结算结果。`modelCalls` 与 `toolCalls` 用于记录进度，不设固定次数上限；循环持续到模型给出最终回答、用户取消或发生失败。最终回答最多 65536 字节，累计工具输出最多 131072 字节：Bash 计 stdout/stderr，Apply Patch 计结果 JSON 的 UTF-8 字节。Bash 组件单次保留的 stdout 与 stderr 合计最多 65536 字节。

## 模型与工具协议

`src/llm/port.ts` 定义项目自有的 `ModelReply`：`{ kind: 'final', text }` 或 `{ kind: 'tool-calls', content, calls }`。工具请求含 ID、名称与待校验参数。LLM 消息允许助手工具请求和按请求 ID 对应的工具观察。API 组件用 `supportsTools` 表示是否接受工具定义，DeepSeek 与 OpenAI Responses 均为 `true`。DeepSeek 将工具定义、助手工具请求和观察映射到 Chat Completions 的 `tools`、`tool_calls` 与 `role: tool`；工具请求显式关闭 thinking 模式，避免缺少 `reasoning_content` 回传的跨轮协议错误。

Responses 将函数定义、请求与结果映射为平铺的 function 工具、`function_call` 和 `function_call_output`，使用 `call_id` 关联调用。组件按同一 Run 的计划私有保留原生 reasoning、加密推理上下文、消息 phase 与函数调用，校验通用消息前缀和完整工具观察后按原顺序续传；使用 `store: false`，不建立服务端会话。最终文本接受 `final_answer`、未设置或 `null` 的 phase，`commentary` 不作为最终回答。这些原生细节不扩展公共 `LLMPort`、Run 事件或数据库类型。两种组件都在每个 Run 的首次模型调用内读取一次密钥，后续工具轮次复用。

Responses 同一计划在 `done` 前拒绝重叠调用，成功解析、未取消且清理完成后才在最终 `done` 阶段提交私有检查点并解锁；失败不推进检查点，也不触发 Run 自动重试。最终文本释放私有续轮上下文；新 Run 仍从对话节点的文本历史开始。异常退出后的在途 Run 继续结算为 `interrupted`，不新增上下文恢复或外部副作用重放。

当前有 `bash` 与 `apply_patch`，所有 Agent 可调用，不设置 Agent 工具允许列表。纯函数 `validateToolBatch` 在执行任何工具前校验整个批次的 ID、名称和参数结构；未知名称、重复 ID 或参数形状错误使整批零执行。Bash 命令须为非空字符串且不含 NUL，不按命令字节数拒绝合法的长文件写入；Apply Patch 接收字符串，补丁语法和文件冲突在执行时作为观察反馈。请求和结果使用两个已知工具的判别联合，AgentLoop 直接注入服务，无动态注册层。

Bash 非零退出码是包含退出码与有界输出的普通观察。Apply Patch 返回 `applied/rejected/partial/cancelled`，附带已完成 `changes`、未完成 `pending` 和可选诊断；语法拒绝、匹配冲突及预期文件系统失败可回传模型修正，执行器故障仍按固定类别结束 Run。`partial` 不是完整成功，可能已经修改文件；移动可能只创建目标而未删除源。下一次模型调用只能在当前批次每个已启动工具的 `result` 与 `done` 都观察并记录后开始，取消或执行器故障后不启动下一项。

`OwnedCall.result` 表示业务结果，`done` 表示实际退出。用户取消请求写入 `cancelling`、通知当前调用并等待 `done`；此后不启动下一项。依赖撤销同样取消并等待，按 `dependency-unavailable` 结算；清理失败优先记为失败。Bash 的命令副作用和 Apply Patch 已提交的文件均不回滚。Apply Patch 组件持有跨项目串行队列，先全量预检再逐文件提交；取消在检查点停止后续文件，已开始的单文件提交与临时资源清理须真正退出。多文件补丁没有事务原子性，队列也不约束 Bash 或外部文件写入。

每次工具启动写 `tool-started`，结果写 `tool-observed`，执行器或清理失败写 `tool-failed`；观察和失败显式带工具名。清理失败时，失败事件可附已经取得的 Apply Patch 结果，以保留已知变更事实，但 Run 仍失败。`advanceExecution` 同时检查请求 ID 和工具名，观察后才推进批次索引。

## 持久化与恢复

`run-state` 第 2 版迁移给旧 Run 表增加执行快照，并建立事件表。旧终态 Run 标为内部 `terminal`；旧在途 Run 在启动时结算为 `interrupted`。每次启动意图、工具观察与终态有递增序号，`StatePort.getRunExecution` 和 `getRunEvents` 可供受信组件读取。Run 服务与 Harness 门面提供事件读取，Web 通过 `GET /api/v1/runs/:id/events` 返回公开事件及有界输出摘要。

工具扩展不新增表或列。新执行 JSON 只写 `toolCalls`，事件只写通用 `tool-*`；`parseRunExecution` 将旧 `bashCalls` 映射为工具总数，`parseRunEvent` 将旧 `bash-*` 映射为带 `name: 'bash'` 的事件。兼容只在读取边界保留，原序号、时间及 `afterSeq` 不变，不维护旧格式写入器，也不全量重写已结算历史。

异常退出后，已记录的 `tool-started` 可能对应“工具尚未启动”或“已经产生副作用但观察未落盘”，包括部分补丁提交。重启统一把未终结 Run 标为 `interrupted` 并写入恢复事件，不重放命令或补丁。原幂等键仍指向旧 Run；Session 可用新键开始新的 Run。

本地行为测试覆盖工作目录与环境、长文件完整写入、混合工具串行批次、无效批次零执行、非零退出码、补丁拒绝与部分提交、超过原有调用次数限制后的正常完成、输出上限、取消竞态、依赖撤销等待、旧 SQLite 数据及 Bash 事件读取兼容，以及记录工具意图后的异常重启不重放。补丁专项还验证文本类型、精确匹配、文件预检与资源清理；真实服务验收不由这些模拟测试代替。
