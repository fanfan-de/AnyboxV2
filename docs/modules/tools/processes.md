# 进程工具组件

[工具模块](README.md) · [模块导航](../README.md)

## 职责、工厂和服务

`createProcessToolsComponent(options?: ProcessOptions)` 安装根上的 `process-tools` 组件，提供 `tools.processes` / `ProcessToolsPort`，通过 `inject` 消费本轮 `harness.projects`。它持有每个 Run 的管道进程组、stdin 写入顺序、增量输出、等待计时器和清理；不解释原生协议，也不自己写 Session。前台 Claude Code / DeepSeek Harness 命令和 Codex 的进程会话共用此资源边界。

`openRun({runId, projectId, workspacePath?}): ProcessRunScope` 同步接管 Run 所有权，随后才允许异步项目查询。相同活跃 Run ID 重复打开会拒绝。独立 worker 的执行适配器传入固定 workspacePath，scope 全部进程复用此基准，省略时保留 Projects.requireAvailable 查询行为。返回 scope 支持：

- `execute('codex_exec_command' | 'codex_write_stdin', args): OwnedCall<JsonValue>`。
- `foreground({command, timeoutMs?, maxOutputTokens?, workdir?}): OwnedCall<JsonValue>`，用于其他来源的前台命令适配。
- 幂等 `close(): OwnedCall<JsonValue>`，关闭准入，取消调用、终止进程组并等待实际退出。

支持 Windows 与 Unix 原生管道模式。Codex 在 Windows 默认 PowerShell 7，在 Unix 默认 Bash，可显式保存 `shell` 和 `login`；固定 Bash 前台契约仍使用 Bash，Windows 为 Git Bash/PortableGit，不启动 WSL。`src/core/platform/` 的私有适配不注册 Nya 服务，Node 与可选 shell 运行时配置见[原生平台支持](../../native-platform-support.md)。PTY 和独立后台作业不受支持。项目路径为相对工作目录基准，并非文件系统沙箱；绝对 `workdir` 可以位于项目外。

## 配置和数据归属

| 配置 | 默认 | 含义 |
| --- | --- | --- |
| `timeoutMs` | 120000 | 启动后的进程执行期限 |
| `maxBufferedOutputBytes` | 131072 | 每进程未读取的合并输出字节上限 |
| `terminationGraceMs` | 5000 | Unix SIGTERM 后的 SIGKILL 宽限期；Windows 终止独占 Job |
| `maxProcessesPerRun` | 32 | 同一 Run 同时存活的进程上限 |

子进程仅继承平台 shell 白名单中的路径、用户目录、临时目录、语言及必要 Windows 系统变量，不带模型 Key 或应用配置。stdout/stderr 经独立 UTF-8 解码器按观察到达顺序合并，缓冲及返回输出均在完整字符边界截断。stdin 始终有错误监听，写入串行；前台模式关闭 stdin，Codex 会话保留它供后续输入。

进程 ID 在组件代内单调分配，查找还必须属于当前 Run scope。实际 ManagedProcess、流、缓冲和运行句柄仅存在内存中；持久观察中的 `session_id` 不是恢复凭证，不能跨 Run 读取、重启恢复或自动重放。

## 执行、取消与清理

`codex_exec_command` 在所选 `yield_time_ms` 或进程退出时返回；仍存活或还有未取输出时返回 `session_id`。`codex_write_stdin` 发送可选字符，或以空字符查询新输出。结果包含 `output`、`exit_code`、`signal`、`wall_time_seconds`、`truncated` 及可选 `session_id` / `timed_out` / `error`；非零退出和超时后的真实退出是可观察业务结果。

每次工具调用的 `done` 等待的是该次启动、输出观察和取消清理，提前返回的进程由 scope 继续持有。取消工具调用会终止关联进程组，并等待其实际退出。项目查询期间取消会等待查询结束，禁止之后启动命令。

scope 关闭和 Nya Effect 卸载先阻止新调用，再取消所有已接收调用，通过本包受管进程后端终止存活树：Unix SIGTERM 后升级 SIGKILL，Windows 终止独占 Job，最后等待树、管道和调用退出。shell 已退出的遗留子进程也会清理，包括重定向了输出的子进程。关闭业务结果保存全部进程的实际退出、剩余输出、截断、超时和终止事实；无法确认清理时，结果含 `cleanup: failed`，`done` 以 `cleanup-failure` 拒绝。正常 Run 结束调用这个入口属于资源清理，不等于用户取消 Run。

终止请求可能与进程正常退出竞争，最终以监督器确认整棵树、管道和清理确实退出为依据；Windows helper 自身死亡时即使 Job 清理了树，缺少回执仍报告失败。进程 scope 由独立 worker 的内部执行适配器持有；computer scope 等它实际退出后，才原子释放实例 pin 与工作区 reservation。RunRuntime 等待 computer scope 的 `done` 后持久化清理观察并结算；失败不得生成成功节点。应用关闭通过持久 Run 控制等待所属 scope；停止 worker 服务等待此组件的全部 scope，并聚合清理错误。

## 内部纯目录与选择契约

同目录 `catalog.ts` 是纯内置数据与校验器，不是额外 Nya 组件，不支持运行期插件注册。目录含 20 个来源工具契约及两个既有 Anybox 契约；来源标签、固定前缀调用名、稳定工具 ID、版本、声明、适配范围和依赖均显式保存。推荐默认是 Codex 五个工具及 Claude Code Read / Write / Edit / Glob / Grep。

`createToolSelection()` 只解析实际选择，不静默增加工具；Codex exec/write 必须成对选择。`validateToolSelection()` 验证版本、完整定义、唯一 ID/调用名及依赖；`validateLibraryArguments()` 校验来源参数 schema、受支持模式及计划状态。保留的 `bash` / `apply_patch` 定义与原 `known-tools-v1` 完全一致，也可与新来源工具混选。工具选择快照由 Session 保存；执行绑定和运行句柄不进入该快照。

## 验证入口

`tests/managed-process-runtime.test.mjs` 验证原生 Job/进程组隔离、owner/helper 强杀和实际退出，`tests/native-tool-platform.test.mjs` 验证平台 shell。`tests/process-tools.test.mjs` 验证增量输出、stdin、跨 Run 句柄拒绝、正常关闭和卸载等待、超时、UTF-8 截断及项目查询取消。`tests/tool-catalog.test.mjs` 验证目录来源、推荐默认、依赖拒绝、固定快照、旧契约、参数范围与计划约束。集成行为由 RunRuntime 与原生协议测试覆盖。完整验证使用根 `npm run check`。
