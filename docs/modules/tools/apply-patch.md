# Apply Patch 组件

[工具模块](README.md) · [模块导航](../README.md)

## 职责与入口

Apply Patch 提供精确的 UTF-8 文本文件变更。组件持有文件系统副作用；补丁解析与文本转换是独立纯函数。它对整个补丁先做预检，再按文件顺序提交；预检通过不代表多文件变更具有事务回滚能力。

| 项目 | 定义 |
| --- | --- |
| 组件入口 | [apply-patch-component.ts](../../../src/applications/harness/core/tool/apply-patch-component.ts) |
| 纯领域逻辑 | [apply-patch-domain.ts](../../../src/applications/harness/core/tool/apply-patch-domain.ts)：`parsePatch`、`validatePatchText`、`applyPatchText` |
| 项目自有类型 | [apply-patch-types.ts](../../../src/applications/harness/core/tool/apply-patch-types.ts) |
| 工厂 / Nya 名称 | `createApplyPatchComponent(options?)` / `apply-patch-tool` |
| 服务 / `inject` | `tools.apply-patch: ApplyPatchPort` / `harness.projects` |
| 工具名 / 消费方 | `apply_patch` / 独立 [worker 执行器](../computers/worker-executor.md) |

## 配置、接口与结果

唯一工厂选项为 `filesystem?: Partial<ApplyPatchFileSystem>`，按方法覆盖默认 `node:fs/promises` 实现，主要用于可控故障与取消测试。文件系统端口包括 `lstat`、`realpath`、`readFile`、`mkdir`、`mkdtemp`、`writeFile`、`chmod`、`link`、`rename`、`unlink`、`rmdir`；替身必须维持各方法的完成时间和文件事实，不能只返回成功值而跳过副作用。

`ApplyPatchPort.definition` 声明唯一必填字符串参数 `patch`，禁止额外属性。宿主调用 `execute({ projectId, patch, workspacePath? }): OwnedCall<ApplyPatchResult>`，项目 ID 和可选固定绝对路径来自受信执行上下文。服务先同步验证项目 ID、patch 类型和可选路径；语法错误在队列内解析为诊断结果。

文件工具另调用 `mutateText({projectId,path,mutation,workspacePath?})`：`mutation` 为整文件 `write` 或 `oldString/newString/replaceAll` 的精确 `edit`。它在同一队列内部读取最新快照并规划变更，共享全部文本校验、文件预检、逐文件提交及清理；不是第二个写入提供方。纯 `applyTextMutation` 保留显式文本、BOM 和末尾换行，不添加补丁 Add 的隐含换行。

独立 worker 的内部执行适配器传入固定 binding.path，嵌套文件 Write/Edit 将同一 workspacePath 原样传给 mutateText，不在排队后重新选择项目路径。省略固定路径的直接调用保留 Projects.requireAvailable 兼容行为；文件预检、跨项目队列和实际部分提交规则保持不变。

| 结果字段 | 含义 |
| --- | --- |
| `status` | `applied` 全部完成；`rejected` 发生已知拒绝且尚无变更；`partial` 已有变更后发生已知失败；`cancelled` 已响应取消，仍可能带已完成变更 |
| `changes` | 真实发生的 `added`、`updated`、`deleted`，每项保留补丁中的路径 |
| `pending` | 尚未完整完成的操作，含 `kind`、`path`、可选 `moveTo` |
| `diagnostic` | 可选固定诊断 `code`、`message`、`path`、一基 `line` |

`pending` 包含部分完成的 Move 操作：如果目标已经创建但源删除失败，`changes` 有目标的 `added`，而该 Move 仍在 `pending`。重试必须先检查文件事实，不能直接假设整个操作从未发生。若补丁连解析都未完成，`pending` 也可能为空，诊断才是拒绝原因。

## 补丁语法与文本规则

```text
*** Begin Patch
*** Add File: notes.txt
+first line
*** Update File: src/example.ts
@@
-const oldValue = 1
+const newValue = 2
*** Delete File: obsolete.txt
*** End Patch
```

支持 Add、Delete、Update；Update 可带 `*** Move to: path`，也允许仅移动而没有 hunk。`@@` 开始 hunk，`@@ exact line` 指定精确锚点；hunk 内空格表示上下文，`-` 表示删除，`+` 表示新增。`*** End of File` 限定末尾匹配。首个 hunk 可直接以带前缀的补丁行开始。这里不接受带行号的 unified diff 头、其他补丁命令语言、NUL 或无效 Unicode。

全部 hunk 按顺序匹配原始文件行，前一处修改不会成为后一处匹配上下文。上下文和锚点要求精确且唯一，不折叠空白，不归一化 Unicode，不做模糊匹配。纯插入必须定位在空文件、唯一锚点之后或显式 EOF。Update 保留原文件 BOM、LF/CRLF 和末尾换行选择；新建有内容文件使用 LF 并带末尾换行。拒绝非法 UTF-8、NUL 二进制内容、裸 CR 和混合换行。

## 预检与提交流程

1. 同一组件的所有调用进入一条跨项目串行队列；解析补丁并确认项目目录可用。
2. 以项目路径解析相对路径；绝对路径、`..` 和父目录符号链接允许。目标最终路径本身不能是符号链接。项目目录不是沙箱。
3. 解析现有父目录的真实路径，检查新建/移动目标不存在；已有目标须为单硬链接普通文件。读取前后核对设备、inode、权限、链接数、大小、mtime、ctime，再验证文本格式。
4. 拒绝重复路径、别名以及父子目标重叠。macOS 保守折叠 Unicode 规范形式和大小写，Windows 折叠大小写。
5. 所有文件完成计划后，再复核整份计划的源文件信息与字节、目标存在状态；在此之前不创建父目录或临时文件。
6. 按顺序提交。写入在目标同目录的 `.anybox-patch-*` 临时目录暂存，先用 `wx` 与 `0600` 创建，再恢复原文件权限，或对新文件应用 `0666 & ~umask`。就地更新使用 rename；新建/移动通过硬链接原子发布，以免覆盖预检后由其他写入者创建的目标。
7. Move 发布目标后再次检查源，再删除源；Delete 复核后 unlink。每一步成功立即记录真实 `changes`，单项完成后才推进 `pending` 游标。

外部进程仍可并发改文件。实现通过快照复核、父目录核对和禁止覆盖的新目标发布减少竞态，但不提供跨进程文件锁或整份补丁的原子事务。保留的是普通权限位，不承诺复制扩展属性或其他文件元数据。

## 取消、实际退出与清理

`cancel()` 设置取消状态；排队调用和预检在检查点停止。已进入提交的单文件操作继续到实际结束，Move 的目标创建与源删除也作为一个提交单元处理。取消不会回滚已写文件，最后一个文件提交期间取消可能返回 `cancelled` 且 `pending` 为空。

`result` 可以先于临时资源清理完成。`done` 等待当前文件系统操作、临时文件删除、临时目录删除和新建空父目录清理；已有已提交文件或并发用户内容的目录保留。清理失败以 `ApplyPatchFailure('cleanup-failure')` 拒绝 `done`，即使 `result` 已返回 `applied`。RunRuntime 必须等待并保留真实观察，不能据此创建成功节点。

卸载 Effect 先停止准入，再取消全部已接受调用，等待所有 `done`；队列仅在前一调用清理完成后推进。清理错误持续保留，组件关闭时单独或聚合报告。

## 失败分类与替换边界

语法/文本诊断、符号链接或硬链接拒绝、上下文冲突、目标已存在、权限拒绝及受支持的文件系统错误被归一为 `ApplyPatchResult`，便于模型修正补丁。基础设施错误以固定 `ApplyPatchFailure` 拒绝：`invalid-request`、`unavailable`、`cleanup-failure`。`isApplyPatchFailure` 是公开判别入口，不向调用者传播任意底层异常文本。

替换组件时保持 `ApplyPatchPort`、完整结果事实和 `OwnedCall` 生命周期；纯解析器不能承担临时资源所有权。工具不写 Session：当前经 [Computer Operations](../computers/computer-operations.md) 协调的独立 worker 执行，由 [RunRuntime](../execution/run-runtime.md) 提交观察、清理和结算。

## 验证依据

- [apply-patch-domain.test.mjs](../../../tests/apply-patch-domain.test.mjs)：语法、精确匹配、锚点/EOF、Unicode/BOM、换行、大文件匹配。
- [apply-patch-component.test.mjs](../../../tests/apply-patch-component.test.mjs)：全部预检、跨项目队列、路径别名、并发外部编辑、部分提交、Move 事实、取消及清理失败。
- [apply-patch-loop.test.mjs](../../../tests/apply-patch-loop.test.mjs)：混合工具顺序、失败后修正、参数预检、旧事件读取及在途补丁恢复为 interrupted。
- [harness-server-http.test.mjs](../../../tests/harness-server-http.test.mjs)、[tool-trace.test.mjs](../../../tests/tool-trace.test.mjs)：浏览器补丁预览截断与部分/取消结果展示。

完整验收运行 `npm run check`。
