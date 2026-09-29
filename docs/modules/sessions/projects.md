# Projects 组件

[返回项目与会话模块](README.md) · [返回组件文档](../README.md)

Projects 为执行设备目录建立稳定项目身份，查询目录当前是否仍可用，并提供项目选择所需的有界目录浏览。浏览协议、DTO 和客户端流程见[项目目录选择](../../project-directory-picker.md)。它不持有会话、Run、模型或文件系统沙箱；项目路径只是工具运行的相对路径基准。

## 实现与装配

- 源码：[Projects 组件](../../../src/harness/project/component.ts)、[RuntimeInputs](../../../src/harness/contracts.ts)。
- 工厂：`createProjectComponent(inputs, options?)`；组件名：`harness-projects`；配置类型：`void`。
- `options.directoryHome` 由宿主通过 `HarnessOptions.projectDirectoryHome` 传入，生产默认是执行端系统用户主目录；未配置只禁用浏览，不影响旧接口。
- `inputs.now()` 和 `inputs.newId()` 由组合根注入，默认时间与 ID 生成不写死在领域动作里。
- 注入 [本地存储](../infrastructure/local-sqlite.md) 的 `local-storage`；提供 `harness.projects: ProjectPort`。
- `apply` 等待 `migrate('projects', migrations)` 后注册服务；当前迁移版本为 1。

## 数据与接口

`Project` 包含 `id`、规范化 `path`、`name`、`createdAt`、`available`。前四项是持久事实；available 在读取时使用 stat 计算，不持久缓存目录存活状态。名称初始为规范路径 basename，没有项目改名或删除接口。

| 方法 | 输入和结果 |
| --- | --- |
| `openProject(path)` | 只接受非空绝对目录路径；realpath 后按规范路径去重，返回 available=true 的项目 |
| `listProjects()` | 按 createdAt、id 排序返回所有项目，并并行检查每个目录当前可用性 |
| `getProject(id)` | 不存在返回 undefined；存在则重新检查目录 |
| `requireAvailable(id)` | 不存在抛 unknown project；不可用抛 `ProjectUnavailableError`，code 为 project-unavailable |

浏览服务还提供 `directoryBrowsingSupported`、`openDirectoryBrowse(owner,input,signal?)`、`readDirectoryPage(owner,browseId,page,signal?)` 与 `closeDirectoryBrowse(owner,browseId)`。open/page 返回 OwnedCall，close 幂等并等待实际退出；owner 由受信宿主提供。`onDirectoryBrowseRetired(listener)` 在实际清理后通知宿主移除认证归属跟踪，并返回取消订阅函数。预留和浏览不登记项目，所有 DTO 见[公开协议](../../project-directory-picker.md#api-v1-与公开-dto)。

Harness 门面提供登记、查询与浏览接口；`requireAvailable` 供 Session、Run 和工具的依赖校验使用。

## 业务流程与持久归属

openProject 首先 realpath 解析目录别名，并确认目标是目录；文件、已删除路径或权限导致不可达的路径被拒绝。随后在事务内查询 `harness_projects.path`，已存在则复用同一 ID，否则插入新 ID、目录名和时间。数据库的 UNIQUE(path) 保证规范路径身份唯一，打开同一目录的不同路径表示不会创建多个项目。

`harness_projects` 表由本组件的 projects 迁移域拥有；SQLite 连接归存储组件。本组件不打开额外连接，不建立每项目数据库或 Nya Context。目录失效只影响 available 和新操作准入，不删除项目记录及其 Session 历史。

## 取消、清理与限制

原有项目登记与查询接口没有独立取消信号；组件跟踪每个已接收 Promise。Effect 先设置 accepting=false，再等待所有 pending 操作完成；后续请求以 project service is closing 拒绝，已接收的目录校验和事务不会被提前丢弃。

目录浏览的内部提供方独占句柄、最多 16 个会话、2 个扫描和空闲 60 秒回收计时器。每页最多 100 项、扫描 1,000 项或达到 200 ms 软预算。Effect 停止准入与计时器，取消并等待全部浏览及句柄清理；清理失败必须报告。会话只存在内存，关闭后的标识不能重新创建资源，不修改 projects 迁移域。

浏览只处理当前层，允许有效目录链接并在进入后 realpath；断链、链接循环和权限不足返回固定原因，不继承 Project Files 的链接禁用或目录排除规则。

可用性是检查时的状态，不保证未来文件操作一定成功；Bash 与 Apply Patch 仍负责各自执行时检查。项目路径不是访问控制或路径沙箱，不能把选择项目当作权限限制。服务没有遗留项目格式导入逻辑，迁移由通用存储按已登记版本执行。

## 验证

[目录浏览测试](../../../tests/project-directories.test.mjs) 验证分页、取消和句柄清理；[多项目测试](../../../tests/multi-project.test.mjs) 验证规范目录身份、项目间 Session 隔离、并发 Run、重启后的历史以及目录不可用时历史可读；[Session 测试](../../../tests/session.test.mjs) 验证创建期间的项目检查会被关闭等待；[本地 SQLite 测试](../../../tests/local-sqlite.test.mjs) 验证底层独占存储与迁移。统一执行 `npm run check`。
