# Claude Agent Store 组件

[Claude Agent 模块](README.md)

## 职责与入口

索引库：线程 → 原生 session id、项目目录、标题及其来源（default/prompt/claude/user）、时间与最近一次 Run；Run 记录（状态、提示词、请求模型与 init 报告的实际模型、强度、结果与错误）；审批记录。转录不在这里，由 [SDK 适配器](sdk.md) 从 Claude 环境读取。

| 项目 | 定义 |
| --- | --- |
| 源码 | [core/store/component.ts](../../../packages/app-claude-agent/src/core/store/component.ts) |
| 工厂 / Nya 名称 | `createClaudeAgentStoreComponent({ now? })` / `claude-agent-store` |
| 服务 | `claude-agent.store: ClaudeAgentStorePort` |
| `inject` | `local-storage`（宿主业务 SQLite，不另开连接） |
| 迁移域 | `claude-agent` v4 |

## 接口

`createThread/listThreads/getThread/updateThread(id, patch, updatedAt)`、`createRun/findRunByKey/getRun/listRuns/updateRun(id, patch)`、`recordApproval/updateApproval/listApprovals(runId)`、`listRecentModels(limit)`（最新 Run 的请求模型与实际模型去重，最新在前）。记录即 DTO 去掉 `schemaVersion` 与内存计数的形状；结果与错误以 JSON 列保存。`createRun` 在事务内检查线程存在与 `(thread_id, idempotency_key)` 唯一，冲突抛 `idempotency-conflict`。

## 数据与资源归属

表 `claude_agent_threads`（updated_at 索引，v2 增加 `title_source`，默认 default）、`claude_agent_runs`（thread_id + created_at 索引，thread + key 唯一，v2 增加 `resolved_model`）、`claude_agent_approvals`（run_id + requested_at 索引）。审批的请求投影存 `request_json`，决定、答案与时间单独成列。v2 迁移在事务内把标题不等于目录名的既有线程标为 user 来源，其余保持 default；旧行的 `resolved_model` 为空。

## 执行、取消与清理

`apply` 登记迁移后，在一个事务里把 `running/cancelling` 的 Run 改为 `interrupted`（错误码 `interrupted`），对应线程的最近状态同步更新，未回答的审批记为 `cancelled`：Run 不跨进程存活。每个操作登记在途集合；Effect 停止准入并等待在途写入，数据库连接由宿主提供方随后关闭。

## 失败与兼容

未知线程/Run 返回 `thread-not-found` / `run-not-found`（404），冲突 409，关闭后 `service-unavailable`（503）。v1 库由 v2 迁移原地升级，`tests/claude-agent-runs.test.mjs` 用 v1 样本验证。

## 测试

[claude-agent-runs.test.mjs](../../../tests/claude-agent-runs.test.mjs) 通过 Runs 组件覆盖创建、幂等键、结算、审批持久化与重启标记。

## v3 权限模式

线程和 Run 分别追加 `permission_mode TEXT NOT NULL DEFAULT 'default'`；旧库不推断或扩大权限。Run 接受时固定本轮选择，活动切换仅在 SDK 确认后写回。线程选择对后续任务有效，0.1.5 的审批临时规则未跨 Run 复用；0.1.6 的完整会话授权见下节。v1→v2→v3 原地升级，权限持久化与进程重启行为见 `tests/claude-agent-capabilities.test.mjs`。

## v4 整个会话的授权

新增 claude_agent_session_grants：id、thread_id、native_session_id、project_path、approval_id（唯一）、permissions_json、created_at、revoked_at。权限仅保存应用自有的允许规则（tool/pattern）与额外目录，不保存 SDK 类型或自动解释工具输入。saveSessionGrant 在同一事务检查线程/会话/路径及 pending 审批、保存明确授权并更新审批决定；工具放行发生在事务完成之后。只返回审批仍为 allow-session、未撤销且原生会话和路径匹配的规则。

listSessionGrants 查询当前会话有效授权；revokeSessionGrant 以 revoked_at 保存撤销事实，不删除审计历史。只按新用户选择写入，不把 v1-v3 的历史本轮批准自动提升为完整会话授权。校验损坏或超限规则时关闭复用；每会话最多 200 条有效授权记录，合并最多 500 个规则/200 个目录且 JSON 不超过 128 KiB。重启不撤销已明确保存的会话授权，仍不恢复或重放被中断的工具操作。

## 迁移 v5：工作区索引

线程新增 options_json（预算、轮次、备用模型、检查点开关、会话 MCP 配置）、archived、tag、forked_from；Run 新增不可变 options_json 与可空 context_json。旧线程默认开启后续任务的检查点，旧 Run 的快照标记未开启，不补建历史事实。

claude_agent_checkpoints 只保存消息 UUID、线程/Run/原生会话身份和时间，备份与转录仍属于原生 Claude。claude_agent_mutations 在原生副作用前保存请求 ID、动作、规范输入、pending/completed/unknown 及结果身份；未知结果不重放，原生分支创建成功但索引失败时不丢弃已知原生身份。MCP 的 headers/env/令牌不属于配置契约；原生认证和 elicitation 回答不进入本库。

配置有独立 options_revision；保存必须匹配前一修订，事务比较并递增，过期页面返回 settings-changed，避免预算表单覆盖另一页面刚保存的 MCP。

## 0.1.8 附件与追加消息账本

迁移 v6 增加 claude_agent_assets（二进制上传与摘要）、claude_agent_inputs（同 Run 请求键、指纹、提交状态）、Run 附件元数据，以及线程 deleted 标记。资产实现为 Store 内的 `store/assets.ts` helper，不注册新 Nya 组件。单文件最多 8 MiB、每条消息最多 5 个及 16 MiB，单块原始字节最多 192 KiB，总声明容量最多 256 MiB。块按实际偏移串行提交，相同偏移及字节可观察原提交，不同内容不能覆盖；完成时校验文件头或 UTF-8 与摘要。尚未完成的上传不能进入任务。

追加消息在调用 SDK 前耐久预留；同请求键内容不同返回冲突。重启将 queued/sent 改为 unknown，只观察、不自动重新发送。取消队列与 SDK 消费状态通过事件保存；应用退出等待这些索引写入。附件通过 ID 关联，公开 Run 仅返回元数据，字节只在发送时由应用读取。被 Run 或追加消息引用的资产不能通过草稿 discard 删除。

删除会话先等待线程空闲，耐久预留操作，再调用原生 deleteSession，确认后把本地线程索引标记 deleted，默认列表不再返回。未知结果保留原操作，不重放删除。只删除明确选择的原生会话历史，不删除项目文件。
