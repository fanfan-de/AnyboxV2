# Client Gateway 组件

[宿主与客户端模块](README.md)

`src/applications/harness/client/gateway.ts` 的 `createClientGatewayComponent({localInstanceId?})` 创建 Anybox Harness 内部 `client-gateway`，提供 `client.gateway: HarnessGateway`（handle、幂等 close）。inject `client.connections`、`host.directory-picker` 与 `app.activity`。组件仅在 Anybox Harness 客户端打开时安装，拥有在途连接、上传、SSE 和下载流；常驻监听器及静态页面属于 [Client Shell](client-shell.md)。

每个委托请求在首次异步读取之前登记 Anybox Harness Activity 租约。写入阻止关闭客户端应用，读操作可取消但等待实际退出。`createHarnessGateway` 为内部闭包工厂；`createHarnessGateway` 仅组合相同 Gateway 与 Shell 的嵌入/测试入口，没有第二套产品生命周期。

Shell 只监听 127.0.0.1 并检查精确 Host/Origin 和同源约束；通过后交给 Anybox Harness Gateway。`/api/client/v1/connections` GET/POST 查询和保存连接；`/:id/check`、`/:id/delete`、`/:id/pick` POST 执行检查、移除和本机目录窗口。`/api/client/v1/local` 返回启动器确认的本机身份与目录能力，桌面自动配对启用时附加非秘密 status。`POST /api/client/v1/local/retry {}` 仅在受信桌面配对配置启用时可用，不接受地址、身份或 token；普通 Web 返回 local-pairing-unavailable。目录窗口必须匹配受信配对已确认身份或启动器 localInstanceId，不能按 hostname 推断。

`/api/connections/:connectionId/v1/...` 只转发声明的业务路由。连接服务捕获配置代、地址、令牌、实例，网关自行生成 Authorization 与期望实例头，只转发必要 Content-Type/Length 与经过格式校验的 `X-Anybox-Product-Id`，不转发浏览器认证与代理身份头。不接受任意 URL，不跟随重定向、不重试写入，拒绝响应实例不匹配。JSON、图片、资源与 SSE 保留流背压，断开观察不取消 Run。

新会话默认值白名单只接纳 `GET` / `POST /agents/:id/session-defaults`。默认属于固定连接所指的执行设备，不在客户端 SQLite 或 sessionStorage 另存权威副本。浏览器设置使用所选设备的固定 settings Api，模型目录与响应保留本地 ID，Agent 选择器的作用域 ID 在进入该 Api 前转为本地 ID。聚合 Api 则对请求解包，并将响应的 agentId、modelId、fallbackModelId、effectiveModelId 包装回同一 instanceId。设备切换或连接版本变化不会把旧草稿提交到其他实例；冲突、断开或未知写入结果不会自动重试。

工具库增加精确 `GET /tools` 和 `GET` / `POST /agents/:id/tools` 白名单，不允许目录写入或任意子路径。目录与工具设置使用所选执行设备的固定 Api。toolId、toolIds 和 toolSelection 内的声明是跨设备稳定工具身份，不做 instanceId 包装；Agent 和会话资源身份仍按原规则固定设备。不存在按来源标签分流模型或跨设备合并后保存配置的路径。

目录选择只增加精确的 POST `/projects/directories/browse`、`/projects/directories/create` 与 `/projects/directories/close` 白名单，路径作为 JSON 业务参数，不成为代理目标 URL。create 只转发 `{browseId,name}`，属于写请求；目标 Projects 在认证调用方已加载的当前浏览目录下创建单个子目录，不递归创建或登记项目。选择器请求携带 `X-Anybox-Expected-Instance-Id` 和 `X-Anybox-Connection-Revision`；网关获取同一连接租约后比较，匹配才访问上游。新增头只在网关消费，旧客户端未发送时仍兼容。系统目录窗口同样检查预期连接。浏览器在“添加项目”时捕获目标，本机身份匹配且平台支持时直接调用窗口，用户确认后立即向该目标登记，不再打开应用内对话框；取消不登记。远程或原生能力未确认可用时使用应用内浏览，窗口启动或登记失败只显示通知，不回退、换连接或重试写入。确认登记和新建文件夹不会跟随另一标签页的连接修改，创建未知结果也不自动重试。完整协议见[项目目录选择](../../project-directory-picker.md)。

新建入口以目标声明的 `projects.create-directory` 为准；缺少该能力时隐藏入口，原有 `projects.browse` 流程继续可用。创建代理和目标 harness server 都需要升级，能力协商不新增数据库或迁移。

Effect 停止接收请求，取消网络、上传和流读取并等待实际关闭；连接组件与 SQLite 随后清理。客户端关闭不发送 Run 取消或 harness server 关闭；目录对话框关闭会释放自己的短期浏览会话，不影响执行。失败用稳定代码区分认证、实例不匹配、配置冲突和不可达。

浏览器 `src/applications/harness/web/harness-client.ts` 实现固定连接的 settings Api 和多实例查询/命令/上传/资源/订阅。资源身份用 instanceId，SSE 按实例分组；dispose 只关闭本地连接资源。草稿、pending、位置与布局使用实例限定 ID；结果未知先向原实例按幂等键补查。旧状态处理由 `legacy-state.ts` 所属客户端逻辑完成，不是新组件。

测试：`tests/remote-harness-server.test.mjs`、`tests/harness-client.test.mjs`、`tests/deployment-boundaries.test.mjs`；浏览器测试宿主 `tests/helpers/remote-browser-host.mjs` 提供三个受控实例。运行 `npm run check`。

应用控制代理仅允许已知 `/products`、`/products/:id` 与 `/:id/open|stop|retry`，不提供模块列表、创建或定义写入。每个代理请求固定所属 Anybox Harness 应用及期望实例/连接 revision，业务端核验该设备的 Anybox Harness 运行目标。

图片 `<img>` 无法携带自定义请求头时，仅 GET `/sessions/:id/images/:assetId/content` 可通过 `__anyboxProductId`、`__anyboxInstanceId`、`__anyboxConnectionRevision` 三个保留查询参数携带同样绑定。网关验证完整性和与头的一致性，剥离这些参数，再生成上游产品头；其他路由拒绝这些保留参数。SSE 通过带头的流式 fetch 发起。`tests/products-api.test.mjs` 验证产品来源转发、实例/revision 冲突、查询参数剥离与白名单。

网关通过 Anybox Harness 注册提供 /api/client/v1/apps/agent 下的应用相对路由，旧连接与代理路径是目录别名。handle 等待转发管道真实退出，并响应监听器的关闭信号。上游仍使用相同白名单及兼容执行入口；应用 open/stop/retry 的响应等待上限为 120 秒，普通连接握手 15 秒、活动空闲 35 秒。断连或超时不自动重试已接受控制。

## 项目目录树代理

白名单显式接纳会话文件树的 `tree/open`、`tree/page` 和 `tree/close` POST 路径，复用固定连接版本与 instanceId 的请求绑定。游标 ID 不决定设备，不跨连接或应用重试；取消网络观察仍等待实际退出。浏览器按活动 thread 读取所属项目，不受左侧设备选择影响。详情见[三栏工作区](../../harness-three-column-workspace.md)。
