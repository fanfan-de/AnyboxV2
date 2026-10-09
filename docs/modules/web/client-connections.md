# Client Connections 组件

[宿主与客户端模块](README.md)

`src/applications/harness/client/connections.ts` 的 `createConnectionsComponent({namespace?,openEntry?,fetch?,localPairing?})` 创建 `client-connections`，提供 `client.connections: ConnectionsPort`。inject 客户端根的 `local-storage`，此根只打开独立 `client.sqlite`，不共用执行库。`namespace` 默认 `anybox.client`；`openEntry` 是测试/平台替身边界。

连接是 Anybox Harness 内部功能。组件随 Anybox Harness 客户端打开安装、关闭卸载；通用外壳不管理本地/远程目标。工作区侧栏底部将一处紧凑的“执行设备”选择器与只显示图标的“设置”按钮放在同一行；选择器保留屏幕阅读器标签，完整设备名称通过 title 提示。“管理连接”是 Anybox Harness 设置中的第五个分类，与“会话设置”“模型管理”“Prompt 管理”“已归档会话”共用同一弹窗。连接和归档分类跨设备展示，弹窗在这两个分类隐藏当前执行设备提示。所选设备固定新增项目及模型、Prompt 设置的归属，已有会话保持所属设备，归档列表不受所选设备筛选限制。连接管理展示每台设备的 Agent 状态，并提供“启动 Agent”“停止 Agent”操作；这些控制通过网关调用目标宿主，连接组件仍只拥有连接和凭据。用户关闭设置或按 Esc 时清空未保存的访问令牌与已发行令牌的临时展示；临时停用应用保留已有草稿。关闭仅释放句柄，已保存连接和凭据保留。

设备切换先在应用路由中固定新选择，再重建本应用界面；旧工作区同步更新项目或会话查看位置时保留路由当前的设备选择，不能用重建前的连接覆盖它。查看项目与会话不自动改变设备选择，已有会话请求继续按自身 instanceId 路由。

侧栏项目与会话树仅包含所选 instanceId 的项目，并直接接在仅保留添加项目按钮的顶部操作栏下方，不显示应用名称文字或设备名称标题。项目折叠状态按完整项目 ID 保存在当前标签页的边栏偏好中，刷新网页、设备切换和工作区恢复时保留；恢复选中项目不自动展开，项目行从文件夹图标开始，不显示独立折叠箭头；点击项目行选中该项目并切换其会话展开状态，新建会话则展开对应项目。项目行右侧按钮在该项目中新建会话，空工作区“新建会话”使用该设备的侧栏选中项目；原选择属于另一设备时重新选择当前设备的项目，无项目或所选项目不可用时禁用，不沿用隐藏设备的项目。所选设备离线或未启动时，不展示其他设备项目；所属设备的不可用占位项目可以保留，已有跨设备会话面板仍保留。工作区继续保存全量项目资源，供已打开面板的标题、模型与附件归属及跨设备全局归档查询使用，侧栏筛选不改变既有 Session 的设备。

组件拥有 `client-connections` v2 的连接表、凭据意图日志和单条本机归属记录，以及独立 system-keyring-store 句柄。公开 list/save/check/remove 不返回 token 或 credentialRef；只有受信网关 acquire 获得本次固定的配置版本与 token。连接包含本机 ID、名称、地址、固定 instanceId、revision；编辑使用 expectedRevision。相同 instanceId 不重复登记。

桌面组合可注入 `DesktopLocalPairingOptions`：`getLocal(signal)` 返回受信本机地址及 instanceId，`issue(signal)` 通过私有宿主控制发行 managed token，`reconcile(retainedToken,signal)` 回收同一桌面所有者的孤立凭据。组件每代异步启动一次配对，不阻塞初始化；并发 `retryLocal(signal?)` 复用当前操作。`localStatus()` 仅返回 enabled、disabled/pending/ready/failed 状态、本机身份、连接 ID/版本及固定错误码。普通 Web 组合不注入此选项，不能调用重试。

首次自动保存与本机 connectionId/instanceId 归属同事务提交。已有本机连接保留 ID、名称和凭据，仅端口变化时保存新地址；未变地址不增加 revision。执行库身份变化拒绝静默替换。Vault 读取失败保留已存凭据和宿主 token，不以无凭据状态撤销它；仅明确认证失败或非 managed token 才发行替代。失败新 token 由受信回收或下一次初始化恢复，远端连接继续可用；自动配对不启动 Agent。连接管理展示 pending/失败状态，提供显式重试，成功后只刷新本应用。桌面配对启用且界面活动时，pending 每 500 毫秒、其他状态每 5 秒读取非秘密状态，以观察明确重启后的连接版本；已有未保存表单或工作区不能离开时推迟重建。停用或释放界面停止计时器，状态读取不触发配对或重启。

只允许 HTTPS 或显式 127.0.0.1 / ::1 HTTP，拒绝 URL 用户信息、query、fragment。配对调用认证后的实例信息接口，禁止重定向、限制响应大小与 15 秒超时，核对 API 版本；改地址须匹配原 instanceId。网络检查不占用串行配置/凭据队列，提交时重新检查版本，离线设备不阻塞其他设备读取。

项目选择从打开到登记固定 connectionId、instanceId 和 revision；网关获取租约后检查浏览器预期版本，配置变化要求重新打开选择器，不改向另一地址提交。能力 projects.browse 是 API v1 的可选扩展，缺少时使用应用内手动路径兼容；认证或连接失败不按旧版降级。

写入新令牌先事务记录 intent，再等待原生系统凭据写入，再事务替换引用并登记旧条目清理。失败保留原连接，未清理 intent 下次编辑/启动重试。凭据不可用返回固定错误，元数据仍可查询；不使用明文或 SQLite 后备。移除仅删除连接及其凭据引用，不调用目标 Run 或进程控制。

Effect 停止准入、取消握手和本代私有配对操作、等待全部已接受操作与 native keyring 实际完成，然后关闭凭据句柄；数据库由其提供方随后关闭。请求可通过 AbortSignal 提前退出网络检查。组件初始化后立即返回。配对回调收到取消信号仍必须等待自身实际退出，不缓存跨代组件引用。

测试：`tests/remote-harness-server.test.mjs` 的失败写入、重启、身份变化、凭据不可用和元数据无秘密；`tests/desktop-local-pairing.test.mjs` 覆盖自动配对、端口修订、Vault 失败、managed orphan 回收、身份变化、并发重试及取消实际退出；`tests/desktop-local-pairing-ui.test.mjs` 验证配对就绪、版本变化、未保存表单保护与普通 Web 停用桌面轮询。真实平台测试由 `ANYBOX_DEPLOYMENT_TESTS=1` 门控，跳过不代表验收通过。根验证 `npm run check`。
