# Session 原生对话树与分支并发

状态：2026-09-29。新会话使用 `native-local-v1`，同一 Session 固定协议；完整原生历史通过不可变记录链跨 Run 和重启恢复。既有 `dialogue-v1` 会话只读，不导入、不补造原生上下文。验证使用临时 SQLite，不自动迁移工作区真实数据库。

## 会话、节点与模型选择

Session 保存项目、Agent、可空 `modelId`、`historyMode`、可空 `protocolId` 、可空 `archivedAt` 和创建时间，没有全局 head。`modelId` 始终是 ModelConfiguration ID。新空 Session 可以调整默认模型；首次 Run 的接受事务原子固定协议。两个协议并发提交首个 Run 时，只有符合已提交绑定的一方被接受。已接受 Run 随后失败、取消或中断也不解除绑定。

后续默认模型选择和显式 `RunInput.modelId` 都检查协议。父节点恢复额外校验协议格式、驱动／Loop 版本、模型及有效参数、工具契约和 Models 的 `historyScopeEpoch`。Key、连接地址等语义变更使旧历史无法继续时明确拒绝，不按 hostname 或相同连接 ID 猜测账户兼容性。配置显示名变化不改写原生历史。切换协议或应用不兼容配置时新建 Session。

节点保存原始输入和显示摘要、来源 Run、父节点及内部上下文恢复引用。摘要不是历史恢复依据，合法非文本结果允许空摘要。成功节点不可更新、删除或改变父节点；失败、取消及中断不创建节点。每个成功 Run 形成独立节点，没有独立 Branch 实体。

| 操作 | 起点和新输入 |
| --- | --- |
| 开始 | `parentNodeId:null`，使用该会话固定的初始化 |
| 继续／分叉 | 指定成功节点，读取其完整原生记录链 |
| 重新生成 N | `N.parentId`、`N.input`、`N.images` 和新幂等键 |
| 编辑 N | `N.parentId`、修改后的原始文本与图片引用和新键 |
| 重试失败／取消 Run | 原起点与原始文本和图片引用、新键；不恢复旧工具执行位置 |
| 查看旧会话 | 查询旧节点／Run；继续时另建空原生 Session |

编辑和重新生成产生兄弟节点，不携带被替换节点及其后代。继续只读选定父路径，不能混入兄弟、失败、取消或进行中的候选上下文。

## 准入、Prompt 与上下文

`startRun({sessionId,parentNodeId,input,images?,idempotencyKey,modelId?})` 的父节点必填且可为 null。输入、键和显式模型 ID 经过现有 trim 校验。同 Session、同键、同规范化输入及有序图片 ID、同父节点、同显式模型选择返回原 Run；任何差异都是幂等冲突。先查旧键，再读取当前设置，因此重试不会重新选模型或应用新版模板。

模型选择优先级仍为显式 `modelId`、Session 默认值、Agent 默认值。Run 从应用协议注册表取得固定 Models 代、Loop、codec 和展示版本，打开新的 native execution。每个分支、每个 Run 都有自己的 execution，凭据只在初始化时读取一次。

会话首次接纳 Run 时保存唯一的不可变初始化记录：完整 instruction/context Prompt 快照、工具声明和宿主工具契约版本。同会话所有根 Run 和后代共享它，首次失败或取消也不会解除；重新生成／编辑首节点仍沿用旧指令。发布新 instruction/context 仅影响尚未接纳 Run 的会话，已有会话需新建会话才应用新指令。每个新 Run 单独固定当前 task-template，将其应用一次于本次原始输入，并保存 v2 原文、模板快照、编码前文本和服务端确认的有序图片描述。恢复不重新套用旧模板，当前模板也不会包裹旧消息。并发首次接纳在事务内复核初始化，拒绝使用已过期初始化的候选。

原生上下文运行期唯一权威所有者是 execution。Session 持久层保存可恢复的版本化数据，不保存 SDK 实例、execution、reader、取消句柄、凭据或 Vault 引用。Session 服务只临时管理其委托的图片上传/读取句柄，关闭会取消并等待它们退出。Run 接受事务再次校验 Session 绑定和精确父恢复引用，防止准备与提交之间的竞态。

同父并发 Run 从同一不可变恢复引用初始化，乱序完成不改变彼此输入。工具往返、原生调用 ID、签名和协议关联状态沿该分支保留；兄弟分支的工具轨迹不进入上下文。工具仍在项目工作目录执行，历史隔离不提供文件系统隔离或回滚。

## 不可变记录与事务

`run-state` v5 在同一 Session 持久所有者下增加：

- Session 协议绑定与历史模式、Run 绑定快照和 schemaVersion 3 模型快照。
- 不可变根初始化、每 Run 原始输入／模板，以及版本化原生记录。
- 独立 operationId 的操作账本：启动意图、实际观察与退出结果。
- 每成功节点的增量上下文链节和原生结果记录引用。

v6 增加原生记录的通用 resource_refs_json 列；旧 v1 输入按无图片读取，旧 JSON 不重写。节点 images 从来源 Run 投影，不重复保存附件。Run 接纳事务通过图片组件同步 retainIn 验证与保留输入；失败、取消和 interrupted 的已接受 Run 仍保留图片供查看与重试。

每个请求记录只保存本次原生 intent／增量请求配方与资源描述；响应内容只保存一次。上下文链节引用父链节、共享根初始化、本 Run 记录及小型恢复元数据，不复制完整历史或逐轮增长的 recordId 数组。读取时沿选定路径在内存展开，协议 codec 用固定版本重建请求及续轮上下文。历史格式未知、记录损坏、归属错误、父链缺失或有环都拒绝恢复，不退回文本拼接。

同一 recordId 重复出现只在 Run／协议归属、格式、resourceRefs 和 payload 完全一致时幂等接纳。已有原生记录、上下文和结果引用均不可修改或删除。

成功结算在单事务内裁决终态、保存最终原生记录、创建上下文恢复引用、写终态事件、插入节点及结果记录关系、连接 `Run.resultNodeId`。结果引用必须存在并属于本 Run，所有受管操作已经有实际观察；任一写入失败整体回滚，不发布可继续的节点或悬空引用。重复结算返回原终态。

Run 的公共状态保持 running/cancelling/completed/cancelled/failed/interrupted。公共账本不规定模型与工具交替：模型及其他协议操作产生 `operation-started/operation-observed/operation-failed`；已知本地工具保留 `tool-started/tool-observed/tool-failed`。原生工具 ID 与独立公共 operationId 不混用。旧 `model-*`、`bash-*` 和阶段格式只有读取兼容器，没有旧写入入口。

## Runtime、撤销与恢复

Run 负责准入、取消和等待；RunRuntime 拥有交接后的 program、模型与工具操作及清理责任；协议 Loop 决定原生续轮、工具桥接和结束。Runtime 不解释 stop reason，也不要求“模型→工具→模型”的固定阶段机。本期本地工具串行，Apply Patch 继续独占自身跨项目队列。

`Runtime.start({runId,program})` 在首次异步读取前同步登记所有权。相同 program 的重复 start 共享启动／结束任务；同步拒绝意味着 Run 仍负责关闭未交接 program。`waitRun` 覆盖已经接受但尚未交接的窗口。

每次外部操作遵循持久屏障：先保存启动意图和请求记录，再检查停止状态，同步取得并登记句柄，立即观察 result/done，等待实际退出，提交观察后才能交回 Loop。持久写失败禁止下一操作，不能重放已发生的副作用。取消后仍保存已经实际产生的工具观察和 Apply Patch 部分提交。

取消关闭新操作准入，取消并等待全部句柄、观察提交和 program 退出。模型关闭返回不可变退出报告后再清除私有状态；Runtime 在资源实际退出、报告校验和持久提交完成前不发布成功节点。清理失败及状态写失败优先于普通取消。正常成功与取消的竞争由 Session 事务顺序裁决。

单协议绑定注销停止该代准入，撤销初始化与关联 Run，并等待模型、工具、程序和结算后释放租约；其他协议继续运行。Models 驱动注销只负责自己的资源，应用绑定注销负责整个 Run。旧代只能清理自身 entry；lease release 不等待注销整代，避免等待环。

应用关闭先停止外部准入，依靠单根 Nya 的依赖快照和 Effect 顺序等待 Run、Runtime、Session 与存储。重启将遗留 running/cancelling 结算为 interrupted，保留已提交原生记录与工具事实，不自动恢复或重放副作用。新 Run 从成功节点恢复，重新读取当前凭据并检查兼容性。

`waitRun(id,signal?)` 只取消等待者。HTTP 超时、断开和浏览器关闭不取消 Run。

## 查询与 Web

所有 Session、节点、Run、事件查询仍经 Session。HTTP Session 响应增加历史模式和协议 ID；Run 返回绑定版本及安全模型快照。原生恢复记录只在受信服务端读取，经协议投影后才进入浏览器；签名、密文续轮内容及原生运行对象不会自动下发。

| 接口 | 行为 |
| --- | --- |
| `POST /sessions` | 创建空原生 Session |
| `POST /sessions/:id/model` | 检查只读状态和绑定协议后修改默认模型 |
| `POST /sessions/:id/runs` | 显式父节点、输入、幂等键与可选模型 |
| `GET /sessions/:id/nodes/:nodeId`、`/path` | 查询节点／有序祖先；不隐式选最新节点 |
| `GET /sessions/:id/nodes?parentNodeId=root` | 按直接子节点分页 |
| `GET /sessions/:id/runs`、`/runs/by-key/:key` | 列表、过滤活动 Run 或查回幂等请求 |
| `GET /runs/:id`、`/events?afterSeq=0` | 查询状态和已提交事实 |
| `GET /runs/:id/view` | 重建协议安全展示快照，合并当前有界临时视图 |
| `POST /runs/:id/cancel`、`GET /runs/:id/wait` | 单 Run 控制及等待 |

共享 Web 管理导航、分屏、分支、订阅和 Run 控制；协议模块维护内容块、引用、工具状态和安全流式投影。`harness.run-view` 仅保存每个活动 Run 的一个有界临时快照；最终展示来自已确认记录。重连重新查询展示快照，不能依靠完整重放 delta。流式信息不创建业务节点。

## 旧数据与验证

v1–v4 历史迁移保留原行为：旧 `turns_json` 按数组顺序迁为单链，不根据相同文本或时间猜测来源 Run；旧快照 JSON、事件游标和歧义来源保持只读。v5 将迁移前所有 Session（包括旧空 Session）标记 `dialogue-v1`，禁止继续和修改模型，不导入到新原生会话。旧 profile/configVersion 和 v2 快照由专门的只读类型解释，不保留统一执行引擎。

Chat/DeepSeek 的 v2 原生记录可以与旧 v1 文本记录混合恢复；v1 读取器拒绝伪装图片。整条父路径验证为无图片时才允许 imageInput false→true，其余兼容要求不变。图片只来自当前 Run 与指定成功父路径；编辑、重新生成及同父并发不混入兄弟引用。

上线前停止旧宿主、备份数据库及图片目录并确认排他所有权。正常构建和测试不修改工作区数据库。

验证覆盖 `conversation-tree` 的并发／竞态／事务故障，`conversation-migration` 的旧样本不重写与迁移回滚，`native-session` 的首次协议绑定、不可变增量引用、Prompt 固定与模板一次应用、持久启动屏障，以及工具／Harness 测试的取消、实际退出、清理失败与无副作用重放。五协议端到端及 Web 展示验收另由原生协议集成测试和 Web 测试覆盖。

## 会话归档

run-state v7 增加可空 archived_at；既有会话默认未归档，历史 JSON 不重写。归档仅调整会话管理状态，不影响树、固定初始化或资源引用。项目列表隐藏归档会话，跨项目归档列表集中查询，按 ID 仍可查看全部历史。存在 running/cancelling Run 时拒绝归档；Run 准备前及接受事务内检查归档，已接受幂等查询保持优先。恢复后可继续原成功父路径，旧 dialogue-v1 恢复后仍只读。归档不自动取消、不删除、不批量处理。
