# Client Gateway 组件

[宿主与客户端模块](README.md)

`src/host/client/gateway.ts` 的 `createClientGatewayComponent({port?,localInstanceId?})` 创建 `client-gateway`，提供 `client.gateway: ClientGateway`（url、幂等 close）。inject `client.connections` 和 `host.directory-picker`，拥有唯一客户端 HTTP 监听器、在途请求与全部上传/SSE/下载流。静态页面映射 `src/host/assets.ts` 是内部提供方，不是组件。

只监听 127.0.0.1，检查精确 Host/Origin 和浏览器同源约束。`/api/client/v1/connections` GET/POST 查询和保存连接；`/:id/check`、`/:id/delete`、`/:id/pick` POST 执行检查、移除和本机目录窗口。`/api/client/v1/local` 只返回启动器确认的本机身份与目录能力。目录窗口必须匹配 localInstanceId，不能按 hostname 推断。

`/api/connections/:connectionId/v1/...` 只转发声明的业务路由。连接服务捕获配置代、地址、令牌、实例，网关自行生成 Authorization 与期望实例头，只转发必要 Content-Type/Length，不转发浏览器认证与代理身份头。不接受任意 URL，不跟随重定向、不重试写入，拒绝响应实例不匹配。JSON、图片、资源与 SSE 保留流背压，断开观察不取消 Run。

Effect 停止接收请求，取消网络、上传和流读取并等待实际关闭；连接组件与 SQLite 随后清理。客户端关闭不发送任何远程取消或 Harness 关闭。失败用稳定代码区分认证、实例不匹配、配置冲突和不可达。

浏览器 `src/client/harness-client.ts` 实现固定连接的 settings Api 和多实例查询/命令/上传/资源/订阅。资源身份用 instanceId，SSE 按实例分组；dispose 只关闭本地连接资源。草稿、pending、位置与布局使用实例限定 ID；结果未知先向原实例按幂等键补查。旧状态处理由 `legacy-state.ts` 所属客户端逻辑完成，不是新组件。

测试：`tests/remote-harness.test.mjs`、`tests/harness-client.test.mjs`、`tests/deployment-boundaries.test.mjs`；浏览器测试宿主 `tests/helpers/remote-browser-host.mjs` 提供三个受控实例。运行 `npm run check`。
