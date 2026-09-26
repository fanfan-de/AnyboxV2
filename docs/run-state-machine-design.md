# Run 状态转换设计（H2）

状态：2026-09-26，受控 Bash 工具循环、DeepSeek 原生工具协议和 Web 过程展示已实现并通过本地验证。

## 执行边界

Run 服务负责准入、快照和取消入口；AgentLoop 独占执行期间的模型与 Bash 调用；SQLite 状态组件持有 Run、执行阶段和事件。AgentLoop 从已固定的 Prompt、Session 历史和本次 Run 的工具轨迹组装模型消息。模型返回最终文本或一批工具请求，整批校验通过后才逐项执行。Bash 只接收项目 ID 与命令，工作目录由 Projects 服务决定。

`src/run/execution.ts` 的 `advanceExecution(current, event)` 是纯函数。它根据已提交的事件推进阶段、调用次数、当前批次索引和修订号。状态组件在一个 SQLite 事务中提交新阶段与事件；模型和 Bash 的启动事件必须先提交，外部调用才可开始。调用退出后再提交工具观察或固定类别的失败。终态事件、Run 状态和成功时新增的 Session 轮次也在一个事务中提交。

| 内部阶段 | 含义 |
| --- | --- |
| `ready-model` | 可以登记下一次模型调用 |
| `model-in-flight` | 模型启动意图已提交，等待结果与退出 |
| `ready-tool` | 整批 Bash 请求已校验，等待当前项启动 |
| `tool-in-flight` | 当前 Bash 启动意图已提交，等待结果与退出 |
| `terminal` | Run 已结算，不能再推进 |

对外 Run 状态仍为 `running`、`cancelling`、`completed`、`cancelled`、`failed`、`interrupted`。内部阶段记录执行位置；对外状态表达调用者需要的结算结果。模型与 Bash 调用次数用于记录进度，不设固定次数上限；循环持续到模型给出最终回答、用户取消或发生失败。最终回答最多 65536 字节，累计 Bash 输出最多 131072 字节；Bash 组件单次保留的 stdout 与 stderr 合计最多 65536 字节。

## 模型与工具协议

`src/llm/port.ts` 定义项目自有的 `ModelReply`：`{ kind: 'final', text }` 或 `{ kind: 'tool-calls', content, calls }`。工具请求含 ID、名称与待校验参数。LLM 消息允许助手工具请求和按请求 ID 对应的工具观察。API 组件用 `supportsTools` 表示是否接受工具定义；DeepSeek 为 `true`，将 Bash 定义、助手工具请求和观察映射到 Chat Completions 的 `tools`、`tool_calls` 与 `role: tool`，OpenAI Responses 为 `false`，保持纯文本。DeepSeek 的工具请求显式关闭 thinking 模式，避免缺少 `reasoning_content` 回传的跨轮协议错误。

首版只有 `bash`。所有 Agent 可调用，不设置 Agent 工具允许列表。纯函数 `validateBashBatch` 在执行任何命令前校验整个批次的 ID、名称和参数；命令须为非空字符串且不含 NUL，不按命令字节数拒绝合法的长文件写入。一项无效则整批零执行。Bash 非零退出码是普通观察，包含退出码和有界输出，会回传模型；取消、超时或执行器故障按固定类别结束 Run。下一次模型调用只能在当前批次每个已启动 Bash 的 `result` 与 `done` 都观察并记录后开始。

`OwnedCall.result` 表示业务结果，`done` 表示实际退出。用户取消先把 Run 改为 `cancelling`，再取消在途调用并等待 `done`；此后不启动下一项。依赖撤销同样取消并等待，按 `dependency-unavailable` 结算；清理失败优先记为失败。已经启动的 Bash 可能有副作用，取消不回滚它。

## 持久化与恢复

`run-state` 第 2 版迁移给旧 Run 表增加执行快照，并建立事件表。旧终态 Run 标为内部 `terminal`；旧在途 Run 在启动时结算为 `interrupted`。每次启动意图、工具观察与终态有递增序号，`StatePort.getRunExecution` 和 `getRunEvents` 可供受信组件读取。Run 服务与 Harness 门面提供事件读取，Web 通过 `GET /api/v1/runs/:id/events` 返回公开事件及有界输出摘要。

异常退出后，已记录的 `bash-started` 可能对应“命令尚未启动”或“命令已产生副作用但观察未落盘”。重启统一把未终结 Run 标为 `interrupted` 并写入恢复事件，不重放命令。原幂等键仍指向旧 Run；Session 可用新键开始新的 Run。

行为测试覆盖工作目录与环境、长文件完整写入、串行批次、无效批次零执行、非零退出码、超过原有调用次数限制后的正常完成、输出上限、取消竞态、依赖撤销等待、旧 SQLite 数据迁移，以及记录 Bash 意图后的异常重启不重放。
