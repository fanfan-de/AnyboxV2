# Workspaces 组件

[返回 Computer 模块](README.md) · [返回组件手册](../README.md)

## 职责、工厂和依赖

`createWorkspacesComponent(options?)` 安装根上的 `harness-workspaces`，提供 `harness.workspaces: WorkspacesPort`。组件 inject 本轮 `harness.projects` 和 `local-storage`，拥有项目到稳定工作区的映射、逻辑 scope reservation 及确切执行 binding。Projects 不反向依赖它；本阶段没有产物提供方或独立准备组件。

源码：[组件](../../../src/applications/harness/core/workspace/component.ts)、[端口](../../../src/applications/harness/core/workspace/port.ts)、[领域值与校验](../../../src/applications/harness/core/workspace/domain.ts)。调用者为 [Computer Operations](computer-operations.md)；项目身份仍归 [Projects](../sessions/projects.md)。

`options` 可提供 `now()`、`newId()` 和受信的 `localProviderId`。默认提供方为 `local`；替代提供方仍须在本机解析目录，不能通过改名获得远端准备能力。组件没有新增环境变量、浏览器设置、独立数据库连接或目录。

## 接口与本机映射

| 方法 | 当前行为 |
| --- | --- |
| `get(workspaceId)` / `getForProject(projectId)` | 查询已经保存的工作区，不激活实例、不检查目录 |
| `getBinding(reservationId)` | 读取固定 binding，保留已释放 scope 的历史事实 |
| `reserveIn(tx,{reservationId,scopeId,projectId})` | 同步读取 Projects 的稳定身份，惰性建立 pinned-local 映射及 reservation；不准备文件 |
| `prepare({reservationId,instance},signal?)` | 在事务外检查固定本机的原项目目录，返回本组件代内的准备凭证与确切实例信息 |
| `bindIn(tx,{reservationId,prepared})` | 原子提交准备凭证对应的 binding；同一事实幂等，冲突或伪造凭证拒绝 |
| `requireBindingIn(reader,ref)` | 同步复核 scope 尚未释放、实例 ID/代次与 workspace epoch，不重新解析项目路径 |
| `releaseIn(tx,reservationId,scopeId)` | 所属 scope 幂等释放 reservation；调用者须已等待实际 scope 退出 |

旧项目无需重写或导入；首次计算工具接纳时按原 projectId 创建稳定 workspaceId。当前 mode 只有 pinned-local，revision 固定为 0，workspaceEpoch 初始为 1。workspace 身份是独立 ID，绝对路径只用于固定本机映射和 binding。

prepare 通过 Projects.requireAvailable 确认原目录，接受 ready 的本机实例，将 computerId、computerInstanceId、instanceGeneration、workspaceEpoch、revision、path 和 preparedAt 固定在 binding。已绑定 scope 不允许通过再次 prepare 偷换实例或路径。同一项目的不同 Run 可共享原目录，保持原有并发语义；尚未实现 portable-managed 的排他写租约。

## 持久化与事务归属

组件在 apply 登记 `workspaces` 迁移域 v1，拥有 `harness_workspaces`、`harness_workspace_reservations` 和 `harness_workspace_bindings`。Projects 的表通过其 `getIn` 查询，不由 Workspaces 直接读写。存储组件继续独占唯一业务 SQLite 连接。

reserveIn 与工具意图、待执行声明及逻辑 computer 需求在同一业务事务提交。准备在事务外进行；首次 bindIn 与 Computers.pinIn 在同事务固定实例与工作区归属。scope 长进程还在运行时引用不会释放；Computer Operations 观察 scope 实际退出后，同事务 releaseIn 与 releasePinIn。同步端口不等待网络、目录检查或进程退出。

准备凭证是本组件代内的受信不可变对象，不进入历史。已提交 binding 在组件重装配后可查询，但该事实不证明任何旧进程已恢复。释放记录不删除映射或 binding，也不能以相同 reservationId 重新建立活跃归属。

## 取消、关闭和失败边界

组件 apply 完成迁移后返回。prepare 返回 OwnedCall，取消会阻止后续 binding 准备；若目录查询已开始，done 仍等待它实际退出。Effect 停止新准入，取消已接收准备，等待所有调用和数据库查询结束。本代关闭不删除持久映射、reservation 或 binding。

错误使用固定 WorkspaceError code，涵盖无效输入、未知映射、服务不可用、取消、reservation 冲突、已释放、binding 冲突和过期准备凭证。原项目目录失效仍通过 Projects 的不可用边界报告。工作区并非文件系统沙箱，也不承诺外部修改隔离、checkpoint、跨平台路径转换或目录迁移。

## 验证

[computer-workspaces.test.mjs](../../../tests/computer-workspaces.test.mjs) 验证惰性映射、旧 Projects 路径兼容、事务回滚、准备凭证、scope/实例代次/epoch 校验、共享本机目录、原子释放、重装配身份，以及取消和关闭等待目录检查真正退出。测试使用临时 SQLite 和受控本机依赖，避免 Unix Shell；完整验证入口为 `npm run check`。
