# 工作区与执行

[返回模块](README.md)

工厂 [`createPersonalAgentComponent()`](../../../packages/app-personal-agent/src/core/component.ts) 在当前应用 Nya 根安装组件，提供 `personal-agent.workspace` 与内部 `personal-agent.admission`，注入 `local-storage`、`models`、`app.activity`。无子 Context、项目 Context 或业务类。组件初始化迁移并恢复已有事实后返回；长期模型调用不阻塞启动。

`personal-agent.workspace` 的完整契约位于 [`contracts.ts`](../../../packages/app-personal-agent/src/contracts.ts)：查询工作区和详情，保存 Agent，设置默认打开偏好，创建和修改对话/任务，开始和取消 Run，显式建立新上下文段，委派任务及保存成果。输入与状态转换通过纯领域函数校验；持久化和运行资源留在组件边界。

Agent 保存稳定 ID、revision、系统提示词、用户显式记忆、Skills 文本、所选模型执行配置 ID 和上下文字符预算。更新使用 expectedRevision；在途 Run 持有此前完整配置，新 Run 使用最新配置。默认打开哪个 Agent 只是偏好，不是 Agent 层级或协调者身份。应用不根据对话自动写记忆或修改 Skills。

对话和 Task 是不同 kind 的独立记录，各自属于一个 Agent 并持有自己的上下文。任务目标、人工进展、等待条件、完成和取消不依赖某个对话的全局 head。一次推进先原子保存 Run 意图、配置快照、输入和完整文本上下文，再开始 Models `generateText()`；同一工作项只接受一个运行，不同工作项可以并行。每 Run 都是一次新的 Models execution；应用显式传递当前段的历史文本，不宣称原生 continuation 恢复。模型临时原生状态、认证头及 Key 不进入业务记录。

模型完成不代表任务完成：成功输出保存为该 Run 的事实，任务恢复可推进状态。成功结果保存 Models 返回的确切模型修订和协议；失败时公共文本接口没有返回执行配置快照，这两个字段为 null，不能从当前配置猜测历史修订。用户可以保存文本成果，明确关联某个 Run，或填写独立文本。手动委派创建另一个 Agent 的独立任务并固定 sourceWorkId；不自动执行、不隐式共享原任务上下文、不转移取消所有权。详情提供来源和下游任务状态及成果入口；原任务取消后下游仍可推进。

上下文预算包括 instruction 与本次输入的完整字符数，属于用户设置的保守字符上限，不等同于模型精确 token 上限。超预算不发起模型调用，保存 waiting/context-capacity 并返回明确错误。用户可以修改配置或显式开启新段；历史不删除，新段保留任务目标但不自动携带旧段文本。服务端模型自身上限和输出限制仍可能产生 incomplete-response 等失败。

Run 通过 Models 的可取消 operation 持有实际资源，结算等待 `result` 与 `done`。取消请求不等同于取消完成；清理失败保留不确定状态并阻止把它报告为成功取消。运行和接受中的工作参与 Activity 阻塞租约及 guard，防止停止、安装生效或卸载跳过正在工作中的 Agent。宿主主动关闭会停止准入、取消并等待受管执行和已接受写入；关闭界面只释放浏览器观察，不取消后台 Run。

应用数据使用客户端提供的独占 SQL 连接、自有迁移域及自有表保存；无需单独开启相同业务库。异常重启仅把旧 running Run 标记 interrupted 并把工作项置为等待；不凭超时或 PID 猜测成功，不自动重放任何未知请求。数据默认随宿主卸载保留，应用不提供 delete-data。

测试入口为 [`core.test.mjs`](../../../packages/app-personal-agent/tests/core.test.mjs) 和 [`http.test.mjs`](../../../packages/app-personal-agent/tests/http.test.mjs)。测试使用真实 Nya、SQL、Models 配置及驱动，只替换网络/Vault 外部资源。它们不替代真实模型账号、真实系统凭据与跨平台验收。
