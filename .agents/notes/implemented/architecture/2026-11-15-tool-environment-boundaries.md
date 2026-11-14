# Agent Note: 收口工具环境的描述、绑定与 Computer 兼容边界

Status: implemented

## 问题

用户要求先解决工具环境抽象仍特殊对待 Computer 的问题。通用注册表解释 Computer 工具依赖、退役工具与清理回执，RunRuntime 直接构造 Computer 并覆盖先前只有描述的提供方，类型没有表达描述与执行就绪的差别。

## 决策

用户已确认解决这一边界问题。采用纯环境 catalog 与本代执行绑定：`ToolEnvironmentDescriptor` 不提供执行入口，Computer 依赖校验与退役工具由显式 catalog 项声明；受信装配通过现有 Runtime 的 Nya inject/deps 绑定完整执行提供方，不增加纯注册组件或子 Context。绑定拒绝缺失、重复、版本/定义/恢复声明不符及仅有描述的对象；通用注册表和 Runtime 不再构造 Computer、覆盖提供方或探测进程类型。

新关闭操作统一为 `tool-environment-scope-close` / `tool-environment-cleanup`，报告按环境身份聚合。历史适配复用旧关闭操作的 ID、intent 及原始回执表示，不改写已提交观察；恢复中新发生的真实退出失败仍阻止成功结算。Session 输出统计与 HTTP 白名单投影同时读取新 envelope 和旧 Computer 报告，其他环境的同名字段不被解释为 Computer 退出。

Session 同事务接纳、两端账本、owner 栅栏、原操作查询及真实退出屏障保持原有职责。正式 Harness 组合继续提供 Computer 的项目与耐久账本；低层 Runtime 可以只绑定普通环境而不安装 Computer Operations。

## 备选方案

- 只移动 Computer 判断到命名不同的通用 helper，仍保留 metadata 提供方与 override：没有解决描述冒充执行、运行期具体依赖的问题，不采用。
- 为纯注册表新增 Nya 组件或子 Context：没有新的独立资源所有权，不采用；绑定复用现有 Runtime 的依赖代。
- 直接改写旧关闭记录为新 envelope：会破坏已保存操作/观察的幂等匹配，不采用；旧记录只读兼容。

## 影响与代价

新增纯描述类型与 Harness 内部 catalog/bind 契约，调整内部低层装配调用；应用对外的 toolEnvironments 提供方入口保持可用。新关闭记录使用通用环境 envelope，旧记录不迁移、不重放。删除不再使用的 Computer scope 进程探测接口。Computer worker 控制身份、项目绑定、数据库与进程所有权保持原有归属。Harness 应用升至 0.1.4，并同步清单、发行依赖与锁文件；本轮没有安装或生效运行中的应用。

## 验证

- `npm run check` 通过：类型检查、所有 workspace 构建、浏览器资源闭包校验及完整测试共 2329 项，2312 通过、17 项条件跳过、0 失败。
- 定向行为覆盖纯描述/完整绑定、普通同名 Computer 环境无特判、旧工具仅显式兼容、无 Computer Operations 的独立 Runtime 执行、新旧清理操作及已确认回执恢复、实际退出失败优先、混合环境、取消双屏障、真实进程退出及尾输出计数；HTTP 验证新旧报告白名单投影及其他环境同名字段不泄漏。
- 另运行 Harness `typecheck` 通过；`git diff --check` 通过，修改的 Markdown 本地链接目标均存在。
- 本轮验证为本机环境与模拟模型服务；未实测其他操作系统、真实跨机器网络、真实模型 API 或正式签名桌面成品。

## 关联

- [前项：环境提供工具与工具独立拆包](../../implemented/architecture/2026-11-15-environment-owned-tool-packages.md)
- [环境提供工具](../../../../docs/tool-environments.md)
- [RunRuntime](../../../../docs/modules/execution/run-runtime.md)
- [环境注册表](../../../../packages/app-harness/src/core/tool-environments/registry.ts)
- [环境行为测试](../../../../tests/tool-environments.test.mjs)
- [Runtime 行为与旧清理恢复](../../../../tests/tool-environment-runtime.test.mjs)
- [历史清理记录兼容](../../../../tests/tool-environment-history.test.mjs)
- [HTTP 投影](../../../../tests/harness-server-http.test.mjs)
