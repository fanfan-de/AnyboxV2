# 工具模块

[返回模块导航](../README.md)

工具库是受信静态内置目录：Codex、Claude Code、DeepSeek Harness 的 20 个独立来源契约及两个既有 Anybox 契约可按 Agent 自由混选。来源标签用于追溯，不决定模型协议；固定模型调用前缀避免重名，稳定 toolId 与版本用于选择和恢复。目录与参数校验是纯数据/函数，不是插件市场或额外 Nya 组件。跨组件设计见[工具库设计](../../tools-library-design.md)。

## 组件

四个实际 Nya 组件按资源所有权拆分，全部安装在应用根上：

| 组件 | Nya 名称 | 服务 | 资源所有权 |
| --- | --- | --- | --- |
| [Bash](bash.md) | `bash-tool` | `tools.bash` | 既有前台 Bash 子进程、输出缓冲及终止计时器 |
| [Apply Patch](apply-patch.md) | `apply-patch-tool` | `tools.apply-patch` | 跨项目串行队列、文件预检、逐文件提交及临时文件/目录 |
| [进程工具](processes.md) | `process-tools` | `tools.processes` | 按 Run 的管道进程组、stdin、增量输出及关闭等待 |
| [文件工具](files.md) | `file-tools` | `tools.files` | 文件读取 handle、随包搜索进程、图片导入及嵌套变更调用 |

组件通过 inject 获取真实依赖和本轮 deps 快照。项目路径是相对路径基准，不是文件系统沙箱；命令具有应用用户的文件及网络访问权限。文件 Write/Edit 共用 Apply Patch 的预检与串行提交所有权，工具目录不会复制一套生命周期或写入队列。

## 工具选择和历史

Session 在业务库保存该执行设备按 Agent 的工具 ID 列表与修订号；创建 Session 时原子复制完整选择快照，之后不可修改。更新 Agent 只影响新 Session，旧会话、分支、在途 Run 和编辑/重新生成沿用原选择。默认选择 Codex 五项及 Claude Read/Write/Edit/Glob/Grep；Codex exec/write 必须成对选择，服务器拒绝缺失依赖，不静默补入工具。用户也可明确选择空集。

首次接受 Run 固定 NativeInitialization v2 / tool-library-v1、Prompt 与实际工具声明；无工具能力模型声明为空，仍保留会话选择。旧初始化 v1 / known-tools-v1 和旧原生记录保持原样，既有 bash/apply_patch 定义可继续执行或与新工具混选。静态目录声明必须与选择中的身份、版本和完整参数定义一致。

## 调用和清理契约

工具声明使用 ToolDefinition，各协议 Loop 负责原生编码。RunRuntime 在任何工具资源启动前验证完整调用批次、来源参数及是否确实声明，再按模型顺序串行分派。工具不读取原生可变状态，不持有凭据，也不自己决定 Run 终态。

OwnedCall 分离 result、cancel 和 done：结果可早于资源退出；取消只发出请求；done 必须等待实际退出及清理。Codex 命令提前返回后的进程由 Run scope 继续持有；正常模型结束也关闭 scope，并经通用 tool-process-cleanup operation 保存最终退出事实后才结算。清理失败不创建成功节点，取消不回滚已发生文件修改。

工具事实继续使用 tool-started、tool-observed、tool-failed 及 toolCalls，旧 bash-* / bashCalls 仅在读取边界归一化。计划工具返回完整列表形成持久观察，不建立独立后台任务。普通文件和补丁诊断可交回模型修正；存储、资源清理和依赖撤销仍阻止继续执行。

工具读图经既有图片组件保存不可变 JPEG/PNG/WebP 原字节，与工具观察同业务事务保留。协议 Loop 在文本工具结果后追加用户图片块和匹配资源引用；模型调用启动后才编码原图，base64 不进入持久历史。文本模型获得明确不支持结果。PTY、独立后台作业、PDF、notebook、联网搜索和子 Agent 未纳入当前库。

## 维护与验证

目录和进程测试位于 tool-catalog.test.mjs、process-tools.test.mjs，文件行为位于 file-tools.test.mjs，跨协议、图片、选择和生命周期集成位于 native-tool-library.test.mjs；已有工具循环、Apply Patch 循环及组件测试继续验证兼容。修改取消、资源所有权或清理时同步更新行为测试，完成后执行根 npm run check。
