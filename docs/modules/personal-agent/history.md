# Personal Agent 的连续历史与记忆

[返回 Personal Agent 模块](README.md)

点击头像后，工作区显示所选 Agent 在当前执行设备上的连续历史。本轮文件和工具使用该 Agent 的[工作目录](runtime.md#工作目录)，已有连续历史沿原路径追加。可在「设置 → 历史对话」或原会话链接回看旧版会话。原 0.1 文本记录仍由原客户端库保存，见[装配与数据边界](runtime.md)。

## 组件、所有权与接口

`personal-agent-sessions` 提供 `personal-agent.sessions` 与 `personal-agent.session-runs`，拥有连续历史的唯一身份、末端、上下文边界和原始记录。Run 负责确定本轮工作目录、模型、上下文与准入。RunRuntime 继续持有已接纳操作的取消、实际退出和恢复。三者使用应用已有的执行库、服务依赖和清理权属。

- `POST /api/v1/apps/personal-agent/agents/:id/session` 使用 `{}` 打开或创建该执行设备上 Agent 的连续历史，返回 `continuous: true`、`headNodeId` 和工作目录的内部 `projectId`。旧客户端仍可显式提交 `{ projectId }`，沿用已有目录绑定。
- `POST /api/v1/apps/personal-agent/sessions/:id/runs` 在连续历史中显式提交返回的 `projectId`、`parentNodeId`、`idempotencyKey` 及本轮输入。服务端事务核对当前末端并接纳一条继续执行。同键可查回已接纳 Run。成功结算原子追加原始轮次并推进末端。
- 文件浏览、搜索、预览与准备使用同一目录身份。Run 保存其确切归属，单次执行恢复使用该 Run 的工作目录和已接纳上下文。
- 每次新 Run 使用当时的 Agent 指令和工具设置。模型优先采用显式选模，其次为该连续历史的已保存模型覆盖，再其次为 Agent 当前默认模型。原生初始化和工具配置随 Run 固定，后续编辑只影响新 Run。

## 上下文与记忆

模型输入由本轮输入、能放入预算的近期完整对话文本及相关旧历史片段构成。执行端用模型声明的上下文、输入和输出上限、已配置生成参数以及文本的 UTF-8 大小估算预算，并为附件和协议开销留出空间。近期窗口最多使用 32 个完整轮次和 3,000 个估算 token。达到滚动条件时，建立一个新上下文根，记录退出窗口的原始轮次和前一个根。所有轮次继续保存在原历史路径上，近期原文沿同一 Agent 的时间线选取。回看历史或直接读取旧节点仍返回原始内容及附件引用。

窗口外的记录在滚动事务中进入 SQLite 全文索引。自动召回和「引用此轮」按原目录归属匹配。升级前绑定到其他目录的轮次仍可回看，自动召回继续使用其原目录绑定。召回最多选三条有来源的原文片段，合计至多 1,000 个估算 token。模型将近期文本与召回片段读作上下文资料。Run 保存采用的根、轮次和召回来源，以及实际编码的原生请求。恢复沿用原记录，原生工具往返仍由单次 Run 管理。

实现位于 [Session 组件](../../../packages/app-personal-agent/src/core/session/component.ts)、[SQLite 账本](../../../packages/app-personal-agent/src/core/session/sqlite-records.ts)和 [Run 准入](../../../packages/app-personal-agent/src/core/run/component.ts)。历史协议及旧会话读取见 [Session 组件手册](../sessions/session.md)。

## 验证

[真实网关集成测试](../../../packages/app-personal-agent/tests/http.test.mjs)使用临时执行库、受控模型和内存 Vault，覆盖空库打开、目录归属、旧历史接续、工作文件、原始消息、窗口滚动、检索边界、幂等请求和应用重启后的继续。
