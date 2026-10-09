# Anybox 命名与边界

[文档首页](README.md) · [宿主与应用边界](harness-module-boundary.md) · [harness server 部署](harness-server-deployment.md)

本项目统一使用以下三层名称。`server` 表达服务端职责，本地设备上的服务端也称为 harness server。

| 名称 | 定位 | 当前实现 |
| --- | --- | --- |
| **Anybox** | 外层宿主产品，承载受信应用，管理目录、生命周期、访问、HTTP 分派和前端外壳 | `src/host/`；正式组合及进程入口在 `src/entrypoints/` |
| **Anybox Harness** | Anybox 内的 Agent 产品，包含项目与会话工作区、客户端连接和服务端执行能力 | `src/applications/harness/`；稳定应用 ID 为 `agent` |
| **harness server** | Anybox Harness 的通用服务端核心，可部署在本地设备或远端服务器 | `server.ts`、`server-runtime.ts`、`server-config.ts`、`server-models.ts`、`core/` 和 `http/` |
| **Anybox Harness 客户端** | 产品的连接、凭据、同源网关、目录选择和浏览器工作区 | 应用的 `client/`、`web/` 和 `web/apps/agent/`；运行在独立客户端进程及浏览器中 |

Anybox Harness 是完整产品名。描述一次部署、执行设备上的 API、模型与工具资源、持久会话或 Run 时使用 harness server；描述界面和连接管理时使用 Anybox Harness 或 Anybox Harness 客户端。Agent、Session、Run、RunRuntime、Models 等领域名称继续表达各自职责。

## 文件、标识与命令

宿主源码保留 `src/host/`，产品目录短名保留 `harness`。服务端组合入口使用 `server.ts`，配置、装配与模型接入使用 `server-config.ts`、`server-runtime.ts`、`server-models.ts`；CLI 入口为 `src/entrypoints/harness-server-main.ts`。产品和客户端文件继续使用 `harness-*` 表达所属产品，例如 `harness-client.ts`；通用宿主的 `execution.ts` 仍表达可承载不同应用的执行宿主。

服务端类型、工厂和核心安装入口使用 `HarnessServer*`、`createHarnessServer*`、`installHarnessServer*`，例如 `HarnessServerApi`、`createHarnessServer` 和 `installHarnessServerCore`。核心安装句柄通过 `api` 暴露服务端 API。客户端标识 `HarnessClient`、`HarnessGateway` 表达产品内部的客户端职责。`RunHost` 是协议 Loop 使用的运行操作契约，不表示部署宿主，不因产品改名而改写。

| 用途 | 规范入口 |
| --- | --- |
| 启动服务端 | `npm run harness:server` |
| 初始化服务端实例与访问令牌 | `npm run harness:server:init` |
| 启动客户端 | `npm run client` |
| 组合启动本地服务端与客户端 | `npm run web` |
| Linux systemd 示例 | `deploy/harness-server.service.example`，安装为 `harness-server.service` |
| 服务端 HTTPS/SSE 代理示例 | `deploy/harness-server.nginx.conf.example` |

纯服务端文档使用 `harness-server-*`：部署、组件协作、阶段计划和函数式开发说明。涵盖宿主与整个产品或客户端的文档保留产品短名，如 `harness-module-boundary.md` 和 `harness-three-column-workspace.md`。组件手册文件按实际组件职责命名，服务名中的短名不要求扩写。

## 兼容保留

名称统一不迁移已有身份、数据或协议。以下标识保持原值：

| 标识 | 保留原因 |
| --- | --- |
| 应用 ID `agent`、目录短名 `harness`、`/apps/agent/` 资源地址 | 应用归属、路由和浏览器资源身份稳定 |
| `harness.*` Nya 服务、事件及 `harness-*` 组件名 | 现有注入和领域契约使用的技术命名空间 |
| `/api/v1/apps/agent`、`/api/client/v1/apps/agent` 及显式旧业务路由 | 客户端、执行端和已部署实例的协议兼容 |
| `ANYBOX_HARNESS_*`、`ANYBOX_MODELS_*`、`ANYBOX_CLIENT_*`、`ANYBOX_PROJECTS` 等环境变量 | 已部署配置兼容；服务端端口规范变量为 `ANYBOX_HARNESS_PORT`，配置解析仍接受旧 `ANYBOX_WEB_PORT` 入口 |
| `npm run harness`、`npm run harness:init` | 分别委托规范的 `harness:server` 和 `harness:server:init` |
| `harness.sqlite`、Models 与客户端数据库路径、表、迁移域及历史 JSON | 已有数据继续可读，命名变更不创建新数据身份 |
| `anybox.models`、`anybox.client`、旧 `anybox` 凭据命名空间 | 系统凭据引用及明确的旧密钥读取兼容 |
| sessionStorage 键、资源 ID、`instanceId` 和已保存连接 | 草稿、布局、幂等及多实例归属保持稳定 |
| `AnyboxV2` 仓库目录与既有包的技术名称 | 仓库或包标识与面向用户的产品名称分别管理 |

新建 harness server 的默认实例显示名称为 `harness server`，`ANYBOX_HARNESS_NAME` 的显式配置优先；已保存实例名称继续保留。通用 `host.access` 的默认名称仍为 Anybox，因为它也服务于其他应用。

历史架构文件保留图源、导出 SVG/PNG 中绘制时的名称与结构，并明确标注快照日期；文中的导航和源码链接指向当前入口。第三方名称（例如 DeepSeek Harness）、用户自定义名称、历史样本和兼容标识不机械替换。
