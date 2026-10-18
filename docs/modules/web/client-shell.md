# Client Shell HTTP 组件

[宿主模块](README.md) · [应用宿主](../../products-v1.md)

`packages/host/src/client-http.ts` 的 `createClientShellComponent(root,catalog,port?,{transportSecret,packageManagement}?)` 创建 `app-client-http`，提供 `app.client-http: ClientShell`（url 与 close），注入 app.products 和 app.activity。它调用与执行端相同的 startApplicationHttpServer，使用 `/api/client/v1`。通用 `createClientHost` 可选接收 `transportSecret`，供桌面主进程到客户端监听器的私有桥接使用；全部静态资源、产品控制与业务请求都在分派前校验 `X-Anybox-Desktop-Transport`，缺失或不匹配返回 `forbidden-transport`。此凭证不进入页面或持久化；普通 Web 不传该选项，仍使用原 Host/Origin 校验。

组件独占客户端回环监听器与请求。外壳资源仅含 HTML、CSS、HTTP 与应用工作区路由模块；应用资源合并自目录。注册冲突在启动监听前拒绝。连接身份、凭据、代理和 Anybox Harness 路由都由应用适配器处理；Shell 只按注册服务键从根取得本次端口。

D1.2 的空宿主入口已在 D1.4 经 `packages/host/src/main.ts`、`desktop/main.ts` 和固定 `desktop/managed-role-entry.ts` 接入正式角色监督器。每个角色仍只有原有服务根；父进程只管理窗口、稳定协议桥、角色进程及通用退出保护，不持有业务库、应用配对、目录窗口或 Vault。已删除旧的单客户端最小桌面启动路径；现有 distribution 完整桌面保持兼容，迁入由 D3 推进。独立产物和只读验证命令见[产物手册](../package-management/archives.md)，实际角色交接见[生效手册](../package-management/activation.md)。

D1.3 为配置了 `packageDirectory` 的客户端同根增加[文件安装器](../package-management/installation.md)。`packageManagement` 按请求从根取得当前注册库及安装端口，不缓存跨组件代次的服务。`/api/client/v1/app-packages` 提供安装事实、文件任务、上传、取消和显式恢复；它在宿主安全检查之后、应用分派之前处理，不借用应用身份、业务服务或 Activity 租约。没有安装器时查询报告 unavailable，执行端及单元自认证路由不因此获得安装权限。上传先持久登记意图，已完整接收的操作不随响应观察断开而取消；宿主关闭则取消并等待实际上传及准备工作退出，再关闭注册库准入，让取消和待恢复结果能够提交。

Host/Origin/CSP、租约、断连与 Effect 退出见[通用监听器](web-frontend.md)。停止客户端只关闭本机资源，不取消远端 Run。客户端与执行宿主均提供幂等 `prepareClose(): Promise<void>`：调用时同步停止产品控制、活动、应用运行时及监听器准入，返回等待已接收控制和装配退出的 Promise；此阶段不卸载根组件，也不等待由 Nya 清理取消的 Run/HTTP 保留租约。`close()` 复用该阶段，随后同时等待 Nya 根清理与 HTTP 排空，使已受理写入和保留操作实际退出；即使准备阶段失败也继续清理并聚合错误。准备关闭不可撤销，宿主 API 随后不可复用。桌面可先准备两个进程，再按客户端和执行端的顺序完成资源关闭。

浏览器左侧窄条按注册目录顺序呈现全部应用入口；右侧只提供无装饰的挂载容器，全部界面由当前应用内部组件从顶边开始呈现，没有 Anybox 标题栏、顶部应用标签栏或宿主操作栏。切换已有挂载使用 select，保留后台 hidden/inert 界面；上/下方向键、Home/End 移动焦点，Enter/Space 打开或切换应用。

Anybox Harness 的文件阅读区、文件标签、全宽路径顶栏与目录树均在该应用挂载容器内部实现，由当前活动会话固定项目与设备。工作区两侧及阅读区与目录树之间仅显示与宿主应用导航栏一致的 1px 单线，透明命中区向两侧各扩展 4px，保留拖拽与键盘调宽；停靠状态不叠加面板边框，抽屉保留边框与阴影。路径顶栏始终说明会话所属设备与项目，有文件时呈现完整相对路径面包屑，并集中提供目录刷新与折叠入口。左阅读区与右目录树的内部调宽、按会话保存的目录请求宽度、窄布局适配、已加载快照筛选和文件类型图标均属于 Anybox Harness 浏览器资源；Shell 不拥有文件状态、目录请求或预览生命周期。Codicons SVG 本地副本由 Anybox Harness 显式注册到精确静态资源图，来源与许可见[图标说明](../../../packages/app-harness/web/icons/README.md)；具体布局、恢复与浏览器验收入口见[三栏工作区](../../harness-three-column-workspace.md)。

Anybox Harness 的侧栏底部将紧凑执行设备选择器与设置图标放在同一行；“设置”打开应用内部模态弹窗，“管理连接”和“已归档会话”均是其中的分类。连接分类管理全部设备，归档分类提供跨设备、跨项目的归档列表与查看、恢复操作；这两个分类隐藏当前执行设备提示。设置导航、连接与归档请求及列表生命周期由 Anybox Harness 管理。

窄条底部的“关闭界面”和“停止应用”图标按钮用 title 与 aria-label 说明动作及当前应用。“关闭界面”仅等待前端清理，显式停止仍独立控制后台，成功后才关闭界面。“我的应用”打开窄条管理浮层，显示应用列表、状态、控制及宿主通知；加载状态、界面失败和重载入口也在浮层中呈现。打开管理浮层保留当前应用界面，没有活动界面时右侧留空。

管理浮层使用紧凑应用卡片：图标、名称与状态徽标放在同一标题区，说明与打开、停止操作分区排列。打开按钮显示“打开应用”或“进入应用”，无障碍名称保留完整应用名；状态通过文字和徽标同时说明。必需能力的问题直接显示，可选能力以通俗说明呈现在可展开详情中，技术能力 ID 留在详情内；例如目录选择能力缺失只说明该功能暂不可用，不阻止应用打开。详情展开状态在应用目录刷新时保留。

“我的应用”还承载 `web/package-management.ts` 的本地应用包选择、摘要预检、一次性上传及安装状态。信任来自宿主的 `packageTrustPolicy`（正式入口读取 `ANYBOX_APPLICATION_TRUST`），浏览器不能上传公钥授权或服务端路径。结果丢失只查询原请求 ID，不自动重提或重传；显式恢复可被同面板的取消打断。关闭浮层立即清空文件引用和观察请求，并等待已接受的浏览器工作，不代替用户取消宿主安装。安装只提交已安装待生效事实，不改变当前应用目录和挂载；版本与历史记录的展示随当前安装、生效及卸载事实更新。只有相关生效批次完成、其全部预期角色实际就绪且应用版本匹配时才显示“已生效”，缺失角色不构成就绪证明。

本地应用文件夹与 `.anybox-app` 分发文件分别通过“选择文件夹”和“选择应用包”按钮打开对应选择器；文件夹安装仍需对本次所选内容显式勾选信任。“清除选择”同步移除所选文件引用与本次本地信任，不提交安装。安装事实、待生效提示与应用更改操作集中呈现，历史成功记录和实际角色代次等诊断信息放入可展开详情；进行中的操作、失败原因、取消与恢复入口保持直接可见，轮询不会折回已展开的详情。

D1.4 的“应用更改”与安装分开：包管理回调逐请求取得当前生效服务及页面协调器，提供 prepared/commit/cancel/resume、安全 actual 目录和当前 `protected` 证明。所有同源页面通过宿主独立 SSE 参与 canClose 及实际 dispose，包括隐藏页面；新页面登记成功前保持控制冻结。界面先保护全部挂载、等待真实清理，再提交原批次；只在全部计划角色 ready 后重载同一稳定 origin 并恢复旧工作区位置，新装应用不自动打开。断连、忙碌、草稿、清理失败或未确认响应都不能推断生效完成。Shell 不查询应用业务，具体职责与恢复规则见[生效手册](../package-management/activation.md)。

页面 SSE 使用 HTTP 服务 lifetime signal 结束本代流并注销页面；监听器关闭不等待另一个组件后续 Effect 才结束 SSE。稳定代理在 GET/HEAD 观察断开时同时关闭上游订阅，完整 body 已接受的 mutation 则保留原操作。页面 reload 不遗留等待旧页面回执的后台登记，断连仍不构成界面 dispose 完成证明。

应用目录读取失败时，已缓存的应用显示“暂时无法确认状态”，打开、停止和重试控制暂停，并提示检查客户端宿主是否仍在运行；保留已挂载界面与草稿，不把失联推断为成功停止。目录恢复后重新显示实际状态。停止响应丢失时只读取状态进行核对，不重放停止请求；核对必须等待早于控制请求的目录读取退出，再发起新的读取。确认 disabled 后关闭对应界面，applying 时继续观察，仍运行或清理失败时给出终态说明；存储提交失败与忙碌保留各自提示。

目录已成功读取后的界面清理异常只提示刷新页面，保留已确认的应用状态与宿主可用性，不把本地 dispose 失败当作网络失联。

安装管理验证入口为 `packages/host/tests/package-management-http.test.mjs` 与 `package-management-web.test.mjs`，覆盖真实空宿主、完整字节上传、关闭排空、同源和 transport、单元边界、响应丢失及恢复取消。

页面生命周期 SSE 绑定本代 HTTP listener 的 lifetime：关闭或重启 HTTP 先结束旧流，再等待监听器实际退出，不依赖后续生效组件 Effect 才清理连接。该观察退出不构成页面 dispose 证明。父稳定代理在 GET/HEAD 响应观察断开时终止相应上游，移除重载前页面的旧 SSE；已完整接收的 mutation 则继续观察原操作退出，不自动取消或重发。真实客户端根带 SSE 的关闭回归验证此清理顺序。

生效与多页面验证增加 `package-page-lifecycle.test.mjs`、`package-page-lifecycle-web.test.mjs` 和 `application-interface-lifecycle.test.mjs`；`tests/application-shell.test.mjs` 验证真实 Shell 在生命周期保护期间拒绝挂载、路由和控制。

工作区继续使用 anybox.apps.workspace.v1 和原有 tabs 字段兼容已保存位置。局部路由、恢复与 mount 契约见[宿主设计](../../products-v1.md)。验证 tests/desktop-host-boundaries.test.mjs、application-shell.test.mjs、application-host.test.mjs、application-workspace.test.mjs、products-host.test.mjs；npm run check。

D1.5 在已安装应用列表提供本机卸载，默认保留数据。卸载显式提交 kind remove 和 appIds，同样经过全角色保护、全部页面 canClose/真实 dispose，再按原 ID 观察角色切换及文件回收。reclaiming 或 recovery-required 均显示尚未卸载；独立使用者占用、忙碌和回收失败提供明确原因与原批次恢复入口。只有 completed remove 才从所有页面工作区清除目标 appId 的 tabs，并 replace 活动路由后 reload，其他应用的位置和路由保持。重启核对还要求当前全部安装 removed、selected/pending 为空，历史卸载不会误清重装后的标签。Shell 不调用应用业务或删除数据。行为见 package-management-{http,web}、package-page-lifecycle-web、application-shell 和 application-workspace 测试。
