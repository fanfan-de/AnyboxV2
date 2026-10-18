# 应用业务服务独立运行（D0a.1）

[文档首页](README.md) · [应用包设计](application-packages-design.md) · [应用接入](application-development.md) · [发行与运行角色](runtime-roles-and-distribution.md)

D0a 完成源码包拆分后，D0a.1 于 2026-10-17 完成业务服务脱离宿主，再进入 D0b 按消费者装配与 D1 本地包安装。同一套业务实现既可由应用自己的入口启动，也可被 Anybox 集成。本阶段只提供业务服务独立运行，不增加独立桌面客户端、应用包安装器或下载流程。

## 业务与接入边界

| 职责 | 应用独立运行 | Anybox 集成 |
| --- | --- | --- |
| 业务装配 | 应用的装配函数安装领域组件及业务 HTTP 适配器 | 注册适配复用同一个装配函数 |
| Nya 根 | 独立服务创建并关闭唯一根 | 使用宿主已有根；应用不另建根或关闭宿主根 |
| HTTP 与认证 | 应用自己持有监听、设备认证、请求与流式连接，并等待关闭 | 宿主承载应用适配器，保留宿主管理接口及自身认证；应用判断业务权限 |
| 活动与启停 | 应用自己关闭业务准入、取消并等待实际退出 | Anybox 适配增加注册、`app.activity` 忙碌保护及统一启停协调 |
| 持久数据 | 应用及其提供方持有现有数据和迁移 | 继续使用同一数据身份、路径、表与迁移账本 |

HTTP 和认证由各应用自己处理，本阶段不新增公共 HTTP 或认证模块。设备拥有者、宿主管理控制与 Computer 单元认证保持各自边界；单元凭据不能用于拥有者业务请求，设备令牌也不能替代单元凭据。

业务装配不要求存在宿主的应用管理或活动服务。应用组件继续通过 `inject` 和本轮 `deps` 使用真实依赖，外部请求在首次异步步骤前从根捕获当前服务；纯函数、配置和装配辅助函数不虚构为组件。两个应用的独立监听组件实际持有 socket、请求和认证依赖，由 Nya 管理依赖撤销与清理。

## 应用入口与原命令

| 应用 | 可复用业务装配 | 独立服务工厂 | 应用自己的命令 |
| --- | --- | --- | --- |
| Anybox Harness | `@anybox/app-harness/server-runtime` 的 `createHarnessServerRuntime` | `@anybox/app-harness/server` 的 `createStandaloneHarnessServer` | `anybox-harness-server serve/init/recover-access/new-identity` |
| Claude Agent | `@anybox/app-claude-agent/server-runtime` 的 `createClaudeAgentRuntime` | `@anybox/app-claude-agent/server` 的 `createClaudeAgentServer` | `anybox-claude-agent serve/init/recover-access/new-identity` |

应用自己的 CLI 读取配置、输出服务状态、处理 SIGINT/SIGTERM 并等待服务关闭。`init` 等离线身份命令必须取得同一数据文件的排他锁。`init` 和 `recover-access` 只在本次调用返回完整访问令牌，`new-identity` 用于明确创建新的实例身份；不将令牌写入明文文件。

两个独立服务工厂在配置端口为 `0` 时使用系统分配端口。CLI 的默认监听均为回环：Harness 为 `127.0.0.1:3001`，Claude Agent 为 `127.0.0.1:3002`。远端访问继续使用 HTTPS 反向代理与拥有者设备令牌。详细 API 与配置见两个应用自己的 [Harness README](../packages/app-harness/README.md) 和 [Claude Agent README](../packages/app-claude-agent/README.md)。

工作区构建后也可直接使用各应用入口；两组命令共享默认业务文件，按需选择一组启动，切换前先停止原服务：

```sh
node packages/app-harness/dist/entrypoints/server-main.js init
node packages/app-harness/dist/entrypoints/server-main.js serve
```

```sh
node packages/app-claude-agent/dist/main.js init
node packages/app-claude-agent/dist/main.js serve
```

已有实例无需再次 `init`；遗失令牌时在服务停止后使用 `recover-access`，身份及业务历史保持。

原 `anybox harness-server`、`npm run harness:server`、客户端和桌面入口仍由 `distribution` 提供，继续保留两个正式应用的默认组合及原命令行为。它们不改为调用会创建另一个根的独立服务工厂，而是在已有根上安装同一业务装配。独立服务保留 `/api/v1/instance` 与各自应用前缀的 HTTP 契约，只提供本应用业务及身份管理，不提供 Anybox 应用管理页面或 `/products/*`。当前 Web 客户端仍依赖宿主产品控制接口，其直连独立服务的适配不属于本阶段。

## 数据与进程兼容

独立服务沿用 `ANYBOX_HARNESS_DATABASE` 和默认 `./data/harness.sqlite`，不借此拆库或搬表。实例 UUID、设备令牌格式、`host-access` v2 迁移域和原 `host_identity` / `host_access_tokens` 表保持兼容；应用内部服务名不改变已有持久标识。Models JSON、目录缓存、图片目录、Computer worker 目录、Claude 索引及系统凭据继续沿用现有归属与路径规则。

托管实例、Harness 独立服务和 Claude Agent 独立服务不能同时打开同一数据文件。切换方式是先正常关闭原持有者，再以目标入口打开；需要并行运行时须明确选择不同的业务数据位置，Harness 的其他独占配置和资源目录也必须分别设置，不能仅更换监听端口。

原有桌面界面、客户端服务、harness server、Computer worker 进程划分保持。应用独立运行能力不要求每个应用另起一个进程；Anybox 可以在同一执行进程的一个 Nya 根组合两个应用。独立 idle Computer worker 仍是独立设备服务，Harness 服务停止只关闭观察并取消、排空自己所属的工作，不停止无所属工作的 worker。Claude Agent 继续每 Run 一个 SDK 子进程，使用用户原有 Claude 环境。

## 准入、取消与正常退出

服务关闭先同步停止新业务与 HTTP 准入，然后并行推进业务根清理和已接受 HTTP 请求、SSE、等待者及保留操作的排空。请求 `retainUntil()` 可能等待 Run 实际退出，因此不能先等待全部 HTTP 请求结束，再开始取消业务根。

浏览器断开和 SSE 关闭只结束观察，不自动取消已经接受的 Run。显式取消、应用停止或服务信号退出由应用自己的资源所有者执行，等待模型、工具、文件句柄、SDK 子进程和已接受提交实际退出后释放存储及监听端口。清理失败保留真实业务事实并报告失败，不创建伪成功记录。异常退出后沿用已有恢复规则，未知外部副作用不重放。

## 验收要求

关键验收在仓库外临时环境执行：分别只安装一个应用的构建产物及其声明依赖，确认 `@anybox/host`、`@anybox/distribution` 和另一应用均不可解析；不能借 workspace 链接、上级 `node_modules` 或源码相对导入补齐依赖。

| 场景 | 验证事实 |
| --- | --- |
| 独立启动 | 只安装 Harness 或只安装 Claude Agent，读取配置、启动、查询实例及应用能力并访问业务接口 |
| 认证 | 缺失、错误令牌和错误实例拒绝；旧令牌可用；撤销等待所属观察退出；Computer 单元路由独立认证 |
| 流式与取消 | 业务 SSE 传递真实进展；断流不取消 Run；显式取消等待实际退出并保留已观察结果 |
| 正常关闭 | SIGTERM 或服务 `close()` 停止准入，取消并排空所属业务、流式及保留操作，释放端口、子进程与独占锁 |
| 数据兼容 | 托管关闭 → 独立启动 → 独立关闭 → 托管重开，原身份、令牌、历史和迁移账本延续；并发打开同文件明确失败 |
| Anybox 集成 | 原默认组合、应用注册、忙碌停止保护和原 CLI 行为保持，复用应用业务装配且同进程只有一个根 |

测试入口为 [隔离安装](../tests/application-standalone-isolation.test.mjs)、[托管与独立兼容](../tests/application-standalone-compatibility.test.mjs) 及两个应用包的独立服务行为测试。受控测试使用临时数据、内存凭据和模拟模型/SDK。真实模型、系统 Vault、最终桌面成品和其他平台验收单独记录，不由隔离启动或 `npm run check` 推定完成。本阶段完成后运行根 `npm run check`；本次实际结果由 [阶段验收](harness-server-plan.md) 记录。
