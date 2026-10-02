# 项目与会话模块

[返回组件文档](../README.md)

这个模块提供工作目录身份及其会话事实：Projects 负责目录身份、可用性、项目选择时的目录浏览与子目录创建，Project Files 负责目录树、项目文本搜索、预览、发送快照及保留，Session 负责会话、归档状态、不可变对话树、Run 记录、事件及原生恢复链。它们使用同一个应用业务存储服务，但各自登记自己的迁移和领域约束。

| 组件 | Nya 名称 | 服务 |
| --- | --- | --- |
| [Projects](projects.md) | `harness-projects` | `harness.projects` |
| [Project Files](project-files.md) | `harness-project-files` | `harness.project-files` |
| [Session](session.md) | `harness-sessions` | `harness.sessions`、`harness.session-runs` |

## 依赖与职责

Projects 注入 [本地 SQLite](../infrastructure/local-sqlite.md)；Project Files 注入本地 SQLite 和 Projects，独占文件搜索、读取和文本快照；Session 注入本地 SQLite、Projects、Image Assets 和 Project Files。组件都安装在应用根 Context，项目仅是数据归属边界，不创建项目 Context。Session 的内部 SQLite records 实现没有独立组件和独立数据库连接；数据库排他所有权归存储组件，领域表与迁移归这里。

外部使用 Harness 的 `openProject`、`createSession`、节点及 Run 查询方法。[执行模块](../execution/README.md) 使用 Session 的受信执行记录端口进行准入、操作观察和结算；RunRuntime 独占运行期资源。服务名称用于依赖声明，不构成授权边界。

## 数据路径

1. `openProject(absolutePath)` 将可用目录解析为 realpath，按规范路径返回稳定项目身份。
2. `createSession(projectId, agentId, modelId?)` 验证项目和启动时 Agent 定义，创建 `native-local-v1` Session；未选定模型时允许 modelId 为 null。
3. 图片经 Session 导入，文件在发送时经 Session 准备不可变快照。Run 准备只读取快照；第一次接受事务固定 Session 协议、初始 instruction/context 和工具声明，同事务保留附件。Run 指定明确可空父节点；同父节点可同时启动多个 Run。
4. 操作 intent 在外部调用前保存，observation 在资源实际退出后保存。取消不抹去已经发生的工具事实。
5. 成功结算事务创建不可变节点、原生上下文链节和结果引用；失败、取消与 interrupted 不创建可继续节点。恢复仅沿选中的成功父路径，界面当前节点不构成服务端全局 head。
6. `archiveSession` 在无活动 Run 时幂等归档，`restoreSession` 恢复列表可见性；默认项目列表排除归档会话，跨项目查询使用 `listArchivedSessions`。归档不释放历史附件，也不解除旧会话只读规则。

## 恢复与关闭

业务库重新打开时，Session 将仍处于 running/cancelling 的 Run 结算为 interrupted，并记录中断事件；不会重放工具或网络副作用。项目目录暂时不可用不隐藏既有历史，但创建 Session 和启动新 Run 必须再次确认目录可用。

组件 Effect 停止新调用并等待已接收的数据操作；Nya 按实际依赖关闭执行消费者后，再释放 Session、Projects 和存储。旧 `dialogue-v1` Session、旧事件和节点保留只读兼容，不继续执行旧路径。

[多项目测试](../../../tests/multi-project.test.mjs)、[文件快照测试](../../../tests/project-files.test.mjs)、[Session 生命周期测试](../../../tests/session.test.mjs)、[会话树测试](../../../tests/conversation-tree.test.mjs)、[迁移测试](../../../tests/conversation-migration.test.mjs) 和[原生记录测试](../../../tests/native-session.test.mjs) 验证这些行为，包括归档竞争、关闭等待和旧数据只读。统一执行 `npm run check`。
