# 应用客户端业务独立归属

[文档首页](README.md) · [应用包设计](application-packages-design.md) · [应用接入](application-development.md)

2026-10-17 决策：宿主与应用之间不设置共享业务层。设备连接、业务访问凭据、本机配对、请求转发与连接管理界面由各应用完整拥有，不因为两个 Agent 当前行为相似而抽成共同业务包。允许应用内的实现重复；应用可以独立改变认证、连接及转发策略，无须协调另一应用。

SQL、系统凭据库、Nya 与原生目录窗口仍是基础库或平台适配，不拥有跨应用的设备连接状态。宿主只负责应用接入、界面承载、控制、认证分派和退出协调；`application-api` 不提供执行设备连接能力。正式安装的同包角色可使用有界不透明 JSON 私有通道；宿主固定对端身份、传播取消并等待 handler 实际退出，消息协议与业务仍归应用。

## 当前实现

| 应用 | 组件与服务 | 私有持久记录 | 系统凭据命名空间 |
| --- | --- | --- | --- |
| Anybox Harness | `client-connections` / `client.connections` | `harness_client_*`，迁移域 `agent-client-connections` v2 | `<旧 namespace>.agent`，默认 `anybox.client.agent` |
| Claude Agent | `claude-agent-client-connections` / `claude-agent.connections` | `claude_agent_client_*`，迁移域 `claude-agent-client-connections` v2 | `<旧 namespace>.claude-agent`，默认 `anybox.client.claude-agent` |

各自 `src/client/connections.ts`、`connection-proxy.ts`、`connection-failure.ts` 是应用私有实现，不互相导入，也不由宿主或 distribution 安装。客户端应用打开时在所属进程的唯一 Nya 根装配连接组件和网关；停止时取消并等待自己的网络、配对及凭据操作实际退出。停止一个应用不影响另一个的连接、凭据或网络请求；已保存数据保留。两个应用继续复用同一 SQLite 提供方连接，但各自拥有表和迁移域，不增加数据库连接或应用 Context。

`@anybox/execution-connections` 已移除。distribution 只选择应用注册与原生目录适配，向各应用传入所需平台参数。两个应用不再声明 `execution.connections` 公共能力。客户端关闭不取消执行设备上已接受的 Run。

Harness 保持既有连接管理路由与界面。Claude Agent 增加本应用的“管理连接”，其 `/api/client/v1/apps/claude-agent/connections` 提供读取与保存，`/:id/check|delete|pick` 提供检查、删除与目录选择，`/local/retry` 只由显式操作调用。界面不要求安装或打开 Harness；关闭和停用立即清空令牌草稿与本代 DOM，再等待已登记请求退出，迟到请求不能修改新一代界面。

正式安装的 Claude Agent 本机客户端/执行端通过应用内部协议使用同包角色通道；本机目标独立于 connections，不经过设备令牌、配对或 Vault，见[本机执行组件](modules/claude-agent/local-execution.md)。远端连接保留上述私有存储和凭据。旧 distribution 完整默认发行仍集中管理自己启动的本机执行服务进程，但兼容配对凭据按应用分别发行和回收；该旧路径尚未整体迁入 D3。Harness 保留旧 managed owner `anybox.desktop.local`，Claude Agent 使用 `anybox.desktop.local.claude-agent`。一个应用的 reconcile 不撤销另一个应用的令牌。自动观察不启动执行服务。

## 旧数据迁入

原 `client_connections`、`client_local_connection` 与 `client_credential_intents` 停止写入，旧 `client-connections` 账本及系统凭据保留。各应用首次打开时，在自己的迁移事务中复制旧连接 ID、名称、地址、instanceId、revision 与本机归属，之后只写自己的表。迁移按应用执行一次；删除的连接不会在重启后重新导入。

元数据迁移和查询不访问系统凭据。首次需要旧令牌时，从旧 namespace 只读获取，先登记本应用的凭据写入意图，再写入私有 namespace 并提交新引用。失败保留来源和可重试记录，不把秘密写进 SQLite。旧共享条目不自动删除，否则另一个尚未打开的应用可能失去迁入来源。完成复制后，应用不再依赖旧条目；各应用后续修改、删除或换 Key 互不影响。凭据不可用时仍可查询非秘密元数据。

## 验证

- `tests/application-client-connections.test.mjs`：按应用装配与释放、独立连接/凭据、旧格式迁入与只迁入一次、取消等待实际退出、另一应用请求不受影响、桌面 managed owner 隔离。
- 两个应用的 `tests/client-connections.test.mjs`：独立持久化、修订及凭据引用、请求绑定校验。
- `tests/claude-agent-client.test.mjs`：Harness 未打开时由 Claude Agent 独立管理连接并执行远端业务。
- `tests/claude-agent-connections-view.test.mjs`：本应用连接管理、令牌清理、关闭等待与迟到结果隔离。
- `tests/remote-harness-server.test.mjs`、`tests/desktop-local-pairing.test.mjs`：原有转发、配对、实例固定及实际退出语义。

2026-10-17 最终 `npm run check` 通过：1509 项测试，1495 通过、14 跳过、0 失败。本变更不代表 host-only 发行、应用下载安装、原生凭据或跨平台成品验收已经完成。
