# Anybox：NyaCore 应用的宿主应用

[文档首页](README.md) · [组件导航](modules/products/README.md) · [应用接入](application-development.md)

## 目录与进程边界

Anybox 按受信代码目录承载 NyaCore 应用，提供应用注册、装配、启停、公共资源和前端工作区。正式目录目前提供 Anybox Harness（稳定 ID `agent`）；应用随项目构建，不从网络安装执行代码。客户端和执行端各有一个 Nya 根，分别注入 `ApplicationRegistration[]`。同一个 ID 可以在两个进程使用不同装配：Anybox Harness 客户端安装连接、目录窗口与网关，harness server 安装 Models、Prompt、Session、Run、工具和业务 HTTP 适配器。普通应用可以只注册在客户端。

目录注册校验 ID、静态地址、MIME、Web 入口和兼容路由归属。列表顺序等于目录顺序。`ApplicationRegistration` 保存受信工厂、HTTP 服务键和本地资源清单；`ProductDefinition/ProductView` 只含名称、图标、说明、同源浏览器入口及状态，不含 Node 路径、凭据或运行句柄。新增应用无需改 Products、监听器、工作区管理或 Anybox Harness。

通用宿主位于 `src/host/`：`applications/` 管注册和运行归属，`web/` 管外壳与应用工作区，通用 HTTP 负责监听和分派。Anybox Harness 的注册、核心业务、执行适配器、客户端和浏览器实现集中在 `src/applications/harness/`。`src/entrypoints/` 选择正式目录、读取环境变量并处理进程信号，通用宿主不导入 Anybox Harness。业务存储契约为 `src/storage/port.ts`，宿主只安装一次业务 SQLite，应用组件在 apply 中登记迁移域。Models 配置库、目录缓存和 Vault 仍归 harness server，延续独占路径规则。应用不依赖其他应用专属服务；共享服务须明确归宿主并只安装一次。

## 安装与停止

Products 按应用 ID 保存独立目标、控制队列、状态和错误，同一应用串行、不同应用独立推进。工厂首次打开才创建运行时。`createApplicationRuntime` 为每代安装同步登记 Fiber、Effect disposer 和 AbortSignal；全部组件直接安装在进程根上，依赖拓扑由 Nya inject 管理。启动中途失败清理已登记资源；重新打开建立新安装代。过期回调使用安装信号确认归属。

状态继续使用 `disabled/applying/running/blocked/failed`。inspect 投影实际 Fiber：awaitStable 后仍 PENDING 即 blocked；依赖恢复后同一安装自动变为 running。启动失败需显式 retry。清理失败保留错误与安装记录，禁止覆盖或重新安装，要求重启宿主。

停止（以及会撤销现有安装的 retry）先同步检查 Activity 和应用业务 guard，再冻结该应用准入。忙碌拒绝发生在目标写入前；目标提交失败释放冻结并保留原值。保存关闭目标后取消观察、等待真实 release，再卸载本应用 Fiber 并等待 Effect。harness server 的 guard 覆盖 Run 准备至资源实际退出；注册本身归安装所有，重开不累积旧 guard。关闭界面不会调用后台 stop。

整根关闭先同步停止产品控制、活动和运行时准入；等待控制队列与 HTTP 请求，随后关闭根，由各组件取消并等待运行资源，Activity 最终等待全部租约释放。HTTP 和 Nya 清理错误聚合报告，不用超时冒充退出。关闭门面不可复用；持久目标保留，重启按各自目标恢复。

## HTTP 与静态资源

常驻监听器只负责认证、同源校验、应用管理与分派：

| 入口 | 客户端 | 执行端 |
| --- | --- | --- |
| 目录与控制 | `/api/client/v1/products` | `/api/v1/products` |
| 应用业务 | `/api/client/v1/apps/:appId/...` | `/api/v1/apps/:appId/...` |

管理保留 list/get/open/stop/retry，控制 POST 体为空对象。没有用户定义、模块组合或安装接口。应用归属由注册路由确定；伪造 `X-Anybox-Product-Id` 不能切换归属。请求在第一次异步调用前 authorize 并登记 Activity，通过根固定当前 HTTP 端口；harness server 同步捕获本次领域服务快照。不会把旧请求转交重开后的服务。

适配器接收相对 URL、appId、actorId、监听器关闭信号和 retainUntil。handle 等待实际处理退出；SSE 等待流关闭，OwnedCall 等待 done。已接受 Run 通过 retainUntil 将 Activity 延续至原生退出，但单独关闭 HTTP 不取消或等待 Run。监听器关闭信号取消观察与未完成资源请求；已接受控制、普通业务写入继续结算并尽可能返回结果。旧 Anybox Harness 路径是登记的兼容别名，指向同一处理器。

实例信息只由宿主与注册应用声明能力：宿主提供 `products.v2`，目录的 `http.capabilities` 声明应用静态协议，已安装适配器的 `capabilities()` 补充动态能力。Anybox Harness 静态声明项目、附件和 SSE 协议，目录浏览能力按实际 Projects 服务提供。未注册 Anybox Harness 的宿主不带这些业务能力。

外壳只声明 HTML、外壳 CSS、HTTP 工具和工作区模块。Anybox Harness 的模板、图标、样式和浏览器模块由应用资源清单声明。`npm run build` 校验全部登记文件、JS 相对依赖、HTML/CSS 资源和 MIME，拒绝 Node/bare module 依赖。发行脚本也校验复制后资源图。

## 浏览器工作区

外壳与应用界面分别归 `src/host/web/` 和各应用的 `web/`。最左侧窄条是不同应用的入口，按注册目录顺序显示全部应用，并标记当前应用。右侧整块区域由当前应用内部组件从顶边开始呈现；外壳只提供无装饰的挂载容器，不显示 Anybox 标题栏、顶部应用标签栏或宿主操作栏。共同的 mount、route 和生命周期契约不规定应用内部页面结构。

Anybox Harness 直接呈现一个项目与会话工作区。侧栏底部将一处可操作的紧凑“执行设备”选择器与只显示图标的设置按钮放在同一行；选择器保留屏幕阅读器标签，并通过 title 提示完整设备名称。选择器固定新增项目的设备及模型、Prompt 设置的管理范围，侧栏项目与会话树只展示所选 instanceId，并直接接在仅保留添加项目按钮的顶部操作栏下方，不显示应用名称文字或设备名称标题。项目行右侧按钮在该项目中新建会话，空工作区“新建会话”使用该设备的侧栏选中项目；原选择属于另一设备时重新选择当前设备的项目，无项目或所选项目不可用时禁用。离线或未启动的目标不会回退展示其他设备项目。已有跨设备会话面板保留，全量项目资源仍用于面板、模型与附件的原设备归属，以及全局归档查询。设置提供“会话设置”“模型管理”“Prompt 管理”“已归档会话”“管理连接”五个分类，连接管理作为同一弹窗内的面板呈现。连接分类展示全部设备，归档列表跨设备、跨项目查看和恢复，不受所选设备筛选限制；这两个分类隐藏当前执行设备提示。切换分类或关闭弹窗时保留已挂载表单和非秘密草稿；用户关闭或按 Esc 时清空连接的未保存访问令牌和已发行令牌的临时展示，临时停用应用保留已有草稿。未保存修改会阻止设备切换及界面重建。模型、Prompt 不再使用独立功能页面或顶部标签；旧功能页面地址只读兼容为统一工作区位置，不自动打开设置。每台设备的 Agent 状态及“启动 Agent”“停止 Agent”操作放在连接管理中，宿主窄条继续控制 Anybox Harness 客户端应用。

外壳原生 import 已登记入口，调用 `mount(container, context)`，得到 setActive/canClose/dispose。context 提供 appId、同源 apiBase、应用内 route、生命周期 signal 和 domId。全局 location/history 归外壳；应用只订阅和修改自己的路由。

每个应用最多一个已打开界面。左侧入口切换已有挂载使用 select，不重复执行 open 或打开业务目标；首次打开尚未运行的应用才进行应用启动。切换保留挂载 DOM、草稿、滚动和数据，后台 panel hidden 且 inert。左侧应用导航使用上/下方向键、Home/End 移动焦点，Enter/Space 打开或切换应用，并支持焦点恢复。

左侧窄条底部的“关闭界面”与“停止应用”图标按钮具有包含当前应用名称的 title 和 aria-label。“关闭界面”先检查 canClose，再等待 dispose，只销毁当前应用的前端界面；关闭后选中其他已打开界面。左侧应用入口始终保留，可以再次进入。“停止应用”是独立的后台控制，成功停止后关闭对应界面，忙碌或停止失败时保留界面。

宿主失联时，缓存目录只保留应用身份，状态显示为暂时无法确认，暂停后台控制并保留界面和草稿。停止响应未知时通过新的目录读取核对，不自动重放写入；确认 disabled 才关闭界面，applying 继续观察，失败则明确说明。核对读取不能复用控制前的过期轮询，恢复连接后更新实际状态并清除失联提示。

“我的应用”在左侧窄条打开管理浮层，显示应用列表、状态和启停控制，不替换或停用当前应用界面。宿主通知、加载状态、界面失败和“重新加载界面”入口都在该浮层呈现；重新加载只重建界面，不改变后台目标。没有活动界面时右侧挂载区域保持空白，管理入口仍可使用。

已打开界面的顺序、内部路由和活动应用保存于 `sessionStorage: anybox.apps.workspace.v1`。为兼容已有工作区，继续保留原有 tabs 字段及其数据结构，它记录已打开界面，不表示顶部仍有标签栏；左侧应用入口顺序始终来自注册目录。全局地址为 `#/apps/:appId/...`。后台应用导航只改自身记录，不改地址。首次初始化可通过应用兼容解析器读取旧 Anybox Harness 位置。刷新、历史导航或工作区恢复不会隐式启动已停止的应用或 Agent。

Anybox Harness 只在 activation reason 为 open 时自动打开所选设备的 Agent；连接管理也提供显式打开、停止操作。选择设备、切换应用、刷新或恢复位置不隐式启动目标，连接到远端不会启动本机执行。连接编辑/删除只重建 Anybox Harness；全局事件仅在激活时处理，停用取消拖拽和尺寸修改、退出模态顶层显示；激活后重新测量布局。Agent 草稿、树位置和分屏继续由 Anybox Harness 保存，设置按所选设备管理其模型和 Prompt。

## 数据兼容与验收

沿用 `app-products` v2，无新增表版本。事务补齐当前目录缺失行，新应用默认关闭；现有 agent 目标保留。旧执行库首次迁移检测 run-state 并恢复 Anybox Harness；旧组合库只读取内置 agent 目标，保留自定义 JSON 和历史但不装配。不在当前目录的目标记录仍保留。

`npm run check` 包括目录、并发、忙碌拒绝、失败回退、观察真实退出、旧数据库、两进程部署、Models/Anybox Harness 和浏览器资源图测试。`tests/helpers/test-application.mjs` 是仅用于测试的正式注册应用，拥有独立 Nya 服务、迁移域、API 和带输入框的页面，不安装 Models/Anybox Harness。`node tests/helpers/products-browser-host.mjs` 用临时数据库、内存凭据、受控模型提供 Anybox Harness + Notes 浏览器验收。具体步骤见[接入说明](application-development.md)。
