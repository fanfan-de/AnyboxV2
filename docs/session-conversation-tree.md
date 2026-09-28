# Session 完整轮次对话树与分支并发

状态：2026-09-28。对话树、分支并发与 Web 分屏保持原语义；现已将模型执行接入通用 Models，增加 Session 模型选择、Run 模型快照及临时流展示。验证使用临时 SQLite，未迁移工作区真实数据库。

## 语义与归属

Session 保存项目、Agent、可空 `modelId` 与创建信息，不含 `turns` 或全局 head。`modelId` 是后续 Run 的默认选择，不是模型 execution；修改它不会改写历史节点或影响已接受的 Run。只有完整助手回答之后可以继续/分叉；空 Session 的虚拟根是特例，使用 `null`，无需根记录。

```ts
interface ConversationNode {
  id: string
  sessionId: string
  parentId: string | null
  input: string
  output: string
  sourceRunId: string | null
}
type RunHistory =
  | { kind: 'tree'; parentNodeId: string | null }
  | { kind: 'legacy-unknown' }
```

一个节点是一轮原始用户输入和最终回答，成功提交后不可更新、删除或改父节点。一个新 Run 成功产生一个节点；运行中、失败、取消和中断不产生节点。节点只有一个生成来源，却可作为任意多个 Run 的起点。没有独立 Branch 实体，根到节点的路径就是分支。

| 操作 | 新 Run 的起点和输入 |
| --- | --- |
| 开始 | `parentNodeId: null`，新输入 |
| 继续或分叉 | 指定完整节点 ID，新输入 |
| 重新生成 N | `N.parentId` 和 `N.input`，新键 |
| 编辑 N 的输入 | `N.parentId` 和修改后的输入，新键 |
| 重试已知起点的失败/取消 Run | 复用起点与输入，新键 |
| 起点未知的旧 Run | 必须由用户选定位置，再提交新键 |

重新生成/编辑是 `startRun` 的组合使用，创建兄弟节点，不更改原节点和后代；新 Run 使用当前 Prompt 与模型配置。重试不是从旧工具位置恢复。第一版没有修改助手回答、运行中分叉、工具检查点分叉或失败位置续跑。

## 准入、上下文与结算

`startRun({sessionId, parentNodeId, input, idempotencyKey, modelId?})` 的父节点必填、可为 null。输入、键和显式模型 ID 沿用 trim 校验。先查已有键，再读取当前配置；同 Session、同键、同规范化输入、同父节点以及同显式模型选择返回原 Run。更换输入、父节点或显式 `modelId` 都是冲突。省略模型与显式传入某个模型不是同一个幂等请求；已接受的省略模型请求不会因 Session 后来切换默认值而重新解析模型。

新准入按请求 `modelId` → `Session.modelId` → Agent 的 `modelId` 解析选择，没有可用选择时明确拒绝。Run 服务用 `models.open()` 打开执行上下文并取得非秘密快照，固定 Model/Provider 版本、协议实现版本、参数与本次读取的凭据。有效工具能力明确可用时提供 Bash 和 Apply Patch 定义，否则仅进行文本调用。配置或 Key 的后续修改只影响新 execution。新 Run 固定 `history`、`contextVersion: 'dialogue-v1'`、Prompt 内容与版本、实际 `modelId`、`requestedModelId` 和 `ExecutionSnapshot`；execution 本身只留在内存。

接受事务验证 Session、起点同 Session、祖先无环且父引用完整，再写入 Run 及持久快照。准入不创建节点。Run 将 `{runId, execution}` 直接交给 AgentLoop；Session 不持有执行对象、调用句柄、原生协议状态或凭据。AgentLoop 通过 `loadRunContext` 读取固定的 Prompt 和不可变祖先路径，在第一次 `generate()` 中提交以下初始消息，而非读取 Session 的所有节点：

1. 本 Run 的 agent-instruction、context 快照。
2. 从根到起点的祖先输入原文与完整回答。
3. 经本 Run task-template 处理的当前输入。

后续每轮只把新增工具观察交给同一 execution。Models 保留前轮规范化消息、模型工具请求与协议私有续轮状态；AgentLoop 负责工具参数业务校验、执行及完整观察，不重复提交整个历史。一次模型回复可以同时包含文本和多个工具调用，只有完整 `completed` 回复才能推进工具执行；截断或拒绝结算为固定失败类别。

兄弟节点、兄弟工具轨迹和失败记录不参与上下文。历史 task-template 不再次应用。祖先不可变、起点和组装版本固定，因此其他分支晚完成或配置切换都不会改变已接受 Run 的上下文。

SQLite 单连接只串行短事务。没有 Session 或父节点活动排他约束，也没有运行期父节点锁。同键准入共享一个准备/启动任务，不同键独立准备；AgentLoop 内每个 Run 的模型、Bash 与 Apply Patch 调用仍按现有顺序推进；不同 Run 使用不同 execution，可以选择不同 Provider 并行调用。

成功结算在一笔事务里读取最新 Run、裁决终态、写执行阶段与终态事件、插入完整节点、记录 `resultNodeId`。节点父 ID 始终来自准入时的 `history`，不按完成时间推断。失败/取消/中断只写 Run 和事件。重复结算返回已有终态，不重复插入。

- 幂等唯一约束：`UNIQUE(session_id, idempotency_key)`。
- 节点来源的非空 `source_run_id` 唯一；复合外键限制父节点/来源 Run 属于同一 Session。
- 触发器固定节点正文和父子关系、Run 历史起点和已提交结果引用，并校验新节点与成功 Run 的父节点/输入/输出一致。
- 每个 Run 的事件 `(run_id, seq)` 唯一；Run `revision` 在可见状态/进度写入时递增，供客户端丢弃旧响应。

## 生命周期与故障

沿用单个 Nya 根和 `inject` 依赖：Session 拥有会话、节点、Run 记录和事件，提供查询与执行记录两个服务面；Run 负责准入与控制，AgentLoop 独占交接后的 `ModelExecution` 和模型/工具调用。业务 SQLite 由通用存储组件持有；通用 Models 的配置 SQLite、凭据及协议组件各自管理其资源。Provider/Model 仅是数据记录，不引入项目或任务 Context，也不修改对话树的资源归属。

AgentLoop 在首次异步读取前登记启动/完成任务，同一 runId 重复 start 共享任务。Run 服务在接受事务前登记交接任务，wait 覆盖已提交但尚未交给 AgentLoop 的窗口。execution 只沿 Run → AgentLoop 交接，Session 仅持久化非秘密的 `ExecutionSnapshot`；AgentLoop 同步拒绝时，由 Run 关闭未交接 execution 并结算已接受记录。未接受的准入失败同样必须关闭已打开的 execution。启动阶段的取消被保留，首次/下一次外部调用前再次检查。关闭立即停止新准入、取消已登记任务，等待准入和交接、资源 `done` 及结算后，Session 再等待数据操作与通知退出，最终 SQLite 关闭连接。

Models 公共调用 `result` 成功前已等待底层实际退出、上下文提交并释放本轮占用；AgentLoop 仍立即观察 `result` 与 `done`，以收集失败与清理错误。工具调用保持结果与实际退出分开的契约。所有模型/工具资源退出且 `execution.close()` 完成之前，Run 不提交成功节点或终态；流式临时文本不改变这项保证。清理失败优先为 failed，不能被后续持久化错误掩盖；存储故障也以 failed / state-write-failure 保留，而非降为普通取消。取消先提交时后续成功尝试结算为 cancelled，成功先提交时取消返回 completed。取消一个 Run 不影响其他分支。

状态读取/写入失败停止推进，不执行下一模型/工具步骤。已取得的句柄会被取消并等待退出；存储仍可写时以固定 `state-write-failure` 结算，持续不可写则等待者收到持久化错误。AgentLoop 保留拒绝的执行任务，重复 start 不会重放。重启把所有遗留 running/cancelling 独立结算为 interrupted，保留已知历史起点，不重放任何不确定工具副作用。

`waitRun(id, signal?)` 可取消等待本身。HTTP 超时、断开或 Web 组件关闭时会移除等待订阅与定时器，不调用 `cancelRun`。应用根关闭仍按原生命周期取消并等待所有 Run。

## HTTP 合约

保留同源、本机单用户 `/api/v1`。Session 响应仅元数据，包含可空 `modelId`。Run 响应包含 `history`、`revision`、状态、实际 `modelId`、`requestedModelId`、非秘密 `modelSnapshot` 以及可选 `resultNodeId`/结果/错误；继续隐藏 Prompt 内容、execution、原生协议状态和凭据。旧 Run 的原模型摘要只读返回为 `legacyModelSnapshot`，不作为可执行配置。

| 方法 | 参数与行为 |
| --- | --- |
| `POST /sessions` | `{projectId,agentId,modelId?}`；省略模型时使用 Agent 默认值或 `null` |
| `POST /sessions/:id/model` | `{modelId}` 更新后续 Run 使用的会话默认模型；返回 Session |
| `POST /sessions/:id/runs` | `{parentNodeId: string|null, input, idempotencyKey,modelId?}`；缺少父节点返回 400，显式模型参与幂等比较 |
| `GET /sessions/:id/nodes/:nodeId` | 查询完整节点，未知节点 404 |
| `GET /sessions/:id/nodes/:nodeId/path` | 查询有序祖先路径；`root/path` 返回空路径 |
| `GET /sessions/:id/nodes?parentNodeId=root` | 分页直接子节点；`parentNodeId` 必填，支持 `limit=1..100`（默认 50）及不透明 `cursor`；返回 `{nodes,nextCursor?}` |
| `GET /sessions/:id/runs` | 可加 `status=active` 和 `parentNodeId=root或节点ID`；包含同起点的多个执行 |
| `GET /sessions/:id/runs/by-key/:key` | 只读查回已接受请求；路径中的键要 URL 编码；找不到返回 404 |
| `GET /runs/:id` | 指定 Run 状态/结果 |
| `GET /runs/:id/events?afterSeq=0` | 只返回 seq 大于游标的事件，保留既有有界输出摘要 |
| `POST /runs/:id/cancel` | `{}`；只取消该 Run |
| `GET /runs/:id/wait?timeoutMs=25000` | 0..25000 毫秒，返回 `{done,timedOut,run}`；终态 done=true、timedOut=false；超时则相反 |

接口不提供隐式“最新节点”。列表的完成/插入顺序只供展示，客户端必须持有明确查看位置。模型配置、版本及 Key 操作由独立的 `/models/*` 接口映射 `models.settings`，不会改变 Session 的对话树语义；详情见 [Web 客户端设计](./web-client-design.md)。

## 旧数据与升级

上线迁移前停止旧应用，确认数据库排他所有权并备份。`run-state` v3 按 `turns_json` **数组顺序**创建单链，节点 ID 含旧 Session 和数组索引的迁入来源；`sourceRunId` 全部留空。即使内容重复或时间相同也不匹配旧 Run。原 Run 输入、结果、失败、幂等键、快照、执行阶段及事件保留，统一标记 `legacy-unknown`，活动记录再按恢复流程 interrupted。

v3 的表、节点、列删除和迁移版本记录原子提交，失败整体回滚。成功后不再读取或写入 `turns_json`，不存在 `appendTurn` 运行路径；只有迁移代码和测试样本读取旧格式。旧成功链可直接作为新 Run 起点。旧执行记录必须在客户端独立展示，不伪装成已知节点关联。

`run-state` v4 增加 `Session.model_id`、Run 的 `model_id` 与 `requested_model_id`，并将旧 `llm_snapshot_json` 列改名为 `model_snapshot_json`。新 Run 写入完整 `ExecutionSnapshot`；数据库触发器保持已接受 Run 的模型快照与两个模型 ID 不可变。旧 Run 保留原快照数据，读取时归一化为 `legacyModelSnapshot`，`modelId`、`requestedModelId` 和新快照为 `null`，不推断其对应当前 Model，也不保留旧模型执行入口。旧 Session 的选择初始为 `null`，后续可显式设置或由宿主 Agent 默认值解析。

旧 pending 恢复需先按 Session/键查回已接受 Run；没有记录且缺少父节点或固定的 `modelId` 时，只恢复输入并要求用户选定位置与模型，不得猜最新节点或静默换模。该规则已接入会话控制器并有旧记录测试。

## Web 集成

分屏面板分别管理查看节点、关注 Run 和活动 Run 集合。祖先路径与运行记录分别管理，完整节点支持继续、编辑重发、重新生成；旧 Run 保留独立状态卡渲染逻辑，当前页面沿用隐藏运行卡的展示选择。发送固定父节点和显式模型 ID，接受后允许从原位置继续提交新键。模型选择独立于查看节点，切换只改变后续提交；未确认请求保存原模型，重试不会跟随 Session 默认值变化。当前标签页主动提交可显式跟随结果；改变查看位置、关注其他 Run、开始新输入或关闭面板都会停止跟随，刷新仅恢复位置与关注对象。草稿按 Session/父节点在页面内保存，未确认请求保持原参数，按键查回已接受对象；起点或模型未知的旧 pending 仅恢复输入供确认。

客户端共享 SSE 订阅，以 `run-changed` 触发每会话串行刷新，并保留定时校准/断线兜底；按 revision 合并状态、按 afterSeq 读取过程。`model-progress` 只显示有界临时文本，最终回答仍以节点为准。生命周期代次和取消读取阻止过期响应发布；关闭视图不取消 Run，已经发出的写入独立结算。实现、存储边界与浏览器验收记录见[Web 客户端设计](./web-client-design.md)。

## 工作目录及验证

所有分支的 Bash 仍使用 Session 项目目录。历史隔离不提供文件隔离、文件回滚或环境可复现；并发工具可以修改彼此看到的文件。未来独立工作区通过显式工作区绑定接入，不改变对话节点含义；本版不引入 worktree、资源限流、压缩、权限、预算或通用调度。模型流式事件通过宿主通知转发，不改变节点原子提交或工具副作用边界。

`tests/conversation-tree.test.mjs` 使用可控模型、启动屏障和临时 SQLite 验证同父并发、祖先/工具隔离、快照、再生成、幂等、乱序完成、重复启动、取消竞态、result/done、事务故障、工具副作用不重放、多 Run 重启以及应用关闭等待。`tests/conversation-migration.test.mjs` 使用旧 v2 样本验证重复内容/相同时间不猜关联和迁移回滚。`tests/web-server.test.mjs` 验证新 HTTP 查询、分页、增量事件、超时、断开和 Web 单独关闭。


Models 接入的行为验证还覆盖多模型/多 Provider 选择、配置与密钥修改不影响已打开 execution、同键模型选择冲突、准入失败或交接拒绝时关闭 execution，以及流式展示不会提前创建成功节点。Web 的模型选择与进展测试位于 `tests/model-selection-client.test.mjs`、`tests/models-client.test.mjs` 和 `tests/run-change-client.test.mjs`；Models 自身的协议与生命周期测试位于 `packages/models/tests/`。
