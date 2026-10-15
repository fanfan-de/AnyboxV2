# Anybox Harness 架构评估与调整建议（2026-10-15）

[文档首页](README.md) · [组件手册](modules/README.md) · [架构图（2026-10-15）](architecture/anybox-harness-architecture-2026-10-15.md) · [模块边界](harness-module-boundary.md) · [重建计划](harness-server-plan.md)

状态：2026-10-15 评估稿。依据 HEAD `fd161c6` 加当日未提交的 U1 变更做静态阅读，未运行测试，未阅读 NyaCore 源码，Web 层只看了文件结构与导入关系。本文是评估和建议，不是已采纳的计划；每条建议附验收条件，采纳后转入[重建计划](harness-server-plan.md)，实施时按[维护约定](README.md#维护约定)同步组件文档。

## 结论

核心取舍是对的：资源归属与退出语义、耐久操作账本、不做统一消息抽象的原生协议 Loop、宿主与应用的硬边界，这四项构成了一个可信的 Agent 运行时底座，应当保持。

代价集中在五处：Session 变成全局存储、run 与 session 互相依赖、栅栏标识只靠约定区分、门面与路由重复声明、Run 生命周期靠闭包标志表达。另有两项阶段性问题：pre-1.0 就开始累积的读兼容分支，以及 NyaCore 没有版本固定。

建议按"先低风险、再正确性核心、最后结构重排"的顺序处理：栅栏表格与 NyaCore 固定随时可做；Run 生命周期显式化和 Run 持久化拆出 Session 应在 U2/U3 增加新的恢复路径之前完成；目录重排与路由表可穿插；兼容清理放在格式冻结点。

## 评估依据

方法：通读[组合根](../src/applications/harness/core/index.ts)、[Run](../src/applications/harness/core/run/component.ts)、[RunRuntime](../src/applications/harness/core/run/runtime-component.ts)、[Session 端口](../src/applications/harness/core/session/port.ts)与 [HTTP 门面](../src/applications/harness/http/handler.ts)；用脚本统计 `core/` 各目录间的 `import` 边（含 type-only 导入）与双向依赖；按关键字统计栅栏标识与兼容标记的出现次数。

| 指标 | 数值 |
| --- | --- |
| `src/` TypeScript 行数 | 27.5k |
| `tests/` 顶层行数 / 用例数 | 23.5k / 876 |
| 组件手册登记的 Nya 组件 | 约 50 |
| Session SQLite 实现 | 1043 行、12 张表、11 次迁移、导入 8 个兄弟目录 |
| `harness.sessions` / `harness.session-runs` 方法数 | 31 / 18 |
| core 门面转发方法 / HTTP 命令接口成员 / 路由分支 | 约 60 / 约 60 / 57 |
| core 内目录间双向依赖（不含组合根） | 5 对 |
| 栅栏与版本标识种类 | 8 种 |
| Run 与 RunRuntime 两文件的 try 块数 | 24（共 670 行） |
| 超过 200 字符的行 | core 139、web 188 |
| `ANYBOX_*` 环境变量 | 27 个 |

## 应当保持的设计

- **资源归属与退出语义。** `OwnedCall` 把业务结果和实际退出分开，组件通过 Effect 登记清理，关闭先停准入再取消并等待退出。46 个测试文件使用真实 SQLite，覆盖 SIGKILL、取消窗口和恢复。这是 Agent 运行时最难做对的部分。
- **耐久操作账本。** 意图、启动、观察三段持久屏障加 owner epoch 栅栏，让工具副作用在进程崩溃后可接续而不重放。
- **原生协议不做统一消息抽象。** 四个 Loop 各三十余行、共用一个 exchange runner；原生记录版本化、只读兼容。避免了多协议翻译层的信息损失。
- **硬边界。** Models 独立包不反向依赖 `src/`；`src/host/` 不导入应用；密钥只在 Vault；每进程一个 Nya 根，组合根显式列出全部组件。
- **文档与代码同步。** 组件手册、架构图和设计文档有日期和源码链接，差异可追溯。

## 结构性代价

### 1. Session 成为全局存储

现象：`harness.sessions` 与 `harness.session-runs` 持有会话、节点、Run、操作账本、恢复游标、单元绑定、图片与文件引用、默认模型、工具选择。

证据：[sqlite-records.ts](../src/applications/harness/core/session/sqlite-records.ts) 1043 行，`run-state` 迁移域 12 张表，导入 run、tool、computer、unit、image、project-files、prompt、project 八个目录；其中直接调用 `validateToolBatch` 与 `needsComputer`，即 Session 已在解释工具与 Computer 语义。

影响："所有状态经 Session"原本是事务边界，现在成了职责边界。每个新领域（图片、文件、单元）都要进入 Session，Session 的变更面与其他所有组件相关。

### 2. run 与 session 互相依赖

现象：Run 的领域类型、program 契约与 execution 规则在 `run/`，持久化在 `session/`；session 引 run 13 处，run 引 session 5 处。

证据：目录间双向依赖共 5 对：run↔session、computer↔run、computer↔project、computer↔project-files、computer↔workspace。后四对的原因是 `computer/` 同时放了 Authority 侧与 worker 侧代码。

影响：一个模块被切成两个目录，修改 Run 持久格式时两边都要改；computer 的环使 worker 根的依赖面大于它实际需要的。

### 3. 栅栏标识靠约定区分

现象：revision、附着 epoch、bootId、runOwnerEpoch、instanceGeneration、historyScopeEpoch、workspaceEpoch、generationId 各挡一种竞争，但类型上全是 `number` 或 `string`。

证据：出现次数 revision 247、epoch 94、bootId 48、runOwnerEpoch 41、instanceGeneration 39、historyScopeEpoch 26、workspaceEpoch 20、generationId 14。定义分散在 run、computer、workspace、unit 与 Models 包的 domain 文件中；没有一处文档并列说明。

影响：哪个栅栏挡哪种竞争只在注释和各设计文档里；传错参数编译器不会报错。U2 到 U4 还会增加新的栅栏。

### 4. 门面与路由重复声明

现象：[core/index.ts](../src/applications/harness/core/index.ts) 的 `HarnessServerApi` 约 60 个转发方法；[http/handler.ts](../src/applications/harness/http/handler.ts) 的 `HarnessServerApiCommands` 再声明一遍，之后是 57 条 `method === … && path === …` 分支；Web 的 `Api` 是按路径字符串调用的函数，各客户端模块各自书写路径。

影响：新增一个功能要依次改领域端口、core 门面、HTTP 命令接口、路由分支、Web 客户端路径与 DTO。U1 变更触及 89 个文件，一部分来自这个税。

### 5. Run 生命周期是隐式状态机

现象：对外 `Run.status`、持久化的 `RunExecution.phase`（当前只写 `active`，旧阶段只读）、`RunResumeState.stage`（`model-pending`、`response`、`cleanup`、`settling`）三套状态并存；RunRuntime 还用 `transferred`、`stateFailed`、`reason`、`closing`、`cleanupCategory`、`finalOutputExceeded` 等闭包变量表达中间状态。

证据：Run 与 RunRuntime 两个文件 670 行里有 24 个 try 块；关键不变量如"检查取消与同步持有句柄之间不能有 await"靠注释维持。[Run 状态转换设计](run-state-machine-design.md)仍描述已删除的 AgentLoop 与 `ready-model`、`model-in-flight` 等不再写入的阶段。

影响：这是正确性风险最集中的区域。每增加一种恢复路径（U3 远端 Models 会增加），都要在闭包标志的组合里再加一个分支。

### 6. pre-1.0 累积的读兼容分支

| 兼容标记 | 文件数 | 出现次数 |
| --- | --- | --- |
| `dialogue-v1` 只读会话 | 8 | 21 |
| `known-tools-v1` 初始化 | 3 | 5 |
| `NativeRunInput` v1/v2 | 7 | 14 |
| Loop 1.0 到 1.2 记录 | 3 | 4 |
| 旧 `ExecutionSnapshot` | 4 | 7 |
| Models 旧参数格式 | 3 | 3 |
| `ANYBOX_LLM_*` 引导 | 1 | 10 |
| 旧 Prompt JSON 存储 | 1 | 3 |
| `api-key-manager` 旧凭据 | 4 | 6 |
| `ANYBOX_MODELS_DATABASE` 一次性导入 | 3 | 4 |

影响：33 次提交的项目已经维护 11 次 Session 迁移和上表全部读路径。AGENTS.md 要求删除旧实现，但读兼容本身也是实现，并且每条都带样本测试。

### 7. NyaCore 没有版本固定

现象：`@nya/core` 以 `file:../NyaCore/packages/core` 引用，版本 0.1.0-rc.1；兄弟仓库 HEAD `13431c5`、无 tag、工作区有未提交改动；package-lock 只记录路径。

影响：干净环境下的构建结果取决于兄弟仓库当时的状态，无法从本仓库的某个提交复现。

### 待观察项

- 前端 43 个手写 DOM 文件，没有共享状态模型，最大文件接近 900 行。现在能用，UI 继续增长后会成为下一个痛点；不在本文建议范围内。
- 基础设施走在产品前面：单元附着、长轮询邮箱、跨进程恢复、对话树并发 Run 已就位，产品侧还没有 PTY、子 Agent、联网搜索。这不是缺陷，是取舍，见"待决定事项"。

## 调整建议

### 建议 1：把 Run 持久化从 Session 拆出

目标：Session 只持有会话、节点、默认模型与工具选择；Run 事实由 `run/` 下的 `harness.run-records` 组件持有；消除 run↔session 双向依赖。

做法：

1. 把 `harness.session-runs` 中的 Run 方法（findAcceptedRun、registerRun、loadRunContext、loadRunResume、listRunResumes、claimRunResume、saveRunResume、getRunOperation、startOperation、observeOperation、getRun、getRunExecution、requestCancellation、settleRun）移到 `run/records-port.ts`，由新组件实现；readFileSnapshots、describeImages 留在 Session，它们是资源引用。
2. `harness.sessions` 上的 Run 查询（getRun、getRunByKey、listRuns、getRunEvents、getRunRecords）改由 run-records 提供，组合根门面改转发目标。
3. 接受事务与成功结算仍是单事务：Session 提供接收事务对象的入口，例如 `fixProtocol(tx, …)`、`retainInputs(tx, …)`、`commitNode(tx, …)`，由 run-records 在自己的事务内调用。这要求[存储端口](../src/storage/port.ts)明确"事务对象可以传给另一组件的方法"。
4. 第一步只拆文件与端口，`run-state` 迁移账本仍由一处登记；迁移账本是存储事实，不是职责边界。独立迁移域留到后续。

验收：

- 导入图中 `session/` 不再导入 `run/program`、`run/execution`、`computer/`、`unit/`；`run/` 对 `session/` 只保留对 `port.ts` 中会话类型的引用。
- sqlite-records.ts 降到 600 行以内。
- harness-server-core、native-session、conversation-tree、computer-* 行为测试不改断言通过。

不改变：持久格式、迁移版本、单事务规则、HTTP 路径与 DTO。

风险：settleRun 跨两个组件写同一事务，必须先在存储端口定义契约再动代码。

### 建议 2：把 Run 生命周期写成显式状态机

目标：阶段、转换与不变量成为数据和纯函数；RunRuntime 只执行副作用。这与[函数式开发方法](harness-server-functional-development.md)中"纯决策函数输出新快照与操作意图"的约定一致。

做法：

1. 新增 `run/lifecycle-domain.ts`：状态集合（preparing、accepted、running、cancelling、cleanup、settling、settled）、事实类型（操作启动、观察、取消请求、依赖撤销、写入失败、program 关闭）和纯函数 `advanceLifecycle(state, fact)`，返回新状态与操作意图列表；意图是"关闭 program"、"取消在途操作"、"持久化 stage"、"结算"之类的数据。
2. RunRuntime 的 `perform`、`cancel`、`finish` 改为：归一化事实、调用 `advanceLifecycle`、执行意图。闭包里的布尔标志由状态字段替代。
3. 合并 `RunExecution.phase` 与 `RunResumeState.stage`：选一个作为唯一写入来源，另一个只保留读旧数据。
4. 重写 [Run 状态转换设计](run-state-machine-design.md)为当前状态表与转换表。

验收：

- lifecycle-domain 的纯函数测试覆盖全部转换，特别是取消请求落在"持有句柄之前"和"之后"两种时序。
- runtime-component.ts 中 `let` 布尔标志不超过 2 个。
- computer-runtime-cancel-window、computer-session-resume、computer-worker-resume、harness-server-core 测试不改断言通过。

不改变：持久格式（stage 值集合只增不改）、`RunHost` 契约、协议 Loop、`PreparedRunProgram`。

风险：这是正确性最集中的区域，先补纯函数测试再改组件；分两次提交，先引入状态机并与现有标志并行断言一致，再删标志。

### 建议 3：栅栏标识显式化

目标：每种栅栏挡什么竞争在一处可查，类型上不可混用。

做法：

1. 新增 `docs/fencing-tokens.md`，表格列出名称、定义位置、递增时机、校验位置、挡住的竞争。初稿如下，各行需逐项核对：

| 标识 | 定义位置 | 递增时机 | 校验位置 | 挡住的竞争 |
| --- | --- | --- | --- | --- |
| `revision` | session、prompt、工具设置 domain | 每次用户修改 | `expectedRevision` 比较 | 并发编辑覆盖 |
| `runOwnerEpoch` | [run/program.ts](../src/applications/harness/core/run/program.ts) | Runtime 接管 Run | Session 操作写入、worker 授权 | 旧 Runtime 进程的迟到写入 |
| `generationId` | Models 原生类型、[协议注册表](../src/applications/harness/core/protocol-agents/registry.ts) | 协议驱动注册 | prepare 固定、续轮比对 | 注销后的驱动续轮 |
| `historyScopeEpoch` | Models 配置库 domain | Key、地址、认证方式变更 | 续接检查 | 跨账户续接历史 |
| `instanceGeneration` | [computer/domain.ts](../src/applications/harness/core/computer/domain.ts) | Computers 换代 | Operations placement | 退役实例上的声明 |
| `workspaceEpoch` | [workspace/domain.ts](../src/applications/harness/core/workspace/domain.ts) | 工作区重新绑定 | 工具执行绑定校验 | 旧绑定的工具执行 |
| `bootId` | [worker-port.ts](../src/applications/harness/core/computer/worker-port.ts)、[unit/domain.ts](../src/applications/harness/core/unit/domain.ts) | worker 或单元每次启动 | `previousExited` 判定 | 旧 boot 的孤儿进程被接管 |
| 附着 `epoch` | [unit/domain.ts](../src/applications/harness/core/unit/domain.ts)、[worker-attachments-domain.ts](../src/applications/harness/core/computer/worker-attachments-domain.ts) | 撤销或重新附着 | Run 恢复前 verify、worker 授权 | 已撤销附着的 Run 续接 |

2. 各 domain 文件为自己的标识定义 branded type，例如 `type RunOwnerEpoch = number & { readonly [brand]: 'run-owner-epoch' }`，只在递增处构造。

验收：表格每行有可跟随的源码链接；把 `instanceGeneration` 传给 `runOwnerEpoch` 参数时 `tsc` 报错。

不改变：运行时取值与持久格式。

### 建议 4：合并门面并改用路由表

目标：新增一个端点只改三处：端口实现、路由表项、Web 调用。

做法：

1. HTTP 层直接消费 `HarnessServerApi`，删除 `HarnessServerApiCommands` 的重复声明；单元侧（attachUnit、pollUnit、replyUnit 等）与本机 worker 控制面本来不在 core 门面，单独保留为小接口。
2. 把 57 条分支改为一张路由表 `{ method, path, command, decode, encode }`，由一个分派函数执行；`sessionView`、`runView` 等投影函数挂在表项上。
3. 可选：从路由表生成 Web 端的路径常量，避免字符串漂移。

验收：handler.ts 中 `method === ` 分支只剩单元侧或归零；新增一个只读查询端点的改动文件数不超过 3。

不改变：路径、DTO、认证、SSE、客户端网关白名单。

### 建议 5：computer 目录按进程侧拆分

目标：Authority 侧与 worker 侧代码分目录，消除 computer 与 run、project、project-files、workspace 的双向依赖。

做法：`computer/authority/`（Computers、Operations、worker 客户端、路由）、`computer/worker/`（执行器、worker 根装配、附着账本、拨出）、`computer/contract/`（worker-port、query-domain、operations-domain 中的共享类型）。只移动文件和导入路径。

验收：`computer/worker/` 不导入 `run/`、`session/`、`unit/component.ts`；导入图中 computer 相关双向依赖归零或只剩 type-only。组件名、服务名、worker HTTP 协议不变，测试不变。

### 建议 6：在格式冻结点清理读兼容分支

目标：定一个格式冻结版本，之前的旧格式一次性迁移或标记只读导出，之后删除读兼容代码与样本测试。

做法：

1. 先查实际部署（腾讯云与本机）的业务库中是否存在 `dialogue-v1` 会话、v1/v2 原生输入和旧 Loop 记录；有则提供 `harness:migrate` 一次性命令，无则直接删。
2. 分三类处理：有真实数据的一次性迁移；只有开发期数据的直接删除；外部格式（models.dev 快照版本、Loop 版本号本身）保留。
3. 删除对应的 AGENTS.md 兼容描述、`tests/fixtures/legacy-*` 与只为旧格式存在的用例。
4. 不压缩迁移链；11 条迁移本身代价小，删的是读路径。

验收：上文兼容标记表中除保留项外出现次数归零；`npm run check` 通过。

风险：删前必须核对真实数据；旧凭据读取（api-key-manager）要确认所有设备已完成一次复制。

### 建议 7：固定 NyaCore 版本

目标：从本仓库任一提交可复现构建。

做法：短期在仓库记录 NyaCore 提交（如 `.nya-core-commit` 加 check 脚本校验）；中期改为 git submodule 或 `npm pack` 出带版本号的 tarball 提交到 `vendor/`；长期发布到私有 registry。

验收：干净 clone 加指定 NyaCore 提交可通过 `npm run check`；提交不匹配时脚本失败。

## 实施顺序与依赖

| 顺序 | 建议 | 前置 | 性质 | 建议时机 |
| --- | --- | --- | --- | --- |
| 1 | 3 栅栏表格与 branded type | 无 | 文档加类型 | 立即，U2 前 |
| 2 | 7 NyaCore 固定 | 无 | 构建 | 立即 |
| 3 | 2 Run 生命周期显式化 | 无 | 正确性核心 | U3 增加远端 Models 恢复路径之前 |
| 4 | 1 Run 持久化拆出 Session | 存储端口事务契约 | 结构 | 建议 2 之后，U3 之前 |
| 5 | 5 computer 目录拆分 | 无 | 机械重排 | 可穿插，U2 增加 worker 代码之前 |
| 6 | 4 门面合并与路由表 | 无 | 机械重排 | 下一批端点之前 |
| 7 | 6 兼容清理 | 核对真实数据 | 删除 | 格式冻结点 |

建议 2 与建议 1 都改 `run/`，先做 2 是因为状态机改造在单一端口稳定时风险更低，之后再移动端口。建议 5 与 4 不依赖其他项，可以在等待验证时穿插。

## 待决定事项

- **基础设施还是产品。** 当前架构按可组合、跨机器的 Agent 运行时规划（[可组合单元设计](composable-units-design.md)与 Tetral 参考都指向这个方向）。如果下一阶段仍是 U2 到 U4，本文建议 1 到 3 的价值最高；如果转向产品能力（PTY、子 Agent、联网搜索），建议 4 与 6 更先受益。
- **格式冻结点。** 以 1.0 发行物为界，还是以 U4 完成为界。
- **NyaCore 发布方式。** 子模块、tarball 还是私有 registry，取决于 NyaCore 是否会有本仓库之外的消费者。

## 未验证与局限

- 没有运行 `npm run check`；所有数字来自静态统计。
- 导入统计包含 type-only 导入，部分双向依赖可能只是类型引用。
- 没有阅读 NyaCore 源码，对组件生命周期的判断依据本仓库的使用方式与 AGENTS.md。
- Run 与 RunRuntime 的判断基于通读两个文件，没有逐条核对每个状态转换。
- 栅栏表格为初稿，递增与校验位置需逐项核对。
- Web 层只看了文件结构与导入，没有评估交互与状态管理质量。
