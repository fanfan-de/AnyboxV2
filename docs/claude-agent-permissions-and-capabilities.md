# Claude Agent 0.1.5：权限与能力入口

> 此页保留 0.1.5 的验收快照。0.1.6 已将记住规则修复为完整会话有效，后续消息/重新打开仍复用，见 [会话授权修复](claude-agent-session-permissions.md)。

本次实现限于 Claude Agent 应用包，Anybox 宿主应用栏、通用生命周期和包生效保护保持原有职责。

## 交互与实际范围

- 输入区权限模式：询问、自动接受编辑、规划、自动审批、仅已批准操作。每项说明其行为；运行中切换等待 Claude 确认后生效，并保存为此会话后续任务的选择。自动审批依赖设备上的 CLI/账户支持；拒绝时保留旧选择。
- 审批卡：仅允许这次；本轮记住以上规则；拒绝。展开具体规则和有效期，给出询问原因与可展开的原始原因。复杂引号/展开导致的再次检查会有对应说明。没有可复用建议、规则过大或被 suppress 时，不提供记住按钮，更不会隐式授权整个工具。
- 输入区“＋”或顶部“技能与工具”打开侧面板。技能可搜索、插入草稿；运行中可重新加载技能。选择不会自动发送消息。
- MCP 页显示当前任务或项目的真实服务状态和工具名称，区分需要登录/失败/停用。启停重连只对当前任务有效，不写配置文件；没有活动任务时只展示环境目录并说明控制时机。
- 子 Agent 页展示环境支持的类型，选择后填写委派请求；实际调用由 Claude 执行。本轮任务的状态、用量、工具进展、完成输出与单独停止在同页展示，顶部活动入口显示任务计数。

`session` 临时授权实际只存在于当前 Run 的 Claude 进程。本应用每条消息启动一个 Run，以原生 session id 续接历史，因此临时规则不跨消息持久保存。权限模式是本应用明确保存的会话选择；两者分别展示。本次没有改变为永久持有的多轮 SDK 进程，也不写入用户的权限规则文件。

控制只对指定执行设备的指定 Run 生效。MCP 名称须来自该 Run 的目录，停止操作须命中该 Run 观察到的活动 task；操作失败不自动重试。关闭面板取消读取，不撤回已接受的操作、不取消 Run。子 Agent 的完整历史保留在 Claude 原生环境，本版仅展示有界实时输出，刷新或进程重启后不承诺恢复子 Agent 专属面板内容。

## 实现与验证

Store 迁移至 v3，仅给线程和 Run 增加 permission_mode，旧值默认 default。SDK 对象只留在适配器目录；MCP 仅投影名称、状态、来源及工具名，不向浏览器提供 URL、配置、环境变量、认证头或原始错误。

新增 `tests/claude-agent-capabilities.test.mjs` 覆盖实际 SDK 控制协议、无提示词能力发现、全部控制方法、进程实际退出、权限确认后持久化、重启、任务归属、重复控制拒绝、旧代事件、子线程与主线程隔离、敏感字段过滤、界面插入与过期请求取消。既有审批、HTTP 与断线重连测试同步更新。

交互参考 [Claude 桌面端](https://code.claude.com/docs/en/desktop) 和 [Codex 应用功能](https://developers.openai.com/codex/app/features/)：输入区就近选择模式，审批与任务上下文相连，扩展能力按需打开，不增加宿主级设置面板。

2026-10-18 在真实本机环境使用新版适配器进行初始化查询，当前 AnyboxV2 项目返回 69 个技能/命令、5 类子 Agent、0 个 MCP 服务，没有发送提示词或调用模型。原始白名单 DTO：`/tmp/anybox-claude-ui-audit/real-capabilities-0.1.5.json`。

隔离浏览器夹具验证了审批、权限弹层、技能与 MCP 页、键盘关闭、桌面和窄窗口布局，无控制台错误。截图为模拟数据的交互验收，不能替代正式接口证据：

- `/tmp/anybox-claude-ui-audit/capabilities-desktop-0.1.5.jpg`
- `/tmp/anybox-claude-ui-audit/capabilities-narrow-0.1.5.jpg`

## 正式生效结果

`npm run check` 完成：2020 项，2006 通过，14 项按环境门控跳过，0 失败。技能重载的最新确认结果、控制协议与界面、HTTP 参数/任务归属等追加回归全部通过，见 `/tmp/anybox-claude-ui-audit/capabilities-final-regression.log`。

2026-10-18 18:10（Asia/Shanghai）经正式宿主 `http://127.0.0.1:3000` 在线安装本地信任目录并完成激活：

- 版本：0.1.5；包身份摘要：`885aed2bdd4e5dcabcbb7109a70ab8a252ea311f150c8c158c6196ec87d3e6b0`。
- 安装请求：`claude-capabilities-015-20261018-install`，phase installed。
- 生效请求：`claude-capabilities-015-20261018-activate`；批次 `946d857a-5ba7-46bb-8f1f-e87e6b4b828d`，phase completed。
- client/execution 均为同一新代 `68ebf5e7-16bd-46d8-b0cd-bec3703a47a1`，实际身份 0.1.5，state ready。页面与业务 guard 由正式生效流程执行，没有强制取消用户任务或绕过退出证明。

18:11 对用户当前真实会话（测试项目）的正式接口复核：技能/命令 69 项、子 Agent 5 类、MCP 0 项、模型 13 项；线程权限默认 default；正式静态入口包含新能力面板与权限选择器。MCP 为真实空目录，没有用样本填充。正式证据：`/tmp/anybox-claude-ui-audit/deployment-capabilities-0.1.5.json` 及其中引用的 API DTO/包状态。

自动浏览器验证使用隔离夹具；正式环境以实际安装身份、角色 ready 与真实业务/静态资源接口核对。本次没有声称自动浏览器代点了用户内嵌的正式页面。


## 0.1.7：会话详情

当前会话新增“会话详情”侧面板，分为用量与预算、子 Agent 历史、会话管理、MCP 连接、文件与恢复。参考 Claude 桌面端/Codex 的按需详情、会话上下文和独立确认方式；保留 Anybox 宿主应用栏边界。配置先保存再用于下一次任务；未保存表单阻止退出与切换，显式放弃后可关闭。归档列表可切换并恢复，分叉位置使用原生消息 UUID；原会话和项目文件关系在确认前说明。

MCP 配置支持 HTTP/SSE 与执行设备 stdio 命令；设置仅在本应用会话保存，不写全局 Claude 设置。检查连接有可重新查询/取消的独立任务；原生 URL/表单请求按服务名称展示，认证回答不进入聊天历史。仅 needs-auth 状态未带原生认证请求时，仍需执行设备原生登录。文本文件预览和检查点恢复分开，恢复先预览再确认并报告实际结果。

### 0.1.7 正式生效证明

2026-10-18 19:00（上海），正式稳定 origin `http://127.0.0.1:3000`：安装请求 `claude-workspace-017-20261018-install` 为 installed；生效请求 `claude-workspace-017-20261018-activate`，批次 `7ad52004-99a7-4277-b258-affb135f10c1` 为 completed。客户端和执行端同代 `899aad46-d08d-4499-ac85-c734fd4b8411` 均 ready，实际版本 0.1.7，身份摘要 `57e7975e8970a0b80e8cc9b73ad9af37fc0b72fd1fd5fe18837678b02e2f67f8`。

正式接口 context/agents/checkpoints/mcp/jobs/interactions/permissions 均 200，新 workspace.js 控件资源 200，当前真实模型目录 13 项。原有会话没有事后生成的检查点，后续任务按保存设置记录。全量 `npm run check`：2037 项，2023 通过、14 环境门控跳过、0 失败；最终专项回归 32 项通过。最后的小界面及有界投影修正另经专项测试和实际浏览器确认。真实 Claude 完整链路复验于 18:55 完成，子 Agent 历史 5 条、文件检查点恢复与指定消息分叉成功；原生 SDK 的请求取消信号随查询清理传播。

改动保留 Anybox 宿主应用栏。部署机器本地证明位于 `/tmp/anybox-claude-ui-audit/deployment-workspace-0.1.7.json`，原始真实验证位于同目录 `real-workspace-0.1.7.json`。

验证：隔离浏览器实际保存预算、打开子 Agent 历史、选择分叉位置、预览文件与恢复列表；本机真实 Claude 完成 MCP 表单、子 Agent 历史、编辑、恢复和指定消息分叉，重启后数据仍可读。SDK 与生命周期边界见 [SDK](modules/claude-agent/sdk.md#017上下文原生历史mcp-交互与文件恢复)、[Runs](modules/claude-agent/runs.md#017-会话工作区操作)。

## 0.1.8 交互扩展

运行中输入采用可见队列：本轮结束后顺序发送，可移除待发送项；停止同时关闭队列。粘贴、拖放或选择图片/PDF/文本，分块上传后才提交消息；附件草稿参与页面退出保护。执行区显示工具时长和认证状态，能力面板展示子 Agent 实时过程并可将前台任务转入后台。MCP 面板区分当前任务动态变更与后续任务持久配置，按服务提供逐次确认/沿用任务权限。会话详情增加上下文明细、模型用量明细、原生会话发现与打开、长历史分页和删除确认。工具卡片可跳转到文件预览，文本支持行号、复制、下载；Edit 的 old/new 内容提供局部差异。原生检查点依旧不承诺 Bash 或全部子 Agent 编辑恢复。

0.1.8 本机真实验证已通过：同一进程两轮结果、文本附件中的 NATIVE-ATTACHMENT-018、图片真实识别为红色、运行中添加并连接 qa018 MCP、逐服务权限覆盖、1 次真实 MCP 表单确认、子 Agent 原生历史、28 项详细上下文分类、UTF-8 与 PNG 文件预览、指定消息分叉和删除专用测试会话，以及重启后的 completed/cancelled 消息状态。原生后台任务集合实际发生 2 次更新；各事件白名单及长工具进度另外通过受控 SDK 协议与状态折叠测试。证明为 `/tmp/anybox-claude-ui-audit/real-interactive-0.1.8.json`，只操作专用临时项目与专用原生会话，结束后已清理。

### 0.1.9 正式生效与验证

正式环境 `http://127.0.0.1:3000` 已生效 0.1.9，客户端和执行端均实际 ready。新增客户端白名单经真实跨角色回归后发布；正式接口实测模型 13 项、原生会话目录可读、追加消息查询可读且非法提交按 400 拒绝、附件创建/分块完成/丢弃成功，未发送模型提示词。SDK 适配器、队列与历史 worker 的安装字节与真实 Claude 双轮、图片识别和 MCP 验证版本完全一致。

最终 `npm run check`：2047 项，2033 通过、14 环境门控跳过、0 失败；另有 40 项客户端/私有通道等回归通过。此前宿主 stage-error/closing 日志时序断言偶发失败，单项、宿主模块 20 项及最终全量均已复核通过。详细证明 `/tmp/anybox-claude-ui-audit/deployment-interactive-0.1.9.json`，完整日志 `/tmp/anybox-claude-ui-audit/check-interactive-0.1.9-final.log`。
