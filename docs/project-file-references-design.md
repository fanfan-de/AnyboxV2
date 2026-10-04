# 项目文件引用

[文档首页](README.md) · [Project Files 组件](modules/sessions/project-files.md)

首期支持 `@` 引用当前项目普通 UTF-8 文本及指定行范围，点击发送时固定实际内容。预览是当前文件，历史是不可变快照；上传外部文件、PDF/Office、目录、远程 URL 和按需读取工具不在范围内。

## 数据路径

1. 输入框保存 `{kind:'project-file',path,range?}`，或历史编辑时保存 `{kind:'snapshot',snapshotId}`。普通文本中的 @ 不自动读文件。
2. 发送前先持久保存 pending v3：原始文字、图片、文件选择、父节点、模型、Run 幂等键和独立 preparationKey。
3. 经 Session 调用 Project Files 准备批次。每个文件稳定读取，整批快照及准备键在一个业务事务提交。浏览器保存返回的 FileRef 后，才发送 RunInput.files 中的 snapshotId。
4. Run 先返回已接受幂等结果；新请求解析配置、初始上下文、task-template 和父路径，并经 Session 读取本轮快照。读调用的实际退出由准入路径等待。
5. NativeRunInput v3 保存 raw/text/template/images/files。文件正文只在准备协议输入时暂存，不重复放入该快照字段。Session 接受事务同时复核并保留文件、图片、协议及父恢复引用。
6. 协议绑定将文件相对路径、实际行范围和正文确定性 JSON 编码为 `project-file-context` v1 用户资料。顺序是模板后的本轮用户文本、文件资料、图片。文件内容不再经过模板，不成为 system/developer 指令。
7. 四种协议使用已有原生文本内容，不新增 Models 文件类型、Files API 或图片 resourceRefs。原生增量请求记录保存实际发送资料，后续只沿所选成功父链恢复，不访问项目源文件。

## 恢复语义

准备响应丢失后重复同一 preparationKey，仍取得原批次；同键不同选择冲突，过期键不能重新捕获内容。Run 响应丢失优先按 Run 幂等键查询，再复用保存的快照。失败准备恢复原位置草稿并显示附件错误。已接受 Run 的失败和取消仍保留输入。

历史编辑与重新生成默认使用原快照。编辑附件中的“更新为当前文件”显式改为项目引用，下一次发送才固定新版本；改行范围也需先切换为当前文件。源文件删除不影响历史查看；项目不可用仍按现有准入规则阻止新 Run。

NativeRunInput v1/v2、旧节点和旧图片待提交继续读取，缺失 files 视为空数组；不重写旧 JSON。未知或损坏文件字段可见且阻止提交，不能静默降为纯文本。文件引用不增加 run-state 迁移（会话归档随后升级为 v7），新表由 project-files v1 迁移域拥有；Models 驱动、原生记录格式及 known-tools-v1 不升级。

## Web 与接口

Session/harness server API 提供 openProjectFileTree、readProjectFileTreePage、closeProjectFileTree、onProjectFileTreeRetired，以及 searchProjectFiles、previewProjectFile、prepareProjectFiles、getFileSnapshot、renewProjectFiles；受信执行端口提供 readFileSnapshots。Web 只经过 Session 验证和包装后的 HTTP 接口；退休通知由 HTTP 管理观察租约。

目录、搜索和当前文件预览在旧 `dialogue-v1` 或归档会话中仍可读取所属项目。旧会话不开放快照及图片资源入口；旧会话与归档会话均不能引用到草稿、准备新快照或发送。受限旧格式资源返回 `legacy-session-readonly`，不使用通用内部错误。

| `/api/v1/sessions/:sessionId/project-files/` 下的路由 | 方法与输入 |
| --- | --- |
| `tree/open` | POST `{path}`，按层目录第一页，项目根为空路径 |
| `tree/page` | POST `{cursorId,page}`，继续当前目录 |
| `tree/close` | POST `{cursorId}`，幂等释放目录句柄 |
| `search?q=...` | GET，相对路径候选及 incomplete |
| `preview` | POST `{path,range?}`，当前内容及能否引用 |
| `prepare` | POST `{preparationKey,selections}`，有序快照元数据 |
| `snapshots/:id` | GET，历史文本与元数据 |
| `renew` | POST `{snapshotIds}`，有效/失效列表 |

保留 textarea；行首/空白后的 @ 打开有 250 ms 防抖的候选框，支持方向键、Enter、Esc 和中文输入法。选择项通过预览确认后成为独立附件标签；每个面板拥有查询/预览 AbortController，过时响应不可覆盖其他节点。文件预览用文本节点，行范围和文件数限制由服务端复核。

通用草稿数据由 draft-client 管理，image-client 只负责图片行为；file-client 管理文件选择、待提交恢复和租期，file-view 管理候选与附件卡片，file-sidebar 和 file-tree-client 管理右侧标签、快照预览与目录游标。这些是 Web 内部模块，不注册 Nya 组件。

## 验收

自动测试使用本地文件、内存凭据和受控协议；运行 `npm run check`。可用 `node tests/helpers/project-files-browser-host.mjs` 启动临时 Web 宿主，验证 @ 搜索、行范围、仅文件发送、源文件修改后历史预览、编辑与重新生成；退出会清理临时数据。边界和生命周期的测试入口见组件手册。

## 右侧目录树与预览

文件预览统一位于[三栏工作区](harness-three-column-workspace.md)右栏，不再创建每面板预览弹窗。右侧只有完整目录树，输入框 @ 搜索仍保留。目录按展开分页，不受搜索的 50 条限制。引用确认在控制器内同步更新草稿，验证来源父节点、附件身份及 pending/只读状态；用户继续输入后不按旧 @ 偏移删除文字。当前文件预览与不可变快照标签分别保留来源，不改变发送时捕获和准备幂等规则。
