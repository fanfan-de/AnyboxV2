# Claude Agent

[组件清单](../README.md) · [设计](../../claude-agent-design.md)

Claude Agent（稳定 ID `claude-agent`）原生消费 `@anthropic-ai/claude-agent-sdk`，驱动执行设备上用户自己安装并登录的 Claude 环境。执行端打开该应用时在根上安装四个组件，客户端打开时安装一个网关；两侧共享 `definition.ts` 的纯元数据，客户端不加载执行端代码。连接库是宿主常驻的 [Client Connections](../web/client-connections.md)，本应用只读设备列表并按自己的白名单转发。

| 组件 | 职责 |
| --- | --- |
| [Store](store.md) | 线程、Run、审批的索引；迁移域 `claude-agent` v1；重启时把遗留 Run 标为 interrupted |
| [SDK 适配器](sdk.md) | 唯一接触 SDK 的组件：解析 `claude` 可执行文件、按 Run 启动进程组、翻译帧、经子进程读取转录 |
| [Runs](runs.md) | 一线程一 Run 的准入、取消与等待退出、审批桥接、有界实时投影、停止保护 |
| [HTTP](http.md) | `/api/v1/apps/claude-agent` 业务路由、白名单 DTO 与有界 SSE |
| [Client Gateway](client-gateway.md) | 客户端 `/api/client/v1/apps/claude-agent`：设备列表、本机身份、到所选设备的白名单转发 |

`core/view.ts` 的版本化 DTO、`core/domain.ts` 的校验、`core/events.ts` 的实时视图 fold 与 `web/` 的浏览器控制器都是所属组件使用的纯函数或视图，不是独立组件。

## 当前持久格式

| 边界 | 当前写入 | 读取与兼容 |
| --- | --- | --- |
| 索引迁移域 | `claude-agent` v1：`claude_agent_threads`、`claude_agent_runs`（thread + idempotency_key 唯一）、`claude_agent_approvals` | 使用既有业务连接；转录不复制，经 SDK 读取 Claude 环境的会话文件 |
| HTTP / SSE DTO | `schemaVersion: 1` 的 `ThreadView`、`RunView`、`ApprovalView`、`RunLiveView`、`RunEventView`、`HistoryMessageView` | 白名单投影；SDK 对象、凭据与进程句柄不进入 |
| SDK | `@anthropic-ai/claude-agent-sdk` 精确 0.3.301 | 适配器消费 `system/init`、`stream_event`、`assistant`、`user`、`result` 等帧，未知帧忽略 |

## 测试

`tests/claude-agent-executable.test.mjs`、`claude-agent-projection.test.mjs`、`claude-agent-runs.test.mjs`、`claude-agent-http.test.mjs`、`claude-agent-client.test.mjs`、`claude-agent-web.test.mjs` 使用内存 SDK 替身；`claude-agent-sdk.test.mjs` 由 `ANYBOX_CLAUDE_AGENT_TESTS=1` 门控，使用本机真实 `claude`。边界由 `application-boundaries.test.mjs` 固定。统一入口 `npm run check`。
