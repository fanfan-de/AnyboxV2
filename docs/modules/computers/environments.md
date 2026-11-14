# Computer 执行环境管理

[返回 Computer 模块](README.md) · [Projects](../sessions/projects.md) · [目录选择](../../project-directory-picker.md) · [部署](../../harness-server-deployment.md)

Computer 表示工具、进程与文件资源所在的执行环境。本机与多个远端环境可以同时存在；本机是相对于当前 harness server 所在设备而言，与浏览器或客户端所在设备无关。新项目的默认环境固定为 `local:computer`，不提供全局 local/remote 二选一或默认远端配置。每个项目绑定一个环境，每次 Run 固定该绑定；多个 Run 可以分别使用不同环境并行执行。

文件读写、搜索、命令与图片读取是 Computer 提供的能力，项目目录是该环境中的 Workspace；Bash、文件夹或单个工具不分别建立环境。内部仍按文件、进程与补丁等资源拆分组件，共用环境身份及执行归属。

## 现有组件与资源归属

环境身份复用单元附着的 `attachmentId`，没有新增环境数据库、Nya 组件或 Context。`harness.unit-attachments` 拥有授权与历史，`harness.unit-transport` 拥有临时连接状态，[Worker 路由](worker-router.md)统一提供执行端口，[Computers](computers.md)持有逻辑资源、实际实例与使用引用，[Workspaces](workspaces.md)固定项目目录与实例。Models、Session 和 Run 的业务归属保持各自边界。

[environments.ts](../../../packages/app-harness/src/core/computer/environments.ts) 是 Computer 模块的纯投影函数：输入现有附着、连接状态、本机平台信息与已经收到的工具清单观察，输出公开环境列表，不执行网络请求或打开 worker 数据目录。本机报告来自客户端已接收的 `info` 内存观察，远端报告来自最近一次轮询携带的能力；没有报告时保留未知。组合根始终登记本机附着并装配惰性本机客户端；读取列表、创建 Session 或查看状态不因此启动 worker，实际计算调用才按需确认本机 worker。

## 接口与状态

认证后的 `GET /api/v1/apps/agent/computer-environments` 返回：

```json
{
  "defaultEnvironmentId": "local:computer",
  "environments": [
    {
      "environmentId": "local:computer",
      "origin": "local",
      "state": "approved",
      "unitId": "computer-local",
      "platform": "linux",
      "architecture": "x64",
      "connectionState": "on-demand",
      "toolSupport": { "state": "unknown" }
    }
  ]
}
```

列表只包含 Computer 附着，本机排首；远端平台与架构来自单元声明，未知时为 null。`state` 为 `pending`、`approved` 或 `revoked`；`connectionState` 为 `on-demand`、`connected`、`offline`、`pending` 或 `revoked`。本机的 `on-demand` 表示可按需确认，不声明进程已经运行；远端连接状态为观察时快照，不是未来执行保证。响应不带凭证、授权目录或私有能力扩展。实例能力声明 `computer-environments`，客户端网关只代理该拥有者侧读取接口，不开放单元认证路由。

### 工具支持清单

每项环境的 `toolSupport` 为 `{ state: 'unknown' }`，或 `{ state: 'reported', workerId, bootId, manifest }`。`reported` 表示对应 worker boot 已报告支持这些工具契约；旧 worker 缺少清单、尚未收到本机 `info` 或远端轮询时为 `unknown`。清单不从宿主的完整工具目录或附着中的旧 `tools: 'all'` 推断。

worker 从自身实际执行装配生成清单，定义与校验位于 [tool-support.ts](../../../packages/app-harness/src/core/computer/tool-support.ts)。清单含 `schemaVersion: 1`、`revision`、`tools` 和 `constraints`；每个条目包含稳定 `toolId`、契约 `version`、`definitionHash` 和 `executor`（`bash`、`processes`、`files` 或 `apply-patch`）。`definitionHash` 是受信 `ToolDefinition` 经 `JSON.stringify` 后的 SHA-256；`revision` 按工具 ID 排序后，对版本、条目和约束计算 SHA-256，不随报告顺序变化。当前报告覆盖 19 个可选工具契约，不包含已退役的计划/待办工具。

`constraints` 明确 `terminal: 'pipes'`、`independentBackgroundJobs: false`、`filesystemSandbox: false`、`textEncoding: 'utf-8'`，以及 JPEG/PNG/WebP 的 `imageMediaTypes`。宿主只接纳与受信内置契约、定义摘要、执行器及约束精确匹配的清单；无效、未知版本或身份错配的报告投影为未知，不把远端清单作为任意 schema、命令或可执行插件加载。

工具支持报告、连接状态、授权和运行依赖分别表达：`reported` 不承诺当前在线、Shell/依赖就绪、目录可用或已授权，也不替代模型的图片/工具能力条件。本轮仅公布环境支持事实，不据此过滤模型声明、修改 Session 快照或改变实际执行流程；新操作仍由原准入路径复核权限及资源。

创建项目继续使用 `POST /projects {path, computerAttachmentId?}`。省略附着始终指向本机；显式附着的路径只在目标环境上解析，离线、越界或目录无效都拒绝登记，不向本机或其他远端重试。项目按规范路径与附着共同去重，名称、项目 ID 和历史绑定保持稳定。既有项目、已接受 Run 和恢复记录不会因默认环境改变而迁移或改绑。

## Web 流程

“执行环境”设置列出本机默认环境、多个远端及其连接与授权状态。加入远端沿用一次性 Computer 附着码：在此处生成，由设备拥有者在该设备的“管理本机 Computer worker”或 CLI 消费并指定目录、工具上限，成功后刷新列表即可使用，不需重启 harness server。远端可以撤销，本机附着仍按现有规则自动批准且不可从附着 API 撤销。

新增项目先固定 harness server 连接与实例，再选择执行环境，默认本机。本机支持原有目录浏览、创建及受信系统目录窗口；远端填写该环境上的绝对路径，不访问本机浏览、创建或系统窗口。目录记忆按 harness 实例与环境隔离。等待批准与已撤销的环境不可选择；列表失败显示错误供重试，离线或提交失败保留目标与输入。切换环境、停用及关闭等待旧观察退出，迟到结果不能更新新环境。

界面的“执行设备”连接选择器仍然选择 harness server，模型配置、Session 与项目记录属于该服务；项目的“执行环境”再决定其工具和文件资源的位置。“管理本机 Computer worker”管理客户端服务所在设备，它与当前项目的环境选择独立。

## 生命周期与兼容

不改变现有声明、摘要、附着 epoch、worker owner、实例代次与 scope 退出证明。观察断开不表示工具停止；已接受操作只向原 worker 查回，未知副作用不自动重放，也不因离线切换到另一环境。应用正常关闭仍取消并等待所属 Run，独立 idle worker 继续运行。

工具清单的列表投影只使用本代内存观察，不读取耐久附着中的初始能力提示；沿用现有能力 JSON，没有新增数据库、环境组件或 Context，读取列表不发起 worker 探测。远端报告必须与最新公开连接身份吻合，过时轮询不能恢复上一 boot 的清单。旧 worker 缺字段仍可按原协议执行，只是支持清单保持未知，不冒充空工具集或当前宿主的完整支持。

旧非空 `ANYBOX_COMPUTER_UNIT` / `ANYBOX_COMPUTER_ATTACHMENT` 会在启动配置校验时报错并给出移除指引。程序化调用仍传旧 `computerUnit` 或 Projects 的 `defaultComputerAttachmentId` 也明确拒绝，避免 JavaScript 调用方静默落到本机默认。部署时删除旧配置，再为新项目明确选择远端环境；历史项目与 Run 已持久保存的绑定保持原样。删除旧默认配置不会把原远端项目重建成本机项目。

## 其他环境的设计边界

Browser、外部服务连接与 Database 是未来候选，按共享资源身份、权限、状态和生命周期划分：浏览器环境拥有 context、登录态与页面；服务环境固定账号/租户、工作空间及凭据；数据库环境固定连接、schema、事务与查询资源。页面、文档和表是环境内资源。容器或 VM 可表现为不同 Computer 实例；Bash 和项目文件夹通常仍是 Computer 能力及工作区。本轮不为这些候选建立组件、接口或目录。当前 Models 是模型执行基础设施单元，尚未成为 Agent 可操作的工具环境；应用自有业务 SQLite 不因此开放为通用数据库工具。

## 验证入口

- `tests/computer-environments.test.mjs`：只读投影、工具清单报告与未知状态、敏感数据过滤。
- `tests/computer-worker-router.test.mjs`：本机与两个真实远端 worker、默认本机、既有远端绑定及重装配，列表不启动本机 worker。
- `tests/remote-harness-server.test.mjs`：正式路由、认证、客户端网关白名单。
- `tests/project-directories.test.mjs`、`tests/computer-workspaces.test.mjs`：环境内项目身份、跨平台绝对路径、固定工作区绑定与失败不回退。
- `tests/harness-client.test.mjs`、`tests/project-directory-client.test.mjs`、`tests/units-client.test.mjs`：捕获连接与环境、状态加载失败、路径隔离、远端不调用本机选择与关闭等待。

完整检查为根 `npm run check`。受控本机多 worker 测试不等同于真实跨机器网络、系统凭据或各操作系统目录窗口验收。

### 2026-11-11 验证记录

Linux x64、Node.js 24.16.0 上 `npm run check` 通过类型检查、构建与完整测试：2123 项测试，2102 项通过、21 项按既有条件跳过、0 失败；`git diff --check` 与受影响文档的相对链接检查通过。多环境行为测试使用本机与两个独立远端 worker，覆盖各自工具执行、重装配保留绑定、离线与取消恢复。原有进程清理测试在未修改 HEAD 基线上复现 Linux TERM trap 隐式退出码 143，测试命令改为显式 `exit 0` 后继续验证真实退出屏障，运行时代码不变。

隔离浏览器宿主使用临时数据库、目录与内存凭据，验证默认本机、在线远端路径登记、离线错误保留环境和路径、待批准项禁选、本机与远端同路径项目并存及可见环境标签，以及环境设置的连接状态。验证后关闭宿主并回收临时数据；未对正在运行的用户实例或真实跨机器设备执行部署，也未验收真实系统目录窗口。
