# 工具模块

[返回模块导航](../README.md)

工具模块负责模型执行期间的本机副作用。目前只安装 Bash 与 Apply Patch 两个 Nya 组件；[RunRuntime](../execution/run-runtime.md) 直接注入它们，以项目自有的已知工具判别联合校验和分派请求，没有动态工具注册中心。

## 组件

| 组件 | Nya 名称 | 服务 | 资源所有权 |
| --- | --- | --- | --- |
| [Bash](bash.md) | `bash-tool` | `tools.bash` | 每次调用的 Bash 子进程、进程组、输出缓冲和终止计时器 |
| [Apply Patch](apply-patch.md) | `apply-patch-tool` | `tools.apply-patch` | 跨项目串行队列、文件预检、逐文件提交及临时文件/目录 |

两个组件都通过 `inject` 依赖 [Projects](../sessions/projects.md) 的 `harness.projects`，每次执行先确认项目可用。项目路径只是相对路径基准，不是文件系统沙箱：命令和补丁具有应用用户的文件访问权限，Bash 还具有该用户的网络访问权限。

## 共同契约与执行关系

[definition.ts](../../../src/applications/harness/core/tool/definition.ts) 的 `ToolDefinition` 只包含名称、说明和 JSON 参数定义；各[协议 Agent Loop](../execution/README.md) 负责把它编码为协议原生工具声明。工具只接收已经解析好的项目 ID 与工具输入，不读取模型的可变原生状态，不持有凭据，也不自行写入 Session。

两个 `execute()` 均同步返回 [contracts.ts](../../../src/applications/harness/core/contracts.ts) 中的 `OwnedCall<Result>`：

- `result` 表示可以观察的业务结果；它可能先于底层资源退出完成。
- `cancel(reason: string)` 请求停止；不能用其返回时间判断资源已释放。
- `done` 表示调用已实际退出、清理已结束。清理失败可以在这里拒绝，即使 `result` 已成功。

RunRuntime 负责持久化操作意图、调用工具、等待 `result` 与 `done`、提交真实观察、关闭 program 后结算 Run。工具事实写入 `tool-started`、`tool-observed`、`tool-failed` 与 `toolCalls`；旧 `bash-*` / `bashCalls` 只在历史读取边界归一化。工具组件本身没有持久数据库。

## 两种副作用的差异

| 方面 | Bash | Apply Patch |
| --- | --- | --- |
| 并发 | 每次调用独立进程，可以并行 | 同一组件的所有项目共用一条队列 |
| 输入 | 任意非空 Bash 命令 | 限定补丁语法，精确唯一上下文 |
| 正常观察 | 退出码、信号、截断后的 stdout/stderr | 状态、已发生 `changes`、尚未完成 `pending`、诊断 |
| 非零退出/校验失败 | 非零退出码仍是正常结果 | 语法、文本或已知文件系统失败通常是正常诊断结果 |
| 取消 | 先发 SIGTERM，超出宽限期再发 SIGKILL | 检查点停止；已开始的单文件提交（含 Move 两部分）完成后停止 |
| 回滚 | 不撤销命令副作用 | 不回滚已完成文件修改 |

只有模型配置具备有效工具能力时，协议 Loop 才向模型提供这些声明；无工具能力的模型仍可进行纯文本调用。是否安装工具、是否向某个 execution 暴露工具，是组合与执行层的决策。

## 维护与验证

组件各自文档列出边界测试；[tool-loop.test.mjs](../../../tests/tool-loop.test.mjs)、[apply-patch-loop.test.mjs](../../../tests/apply-patch-loop.test.mjs) 验证工具进入完整 Run 后的结算、取消和观察。修改工具取消、队列、资源归属或清理行为时，同时更新这些行为测试，并运行根目录 `npm run check`。
