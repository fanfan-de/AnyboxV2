# Client Gateway 组件

[宿主与客户端模块](README.md)

`src/host/client/gateway.ts` 的 `createClientGatewayComponent({port?,localInstanceId?})` 创建 `client-gateway`，提供 `client.gateway: ClientGateway`（url、幂等 close）。inject `client.connections` 和 `host.directory-picker`，拥有唯一客户端 HTTP 监听器、在途请求与全部上传/SSE/下载流。静态页面映射 `src/host/assets.ts` 是内部提供方，不是组件。

只监听 127.0.0.1，检查精确 Host/Origin 和浏览器同源约束。`/api/client/v1/connections` GET/POST 查询和保存连接；`/:id/check`、`/:id/delete`、`/:id/pick` POST 执行检查、移除和本机目录窗口。`/api/client/v1/local` 只返回启动器确认的本机身份与目录能力。目录窗口必须匹配 localInstanceId，不能按 hostname 推断。

`/api/connections/:connectionId/v1/...` 只转发声明的业务路由。连接服务捕获配置代、地址、令牌、实例，网关自行生成 Authorization 与期望实例头，只转发必要 Content-Type/Length，不转发浏览器认证与代理身份头。不接受任意 URL，不跟随重定向、不重试写入，拒绝响应实例不匹配。JSON、图片、资源与 SSE 保留流背压，断开观察不取消 Run。

目录选择只增加精确的 POST `/projects/directories/browse` 与 `/projects/directories/close` 白名单，路径作为 JSON 业务参数，不成为代理目标 URL。选择器请求携带 `X-Anybox-Expected-Instance-Id` 和 `X-Anybox-Connection-Revision`；网关获取同一连接租约后比较，匹配才访问上游。新增头只在网关消费，旧客户端未发送时仍兼容。系统目录窗口同样检查预期连接；确认登记不会跟随另一标签页的连接修改。完整协议见[项目目录选择](../../project-directory-picker.md)。

Effect 停止接收请求，取消网络、上传和流读取并等待实际关闭；连接组件与 SQLite 随后清理。客户端关闭不发送 Run 取消或 Harness 关闭；目录对话框关闭会释放自己的短期浏览会话，不影响执行。失败用稳定代码区分认证、实例不匹配、配置冲突和不可达。

浏览器 `src/client/harness-client.ts` 实现固定连接的 settings Api 和多实例查询/命令/上传/资源/订阅。资源身份用 instanceId，SSE 按实例分组；dispose 只关闭本地连接资源。草稿、pending、位置与布局使用实例限定 ID；结果未知先向原实例按幂等键补查。旧状态处理由 `legacy-state.ts` 所属客户端逻辑完成，不是新组件。

测试：`tests/remote-harness.test.mjs`、`tests/harness-client.test.mjs`、`tests/deployment-boundaries.test.mjs`；浏览器测试宿主 `tests/helpers/remote-browser-host.mjs` 提供三个受控实例。运行 `npm run check`。
