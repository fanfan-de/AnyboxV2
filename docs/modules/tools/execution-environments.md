# 执行环境授权组件

[工具模块](README.md) · [设计记录](../../agent-execution-environments-design.md) · [共享包](../../../packages/execution-environments/README.md)

## 装配与资源

两款应用的执行端各在已有 Nya 根中安装 `createExecutionEnvironmentComponent({ serviceKey })`。组件名和服务名均使用调用方传入的私有键，`inject` 声明 `local-storage`，由应用绑定到自己的执行 SQLite。组件启动先请求存储布局 2，再应用 `execution-environments` 迁移、取得本代所有权并清查前代准入。代码入口在[共享包](../../../packages/execution-environments/src/index.ts)，表结构见[授权账本](../../../packages/execution-environments/src/storage.ts)。

模块持有 Agent 的授权修订、变更请求、准入和退出证据。Session 继续保存业务调用意图、完整工具观察及结果。工具产生的子进程、文件、附着凭据、模型请求及其远端结果归相应提供方。每个服务实例使用随机代次，修改时在同一事务校验当前代次。独占数据库所有权负责跨进程互斥。组件关闭停止新调用、取消受管工作，并等待已取得的资源句柄实际完成。

## 身份与接口

每项权限包含环境契约 ID、具体目标 ID、工具 ID 和工具契约版本。目标和版本的导出规则见[运行绑定](../../../packages/execution-environments/src/bindings.ts)。同一 Agent 一次授权变更产生新的修订号，增加权限时保留既有条目的签发代次。撤销后再次授予同一工具会产生新代次，旧 Run 的绑定仍指向原代次。

- `get(agentId)` 只读当前授权。Session 在自身事务中使用 `readIn(reader, agentId)` 固定或核对授权。`seedIn(tx, agentId, tools)` 仅在受信初始配置尚未登记时写入，显式空集也会形成第一版记录。来源区分执行端管理者签发和受信配置。
- `set({ agentId, expectedRevision, requestId, tools })` 以 CAS 替换完整列表，由调用方把新增候选限制在已委托范围。同 ID、同参数的重试查回原操作。同 ID 不同内容或过时修订返回冲突。
- `observe(requestId)` 读取原授权变更及排空状态。`pendingChanges(agentId)` 返回该 Agent 仍待退出或缺少退出证据的变更，重新打开设置时可以继续观察。回执包括受影响、尚待退出及退出未确认的准入数量。业务 HTTP 入口核对 Agent 归属。
- `run(agentId, grants, operationId, start, signal)` 在当前权限与固定授权代次吻合时取得准入。`start(signal)` 同步返回操作的 `result` 和 `done`，应直接覆盖每次真实分派或网络发送。结果和退出均已结算后才完成。提供方应让 `done` 覆盖此项准入的实际资源范围。
- Models 在每次实际出站时使用独立的 `runModel`。仅声明函数的发送占用模型传输资源；一次托管搜索还可能在供应商处执行。进程中断后两种发送都按原 ID 保留为退出未确认。仅声明函数的旧请求无法执行函数，原授权仍有效时允许新的独立函数工作。撤权回执仍计入这个未确认的请求，缺少退出证明时无法重新签发相同授权。
- `reconcile(agentId, operationId, proveExit)` 供受信恢复适配器核对原提供方上的确切操作。未找到操作、查不到原目标或缺少退出证明时返回未确认。公网管理接口仅允许观察，证明由原资源所有者提供。
- `runScope` 登记 Run 的资源 scope。`resumeScope(agentId, grants, operationId, attach, signal)` 允许新所有者重新接管同一 Run 的取消和退出观察。它要求原所有者登记的 scope、原工具与授权代次、当前仍有效的授权。恢复时无需等自己的旧 scope 先结束，实际工具调用和下一次模型发送仍分别经过准入。接管前开始的旧观察无法覆盖已接管的记录。

## 撤权与发送的先后关系

同一所有者串行处理获取准入及改授权；资源自身的执行与退出在队列外进行。准入首次事务固定原操作 ID 及完整授权代次，并提交 `reserved`。下一事务持久提交 `sent` 后，再次同步核对关闭和上游取消信号，立即进入真实提供方。网络重试、下一次模型请求或另一项工具是独立的准入。已存在的操作 ID 被保留，调用同 ID 的 `run` 会拒绝重复派发。

| 耐久状态 | 中断后处理 |
| --- | --- |
| `reserved` | 尚未越过发送提交点，新所有者可结束该预留并释放所占授权。 |
| `sent` | 可能已到达外部执行方。新所有者按 `unknown` 保存，并保留原目标和授权代次。 |
| `unknown` | 提供方执行、scope 和托管搜索占用未确认时，拒绝同一目标工具的新准入。原操作只接受恢复观察。 |
| `exited` | 已取得此项准入的真实退出证据，保留 ID 防止重放。 |

撤权在事务中保存新修订、请求 ID 及受影响操作，随后对这些操作传播取消。已提交权限读取为关闭，仍有工作时回执为 `draining`。只有 `done` 或原操作查询证明退出才算完成。退出失败显示 `exit-unknown`，重新授权同一工具需要该工具的原占用实际清除。撤权事务保存失败会关闭这次变更涉及 Agent 的本代准入，并取消其在途工作；重复同一变更可恢复。若记载退出证明的存储写入失败，本代停止准入并在关闭时报告失败。

模型供应商可能自行在单次请求中运行托管工具。执行端确认的是这个模型发送及本地响应资源的退出，供应商内部动作的状态应由该提供方的原生观察表达。

## 设置与 HTTP

在“管理连接”选定执行端后，“执行环境”列出该应用可委托的目标、工具和已获得授权的 Agent。Computer 另列执行设备、附着权限和最近一次 worker 工具报告。“Agent 工具”按目标授予或撤销具体工具，还可单独保存选用哪些环境、其中哪些工具。保存偏好后，普通项目会话从新建时生效。Personal Agent 连续对话的下一次运行读取环境内工具偏好，采用新的环境集合须点击“应用已保存的环境到后续运行”。

以下路径相对于当前应用执行端的 `/api/v1`。经过客户端网关时，沿用该连接的应用、实例和修订绑定。

| 方法与路径 | 行为 |
| --- | --- |
| `GET /tool-environments` | 列出可委托目标及其已授权的 Agent、工具。 |
| `GET /agents/:id/environment-access` | 读取目标、授权及修订、偏好及版本，以及仍在等待退出证明的变更。 |
| `POST /agents/:id/environment-access/grants` | 提交 `expectedRevision`、唯一 `requestId` 和完整 `tools` 数组。新增项必须取自该 Agent 的目标清单。保留继续授权的条目，省略要撤销的条目。空数组撤销全部。 |
| `GET /agents/:id/environment-access/changes/:requestId` | 查询原变更的状态和受影响、等待退出、退出未知的操作数。提交响应丢失时按原请求 ID 查询。 |
| `POST /agents/:id/environment-access/preferences` | 提交 `expectedVersion`、`environmentIds` 和可选的 `toolIdsByEnvironment`。Computer 的工具偏好仍由 `/agents/:id/tools` 保存。 |
| `GET /sessions/:id/environments` | Personal Agent 读取会话当前采用的环境及版本。 |
| `POST /sessions/:id/environments` | Personal Agent 为连续对话提交 `environmentIds`、`expectedVersion` 和 `expectedGrantRevision`，只影响随后接纳的运行。 |

例如，给原本没有工具的 Agent 启用某个提供方的托管搜索，先读取 Agent 的 `environment-access`，从目标清单中取出该提供方确切的 `web_search` 条目。将其加入原授权列表，连同当前授权修订和新请求 ID 提交到 `/grants`。再将 `model-search` 加入 `environmentIds` 并保存到 `/preferences`。需要在已有连续对话中使用时，读取该会话的环境版本，再用刚保存的授权修订显式采用新的集合。运行时还会检查实际模型的提供方、协议、搜索能力和参数。历史工具详情显示当时固定的环境与目标。

偏好示例采用 `{"expectedVersion":0,"environmentIds":["notes"],"toolIdsByEnvironment":{"notes":["notes.read"]}}`，表示选用资料库的读取工具。给 `notes` 传空数组表示该环境内不选工具。从显式提交的映射移除 `notes` 表示恢复选用其中全部获准工具。省略整个映射会保留已有工具偏好。授权始终单独提交。 [管理投影](../../../packages/execution-environments/src/management.ts) · [界面与恢复测试](../../../packages/execution-environments/tests/settings-view.test.mjs)

## 验证

[授权与故障测试](../../../packages/execution-environments/tests/authority.test.mjs)覆盖修订 CAS、重放、跨目标及跨 Agent 的绑定、撤权取消与真实退出、写入失败、原 scope 接管与迟到回执，以及在预留提交、发送提交、提供方进入、撤权提交四个位置对子进程发送 SIGKILL 后重新打开同一数据库。

应用级覆盖包括[两款应用共享宿主时的私有授权](../../../packages/app-personal-agent/tests/http.test.mjs)、[自定义工具执行期间撤权](../../../tests/tool-environment-runtime.test.mjs)、[项目固定多个真实 Computer 目标](../../../tests/computer-worker-router.test.mjs)及[独立 worker 与服务端进程异常退出](../../../tests/computer-unit-faults.test.mjs)。
