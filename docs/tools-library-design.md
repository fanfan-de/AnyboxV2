# Anybox Harness 工具库

状态：2026-10-10，独立 computer worker 已承担实际工具执行；内置工具目录、按 Agent 混选、不可变 Session 快照、四种协议工具图片及按 Run 的管道进程已接入。组件入口见[工具模块](./modules/tools/README.md)。

## 产品与来源契约

用户按执行设备和 Agent 勾选单个工具，可混合多个 harness 来源。Anybox 保存来源的名字、参考版本与链接、适配范围、参数 schema 和独立契约版本；来源不决定 Provider 或原生协议。工具均由受信 Anybox 执行器执行，当前不开放 MCP 市场或运行期插件注册。

| 来源 | 当前工具 | 稳定 ID / 模型调用名 |
| --- | --- | --- |
| Codex | exec_command、write_stdin、apply_patch、view_image、update_plan | `codex.<name>` / `codex_<name>` |
| Claude Code | Bash、Read、Write、Edit、Glob、Grep、TodoWrite | `claude-code.<name>` / `claude_code_<name>` |
| DeepSeek Harness | bash、read、read_image、write、edit、glob、grep、todo_write | `deepseek-harness.<name>` / `deepseek_harness_<name>` |
| Anybox 既有契约 | bash、apply_patch | `anybox.<name>` / 保留原调用名 |

默认选择 Codex 五项与 Claude Read/Write/Edit/Glob/Grep，共十项。Codex exec/write 必须成对选择；缺失依赖由服务器明确拒绝，保存不自动补入工具。空选择合法。类似功能保持各来源参数约定，底层共享进程、读取、搜索及文本提交边界。

首版支持开发所需的命令、普通 UTF-8 文件、搜索、静态 JPEG/PNG/WebP 图片和完整列表计划。PTY、独立后台作业、PDF、notebook、用户问答等待、联网搜索、子 Agent 和通用脚本编排尚未接入；相应参数明确拒绝。Codex Apply Patch 的自由文本输入在跨协议函数工具中适配为 `patch` JSON 字段，来源与范围元数据记录此差异。

## 配置、快照和兼容

API 提供 `listTools()`、`getAgentTools(agentId)`、`setAgentTools(agentId, {toolIds, expectedRevision})`。Session 组件持有工具设置及 CAS 修订号；配置和当前模型默认均属于所选执行设备。目录为纯数据，不另注册组件。

创建 Session 的事务复制 `ToolSelectionSnapshot {schemaVersion:1, tools:[{toolId,version,definition}]}`，数据库禁止之后修改。Agent 配置更新只影响新 Session；已有会话、所有分支、历史编辑/重新生成和在途 Run 保持原选择。首次接受 Run 固定 `NativeInitialization` v2 / `tool-library-v1`，包含 Prompt、实际声明与会话快照。无有效工具能力的模型使用空声明，快照仍保留。

Session 的 `run-state` v9 增加 Agent 工具设置和 Session 不可变选择。旧会话迁入明确的 Anybox 两工具选择；旧 `NativeInitialization` v1 / `known-tools-v1`、定义、原生记录和历史 JSON 保持原样。当前 run-state v10 增加独立 Run 恢复状态；Loop 1.3.0 兼容 1.0.0/1.1.0/1.2.0，Models 驱动仍为 2.1.0、原生记录仍为 v2。身份、账户 epoch、模型及执行语义的恢复约束继续生效。

## 执行和资源所有权

工具按资源拆为四个独立 worker 根的 Nya 组件：既有 Bash、共享 Apply Patch、Run 管道进程和文件工具。选择、参数验证与来源适配保持纯函数；不新增项目、任务或工具 Context。RunRuntime 通过 Computer Operations 保存声明并观察结果，worker 执行器使用本代四工具依赖，只运行初始化实际声明的工具；完整批次在任何副作用前验证。

每次调用仍遵循持久意图、停止检查、同步启动登记、等待 result/done、持久观察的顺序。文件 Write/Edit 共用 Apply Patch 的跨项目串行队列、文件预检和真实部分提交事实。计划/todo 工具替换完整列表形成持久工具观察，不启动后台任务。

Codex exec 可以返回仍运行的管道会话，write_stdin 只能访问同 Run 的单调会话 ID；实际进程句柄留在内存。每次调用 done 只等待该操作退出，scope 独立持有进程。正常模型结束、取消和应用关闭都终止并等待全部组、流和操作；Runtime 以 `intent.kind=tool-process-cleanup` 的通用 operation 保存最终退出、剩余输出和清理状态，之后才结算。正常清理不把 Run 改为用户取消，清理失败不发布成功节点。worker 存活时，Runtime 进程异常重启从原 ProcessRef 与 operation receipt 接续，stdin/输出领取去重；worker 自身故障不能凭 PID 恢复 OS 管道，未知命令不重放。idle worker 不随应用正常关闭退出。详见 [Computer 资源设计](computer-resource-design.md)。

图片工具通过既有 Image Assets 导入不可变原字节；Session 在工具观察同一业务事务保留引用。只有提交后 program 私有 resolver 才接纳该引用，四种 Loop 将普通文本工具结果回填后追加原生用户图片块；下一次增量交换传匹配 resourceRefs。完整原生请求继续受 32 MiB 限制，base64 只在受管操作中物化，不进历史。文本模型得到结构化不支持结果，其他工具仍可使用。

## 验证和升级

[目录测试](../tests/tool-catalog.test.mjs)、[进程测试](../tests/process-tools.test.mjs)、[文件测试](../tests/file-tools.test.mjs) 和[四协议集成](../tests/native-tool-library.test.mjs) 覆盖跨来源选择、依赖、版本快照、stdin/增量输出、跨 Run 拒绝、正常结束及取消清理、工具图片提交、文本模型和恢复。既有工具循环及旧格式样本继续验证兼容，完整检查运行 `npm run check`。

升级前关闭应用并等待实际退出，备份业务数据库及图片目录；v9 迁移沿用现有业务连接。回退代码需恢复升级前数据库备份。普通测试使用临时库、内存凭据及模拟协议，不访问用户实际业务数据，远端模型与系统凭据仍由既有门控验收。
