# 进程工具组件

[工具模块](README.md) · [模块导航](../README.md)

## 职责、工厂和服务

`@anybox/computer-tools/processes` 导出的 `createProcessToolsComponent(options?: ProcessOptions)` 安装根上的 `process-tools` 组件，提供 `tools.processes` / `ProcessToolsPort`，不注入应用服务。它持有每个调用方 scope 的管道进程组、stdin 写入顺序、增量输出、等待计时器和清理；不解释模型协议、Agent 或 Session。前台 Claude Code / DeepSeek Harness 命令和 Codex 的进程会话经来源适配后共用此资源边界。源码为 [process-component.ts](../../../packages/computer-tools/src/process-component.ts)。

`openScope({scopeId, workspacePath}): ProcessScope` 同步接管调用方的进程 scope。scopeId 是调用方提供的不透明非空身份；相同活跃 ID 重复打开会拒绝。workspacePath 必须是受信绝对路径，scope 全部进程复用此基准，不接收项目 ID 或查询 Projects。Harness 在独立 worker 适配中把该 scope 绑定到所属 Run。返回 scope 支持：

- `execute({command,workdir?,shell?,login?,yieldTimeMs?,maxOutputTokens?}): ToolCall<JsonValue>`，启动保留 stdin 的管道进程。
- `write({sessionId,chars?,yieldTimeMs?,maxOutputTokens?}): ToolCall<JsonValue>`，发送输入或查询增量输出。
- `foreground({command, timeoutMs?, maxOutputTokens?, workdir?}): OwnedCall<JsonValue>`，用于其他来源的前台命令适配。
- 幂等 `close(): OwnedCall<JsonValue>`，关闭准入，取消调用、终止进程组并等待实际退出。

支持 Windows 与 Unix 原生管道模式。Codex 在 Windows 默认 PowerShell 7，在 Unix 默认 Bash，可显式保存 `shell` 和 `login`；固定 Bash 前台契约仍使用 Bash，Windows 为 Git Bash/PortableGit，不启动 WSL。`packages/computer-tools/src/platform/` 的私有适配不注册 Nya 服务，Node 与可选 shell 运行时配置见[原生平台支持](../../native-platform-support.md)。PTY 和独立后台作业不受支持。项目路径为相对工作目录基准，并非文件系统沙箱；绝对 `workdir` 可以位于项目外。

## 配置和数据归属

| 配置 | 默认 | 含义 |
| --- | --- | --- |
| `timeoutMs` | 120000 | 启动后的进程执行期限 |
| `maxBufferedOutputBytes` | 131072 | 每进程未读取的合并输出字节上限 |
| `terminationGraceMs` | 5000 | Unix SIGTERM 后的 SIGKILL 宽限期；Windows 终止独占 Job |
| `maxProcessesPerScope` | 32 | 同一调用方 scope 同时存活的进程上限 |
| `shell` | 未设置 | 调用方固定的 runtime 目录或显式 Bash / PowerShell 路径 |

子进程仅继承平台 shell 白名单中的路径、用户目录、临时目录、语言及必要 Windows 系统变量，不带模型 Key 或应用配置。stdout/stderr 经独立 UTF-8 解码器按观察到达顺序合并，缓冲及返回输出均在完整字符边界截断。stdin 始终有错误监听，写入串行；前台模式关闭 stdin，Codex 会话保留它供后续输入。

进程 ID 在组件代内单调分配，查找还必须属于当前调用方 scope。实际 ManagedProcess、流、缓冲和运行句柄仅存在内存中；持久观察中的 `session_id` 不是恢复凭证，不能跨 scope 读取、重启恢复或自动重放；这里的进程 session 与应用的 Session 无关。

## 执行、取消与清理

`execute` 在所选 `yieldTimeMs` 或进程退出时返回；仍存活或还有未取输出时返回 `session_id`。`write` 发送可选字符，或以空字符查询新输出。来源纯适配 `adaptProcessToolCall` 在进入资源组件前把 `codex_exec_command` / `codex_write_stdin` 和前台来源参数映射到这些中立接口，原模型调用名、参数和输出字段保持兼容。结果包含 `output`、`exit_code`、`signal`、`wall_time_seconds`、`truncated` 及可选 `session_id` / `timed_out` / `error`；非零退出和超时后的真实退出是可观察业务结果。

每次工具调用的 `done` 等待的是该次启动、输出观察和取消清理，提前返回的进程由 scope 继续持有。取消工具调用会终止关联进程组，并等待其实际退出。在同步接纳之后、实际启动之前取消的调用不会再启动命令。

scope 关闭和 Nya Effect 卸载先阻止新调用，再取消所有已接收调用，通过本包受管进程后端终止存活树：Unix SIGTERM 后升级 SIGKILL，Windows 终止独占 Job，最后等待树、管道和调用退出。shell 已退出的遗留子进程也会清理，包括重定向了输出的子进程。关闭业务结果保存全部进程的实际退出、剩余输出、截断、超时和终止事实；无法确认清理时，结果含 `cleanup: failed`，`done` 以 `cleanup-failure` 拒绝。正常 Run 结束调用这个入口属于资源清理，不等于用户取消 Run。

终止请求可能与进程正常退出竞争，最终以监督器确认整棵树、管道和清理确实退出为依据；Windows helper 自身死亡时即使 Job 清理了树，缺少回执仍报告失败。进程 scope 由独立 worker 的内部执行适配器持有；computer scope 等它实际退出后，才原子释放实例 pin 与工作区 reservation。RunRuntime 等待 computer scope 的 `done` 后持久化清理观察并结算；失败不得生成成功节点。应用关闭通过持久 Run 控制等待所属 scope；停止 worker 服务等待此组件的全部 scope，并聚合清理错误。

macOS 退出中的进程组可暂时对信号或存活探测返回 `EPERM`。后端继续把它视为未退出，只有随后取得 `ESRCH` 并等到输出排空，才报告成功；原有清理期限和未知退出失败保持不变。失败 cause 仅包含固定内部阶段，便于区分原生失败、协议帧不完整与缺失退出回执，不包含命令或路径。

## 来源契约、适配与选择

工具包 `/contracts` 入口是纯内置数据与校验器，`/adapters` 负责来源参数转换；它们不导入资源组件或 Node。Harness 的 `core/tool/catalog.ts` 仅保留产品默认选择和历史快照策略。目录不是额外 Nya 组件，不支持运行期插件注册。公开目录含 17 个来源工具契约及两个既有 Anybox 契约；来源标签、固定前缀调用名、稳定工具 ID、版本、声明、适配范围和依赖均显式保存。推荐默认是 Codex 四个工具及 Claude Code Read / Write / Edit / Glob / Grep，共九项。计划与待办三项契约已退役，仅保留旧 Session 继续执行和恢复所需的定义与校验。

`createToolSelection()` 只解析当前可选工具，不静默增加工具；Codex exec/write 必须成对选择。`validateToolSelection()` 验证版本、完整定义、唯一 ID/调用名及依赖，并接受已退役工具的完整旧快照；`validateLibraryArguments()` 校验来源参数 schema、受支持模式及兼容计划状态。保留的 `bash` / `apply_patch` 定义与原 `known-tools-v1` 完全一致，也可与新来源工具混选。新会话由注入环境提供完整工具快照，Session 保存环境身份、版本和工具定义；Computer 环境继续应用这些既有选择策略。已有会话沿用固定快照；执行绑定和运行句柄不进入该快照。

## 验证入口

`tests/managed-process-runtime.test.mjs` 验证原生 Job/进程组隔离、owner/helper 强杀和实际退出，`tests/native-tool-platform.test.mjs` 验证平台 shell。`tests/process-tools.test.mjs` 验证增量输出、stdin、跨 Run 句柄拒绝、正常关闭和卸载等待、超时、UTF-8 截断及同步接纳后、进程实际启动前的取消。`tests/tool-catalog.test.mjs` 验证目录来源、推荐默认、退役工具的新选择拒绝、固定旧快照兼容、依赖及参数范围。集成行为由 RunRuntime 与原生协议测试覆盖。独立包测试使用 `npm test --workspace @anybox/computer-tools`，其中 `independent-tools.test.mjs` 验证不需要 Agent、Projects 或 Session 的真实执行，`package-consumer.test.mjs` 验证生产文件闭包。完整验证使用根 `npm run check`。
