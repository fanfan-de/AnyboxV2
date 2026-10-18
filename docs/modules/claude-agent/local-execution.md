# Claude Agent 本机执行组件

[Claude Agent 模块](README.md) · [客户端网关](client-gateway.md) · [同包角色通道](../package-management/activation.md#同包角色私有通道)

## 工厂、服务与依赖

`packages/app-claude-agent/src/local-execution/component.ts` 的 `createClaudeAgentLocalExecutionComponent(root)` 创建 `claude-agent-local-execution`，提供 `claude-agent.local-execution: ClaudeAgentLocalExecutionPort`，注入本轮 `app.products`、`app.activity` 和 `host.access`。`host.access` 只提供非秘密的本机 instance 身份，本组件不调用 authenticate、issue、issueManaged 或凭据管理；本机请求权限来自宿主固定的同包私有角色通道。

`createClaudeAgentLocalExecutionChannel()` 构造纯注册的 `channel.handle` 声明。首次运行期请求在 execution 的唯一 Nya 根惰性安装本组件，并等待本轮服务就绪；不会建立应用子 Context。它独立持有本机观察和流资源，不以业务是否打开为自身寿命。准备阶段和纯注册不打开数据库、Claude SDK、监听器或其他业务。

客户端 `client/local-execution.ts` 的描述与转发函数使用 runtime 交付的 `ApplicationPackageRuntimeContext.channel`；应用自有 `local-execution/protocol.ts` 定义和校验消息，`http-stream.ts` 提供 Node request/response 的内存适配。这些函数和协议数据没有独立 Nya 组件或持久化表。

## 接口与边界

私有协议使用 `describe`、`reserve`、`request`、`read`、`close` 和 `watch`。客户端先固定 requestId/instanceId 并发送 reserve，执行端仅分配轻量观察意图，不创建 HTTP 或 SSE 资源；收到确认后，客户端并发持有 watch 并发送 `request { reserved: true }`。执行端等待 watch 实际附着后才创建 HTTP 资源。watch 的取消会撤销原意图，迟到的 reserved request 必须拒绝，不能重建观察。打开响应丢失或浏览器背压导致没有 pending read 时，watch 仍持有取消链，关闭客户端会等待原观察实际退出。消息只传 JSON，宿主不解释路由、DTO 或 SSE；同一 appId 和确切不可变包身份由宿主绑定，不能选择另一个应用或旧版本。请求路径只接受 `/instance`、`/products/claude-agent` 及其 open/stop/retry，以及 `/apps/claude-agent/` 业务路径。

描述与产品查询在业务关闭时仍可用。显式 open/retry/stop 转交本应用 Products 生命周期；业务请求先经 Products 准入，再从本代根获取 `claude-agent.http`，复用现有 handler、参数校验、白名单 DTO、retainUntil 和 SSE。GET 观察与 POST 阻塞租约经 Activity 登记，不另建公开 HTTP socket、回环地址或设备认证入口。

请求 JSON 体最大 512 KiB，响应按 64 KiB 字节分帧并编码为 base64，避免破坏 UTF-8 边界。客户端按帧读取并等待浏览器 drain，执行侧限制并发流和缓存，对遗弃观察进行回收；完整 SSE 队列与慢消费者保护继续由[HTTP 组件](http.md)持有。应用消息还受宿主单值 1 MiB 的通用 JSON 边界约束。

浏览器入口由网关提供：`GET /local` 返回 `managed: true` 及独立 `kind: 'local'` 的本机 device，`/local/v1/<path>` 转发业务，`POST /local/pick` 走已取得的本机目录能力。本机不写入 connections、不需要访问令牌，也不访问 Vault。远端连接仍由[连接组件](client-connections.md)管理，不因本机通道就绪而迁入、删除或重写。

## 执行、取消与清理

浏览器断开、客户端关闭或通道取消会关闭该观察与内存流，等待对应 handler、历史读取、目录操作及观察任务实际退出。已接受 Run 的 retainUntil 持续保持业务租约至 Run 实际结束；结束观察不等于取消 Run。显式停止本机业务继续遵守既有 guard，忙碌时不默认取消业务。

组件 Effect 停止新请求、关闭全部内存观察并等待资源退出。execution 根关闭还会通过原有业务组件停止准入、取消 Run 并等待 Claude 子进程及历史 worker；Nya 按真实依赖和资源所有权完成清理。客户端关闭只结束观察，不停止宿主管理的角色进程。

## 失败、兼容与验证

角色尚未 ready、已退出、冻结或包身份不匹配时报告 `local-execution-unavailable`；instance 换代拒绝旧绑定，不退回旧公开服务或建立 token 连接。业务未打开继续返回原有产品不可用状态，参数、路由与业务错误保持既有语义。

仅正式安装的受管角色注入此通道。独立 `anybox-claude-agent` 服务继续使用应用自己的 HTTP/认证；旧 distribution 完整默认发行保留已有配对兼容，尚未整体迁入新路径，不能据此宣称 D3 已完成。

`packages/app-claude-agent/tests/local-execution.test.mjs` 使用 SDK 替身验证无设备连接/令牌、惰性打开、DTO/SSE、观察取消与实际清理；`packages/host/tests/application-channel.test.mjs` 验证同包身份、运行期门控、有界 JSON 和取消退出；`tests/claude-agent-local-client.test.mjs` 验证浏览器本机目标与远端列表独立、无本机配对界面。统一入口 `npm run check`；真实 Claude 登录、真实平台凭据与其他平台验收不由替身测试代替。

0.1.9 在应用自己的客户端白名单增加附件分块、Run 追加输入和项目原生会话路由。每块最大 192 KiB 原字节，编码请求仍满足原通道大小上限；不改变宿主通道、身份或权限。`tests/claude-agent-local-client.test.mjs` 从客户端 HTTP 经真实执行适配器覆盖这些业务请求，正式环境另以临时附件完成创建/提交/丢弃验证。
