# Claude Agent Store 组件

[Claude Agent 模块](README.md)

## 职责与入口

索引库：线程 → 原生 session id、项目目录、标题、时间与最近一次 Run；Run 记录（状态、提示词、模型/强度、结果与错误）；审批记录。转录不在这里，由 [SDK 适配器](sdk.md) 从 Claude 环境读取。

| 项目 | 定义 |
| --- | --- |
| 源码 | [core/store/component.ts](../../../src/applications/claude-agent/core/store/component.ts) |
| 工厂 / Nya 名称 | `createClaudeAgentStoreComponent({ now? })` / `claude-agent-store` |
| 服务 | `claude-agent.store: ClaudeAgentStorePort` |
| `inject` | `local-storage`（宿主业务 SQLite，不另开连接） |
| 迁移域 | `claude-agent` v1 |

## 接口

`createThread/listThreads/getThread/updateThread(id, patch, updatedAt)`、`createRun/findRunByKey/getRun/listRuns/updateRun(id, patch)`、`recordApproval/updateApproval/listApprovals(runId)`。记录即 DTO 去掉 `schemaVersion` 的形状；结果与错误以 JSON 列保存。`createRun` 在事务内检查线程存在与 `(thread_id, idempotency_key)` 唯一，冲突抛 `idempotency-conflict`。

## 数据与资源归属

表 `claude_agent_threads`（updated_at 索引）、`claude_agent_runs`（thread_id + created_at 索引，thread + key 唯一）、`claude_agent_approvals`（run_id + requested_at 索引）。审批的请求投影存 `request_json`，决定、答案与时间单独成列。

## 执行、取消与清理

`apply` 登记迁移后，在一个事务里把 `running/cancelling` 的 Run 改为 `interrupted`（错误码 `interrupted`），对应线程的最近状态同步更新，未回答的审批记为 `cancelled`：Run 不跨进程存活。每个操作登记在途集合；Effect 停止准入并等待在途写入，数据库连接由宿主提供方随后关闭。

## 失败与兼容

未知线程/Run 返回 `thread-not-found` / `run-not-found`（404），冲突 409，关闭后 `service-unavailable`（503）。没有旧格式需要迁入。

## 测试

[claude-agent-runs.test.mjs](../../../tests/claude-agent-runs.test.mjs) 通过 Runs 组件覆盖创建、幂等键、结算、审批持久化与重启标记。
