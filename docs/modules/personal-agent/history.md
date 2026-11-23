# Personal Agent 的连续历史、子链与模型上下文

[返回 Personal Agent 模块](README.md)

在一个执行设备上，每个 Agent 有一个可持续续写的 Session。点击头像会打开已有 Session，首次打开时会创建 Session 并准备该 Agent 的[工作目录](runtime.md#工作目录)。工作区先显示最近的轮次，向前加载可继续查看较早轮次，发送消息始终从当前末端继续。

## 组件、所有权与接口

`personal-agent-sessions` 提供 `personal-agent.sessions` 与 `personal-agent.session-runs`，拥有连续历史的唯一身份、末端、应用轮次和原始协议记录。Run 负责确定本轮工作目录、模型、上下文与准入。RunRuntime 继续持有已接纳操作的取消、实际退出和恢复。三者使用应用已有的执行库、服务依赖和清理权属。

- `POST /api/v1/apps/personal-agent/agents/:id/session` 使用 `{}` 打开或创建该执行设备上 Agent 的连续历史，返回 `continuous: true`、`headNodeId` 和工作目录的内部 `projectId`。旧客户端仍可显式提交 `{ projectId }`，沿用已有目录绑定。
- `GET /api/v1/apps/personal-agent/sessions/:id/history` 在省略 `before` 时读取最近一页。`limit` 默认 24，接受 1 至 50，`before` 接受该 Session 的轮次 ID。响应返回当前 `headNodeId`、按时间正序排列的 `nodes`、该页涉及的 `subchains` 和关联的 `runs`。首页还包含当前末端最多 20 条在途、失败或取消等尝试。每个节点通过 `subchainId` 引用子链。把响应的 `nextCursor` 作为下一次的 `before` 即可读取较早的轮次，直到响应省略 `nextCursor`。
- `POST /api/v1/apps/personal-agent/sessions/:id/runs` 在连续历史中显式提交返回的 `projectId`、`parentNodeId`、`idempotencyKey` 及本轮输入。服务端事务核对当前末端并接纳一条继续执行。同键可查回已接纳 Run。成功结算原子追加原始轮次并推进末端。
- 在「设置 → 常规」修改所选 Agent 的默认模型。连续会话的模型字段反映当前生效的默认模型。改用另一种协议后，既有会话路径继续用于组包。
- 文件浏览、搜索、预览与准备使用同一目录身份。Run 保存其确切归属，单次执行恢复使用该 Run 的工作目录和已接纳上下文。
- 连续会话的新 Run 首先使用 Agent 当前配置的默认模型。缺省时，旧 API 调用仍可依次使用请求的 `modelId` 或 Session 已保存的模型。原 `POST /api/v1/apps/personal-agent/sessions/:id/model` 仍支持写入这个兼容值。每轮读取该 Agent 当前保存的 Prompt。接纳后的模型和原生初始化随 Run 固定。

### 子链与翻页

工作区先加载最近的成功轮次，向前翻页仍在同一 Session 中。历史接口为每个节点返回所属的 `subchainId`。子链首轮之前的成功节点是它的 `anchorNodeId`，该节点所属的子链是它的 `parentId`。只有产生成功轮次的子链才会出现在历史中。加载旧页后发送消息仍沿当前成功末端追加。

升级保留旧上下文根的身份及其已有轮次。新轮次按原生上下文能否续接分组，切换 API 后仍带入完整应用历史。旧项目会话可以从「设置 → 历史对话」或原链接查看。旧版创建项目会话的入口已退役，已接纳的请求仍可按幂等键查回。

## 模型上下文

### 连续历史与模型切换

会话节点通过父引用组成树。连续会话始终在当前成功末端追加，发送沿所选节点的祖先路径读取应用历史。每次发送都按当前选定 API 传入完整的已完成历史和本轮输入。模型、连接及初始化允许原生续接时，Models 驱动恢复兼容的原始记录。更换 Key、切换模型或提供方等操作使原生上下文不兼容时，应用按原顺序逐项编码完整的用户输入、助手文本、工具调用及结果，以当前连接的 Key 和 API 在同一个会话中继续。已经记录的工具结果随历史传入，实际执行仍归原 Run。失败或取消的 Run 不推进成功末端。

- **Chat Completions** 在 `messages` 中按顺序续接 `user`、`assistant` 和 `tool` 消息。兼容的原生续接保留模型返回的 `reasoning_content`。
- **Responses** 在 `input` 中传入消息、`function_call` 及 `function_call_output`，采用 `store: false`。兼容的原生续接保留输出项和加密推理 `encrypted_content`。 [Responses 会话状态](https://developers.openai.com/api/docs/guides/conversation-state?api-mode=responses)
- **Anthropic Messages** 在 `messages` 中按内容块传入 `tool_use` 及关联的 `tool_result`。兼容的原生续接保留带签名的 `thinking`、`redacted_thinking` 和块顺序。 [Anthropic 思考与工具调用](https://platform.claude.com/docs/en/build-with-claude/thinking-tool-workflows)
- **Gemini Interactions** 在 `input` 中传入 `user_input`、`model_output`、`function_call` 及关联的 `function_result`，采用 `store: false`。兼容的原生续接保留 `thought` 签名。 [Gemini 无状态多轮对话](https://ai.google.dev/gemini-api/docs/get-started#stateless)

模型专属推理、签名和服务端工具的私有数据留在原协议轨迹中。已记录的服务端搜索调用和结果元数据以逐项历史内容传给新 API。工具调用 ID 按目标协议要求编码并保持调用与结果配对。会话保持原工作目录的资源边界。历史无法完整还原时，在访问模型服务前返回 `history-incompatible`。

兼容的原样追加能更稳定地保留请求前缀，实际缓存命中取决于提供方已缓存的前缀与本次请求的匹配。具体接口和型号可能限制从其他 API 转入的工具历史。DeepSeek 的带工具思考模式要求回传原生推理，其 Chat Completions 接口限制在历史中插入工具调用。 [工具调用](https://api-docs.deepseek.com/guides/tool_calls/#inserting-tool-calls-mid-conversation) · [思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/#工具调用) · [缓存规则](https://api-docs.deepseek.com/zh-cn/guides/kv_cache/)

### 预算、持久化与恢复

兼容原生续接时，执行端用最近一次可用的提供方实测输入 token 数作基准，按 UTF-8 大小估算随后进入请求的原生响应片段和本轮新增输入。没有实测基准时，估算已组好的输入。切换模型或 API 时按目标协议编码后的输入重新估算。估算随 Run 公开为 `estimatedInputTokens`，上下文用量在运行中暂用估算，收到模型报告后使用实测。模型上下文是否超限由提供方判断。历史和本轮图片合计的应用批次上限继续独立校验。

接纳事务保存当前成功末端、本轮原生初始化和输入估算。执行库 `run-state` v21 补齐成功子链的起点索引和环境授权相关表。它兼容只含其中一组表的两种 v20，保留已有边界、环境偏好、会话选择和 Run 授权。v19 给已有 Run 保留缺省的输入估算。v18 的应用历史组包标记、独立应用轮次和原生记录继续用于重建。旧连续历史沿应用父节点读取，可从各轮原生记录恢复应用事件。此前已接纳且缺少授权快照的 Run 只允许清理、结算或取消。具有必要授权和恢复记录的 Run 沿原引用恢复。旧 Run 发送过的 `recent-conversation` 或 `historical-memory` 作为历史轨迹保留。

成功结算后，Run 准入可在内存保留该 Session 最新末端已经组好的原生上下文及预算统计。下一轮吻合同一末端、模型、协议、指令、工具和目录绑定时，复用上下文并开启本轮的新 execution。Models 核对配置和驱动代次并读取当前凭据，Session 接纳事务仍核对持久父引用。缓存最多保留 16 个末端，合计估算上限为 16 MiB。切换 API、兼容条件改变、重启或缓存淘汰时从持久历史重建。完整请求仍按原格式组包，图片继续读取并校验原字节。

### 轨迹

轨迹的输入项展示本轮新增消息，执行端在组包时从父引用重建完整历史。在「轨迹」中点开「上下文」，JSON 对象和数组按两空格缩进和换行显示。字段顺序、字符串转义及 Markdown 标记保留在原有位置。普通文本和无法格式化的片段按原样显示。

在「轨迹」中点开某条「助手」模型调用，可在明细中查看该请求的输入缓存命中与未命中 token 数。Chat Completions 优先采用 DeepSeek 等服务显式报告的命中和未命中数；只提供命中数时，可用已知的总输入数减去命中数得到未命中数。没有统计的项保持缺省，报告的 `0` 照常显示。已有 Run 从原始响应读取统计。

实现位于 [Session 组件](../../../packages/app-personal-agent/src/core/session/component.ts)、[SQLite 账本](../../../packages/app-personal-agent/src/core/session/sqlite-records.ts)和 [Run 准入](../../../packages/app-personal-agent/src/core/run/component.ts)。历史协议及旧会话读取见 [Session 组件手册](../sessions/session.md)。

## 验证

[网关集成测试](../../../packages/app-personal-agent/tests/http.test.mjs)和[连续历史测试](../../../packages/app-personal-agent/tests/continuous-history.test.mjs)使用临时执行库和模型替身。覆盖四种协议的原生请求、同一会话切换 API、用新 Key 重新组包、兼容续接跳过历史扫描、重启重建完整历史与应用轮次、上下文预算、历史迁移、目录归属及幂等接纳。[SQLite 迁移回归](../../../packages/app-personal-agent/tests/session-migration.test.mjs)覆盖两种 v15、v17、v18 和两种 v20 布局，核对原轮次、分页、子链身份和已保存的环境授权。

[Run 恢复测试](../../../packages/app-personal-agent/tests/run-recovery.test.mjs)验证重启后只有具备授权快照的 Run 能恢复执行，已持久保存的模型响应继续沿用。
