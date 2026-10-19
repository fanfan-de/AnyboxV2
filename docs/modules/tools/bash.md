# Bash 组件

[工具模块](README.md) · [模块导航](../README.md)

## 职责与入口

Bash 组件在选定项目目录中执行本机 Bash 命令，独占每次调用的受管进程、输出和退出等待。Windows 使用原生 Git Bash/PortableGit，Unix 使用 Bash；不会把 Bash 契约改成 PowerShell。进程与 shell 选择来自本应用 `src/core/platform/` 的私有适配，不新增 Nya 组件，配置见[原生平台支持](../../native-platform-support.md)。它不解释模型协议，不写 Session，也不决定 Run 的终态。

| 项目 | 定义 |
| --- | --- |
| 源码 | [bash-component.ts](../../../packages/app-harness/src/core/tool/bash-component.ts) |
| 工厂 | `createBashComponent(options?: BashOptions)` |
| Nya 名称 | `bash-tool` |
| 提供服务 | `tools.bash`，类型 `BashPort` |
| `inject` | `harness.projects`，本轮 `deps` 中的 `ProjectPort` |
| 工具名 | `bash` |
| 消费方 | 独立 [worker 执行器](../computers/worker-executor.md) |

## 配置与公开接口

`BashOptions` 在创建组件时校验；每项必须是 `1..2147483647` 内的安全整数。

| 选项 | 默认值 | 含义 |
| --- | --- | --- |
| `timeoutMs` | `120000` | 子进程启动后的命令超时；不包括等待项目查询的时间 |
| `maxOutputBytes` | `65536` | stdout 和 stderr 合计保留的字节数 |
| `terminationGraceMs` | `5000` | Unix 终止升级宽限时间；Windows 终止所属 Job |

`BashPort.definition` 是冻结的 `ToolDefinition`，仅允许一个必填字符串参数 `command`，不允许额外属性。宿主服务使用 `execute({ projectId, command, workspacePath? }): OwnedCall<BashResult>`，其中项目 ID 和可选固定绝对路径由受信执行上下文提供，不由模型工具参数指定。

独立 worker 的内部执行适配器传入 [Workspaces](../computers/workspaces.md) binding.path，命令以该 workspacePath 为 cwd，不重新查询或选择项目目录。省略该字段的直接调用保留原项目查询行为；组件依赖仍为 Projects，不反向依赖 Computer Operations。

`BashResult` 含 `exitCode: number | null`、`signal: NodeJS.Signals | null`、`stdout`、`stderr`、`truncated`。非零退出码仍返回该结果，由上层观察失败的命令输出；它不是组件异常。

## 执行流程

1. 同步检查组件仍接受调用、项目 ID 非空、命令非空且不含 NUL；非法输入同步抛出 `BashFailure('invalid-request')`。
2. 注册调用，使用受信 workspacePath；未指定时通过 `projects.requireAvailable(projectId)` 获取项目路径。查询期间取消的调用会等查询退出，再阻止进程启动。
3. 经 `prepareShellCommand({bash:true,login:false})` 与 `spawnManagedProcess` 启动原生 Bash，`cwd` 为项目路径，stdin 忽略，stdout/stderr 使用管道。Windows 用 Job Object，Unix 用独立进程组。
4. 私有 shell 适配仅继承 PATH、HOME、临时目录、语言及 Windows shell 运行必需的系统路径变量；不传模型 Key、Provider 或应用配置。完整白名单位于 `core/platform/shell.ts`。
5. 按到达顺序共享输出字节预算；超出部分丢弃并置 `truncated: true`，但继续读取管道，避免因输出填满而阻塞退出。
6. 分别等待初始进程 `exited` 与完整资源 `done`，确认后代与管道退出后生成正常结果；调用 `done` 等待真实退出、清理计时器并移除活动调用。

项目路径不是文件系统沙箱。命令可以访问项目外路径和网络；最小环境继承也不构成权限隔离。输出按管道分别增量 UTF-8 解码，在完整字符边界按字节额度截断。

## 取消、超时与组件清理

超时和显式 `cancel()` 都先拒绝中断 Promise，因此 `result` 可以在进程退出前以 `timeout` 或 `cancelled` 拒绝。组件请求受管进程终止；Unix 向进程组发 SIGTERM、宽限后 SIGKILL，Windows 终止独占 Job。重复取消和已经退出后的取消不会再次启动终止流程。

调用者必须继续等待 `done`。它会等待项目查询或子进程实际结束，不因 `result` 已拒绝就提前完成。后端不能证明整棵树及管道退出时记录 `cleanup-failure`，在 `done` 暴露；helper 失联不以初始进程消失推定清理成功，普通业务错误本身不使 `done` 拒绝。

组件通过 Effect 登记清理：先关闭准入，再取消所有活动调用，等待全部 `done`。已发生的清理错误会保留至组件关闭；多个错误用 `AggregateError` 聚合。不会因某一个调用失败而跳过其他调用的退出等待。

## 失败语义与替换边界

| `BashFailure.category` | 场景 |
| --- | --- |
| `invalid-request` | 非法项目 ID、空命令、NUL 等输入问题 |
| `unavailable` | 已关闭、项目不可用、进程无法启动 |
| `timeout` | 命令超过执行时限 |
| `cancelled` | 显式取消或所有者卸载 |
| `cleanup-failure` | 进程树、输出或监督器清理无法确认 |

错误文本固定，不把底层进程或项目异常直接向模型/浏览器传播。可在组合根替换 `tools.bash` 的提供组件，替身须保留 `BashPort` 和 `OwnedCall` 的实际退出语义；不能把 `done` 简化为 `result` 的别名。Nya 根据依赖重启消费者，业务代码不要缓存跨重启服务引用。

## 验证依据

- `tests/managed-process-runtime.test.mjs`、`tests/native-tool-platform.test.mjs`：原生平台进程树、shell、编码与取消。
- [bash-component.test.mjs](../../../tests/bash-component.test.mjs)：项目 cwd、最小环境、非零退出、合并输出上限、输入拒绝、超时先于退出、取消与卸载等待、项目查询期间的取消。
- [tool-loop.test.mjs](../../../tests/tool-loop.test.mjs)：工具调用与 Run 观察/结算的集成行为。
- [harness-server-http.test.mjs](../../../tests/harness-server-http.test.mjs)：Bash 事件的有界浏览器投影以及取消等待。

从仓库根目录运行 `npm run check`；仅定位 Bash 行为时可在构建后运行 `node --test tests/bash-component.test.mjs`。
