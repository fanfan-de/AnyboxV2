# Client Computer 组件

[客户端模块](README.md) · [独立管理操作](../../computer-worker-management.md) · [本机传输](../computers/local-worker-client.md)

`src/applications/harness/client/computer-worker.ts` 的 `createClientComputerComponent(options)` 创建 `client-computer`，提供 `client.computer: ClientComputerPort`。组件无 inject，随 Anybox Harness 客户端安装；`client.gateway` 注入它，按本代 deps 使用服务。它复用 `connectLocalComputerWorker` 的回环观察，固定 `autoStart: false`，不导入 worker 服务装配，不建立额外 Nya 根。

配置为受信宿主提供的 `directory`、可选 `executable`、`startupTimeoutMs` 与 `requestTimeoutMs`。目录不是浏览器可修改的请求参数。客户端默认控制超时 120 秒；状态读取最多 5 秒。创建／卸载组件不会读写 worker 账本、读取系统单元凭据或启动／停止 worker。

| 入口 | 行为 |
| --- | --- |
| `status(signal?)` | 读取 endpoint、确认 PID 和 workerId/bootId，返回 stopped/running/unavailable、平台支持与非秘密附着状态；不创建目录、不启动 |
| `start()` | 显式启动或复用已运行实例；Windows 检查随包原生后端并使用受保护 DACL 的私有目录 |
| `control.consumeAttachCode(input, signal?)` | 已运行 worker 附着到远端，码仅出现在请求中 |
| `control.updatePermissions(id, ceiling, signal?)` | 保存权限并等待既有执行退出，空数组与 all 区分 |
| `control.revokeAttachment(id, signal?)` | 本地撤销与清理，不要求远端在线 |

Effect 停止本代新观察、取消 HTTP 并等待在途观察退出；不停止独立 worker，也不把管理请求的断开解释为 worker 已回滚。管理操作与真实工具的资源、账本和清理归 worker 根；客户端只拥有观察连接及超时。

HTTP 仅在客户端应用路径 `/api/client/v1/apps/agent/computer` 下提供 `GET /status`、`POST /start`、`POST /attachments`、`POST /attachments/:id/permissions`、`POST /attachments/:id/revoke`。受客户端回环 Host/Origin 及桌面私有传输保护，不在远端连接代理白名单内。浏览器不收到 endpoint URL/令牌或单元凭据。

浏览器入口在“管理连接”的独立本机区域，手动刷新，不跟随所选 harness server。已停止的 worker 返回状态但不离线读取其数据库；启动后才能查看持久附着详情。CLI 使用同一观察工厂和协议，不要求启动客户端进程。

验证：`tests/computer-worker-management.test.mjs` 覆盖独立 HTTP / CLI、权限准入、取消后实际退出、并发撤销、断开观察与持久化；`tests/runtime-roles.test.mjs` 在真实客户端子进程中禁止执行端导入和子进程创建，检查恢复及只读状态无副作用；`tests/units-client.test.mjs` 验证按钮与 API 绑定。
