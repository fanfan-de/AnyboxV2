# Personal Agent 装配与数据边界

[返回 Personal Agent 模块](README.md)

## 客户端与执行端

客户端注册由 [`client/registration.ts`](../../../packages/app-personal-agent/src/client/registration.ts) 提供。打开产品后装配设备连接、应用网关和 Computer worker 的本机观察与管理。网关使用宿主同源命名空间 `/api/client/v1/apps/personal-agent`，以受管设备连接访问 Personal Agent 执行端 `/api/v1/apps/personal-agent`。执行设备身份和连接修订参与请求绑定。

执行注册由 [`registration.ts`](../../../packages/app-personal-agent/src/registration.ts) 提供。执行产品打开后才装配业务组件、Models 及原生协议、工作目录、Session、图片与文件、Prompt、Run/RunRuntime、Computer 和 HTTP。长期执行由 RunRuntime 持有。Computer worker 独立运行，保存实际工具调用及退出结果。

| 组件名称 | 提供服务 |
| --- | --- |
| `personal-agent-client-connections` | `personal-agent.client.connections` |
| `personal-agent-client-gateway` | `personal-agent.client.gateway` |
| `personal-agent-client-computer` | `personal-agent.client.computer` |
| `personal-agent-http` | `personal-agent.http` |
| `personal-agent-directory` | `personal-agent.agents` |

执行组件使用 `personal-agent.*` 服务和事件名。独立的 Models 与 SQL 在执行注册中绑定到 `personal-agent.models.*`、`personal-agent.models` 和 `personal-agent.local-storage`。同根执行宿主仍拥有请求认证、应用目标与活动准入。依赖、运行和退出规则见[各组件手册](README.md#组件文档)。

浏览器入口使用 `/apps/personal-agent/0.2.1/` 下的版本专属资源，外壳工作区路由为 `#/apps/personal-agent`。点击左侧头像打开所选 Agent 的[连续历史](history.md)，支持文件树、实时 Run 视图与草稿。设置面板提供设备选择，并管理 Agent、模型、Prompt、工具和 Computer。页面卸载会清理该页观察和控件，执行端仍持有已接纳的 Run。

## 工作目录

`personal-agent-projects`（服务 `personal-agent.projects`）维护目录身份和 Computer 绑定。首次打开 Agent 的连续对话时，在执行库路径加 `.workspaces` 的目录下按 Agent ID 派生目录名，登记稳定工作目录身份并绑定本机 Computer。后续重新打开、改名、改头像或重启继续使用同一身份和路径。Run 与文件接口使用相同的目录身份，旧项目目录由其既有记录继续定位。实现与兼容契约见 [工作目录组件](../../../packages/app-personal-agent/src/core/project/component.ts)和[连续历史](history.md#组件所有权与接口)。

## 数据与凭据

Personal Agent 与 Anybox Harness 各自持有执行 SQLite、Models JSON、目录缓存、图片目录、Computer worker 和系统 Vault 命名空间。Personal Agent 客户端拥有独立的设备连接表和凭据作用域。默认执行宿主可用同一监听器和实例身份承载两个应用。Nya 服务按资源归属绑定，组件通过本轮依赖找到所属资源。

应用沿用 Personal Agent 已有的 Models JSON 路径和模型 Vault 命名空间。原 0.1 对话、任务、文本 Run、委派、成果和偏好记录仍保存在原客户端业务库的 `personal_agent_*` 表中。0.2 使用原生 Session/Run 数据模型，旧文本历史保留原有语义，当前工作区没有这些旧记录的浏览、迁入或继续执行入口。

| Node 配置 | 默认值与用途 |
| --- | --- |
| `ANYBOX_PERSONAL_AGENT_DATABASE` | `npm run personal-agent` 的客户端库，默认 `./data/personal-agent.sqlite` |
| `ANYBOX_PERSONAL_AGENT_EXECUTION_DATABASE` | 新工作区的执行库，默认同一数据目录内 `personal-agent-execution.sqlite` |
| `ANYBOX_PERSONAL_AGENT_IMAGE_ASSETS_DIRECTORY` | 图片字节目录，默认为执行库路径加 `.images` |
| `ANYBOX_PERSONAL_AGENT_MODELS_CONFIG` | Models 配置，默认同一数据目录内 `personal-agent-models.json` |
| `ANYBOX_PERSONAL_AGENT_MODELS_DATABASE` | 先前的 Models SQLite 导入路径，默认同一数据目录内 `personal-agent-models.sqlite` |
| `ANYBOX_PERSONAL_AGENT_MODELS_CATALOG_DATABASE` | 公开目录缓存，默认同一数据目录内 `personal-agent-models-catalog.sqlite` |
| `ANYBOX_PERSONAL_AGENT_MODELS_NAMESPACE` | 系统 Vault 命名空间，Node 默认 `anybox.personal-agent.models`，桌面沿用其用户配置命名空间 |
| `ANYBOX_PERSONAL_AGENT_EXECUTION_PORT` | `npm run personal-agent` 的执行监听端口，默认 `0` 由系统分配 |

桌面使用桌面数据目录。`web:local` 和默认执行命令使用其执行宿主监听地址。Personal Agent 的 Computer worker 默认使用执行库路径加 `.computer-worker`。

## 准入、退出与加载

客户端和执行端通过各自的 Products 目标控制。版本准备只构造注册描述。业务库、Models、凭据和 worker 按运行角色及应用开放状态初始化。宿主正常关闭先停止准入，再让所属运行、工具与观察完成实际退出。活动 Run 和页面草稿参与宿主的应用停止或生效保护，独立 worker 沿用自己的进程生命周期。

原生 Run 的模型或工具调用未知结果按执行模块的恢复契约处理。停止客户端应用或关闭浏览器只关闭本地观察。数据由各自运行实例持有，宿主包卸载默认保留应用数据。
