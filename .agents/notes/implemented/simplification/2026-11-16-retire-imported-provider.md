# Agent Note: 清理旧提供方定义并统一目录添加入口

Status: implemented

## 问题

删除旧连接并移除自动初始化后，本机仍保存 `anybox-imported-provider` 与 `anybox-imported-model` 的用户定义。“添加提供方”将所有来源混在候选中，因此旧的“DeepSeek（迁入）”仍可见。用户要求清理该旧定义，后续统一从 models.dev 目录添加提供方。

## 决策

已先经正常退出 guard 停止本机 Harness，确认旧提供方及子模型没有当前连接或实际模型配置使用，再通过公开 Models JSON store 的独占锁、修订 CAS 与原子提交，将确切旧身份退役为 missing 并追加新修订；保留历史引用及目录来源定义。提交与释放独占锁后已恢复应用，普通定义查询和页面均已验证。

添加提供方 UI 已固定查询 models.dev 来源，移除新建自定义提供方的入口与提交分支，新连接必须选中 present 的目录提供方；已有自定义连接的管理、模型级自定义及通用 Models API 保留。其他实例不自动迁移或清理用户定义。

真实页面验证还发现原目录可见性观察只覆盖自身 hidden 和 dialog.open；初始化时位于隐藏设置分类中，之后切换到模型管理不会启动读取。已将观察范围扩为当前祖先链的 hidden，并在 dialog 合并观察 open/hidden；仍不观察渲染子树，dispose 统一断开观察器。

## 备选方案

未采用直接从 JSON 数组删除 provider/model：当前格式要求历史连接与模型引用仍有对应定义，物理删除会破坏校验。未采用仅按名称隐藏：这不能处理旧定义的可用状态，且会误伤用户同名数据。未扩展通用删除 API 或 JSON schema，仅对用户明确指定且无当前使用的本机旧身份进行受控退役。

## 影响与代价

普通可用定义查询不再返回旧条目，includeMissing 与历史仍保留旧身份以兼容已有记录。退役状态不是历史数据物理擦除，也不是通用服务对显式定义 ID 的权限边界。清理需要短暂正常停止并恢复 Harness，不触碰业务数据、Models Key 或其他应用。新添加提供方从目录选择，既有自定义连接可继续管理。

## 验证

本机实际清理前确认连接及实际配置均为空，旧提供方及一个子模型为 user / present，models.dev / deepseek 目录定义存在。正常 stop 成功后，公开 store 独占打开并提交：`anybox-imported-provider` 和 `anybox-imported-model` 均从 revision 1 / present 进入 revision 2 / missing，各自保留两条历史修订；finally 等待根清理后正常 open 成功。恢复后默认 providers / definitions 查询不再返回旧定义，includeMissing 保留退役记录，models.dev 的 DeepSeek 仍 present，连接和实际配置仍与清理前相同。没有写入 Key 或业务数据。

`npm run build --workspace packages/app-harness` 与最终源码的 TypeScript 编译通过。`node --test --test-timeout=60000 tests/models-client.test.mjs tests/models-directory-web.test.mjs` 在最终代码上 32 项全部通过，0 失败/跳过，覆盖目录来源、搜索与取消、新连接来源准入、既有用户连接查询/选择/CAS 修改及协议/模型行为。`git diff --check` 通过。

真实 Chrome 按 reload → 打开设置默认会话设置 → 切模型管理 → 搜索 DeepSeek 验证目录自动加载，只显示 models.dev / deepseek；选择后连接表单来源正确，无旧条目或新增自定义提供方入口。页面确认没有未输入完成的 Key 或消息草稿后才刷新，当前停留在目录 DeepSeek 的待填 Key 表单。结果截图 `/tmp/anybox-modelsdev-provider-only.jpg` 为临时交付材料。未重跑全仓测试、未调用真实模型或验证其他操作系统/系统 Vault。

## 关联

- [前项：移除兼容自动初始化](../../implemented/simplification/2026-11-16-remove-model-bootstrap.md)
- [前项：本机切换目录连接](../../implemented/process/2026-11-16-deepseek-catalog-connection.md)
- [Models JSON 存储](../../../../docs/modules/models/json-store.md)
- [模型目录 UI](../../../../packages/app-harness/src/web/models-directory-client.ts)
- [模型管理 UI](../../../../packages/app-harness/src/web/models-client.ts)
- [目录与管理测试](../../../../tests/models-client.test.mjs)
- [真实 HTTP 目录测试](../../../../tests/models-directory-web.test.mjs)
