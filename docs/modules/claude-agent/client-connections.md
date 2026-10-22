# Claude Agent Client Connections 组件

[Claude Agent 模块](README.md) · [客户端网关](client-gateway.md) · [应用独立归属](../../application-client-isolation.md)

## 工厂、服务与依赖

`packages/app-claude-agent/src/client/connections.ts` 的 `createConnectionsComponent(options)` 创建 `claude-agent-client-connections`，提供 `claude-agent.connections: ConnectionsPort`，inject 当前客户端根的 `local-storage`。组件由本应用客户端注册的 runtime 打开时安装，管理应用自己的远端连接，不依赖 host 实现、Harness 或共享连接业务包。正式安装的本机目标由[本机执行适配](local-execution.md)提供，不保存到这些连接表，不读取或发行设备令牌，也不使用 Vault。

配置接受系统凭据替身 `openEntry`、网络替身 `fetch`、旧 namespace 和旧 distribution 发行兼容的桌面 `localPairing` 回调。正式受管客户端取得 `localChannel` 时不使用此回调。默认私有 namespace 为 `anybox.client.claude-agent`，传入 namespace 时追加 `.claude-agent`；旧 namespace 仅用于只读迁入。所有秘密只在系统凭据库，SQLite 只保存引用和操作意图。

## 数据与接口

组件独占 `claude-agent-client-connections` v2 迁移域：`claude_agent_client_connections`、`claude_agent_client_credential_intents` 与 `claude_agent_client_local_connection`。这些表使用既有客户端 SQLite 连接，不新建数据库或 Context。`list/save/check/remove` 管理本应用的连接与修订，公开投影不含令牌、凭据引用或迁入来源；受信网关通过 `acquire` 获取固定配置版本与令牌。

首次打开按[旧数据迁入规则](../../application-client-isolation.md)复制旧共享元数据一次，保留连接 ID、instanceId、revision 与本机归属。首次使用令牌时登记意图、复制到本应用的 Vault 并提交引用。旧共享表和条目不再写入或删除；另一应用的改删和迁入进度不影响本应用。凭据失败保留来源和可重试记录，非秘密列表仍可读。

地址只允许 HTTPS 或明确回环 HTTP。保存先校验远端身份及 API 版本，再按 expectedRevision 提交；不跟随重定向，不静默替换实例。握手有界，网络检查不占配置队列。新凭据先登记 intent、写系统凭据、提交引用，再回收本应用旧条目；失败不替换原配置。

## 旧发行配对兼容、执行与清理

以下配对只用于尚未迁入受管角色通道的旧 distribution 完整默认发行。新安装 Claude Agent 的本机目标走应用内部通道，用户无需填写地址或令牌，“管理连接”保留应用自己的远端连接管理。

旧桌面回调仅提供本机服务描述、显式启动、发行与 reconcile。本应用对应 managed owner `anybox.desktop.local.claude-agent`，不撤销 Harness 的 token。初始化异步观察已经运行的服务；服务不存在时不启动、不发行凭据，不阻塞组件就绪。`localStatus` 只返回状态；`retryLocal` 是显式启动/重试入口。

旧 distribution 的显式 `web:local` 组合也注入本机配对：打开本应用后，经启动器继承的私有父子 IPC 自动连接该启动器实际创建的执行端，无须手工复制令牌。本应用使用 `anybox.web.local.claude-agent` managed owner、自己的连接表与 `anybox.client.claude-agent` Vault namespace；不撤销 Harness 或桌面的凭据。重启保留原连接、身份及有效 token，仅本机端口变化时修订地址。token 不进入环境变量、日志或浏览器，Vault 失败保留非秘密状态与显式重试，不改用明文后备。该回调不提供启动动作，也不打开执行端业务；独立 `client`/`web` 入口仍按既有方式管理连接。它没有把旧完整发行迁入正式同包角色通道。

`tests/web-local-pairing.test.mjs` 以真实组合子进程和测试父进程内存 Vault 验证两个应用自动配对、重启复用和凭据隔离、失败重试、关闭等待及启动期间接收关闭请求；`tests/runtime-roles.test.mjs` 继续验证独立客户端不启动执行端或自动配对。

客户端应用停止后 Effect 拒绝新调用，取消并等待网络、配对、配置及系统凭据操作实际退出，再关闭本应用 Vault 与只读迁入句柄。停止仅释放本应用资源并保留数据，不取消执行设备上已接受的 Run，不停止本机服务或其他应用。旧门面在停止后拒绝调用，重新打开创建新一代。

同目录 `connection-proxy.ts` 与 `connection-failure.ts` 是本组件/网关的私有函数和错误边界，不是额外组件。请求绑定、认证头、实例校验和双向管道语义见[客户端网关](client-gateway.md)。

## 失败与测试

凭据不可用返回固定 `credential-unavailable`；冲突、实例变化、旧版本、网络失败和取消保留既有错误码。清理等待真实退出，不用超时伪造完成。

`packages/app-claude-agent/tests/client-connections.test.mjs` 验证独立存储、修订、系统凭据与转发绑定；`tests/application-client-connections.test.mjs` 验证按应用装配/退出、另一应用不受影响、旧格式样本迁入及桌面 token owner 隔离。统一运行 `npm run check`。未启用的真实凭据及平台测试不代表通过。
