# Computer 执行环境管理

[返回 Computer 模块](README.md) · [Projects](../sessions/projects.md) · [目录选择](../../project-directory-picker.md) · [部署](../../harness-server-deployment.md)

Computer 表示工具、进程与文件资源所在的执行环境。本机与多个远端环境可以同时存在；本机是相对于当前 harness server 所在设备而言，与浏览器或客户端所在设备无关。新项目的默认环境固定为 `local:computer`，不提供全局 local/remote 二选一或默认远端配置。每个项目绑定一个环境，每次 Run 固定该绑定；多个 Run 可以分别使用不同环境并行执行。

## 现有组件与资源归属

环境身份复用单元附着的 `attachmentId`，没有新增环境数据库、Nya 组件或 Context。`harness.unit-attachments` 拥有授权与历史，`harness.unit-transport` 拥有临时连接状态，[Worker 路由](worker-router.md)统一提供执行端口，[Computers](computers.md)持有逻辑资源、实际实例与使用引用，[Workspaces](workspaces.md)固定项目目录与实例。Models、Session 和 Run 的业务归属保持各自边界。

[environments.ts](../../../packages/app-harness/src/core/computer/environments.ts) 是 Computer 模块的纯投影函数：输入现有附着、连接状态与本机平台信息，输出公开环境列表，不执行网络请求或打开 worker 数据目录。组合根始终登记本机附着并装配惰性本机客户端；读取列表、创建 Session 或查看状态不因此启动 worker，实际计算调用才按需确认本机 worker。

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
      "connectionState": "on-demand"
    }
  ]
}
```

列表只包含 Computer 附着，本机排首；远端平台与架构来自单元声明，未知时为 null。`state` 为 `pending`、`approved` 或 `revoked`；`connectionState` 为 `on-demand`、`connected`、`offline`、`pending` 或 `revoked`。本机的 `on-demand` 表示可按需确认，不声明进程已经运行；远端连接状态为观察时快照，不是未来执行保证。响应不带凭证、授权目录或私有能力扩展。实例能力声明 `computer-environments`，客户端网关只代理该拥有者侧读取接口，不开放单元认证路由。

创建项目继续使用 `POST /projects {path, computerAttachmentId?}`。省略附着始终指向本机；显式附着的路径只在目标环境上解析，离线、越界或目录无效都拒绝登记，不向本机或其他远端重试。项目按规范路径与附着共同去重，名称、项目 ID 和历史绑定保持稳定。既有项目、已接受 Run 和恢复记录不会因默认环境改变而迁移或改绑。

## Web 流程

“执行环境”设置列出本机默认环境、多个远端及其连接与授权状态。加入远端沿用一次性 Computer 附着码：在此处生成，由设备拥有者在该设备的“管理本机 Computer worker”或 CLI 消费并指定目录、工具上限，成功后刷新列表即可使用，不需重启 harness server。远端可以撤销，本机附着仍按现有规则自动批准且不可从附着 API 撤销。

新增项目先固定 harness server 连接与实例，再选择执行环境，默认本机。本机支持原有目录浏览、创建及受信系统目录窗口；远端填写该环境上的绝对路径，不访问本机浏览、创建或系统窗口。目录记忆按 harness 实例与环境隔离。等待批准与已撤销的环境不可选择；列表失败显示错误供重试，离线或提交失败保留目标与输入。切换环境、停用及关闭等待旧观察退出，迟到结果不能更新新环境。

界面的“执行设备”连接选择器仍然选择 harness server，模型配置、Session 与项目记录属于该服务；项目的“执行环境”再决定其工具和文件资源的位置。“管理本机 Computer worker”管理客户端服务所在设备，它与当前项目的环境选择独立。

## 生命周期与兼容

不改变现有声明、摘要、附着 epoch、worker owner、实例代次与 scope 退出证明。观察断开不表示工具停止；已接受操作只向原 worker 查回，未知副作用不自动重放，也不因离线切换到另一环境。应用正常关闭仍取消并等待所属 Run，独立 idle worker 继续运行。

旧非空 `ANYBOX_COMPUTER_UNIT` / `ANYBOX_COMPUTER_ATTACHMENT` 会在启动配置校验时报错并给出移除指引。程序化调用仍传旧 `computerUnit` 或 Projects 的 `defaultComputerAttachmentId` 也明确拒绝，避免 JavaScript 调用方静默落到本机默认。部署时删除旧配置，再为新项目明确选择远端环境；历史项目与 Run 已持久保存的绑定保持原样。删除旧默认配置不会把原远端项目重建成本机项目。

## 验证入口

- `tests/computer-environments.test.mjs`：只读投影、状态与敏感数据过滤。
- `tests/computer-worker-router.test.mjs`：本机与两个真实远端 worker、默认本机、既有远端绑定及重装配，列表不启动本机 worker。
- `tests/remote-harness-server.test.mjs`：正式路由、认证、客户端网关白名单。
- `tests/project-directories.test.mjs`、`tests/computer-workspaces.test.mjs`：环境内项目身份、跨平台绝对路径、固定工作区绑定与失败不回退。
- `tests/harness-client.test.mjs`、`tests/project-directory-client.test.mjs`、`tests/units-client.test.mjs`：捕获连接与环境、状态加载失败、路径隔离、远端不调用本机选择与关闭等待。

完整检查为根 `npm run check`。受控本机多 worker 测试不等同于真实跨机器网络、系统凭据或各操作系统目录窗口验收。

### 2026-11-11 验证记录

Linux x64、Node.js 24.16.0 上 `npm run check` 通过类型检查、构建与完整测试：2123 项测试，2102 项通过、21 项按既有条件跳过、0 失败；`git diff --check` 与受影响文档的相对链接检查通过。多环境行为测试使用本机与两个独立远端 worker，覆盖各自工具执行、重装配保留绑定、离线与取消恢复。原有进程清理测试在未修改 HEAD 基线上复现 Linux TERM trap 隐式退出码 143，测试命令改为显式 `exit 0` 后继续验证真实退出屏障，运行时代码不变。

隔离浏览器宿主使用临时数据库、目录与内存凭据，验证默认本机、在线远端路径登记、离线错误保留环境和路径、待批准项禁选、本机与远端同路径项目并存及可见环境标签，以及环境设置的连接状态。验证后关闭宿主并回收临时数据；未对正在运行的用户实例或真实跨机器设备执行部署，也未验收真实系统目录窗口。
