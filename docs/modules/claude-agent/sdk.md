# Claude Agent SDK 适配器组件

[Claude Agent 模块](README.md) · [设计](../../claude-agent-design.md)

## 职责与入口

唯一接触 `@anthropic-ai/claude-agent-sdk` 的组件。启动时解析用户自己的 `claude` 可执行文件；按 Run 启动一个流式输入模式的 `query()` 子进程，把 SDK 帧翻译成应用自己的事件，把 `canUseTool` 桥接为审批请求；经子进程读取会话转录。拥有它启动的全部进程。

| 项目 | 定义 |
| --- | --- |
| 源码 | [core/sdk/adapter.ts](../../../src/applications/claude-agent/core/sdk/adapter.ts)；纯函数 [executable.ts](../../../src/applications/claude-agent/core/sdk/executable.ts)、[translate.ts](../../../src/applications/claude-agent/core/sdk/translate.ts)；子进程入口 [history-worker.ts](../../../src/applications/claude-agent/core/sdk/history-worker.ts) |
| 工厂 / Nya 名称 | `createClaudeAgentSdkComponent(options?)` / `claude-agent-sdk` |
| 服务 | `claude-agent.sdk: ClaudeAgentSdkPort`（契约在 [port.ts](../../../src/applications/claude-agent/core/sdk/port.ts)，不含 SDK 类型） |
| `inject` | 无 |

## 配置与接口

| 选项 | 默认值 | 含义 |
| --- | --- | --- |
| `executableOverride` | `ANYBOX_CLAUDE_AGENT_BINARY` | 显式可执行文件路径；存在即跳过 PATH 解析 |
| `env` / `platform` / `homeDirectory` / `isFile` | 进程实际值 | 解析输入，可替换以便测试 |
| `historyWorker` | 同目录 `history-worker.js` | 转录子进程入口 |
| `historyTimeoutMs` / `historyLimitBytes` | 30 秒 / 8 MiB | 转录读取上限 |
| `hostInstructions` | 一句说明宿主是 Anybox | `systemPrompt` preset 的 append |

`environment()` 返回 `EnvironmentView`（平台、路径与来源 `override|path|fallback`，或 `claude-binary-missing` / `claude-binary-shim` 错误与可展示文案）。`openRun({ cwd, prompt, resume, model?, effort? }, { onEvent, canUseTool })` 同步返回句柄：`result` 为业务结果（收到 `result` 帧，或迭代器异常结束的失败），`done` 在进程实际退出后才结算，`interrupt()` 发送优雅中断，`close()` 终止进程；两者都不会 reject。`readSessionMessages(sessionId, dir, signal?)` 返回 `HistoryMessageView[]`。

## 功能流程

解析顺序：覆盖 → PATH（Windows 结合 PATHEXT，`.cmd/.bat/.ps1` 垫片换成同目录包内的 `bin/claude.exe` 或 `cli.js`）→ Unix `~/.local/bin/claude`。缺失不让组件失败，而是记录到 `environment()`，`openRun` 以同样的错误码同步拒绝。

固定 SDK 选项：`pathToClaudeCodeExecutable`、`cwd`、`resume`（线程已有 session 时）、`systemPrompt` preset + append、`permissionMode: 'default'`、`allowedTools: []`、`includePartialMessages: true`、`thinking: { type: 'adaptive', display: 'summarized' }`、`env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'anybox' }`、`abortController`、`stderr` 回调、可选 `model`/`effort`。不设置 `settingSources`、`strictMcpConfig`、`persistSession`、`sessionStore`，不覆盖 `HOME`。

prompt 是只 yield 一条用户消息的异步迭代器，收到 `result` 后结束输入，SDK 关闭 stdin，CLI 自行退出。Unix 上 `spawnClaudeCodeProcess` 以 `detached: true` 启动进程组，接管 stderr 尾部（8 KiB），子进程退出时对进程组 SIGKILL 并发出 `exit` 事件；迭代器结束 10 秒后仍未退出也 SIGKILL。Windows 交给 SDK spawn，`done` 以迭代器结束近似。

`translate.ts`：`system/init`→`init`（带 session id、模型、cwd、权限模式、版本）、`stream_event`→`message-start`/`block-start`/`text-delta`/`thinking-delta`/`block-stop`（只在 `message_start` 之后有效）、`assistant`→完整块、`user` 的 `tool_result`→`tool-result`、`status`、`compact_boundary`、`permission_denied`/`api_retry`/`rate_limit_event`→`notice`、`result`→`RunResultView`；子 Agent 帧（`parent_tool_use_id` 非空）与未知帧忽略。`canUseTool` 把 `toolUseID`、`title/description/decisionReason`、`defaultToNo`、`suggestions` 与 `AskUserQuestion` 的问题投影为 `SdkPermissionRequest`；决定转回 `PermissionResult`（`allow` 带 `updatedInput`，会话级允许附 destination 为 `session` 的 `updatedPermissions`，问题类以 `updatedInput.answers` 回答）。

转录读取用 `process.execPath` 启动 `history-worker.js`（`ELECTRON_RUN_AS_NODE=1`，与本机 computer worker 一致），子进程调用 `getSessionMessages(sessionId, { dir })` 输出 JSON，父进程按上限收集后投影为主线程的用户/助手消息。

## 执行、取消与清理

每个 Run 句柄与 worker 登记在组件内；Effect 对全部句柄 `close()`、对 worker SIGKILL，然后等待所有 `done` 与退出。取消语义由 [Runs](runs.md) 编排：先 `interrupt()`，超时才 `close()`。

## 失败与兼容

`agent-exited`（无结果即退出，附 stderr 尾部）、`agent-failure`（SDK 抛错）、`cancelled`（中止）、`history-unavailable`（子进程失败或解析失败，附 stderr 尾部）、`history-too-large`（413）、`invalid-input`（非 UUID session id）。登录失败等 CLI 错误以 `result` 帧（`is_error`）或 stderr 文本原样进入 Run 错误，界面直接显示。SDK 精确固定 0.3.301，升级需重新核对帧与选项。

## 测试

纯函数：[claude-agent-executable.test.mjs](../../../tests/claude-agent-executable.test.mjs)、[claude-agent-projection.test.mjs](../../../tests/claude-agent-projection.test.mjs)。真实二进制：[claude-agent-sdk.test.mjs](../../../tests/claude-agent-sdk.test.mjs)（`ANYBOX_CLAUDE_AGENT_TESTS=1`），覆盖完整一轮、session 固定、转录读取、resume 与 interrupt、以及经客户端网关的端到端。
