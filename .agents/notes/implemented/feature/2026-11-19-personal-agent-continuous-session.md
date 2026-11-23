# Agent Note: Personal Agent 的连续历史与记忆召回

Status: implemented

## 问题

Personal Agent 从 Harness 继承项目会话列表和显式分支操作。用户希望每个 Agent 始终沿一条历史交互，模型上下文放不下时自动切出续接分支，保留全部原文，并能找回退出窗口的历史。

## 决策

执行设备为每个 Agent 固定一条持久历史。工作区自动打开或查回该历史，当前项目属于本次 Run 和文件操作。数据库事务检查当前末端及活跃 Run，成功轮次沿同一原始路径追加。工作区保留项目各自的草稿和文件查看位置。

模型预算以已声明的模型限制和预计编码开销计算，近期文本按完整轮次保留。滚动事务追加上下文根和退出窗口的轮次引用，将旧文本加入 SQLite 全文索引。模型读取近期原文和按当前项目召回的有来源片段，也可直接引用同项目旧轮次。新 Run 固定根、原文范围和召回选择，原生记录继续负责同一 Run 的工具往返、恢复与实际退出。

## 备选方案

讨论过按项目或任务路由多个内部 Session，以及让完整历史始终随模型执行增长。用户选择一条 Session 连续使用，并要求把退出上下文窗口的历史纳入检索。

## 影响与代价

项目、当前模型和原生初始化可在同一连续历史的不同 Run 中变化。近期对话文本沿 Agent 历史选择，退出窗口的文本按当前项目召回。旧项目会话在 Web 历史入口只读展示，原接口按旧语义兼容。历史视图仍按完整已保存路径读取，首版的上下文估算及关键词检索有精度边界。手动选模持久保存覆盖，可改选其他模型。

## 验证

- Linux Node 24 的全仓 `npm run check` 通过，2,393 项中 2,371 项通过、22 项按既有条件跳过。收尾调整后重跑 Personal Agent 包的构建和 8 项测试，全部通过。
- 真实客户端和执行端网关使用临时 SQLite、内存 Vault 与受控 Chat Completions，验证同 Agent 跨项目身份、当前项目文件校验、预算滚动、原始节点回读、自然语言与精确引用召回、不会把召回带入无关下一轮、重复请求、模型配置更新及正常重启后的继续。
- Chrome 以临时宿主验证自动打开、跨项目发送、项目文件和独立草稿、刷新保留历史以及「引用此轮」后发送。`git diff --check` 通过。
- 未用真实付费模型、Electron 或 macOS/Windows 验证本轮行为。连续历史的在途 Run 异常退出未单独注入故障。

## 关联

- [连续历史与上下文手册](../../../../docs/modules/personal-agent/history.md)
- [删除历史召回](../simplification/2026-11-21-remove-personal-agent-history-recall.md) 取代本文的旧问答全文索引及召回方向，沿用连续历史和模型窗口滚动。
- [Personal Agent 的 Harness 起点](../architecture/2026-11-19-personal-agent-harness-baseline.md)
- [Agent 目录](2026-11-19-personal-agent-directory.md)
- [头像导航与工作目录](../simplification/2026-11-19-personal-agent-avatar-navigation.md) 将工作区的项目选择改为自动分配 Agent 工作目录。
- [统一从 Agent 设置选模](../simplification/2026-11-21-personal-agent-default-model-in-settings.md) 取代本文的连续会话 Composer 手动选模方向。
- [Personal Agent 的 Session 子链](../architecture/2026-11-20-personal-agent-session-subchains.md) 接续本项，为长期历史接入子链分页并退役旧项目会话的写入入口。
