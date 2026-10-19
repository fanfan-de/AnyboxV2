# 正式角色加载、版本生效与卸载协调组件

[包管理模块](README.md) · [安装账本](registry.md) · [本地安装](installation.md) · [应用包设计](../../application-packages-design.md)

## 工厂、服务与依赖

[activation.ts](../../../packages/host/src/package-management/activation.ts) 的 `createPackageActivationComponent(config)` 创建 `host-package-activation`，注入同一根上的 `host.package-registry`、`app.products` 和 `app.activity`，提供 `host.package-activation: PackageActivationPort`。它协调版本选择、卸载、准入保护、界面退出与角色交接，不注入或查询 Models、Session、Run、Computer、业务连接及凭据。业务是否忙碌由应用自己的通用 guard 回答；业务关闭和迁移仍由应用及其 Nya 组件完成。

配置的 `manager` 是受信进程所有者，声明可管理角色并提供冻结、解冻、持有使用凭证后的交接；未配置时端口报告不可用，不能自行热换模块。`plan` 根据当前安装事实产生精确角色入口及能力选择，不导入业务。`pages` 协调全部已登记同源页面，包括暂时断流但退出未确认的页面；`preparedTimeoutMs` 默认两分钟，只取消尚未 commit 的准备保护，不把超时当作资源退出。外部使用者检查只接受操作系统锚证明，不替其他管理者停止服务。

显式 `resume()` 取得的临时保护使用相同的 `preparedTimeoutMs`。调用方在 commit 前断开或退出，到期只释放本次角色与页面协调保护，原批次仍为 recovery-required；不会自动重启、回收或把恢复取消为完成。显式 cancel 和再次 resume 各自管理本代计时器，旧计时器不能释放新一轮保护。commit 一经接收就撤销准备计时器，继续等待真实 dispose，超时不能替代该退出证明。

注册库、安装器和生效组件各有实际资源职责，共用客户端已有唯一 Nya 根。`catalog-plan.ts`、加载器、固定进程入口、代理、页面协调器是受信辅助实现，不新增 Context 或额外 Nya 组件。

## 安装、选定与实际版本

D1.4 将 `host-package-registry` 原地升级至 v3，新增 `package_registry_activations`，保留 v1 安装/使用记录及 v2 文件任务。D1.5 复用该表，升级注册库至 v4，不增加新表，规范旧 JSON 的 kind 为 activate、ownedUsageIds 为 []；新增 `kind: activate | remove`，读取边界也兼容旧缺省字段；`reclaiming` 独立表示文件尚在回收。一次批次保存请求 ID、修订、所有者 epoch、目标与原选定身份、全部角色计划、父子使用记录、阶段和恢复回执。公开页面只接收安全投影，不接收内部回执、路径和凭证。

安装成功仍只写 `installed`、`pending`。批次 commit 才提交选定及快照交接意图；它不证明新代码已运行。角色实际版本来自该代 `ready` 使用记录及精确快照；全部计划角色就绪且旧使用退出已确认后才完成批次。Products 的后台目标继续独立保存。首次生效不会把新应用的后台目标设为打开；纯界面应用没有模拟后台或 SQL 目标记录。

| 阶段 | 含义 |
| --- | --- |
| `prepared` | 生效意图已耐久保存，尚未重启；全部页面保护仍需当前 `protected` 回执确认 |
| `handoff` | 选定及父使用 reservation 已提交，父进程持实际 SHARED 锚后接受交接 |
| `loading` | 旧角色确认退出、写锁交接后，新管理者接管批次和新角色使用凭证 |
| `reclaiming` | remove 批次的新角色已 ready，正在逐版本回收代码；尚未卸载完成 |
| `completed` | 所有计划角色报告确切快照 ready、旧使用已退出；remove 还要求全部目标版本 removed、对应 remove 操作 completed |
| `recovery-required` | 进度、版本和归属保留，需显式核对；不自动重启或重放副作用 |
| `cancelled` | 未 commit 的准备取消，待生效安装保留 |

`protected` 是当前管理者完成全部角色及页面保护后的短期事实，不是从耐久 phase 推导的值；写入 prepared 后仍可能在等待其他页面 guard。页面必须同时看到当前 protected 为 true 才能开始 dispose，管理者重启后不能沿用旧证明。查询不推进副作用。`resume(id)` 先重新冻结角色及页面，返回原待恢复批次，不伪装成新 prepared 事实；随后显式 commit 才在旧使用退出证明完备后接管或继续交接。停止、损坏、缺失或仍被独立使用者占用的版本不能靠改状态补齐。

## 正式加载与资源归属

[loader.ts](../../../packages/host/src/package-management/loader.ts) 在导入前持 SHARED 锚并 claim 精确凭证，重新检查不可变目录、原始来源快照、发布者签名或独立的本地受信身份、索引字节、目标运行条件、能力版本及资源/路由闭包。本地身份不冒充发布者签名，受控安装回执与快照决定来源模式，不能由应用自行改写授权。Node 入口经固定公共 Nya/API/SQL 解析器加载；不得回退到宿主搜索路径、包外模块或包私有共享运行时。损坏身份可隔离，但信任策略变化、平台不兼容或能力缺失不冒充文件损坏。加载失败保留安装、指针和诊断，不能伪造当前版本或删除现场。

完整应用归档可以携带供独立进程使用的共享库物理副本。托管加载以实际 resolve/load 为校验边界：公共裸入口固定到宿主实例，相对路径或直接路径绕入私有共享运行时仍拒绝；不因归档含有独立运行所需文件而拒绝完整包。

加载器只调用纯 `createRegistration(context, config)`。运行上下文声明 `phase: 'runtime'`、角色、appId，以及可用时的通用私有 `channel` 和确有声明时的 `startRole`；准备阶段为 `phase: 'prepare'`，不提供私有通道或进程启动。应用自有配置是受信启动器提供的非秘密 JSON，宿主按 appId/角色分发但不解释业务。所有业务初始化仍在用户打开后、由 Products 与 Nya 驱动的应用运行入口中发生。

含独立 Computer worker 的受信应用包须声明 `lifecycleVersion: 1`，发布者签名与显式本地受信目录遵守相同规则。旧包仍可验证或保留安装记录，但正式加载报告 `package-lifecycle-upgrade-required`，需要重新构建受支持产物；不回退旧的应用目录进程启动路径。`startRole('computer-worker', { ownership: 'independent', args })` 只允许启动同一受信包声明的 main，不能提供路径、命令或另一应用。请求只在本代应用受管运行入口存活时准入。父 reservation 和子进程实际 SHARED 使用锁连续交接后，独立 worker 才确认启动；此后关闭客户端或桌面不停止它，仍由应用自己的 worker 协议管理。当前独立启动适配仅支持 Unix Node，Electron/Windows 如实报告运行时不可用。

启动前的信任策略读取、运行环境拒绝、参数校验或同步 fork 失败没有创建子进程，启动器明确标记该事实并释放本次父 SHARED 锁。原 reservation 仍由账本按真实 EXCLUSIVE 证明退出，不保留虚假的独立 worker 占用。已创建进程的失败继续核对实际子进程及进程组退出；未知退出或锁释放失败不能套用启动前失败路径。

## 同包角色私有通道

`ApplicationPackageRuntimeContext.channel.request(payload, signal)` 只向正式加载的客户端角色提供；执行端通过纯注册声明 `ApplicationRegistration.channel.handle(root, payload, context)` 接收。`context` 只有当前取消信号、`sourceRole: 'client'` 与固定 appId，业务服务从本代 execution 根取得。注册声明本身不能打开业务；应用可以在运行期安装自己的通道组件，并自行决定何时打开业务目标。

宿主按实际 ready 角色、有效使用凭证、相同 appId 及确切不可变包身份选定对端，不接受应用提供的另一 appId、地址或角色身份。通道只转送不解释的有界 JSON 请求/结果，不提供设备连接、业务令牌、Vault 或业务路由。单个值序列化上限 1 MiB、深度 32、节点 100,000；拒绝循环、非有限数字、原生句柄、访问器和不受支持的对象。应用自行定义消息 schema、流式分帧、错误及协议版本。

客户端仅在所属运行入口存活时可发起请求；停止、关闭准入和角色交接会撤销准入并取消已接受请求，等待接收方 handler 实际退出。父监督器与两侧角色都跟踪在途调用，取消不能用超时或仅收到 ACK 代替退出。对端尚未 ready、退出、冻结或包身份变化时失败，不回退到旧版本、公开 HTTP、长期访问令牌或另一应用。独立部署与旧 distribution 默认组合不因此自动获得此通道；其迁入仍属 D3。

Claude Agent 在该通道上实现自己的本机请求与 SSE 协议，宿主不解析线程、Run、连接及凭据，见[本机执行组件](../claude-agent/local-execution.md)。

## 进程所有者与稳定连接

[startManagedApplicationHost](../../../packages/host/src/package-management/managed-process.ts) 是不创建 Nya 根、不打开注册库/业务库、不导入应用包的父进程辅助函数。客户端子进程独占包管理写锁；execution 子进程通过私有 RPC 查询同一账本，不成为第二写入者。固定 bootstrap 只消费已登记角色及确切凭证。父进程先持交接锚，旧角色关闭并实际退出后才启动新客户端；新管理者取得写锁、登记新 reservation 并获父确认，再交给相应新角色。原路径、身份和后台目标保留，不恢复整份业务 SQLite 备份。

父进程保持固定回环 HTTP 代理 origin。子进程换端口时，浏览器继续向原 origin 查询原操作；交接期间返回 503，不重试已接受的 mutation。最小 Electron 主进程复用同一监督器，通过固定 `utilityProcess` 入口和私有端口传递角色启动；不使用 RunAsNode，不让渲染器获得内部传输秘密。桌面协议继续使用 `anybox-app://app`，外部回环调用必须通过额外 transport secret。退出检查使用全部受管角色的 Activity/Products 保护；仅在用户明确退出并同意取消时执行根关闭。

GET/HEAD 的响应观察断开会关闭代理的上游请求与流，使旧页面 SSE 登记实际退出；完整 body 已被接受的 mutation 可以继续执行并保留原操作事实。代理不重试变更，也不会把已断开的 GET 订阅留在后台持续读取。

无管理者的 `createMinimumHost` / `createClientHost` 仍可被嵌入，但不能承诺自动进程重启。未托管的外部角色或独立 worker 正在使用版本时，生效会阻塞并保留 pending；不会为了更新自动停止它们。系统服务进程的监督与部署配置仍由实际系统管理者拥有。

## 全部页面的关闭保护

[服务端页面协调器](../../../packages/host/src/package-management/page-lifecycle.ts) 以同源 SSE 登记每个页面，包含隐藏页面及未打开“我的应用”的页面。启用协调后，新页面在登记成功前冻结控制及路由；生效 gate 存在时拒绝新页面进入。freeze 快照全部已登记页面，每页检查其全部挂载界面 `canClose()`，任何草稿、负回执或退出未确认的断连均阻止生效，并释放尚未 commit 的完整保护。

登记从 SSE 连接中独立出来：gate 创建前断流也保留原页面为退出未确认，后续 freeze 必须阻塞；不能因为当前连接列表为空跳过该页。页面在首次 GET 前生成只保存在当前 document 内存的 `registrationId`，首次请求及重连通过 `X-Anybox-Page-Registration` 提交相同凭据，connected 必须回显该值，ACK 与退出也绑定该凭据；首次 connected 回执丢失仍可重连。同 ID 的活动连接或错误凭据不能替换原登记。重连后仍重新执行原界面的 guard，草稿不会因断线丢失保护。Electron 协议桥转发该重连头，不把它提升为宿主管理凭据。

普通关闭、首次挂载激活失败或挂载尚未返回时关闭，只要 dispose 失败，shell 就保留该界面句柄、失败 Promise 和失败事实；不重新挂载、不重复调用清理，也不从后续 canClose/beforeunload 或生效检查中遗漏它。页面生命周期协调保护的释放不能清除此资源失败。

所有真实界面清理成功后，页面先停止新观察并取消、等待在途观察结束，再通过独立的 keepalive `POST /pages/:pageId/exit` 显式提交退出证明；受控版本重载等待该确认后才调用 reload。不存在的登记按幂等空操作确认，以便新管理者接收旧页面在交接后的退出；退出凭据在协调器本代保持终态，迟到的同凭据 GET 不能重建登记。同 ID 的新登记仍要求新凭据，旧退出不能注销它。已收到正向 dispose ACK 的页面随后断流不会撤销已有真实退出证据。浏览器硬刷新、强制关闭或异步清理被中断时，无法保证退出请求送达，原登记继续阻止生效；原 document 可凭内存凭据重连，已销毁 document 则需重新启动宿主页面协调器。sessionStorage、超时、BFCache 或新页面登记都不用于推断旧页面已清理。

页面 SSE 绑定所属 HTTP 服务的 lifetime signal，关闭监听器时先结束流、移除传输的取消监听，避免 HTTP 排空先于生效 Effect 而互相等待。退出未确认的页面登记保留至真实退出证明或协调器整代关闭。该取消仅结束页面观察，不替代页面实际 dispose 证明。

发起页先冻结打开、关闭、停止、重试和路由，等待已有控制及挂载退出，然后请求 prepared。随后再次检查所有界面，保存工作区位置并等待全部 `dispose()` 实际完成，才发送 commit。服务端还要求其他页面逐一确认真实 dispose。清理失败的页面保留保护，不能重新挂载覆盖未知资源。超时只报告阻塞/退出未确认；页面断连不是清理证明。

页面 SSE 同时绑定所属 HTTP 监听器的 lifetime；监听器关闭或重启先结束旧流，让顺序卸载 HTTP 组件不必等待稍后才清理的生效组件。流结束仍只表明观察退出，不证明页面 dispose。稳定代理在 GET/HEAD 观察者断开时结束其上游流，页面登记继续保守核对；已完整接收的 mutation 继续按原操作结算，不随响应观察断开而取消。

每个页面仅观察原批次 ID，批次 completed 且全部角色 ready 后才重载；新装应用不加入工作区。已打开且允许恢复的界面按原标签位置恢复。丢失 prepare/commit 响应只查原请求或操作，不自动重新应用；丢失恢复保护响应也不从未改变的 recovery 阶段推断重启许可，只有当前管理者重新提供 protected 证明才能继续。

## D1.5 本机卸载与代码回收

“我的应用”的每个已安装应用提供一个卸载动作，移除该 appId 的全部未 removed 安装版本，而非仅当前版本。默认保留应用数据；界面和 HTTP 都没有 delete-data 选项。多应用卸载只由显式非空 appIds 声明。删除意图不要求读取或信任目标包的内容，因此损坏包也能在归属和退出证明完备后回收。身份仍由账本提供，浏览器不能传路径。

卸载沿用 prepare→全部角色 guard/全部页面 canClose→页面实际 dispose→commit→角色交接。prepare 和取消准备不改后台目标；commit 在全部页面真实退出后，通过 `Products.setClosedTargets(ids)` 把客户端及所属 execution 已有目标保存为 false。该端口只在排空的控制保护下写宿主自己的 `app_product_targets`，不创建 UI 应用目标、不调用业务 stop；实际应用资源由旧角色正常根关闭释放。新角色计划完全排除卸载应用，其他应用按原目标重新装配。若 commit 在形成 handoff 凭据前失败（例如某角色目标写入失败），原批次进入恢复并释放服务端、其他角色及页面保护，显式 resume 会重新取得全部 guard；浏览器实际 dispose 失败仍由该页 lease 保留资源保护，不能把释放协调保护当作清理成功。重新安装仍默认关闭，兼容业务数据继续由应用自己读取。

独立 worker、系统服务及其他管理者拥有的角色仍持使用凭证时返回 version-in-use 或 use-unavailable，不替其管理者关闭资源。冻结只使用通用 Activity/Products 保护，应用忙碌不会默认取消工作。远端实例、已接受 Run、附着与连接均不受本机卸载控制。

新角色 ready 不等于卸载完成。批次先进入 reclaiming，由 [reclamation.ts](../../../packages/host/src/package-management/reclamation.ts) 在新客户端中逐个调用注册库 `withReclamation`，排他复核使用退出及永久凭证栅栏，再回收固定身份容器。它不导入应用、不调用迁移，也不扫描业务目录。注册库装配时持有固定真实根目录句柄和 dev/ino，在文件回调前复核，并通过私有根锚与适配器捕获根比较；fresh realpath 不能把已替换的原路径重新授权为其他删除根。目录身份和祖先路径必须保持原样；符号链接只删除链接目录项，硬链接只删除该目录项，不读写外部目标；不跟随链接扩大删除范围。受管容器缺失可在显式回收尝试中确认无需继续删除。使用锚、注册历史与业务数据保留。原根或句柄改变固定返回 reclamation-root-changed；Windows Node 使用同样的持有目录句柄、dev/ino、祖先身份及使用锚核对；文件数据仍逐个同步，目录同步差异见[安装文件系统边界](installation.md#文件系统平台边界)。注册库 Effect 在受控文件工作实际退出后释放原根句柄。

只有全部目标安装为 removed、对应 remove 操作为 completed，才由 `completeRemoval` 完成原批次。部分删除、fsync 失败、路径身份变化或关闭中断均保留 reclaiming/恢复事实，不能显示已卸载或推断磁盘已释放；父监督器在失败角色实际退出后进入空管理客户端，供用户显式 resume 原批次，不自动重放应用启动或删除。界面显示“核对并恢复卸载”，CLI 使用原 `activation <id> --action resume`。GET/inspect 只查事实。

所有同源页面仅在原 remove 批次 completed 后，按 targets 去重 appId，移除这些应用的 workspace tabs；保留其他应用顺序、路由和当前选择，并在重载前 replace 活动卸载路由。重启后可依据 completed remove 和当前全部安装均 removed、selected/pending 为空的事实清除旧位置；历史卸载记录不能清除随后重新安装应用的位置。reclaiming 或待恢复不清工作区，不伪装卸载完成。

在线 CLI 为 `anybox-host uninstall <appId> --endpoint http://127.0.0.1:<port> --request-id <id>`。它只调用同源回环运行中管理者，一次 prepare/commit 后观察原 ID，待回收或未知结果均非零退出，不自动重发 mutation。批次查询和恢复沿用 activation 命令，无离线删除或远端卸载入口。

## HTTP 与控制端口

以下接口位于 `/api/client/v1/app-packages`，沿用 Host、Origin、认证及 transport secret 保护，不能通过应用或单元自认证路由调用。

| 请求 | 作用 |
| --- | --- |
| `GET /` | registryRevision、安装事实、文件任务、安全 actual、activations 和管理者/页面协调可用性 |
| `POST /activations` | `{ requestId, expectedRegistryRevision, appIds?, kind? }`；省略 kind 为 activate，remove 必须显式提供非空 appIds；冻结并返回耐久 prepared ID |
| `GET /activations/:id` | 查询原批次，不触发重启 |
| `POST /activations/:id/commit` | `{}`；界面实际退出后受控交接，不把 202 当 completed |
| `POST /activations/:id/cancel` | `{}`；释放未 commit 的准备，保留 pending |
| `POST /activations/:id/resume` | `{}`；显式核对原 recovery-required 批次并重新保护 |
| `GET /pages/:pageId/events` | 同源页面生命周期 SSE；connected 返回 registrationId，原页面重连使用 X-Anybox-Page-Registration |
| `POST /pages/:pageId/ack` | `{ registrationId, activationId, action: 'freeze' | 'dispose', ok }` |
| `POST /pages/:pageId/exit` | `{ registrationId, interfacesExited: true }`；全部真实界面清理成功后注销登记 |

`closeAdmission()` 停止新生效请求，`awaitIdle()` 等待已经接受的本地控制；组件 Effect 等待本代控制退出，再清理保护与页面连接。它不等待必须先关闭自己的根才能完成的角色重启；父进程已持锚后的交接在组件之外继续。文件、业务及使用锁的未知退出均不按超时猜测成功。

## 验证入口与范围

卸载回收见 `package-reclamation.test.mjs` 与 `package-removal-ledger.test.mjs`、`package-removal-managed.test.mjs`；账本见 `package-activation-ledger.test.mjs`；加载与资源闭包见 `package-loader.test.mjs`；父交接及崩溃见 `package-managed-process.test.mjs`；独立所有权见 `package-independent-role.test.mjs`；稳定代理见 `package-role-proxy.test.mjs`。页面、HTTP 和真实 shell 入口行为分别见 `package-page-lifecycle*.test.mjs`、`package-management-{http,web}.test.mjs`、`application-interface-lifecycle.test.mjs` 和根 `tests/application-shell.test.mjs`；Electron 适配见 `desktop-managed-utility.test.mjs`。

回归覆盖普通关闭/首次激活/挂载中关闭的清理失败保留、gate 前断流与凭据重连后的草稿拒绝、显式页面退出和协调器重建、Electron 重连头转发、启动前失败释放父锚及 resume 超时只释放临时保护。锚物理身份和旧格式兼容边界见[安装账本](registry.md)。

当前实际平台范围为 macOS arm64 Node，以及隔离 userData、隐藏窗口的最小 Electron 空宿主与纯界面包生效验证。Electron 44.5.1 / Node 24.21.0 下，纯界面包 1.0.0 首次生效后保持未打开且无 execution 进程；挂载后安装 2.0.0，草稿拒绝返回 409 并保留 selected 1.0.0/pending 2.0.0，放行后等待实际 dispose 退出，再完成新角色 ready、稳定 origin 的安全 reload 和原工作区位置恢复，最终 selected/actual 为 2.0.0、pending 为空，父与 utility 正常关闭。Node 注册准备、独立 worker、真实凭据及其他平台分别保留其既有边界。D1.5 已接入用户卸载及受控代码回收，实际平台验收单列；D2 在线目录下载、D3 旧完整默认发行迁入仍为后续阶段；旧全量默认桌面不能宣称已经迁入最小按需发行。最终检查与实际实验范围见[阶段记录](../../harness-server-plan.md)。
