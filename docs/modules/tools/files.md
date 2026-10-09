# 文件工具组件

[工具模块](README.md) · [模块导航](../README.md)

`createFileToolsComponent(options?)` 安装 Nya `file-tools`，提供根上 `tools.files`。通过 `inject` 获取本代 `harness.projects`、`tools.apply-patch` 和 `harness.image-assets`，不持有模型 execution、凭据、独立数据库或文件目录。

服务 `execute({runId,sessionId,projectId,name,args,signal?,imageInput})` 同步返回 `OwnedCall<{result,images?}>`。调用名为 `claude_code_Read/Write/Edit/Glob/Grep`、`deepseek_harness_read/read_image/write/edit/glob/grep` 和 `codex_view_image`。目录、工具声明及来源元数据由组合和执行层提供；组件只执行已经校验的输入，不注册动态第三方工具。

文本 Read 接受 `file_path`、一基 `offset` 和 `limit`，输出行号、总行数、截断状态和下一位置。默认读取 2000 行，显式行数按目录声明执行；结果默认至多 64 KiB，源文件默认最多 10 MiB。路径相对当前项目或为绝对路径，项目不是沙箱。读取采用 `O_NOFOLLOW`，只接受单硬链接普通文件，核对打开前后 inode、权限、大小及时间。文本采用严格 UTF-8，并沿用 Apply Patch 对 NUL、裸 CR 和混合换行的拒绝规则。

Write 接受精确的 `content`，不自动补末尾换行；Edit 使用 `old_string/new_string/replace_all`，默认精确唯一匹配。两者调用 `tools.apply-patch.mutateText`，共享全部补丁调用的跨项目队列、快照、文件预检、提交和临时资源清理。没有另外的文件写入实现，也没有读观察缓存；此范围属于来源工具的适配实现。

Glob 使用随包 `@vscode/ripgrep` 发现文件，再通过 `picomatch` 匹配，结果按修改时间倒序，最多 100 个；无斜线模式匹配各级 basename。Grep 使用同一随包二进制处理 regex；Claude 接受 `glob`、输出模式与上下文，DeepSeek 使用单一正向 `include`。两者包括隐藏和 ignore 文件，排除既有 project-files 的版本控制元数据、依赖目录，不跟随搜索目标或遍历中的符号链接。搜索默认 30 秒、原始输出最多 20 MB，错误及截断明示，不安装或依赖宿主 rg。

图片调用和 Claude Read 检测到的静态 JPEG/PNG/WebP 经图片服务验证，按 `sessionId` 导入原始字节，只返回不可变 `ImageRef` 和单独 `images`；不在工具历史放入 base64，不在这里保留引用。Session 接受观察时负责同事务保留。模型未声明 image input 时拒绝图片导入。PDF、Notebook、GIF 和动画图片明确不支持，不转码。

工厂可配置 `maxSourceBytes`、`maxResultBytes`、`searchTimeoutMs`。取消中止读取和搜索，传递到已接管的图片或补丁调用，并等待文件 handle、子进程及嵌套 `done`。嵌套结果失败会主动取消并等待实际退出；失败的实际退出不会被尚未完成的结果阻塞。已经提交的文件事实仍保留；清理失败拒绝 `done`，即使 `result` 包含成功观察。卸载 Effect 停止准入、取消并等待全部调用、聚合清理失败。基础设施异常归一固定错误，参数、文本及常见文件错误返回结构化诊断。

Electron 下搜索进程使用 `searchBinaryPath` 将 `app.asar` 的模块解析路径转换为已解包的实际路径；普通 Node 路径保持原样。发行与桌面二进制验证见 [桌面打包](../../desktop-packaging.md) 和 `tests/search-release.test.mjs`。

行为测试：[file-tools.test.mjs](../../../tests/file-tools.test.mjs)、[apply-patch-component.test.mjs](../../../tests/apply-patch-component.test.mjs)。验证包括分页、隐藏/ignore 搜索、排除和链接、原字节图片及能力、共享队列、外部并发修改、取消等待和清理失败。完整验收运行 `npm run check`。
