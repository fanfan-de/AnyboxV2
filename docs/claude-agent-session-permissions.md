# Claude Agent 0.1.6：本次会话始终允许

0.1.5 只展示了原生 session 规则的实际单轮有效期，未满足整个会话持续授权的交互语义。0.1.6 修复该行为：点击“本次会话始终允许”后，把本次明确批准的规则保存到此会话，后续消息和重新打开会话继续复用。

## 行为与范围

- 始终允许只记住审批卡展示的具体工具/命令/路径规则，不把单个命令扩大成全部 Bash 权限。
- 明确绑定执行设备的线程、Claude 原生 session id 与项目路径；同目录的新会话不继承。
- 下一条消息启动新 SDK 进程前，读取该会话有效规则，经原生 allowedTools/additionalDirectories 交给 Claude；应用不自行匹配命令或在回调里按工具名称自动允许。
- 管理员 deny/ask、规划模式限制、需要用户交互的工具及其他 Claude 强制检查继续生效，未覆盖的操作仍然询问。规则与检查顺序以 [Claude Agent SDK 权限文档](https://code.claude.com/docs/en/agent-sdk/permissions) 为准。
- 输入区“权限模式 → 查看会话授权”展示当前规则，任务结束后可以撤销。撤销持久保存，后续消息不再带上该授权；运行中的任务不伪装成已即时撤销。
- “仅允许这次”、拒绝与取消都不建立会话授权。不写入 Claude 的用户或项目权限文件，不保持永久空闲进程。
- 旧版本没有保存完整可复用规则，无法可靠重建，因此不把历史的本轮批准自动升级为整个会话授权；升级后重新选择一次始终允许，即进入新行为。

## 实现与失败边界

Store v4 增加 claude_agent_session_grants，权限数据使用应用自有 allow(tool/pattern)/directories。只有原生建议中的 addRules+allow 和 addDirectories 可以持久复用；替换、移除、模式切换及不完整/被 suppress 的建议不提供会话批准按钮。浏览器只能提交审批决定，不能上传任意授权规则。

保存授权与审批决定同事务提交，成功后才向 SDK 放行。持久化失败时工具仍等待决定；取消与保存竞争时撤销新记录，下一次任务必须等待清理结束。写入/撤销与启动准入互斥；进程重启保留已保存的授权，但不恢复或重放被中断的工具操作。SDK 原生对象与规则解析仍限于适配器边界，宿主不接触此业务。

API：GET /threads/:id/permissions；POST /threads/:id/permissions/:grantId/revoke（空 JSON）。继续通过 Claude Agent 自己的本机私有通道/远端绑定，拒绝跨线程授权与额外字段，忙碌时撤销返回 permissions-active。

## 验证

自动行为测试 `tests/claude-agent-session-permissions.test.mjs` 覆盖跨消息、应用重启、会话隔离、原生 ID 换代、撤销、单次/拒绝/取消不持久化、保存失败不放行、保存与取消竞争、SDK 建议白名单及规则去重。真实 SDK 对受控 CLI 的三轮测试验证：首次询问、第二次匹配不询问、第三次未匹配仍询问，且每轮使用独立进程。HTTP 测试覆盖归属、额外字段与忙碌撤销；浏览器控制器测试覆盖列表、撤销和过期设备响应。

2026-10-18 18:19（Asia/Shanghai）使用本机已安装、已登录的真实 Claude 进行了两轮验证：在独立临时项目内，两条消息都通过 Bash 执行 npm run proof，实际输出文件写入两次；第一次选择会话始终允许，第二次没有审批。原生建议并保存的规则为 Bash(npm run *)，两轮均 completed。验证后已关闭实际进程并清理临时项目。证据：`/tmp/anybox-claude-ui-audit/real-session-grants-0.1.6.json`；脚本位于同目录 real-session-grants.mjs。

隔离浏览器确认审批的新有效期文案、查看授权、撤销成功、空态及键盘关闭，控制台无错误。该截图使用模拟数据，仅作视觉验收：`/tmp/anybox-claude-ui-audit/session-permissions-manager-0.1.6.jpg`。

全仓检查 `npm run check`：2027 项，2013 通过，14 项环境门控跳过，0 失败；本次功能、HTTP、重连与选模专项回归 34 项全部通过。日志分别位于 `/tmp/anybox-claude-ui-audit/check-session-grants-0.1.6.log` 与 `session-grants-final-regression.log`。全仓检查之后追加的授权 HTTP 测试也通过（7 项）。

## 正式生效

2026-10-18 18:26（Asia/Shanghai），正式宿主 `http://127.0.0.1:3000` 已完成 0.1.6 生效：

- 目录包身份摘要：`e9a47756a21b1813cfee0fc1390c368392eda0ff002951116b86b1c45f3a8008`；原始目录摘要：`2719212dd18d40468ebc9c322f0c935ab3335111a115185ce6108a7a6f726015`。
- 安装请求 claude-session-grants-016-20261018-install：installed。
- 生效请求 claude-session-grants-016-20261018-activate，批次 `225ee8ca-1e4a-45d2-befd-431c748e2b20`：completed。
- client/execution 实际代次 `91fb511b-26bd-49c5-9a83-c7c0e095528e`，实际版本均 0.1.6、ready。沿用正式业务及页面退出保护，没有强制取消任务或绕过 dispose。
- 正式当前用户会话的授权查询返回 200，旧版临时授权未被自动扩大；正式模型接口仍返回 13 项。页面入口包含会话授权面板，审批文字已为“本次会话始终允许”，旧“本轮记住以上规则”已移除。

完整正式证明：`/tmp/anybox-claude-ui-audit/deployment-session-grants-0.1.6.json`。浏览器截图仅为隔离 UI 验收；真实两条消息行为由本机真实 Claude/SDK 验证，正式环境通过安装身份、角色 ready、实际 API 和静态资源验证，不声称自动浏览器代点了用户内嵌的正式页面。


