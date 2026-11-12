# Claude Agent

[界面审计](../../claude-agent-ui-audit.md) · [SDK API 审计](../../claude-agent-sdk-api-audit-2026-10-18.md) · [组件清单](../README.md) · [设计](../../claude-agent-design.md) · [当前架构图](../../architecture/claude-agent-architecture-2026-10-18.md)

Claude Agent（稳定 ID `claude-agent`）原生消费 `@anthropic-ai/claude-agent-sdk`，驱动执行设备上用户自己安装并登录的 Claude 环境。执行端打开该应用时在根上安装四个业务组件，客户端打开时安装私有连接组件和网关；两侧共享 `definition.ts` 的纯元数据，客户端不加载执行端代码。正式安装的同包客户端和本机执行端通过宿主交付的私有角色通道，由应用自己的[本机执行适配](local-execution.md)衔接，无须设备连接、访问令牌或 Vault 配对。本应用独占自己的[远端连接组件](client-connections.md)、凭据命名空间、转发与连接管理 UI，不依赖 Harness 的连接或界面。旧 distribution 完整默认发行仍保留兼容配对，尚未整体迁入此受管路径。

`server-runtime.ts` 的 `installClaudeAgentBusiness` / `createClaudeAgentRuntime` 提供无宿主活动管理依赖的相同四组件装配；Anybox 的注册适配另加忙碌停止保护。独立入口 `createClaudeAgentServer` 在唯一根安装既有 SQLite、应用自己的访问组件和相同业务装配，并自行持有 HTTP 监听器、认证、流式与信号退出。`anybox-claude-agent` 提供 `serve/init/recover-access/new-identity`，不要求安装 Harness、host 或 distribution，见[独立业务服务](../../application-standalone-services.md)。

| 组件 | 职责 |
| --- | --- |
| [Store](store.md) | 线程、Run、审批的索引；迁移域 `claude-agent` v4（标题来源、实际模型、权限模式及会话授权）；重启时把遗留 Run 标为 interrupted |
| [SDK 适配器](sdk.md) | 唯一接触 SDK 的组件：解析 `claude` 可执行文件、按 Run 启动进程组、翻译帧、经子进程读取转录、会话目录与会话标题 |
| [Runs](runs.md) | 一线程一 Run 的准入、取消与等待退出、审批桥接、有界实时投影、线程标题、最近项目与目录浏览、停止保护 |
| [HTTP](http.md) | `/api/v1/apps/claude-agent` 业务路由、白名单 DTO 与有界 SSE |
| [独立服务访问管理](access.md) | 应用自己拥有的实例、拥有者令牌与撤销等待，兼容既有 host-access v2 数据 |
| [独立服务监听](listener.md) | 应用自己拥有的 HTTP socket、认证分派、请求/SSE 排空与认证依赖撤销重绑 |
| [本机执行](local-execution.md) | 同包角色通道的私有协议、内存 HTTP/SSE 适配与实际退出等待 |
| [Client Connections](client-connections.md) | 私有远端设备连接、凭据、旧发行配对兼容与旧共享数据只读迁入 |
| [Client Gateway](client-gateway.md) | 客户端 `/api/client/v1/apps/claude-agent`：独立本机目标、远端设备列表及到所选目标的白名单转发 |

`core/view.ts` 的版本化 DTO、`core/domain.ts` 的校验与提示词标题、`core/events.ts` 的实时视图 fold、`core/projects.ts` 的最近项目合并、`core/directories.ts` 的目录浏览，以及 `web/` 的浏览器控制器与项目面板都是所属组件使用的纯函数或视图，不是独立组件。

## 界面语言试点

语言入口位于宿主的 Anybox 菜单；应用通过可选 [`ApplicationWebContext.locale`](../../../packages/application-api/src/web.ts) 读取 `{ preferredLocale, revision }` 并订阅变化，端口不写宿主设置。宿主提供 `system | zh-CN | en` 选择及当前 origin 的 `localStorage: anybox.preferences.locale.v1` 持久化；应用只接收解析后的语言建议，自行选择实际语言。没有来源、来源读取/订阅失败或不支持建议值时，Claude 仍使用自己的简体中文默认值或最后已接受语言，不依赖宿主翻译器、后台语言服务或另一应用。

[`web/i18n.ts`](../../../packages/app-claude-agent/src/web/i18n.ts) 在每次 mount 创建独立 i18next runtime，词条由 [`web/i18n-resources.ts`](../../../packages/app-claude-agent/src/web/i18n-resources.ts) 静态提供。运行实例只更新显式登记的文本/属性绑定与本地格式化；应用 dispose 注销来源、清理绑定，不通过重新挂载或业务调用切换语言。容器标注自己的实际 `lang`，原文内容保留；词条与运行依赖进入应用自己的资源闭包，不要求宿主共享 i18next 或引入新的 Nya 根/组件。

当前迁移会话列表与主界面、草稿及发送提示、基础模型/effort 选择、项目选择与应用内目录浏览、权限模式选择与实时审批操作、消息和工具结果外围标签、队列/附件提示，以及日期和基础用量/美元费用格式。用户提示词、项目与会话自定义名称、模型回答、审批说明和 SDK/工具原文不自动翻译；Prompt、工具声明、原生记录和历史不随界面语言改变。语言状态按本次呈现实例持有，两个浏览器不会通过执行端的全局 locale 相互覆盖。

完整连接管理、账号与额度、工作区详情、技能/工具能力和会话授权管理尚未迁移，相关面板明确标为 `lang="zh-CN"`。宿主包管理面板、Anybox Harness、Electron 原生菜单和弹窗也不属于本次应用试点，不能据此声称全产品中英文已完成。词条归属与只读偏好是受信代码的职责契约，不构成同源应用间的权限隔离；完整边界见[应用接入说明](../../application-development.md#界面语言与应用归属)。

[`packages/app-claude-agent/tests/i18n.test.mjs`](../../../packages/app-claude-agent/tests/i18n.test.mjs) 使用内存语言来源与最小 DOM，覆盖实例独立、词条/参数完整性、复数、来源失败、原文和币种保留，以及主界面与隐藏挂载在草稿、审批、在途 Run 观察中的原位更新及 dispose 清理。该测试不运行浏览器排版引擎。真实浏览器可使用 [`tests/helpers/claude-agent-browser-host.mjs`](../../../tests/helpers/claude-agent-browser-host.mjs) 的内存样本复验；它使用真实构建资源，但不启动真实 Claude 或访问业务数据，不能替代系统凭据、原生桌面或其他平台验收。

## 当前持久格式

| 边界 | 当前写入 | 读取与兼容 |
| --- | --- | --- |
| 索引迁移域 | `claude-agent` v4：`claude_agent_threads`（含 `title_source` 与 `permission_mode`）、`claude_agent_runs`（含 `resolved_model` 与 `permission_mode`，thread + idempotency_key 唯一）、`claude_agent_approvals` | 使用既有业务连接；v1 库升级时标题不是目录名的线程标为 user 来源；转录不复制，经 SDK 读取 Claude 环境的会话文件 |
| HTTP / SSE DTO | `schemaVersion: 1` 的 `ThreadView`、`RunView`、`ApprovalView`、`RunLiveView`、`RunEventView`、`HistoryMessageView`、`RecentProjectsView`、`DirectoryListingView`、`RecentModelsView`、`AvailableModelsView` | 白名单投影，只做追加；SDK 对象、凭据与进程句柄不进入 |
| SDK | `@anthropic-ai/claude-agent-sdk` 精确 0.3.301 | 适配器消费 `system/init`、`stream_event`、`assistant`、`user`、`result` 等帧，未知帧忽略 |

## 测试

`packages/app-claude-agent/tests/claude-agent-executable.test.mjs`、`claude-agent-projection.test.mjs`、`claude-agent-projects.test.mjs`、`claude-agent-runs.test.mjs`、`claude-agent-http.test.mjs`、`claude-agent-client.test.mjs`、`claude-agent-web.test.mjs` 使用内存 SDK 替身与临时目录；`claude-agent-reconnect.test.mjs` 与 `claude-agent-project-panel.test.mjs` 挂载实际浏览器模块验证断流补读、线程隔离及目录窗口取消。`claude-agent-sdk.test.mjs` 由 `ANYBOX_CLAUDE_AGENT_TESTS=1` 门控，使用本机真实 `claude`。本机适配由 `packages/app-claude-agent/tests/local-execution.test.mjs`、`packages/host/tests/application-channel.test.mjs` 与 `tests/claude-agent-local-client.test.mjs` 验证；边界由 `application-boundaries.test.mjs` 固定。统一入口 `npm run check`。

权限、会话详情与技能/MCP/子 Agent 的界面及实际范围见 [使用及验收记录](../../claude-agent-permissions-and-capabilities.md)。

- [0.1.6：本次会话始终允许，跨消息复用与撤销](../../claude-agent-session-permissions.md)
