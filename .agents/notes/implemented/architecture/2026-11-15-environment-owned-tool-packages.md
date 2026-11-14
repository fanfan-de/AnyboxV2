# Agent Note: 环境提供工具与工具独立拆包

Status: implemented

## 问题

工具实现、来源契约与 Harness 的 Project、Session、Models 和 Run 类型仍相互引用，单纯移动目录无法让其他 Agent 独立消费。用户确认不使用 MCP，要求 Agent 按插入的环境获得该环境提供的工具；多 Computer 不是本轮必须目标。环境变更仅影响新会话，已有会话固定环境与工具快照。

## 决策

- 提取无 Harness/Models/Nya 运行依赖的 `@anybox/tool-api`，以及保留四个真实 Nya 资源组件的 `@anybox/computer-tools`。
- 建立受信环境提供工具描述与执行的契约；现有 Computer 作为适配，允许受信装配提供其他环境，不开放任意远端 schema、运行时代码或 MCP。
- Agent 选择环境，环境决定可提供的工具，既有工具偏好仅作进一步筛选。创建 Session 时固定环境身份、契约版本及完整工具定义，旧会话沿兼容路径继续执行。
- 继续使用原 Computer 操作账本、固定工作区与 worker 通道，保留整批副作用前验证、取消请求与真实退出分离、原结果查询和未知副作用不重放。
- 工具与原生执行资源随应用生产闭包发布，不加入最小宿主核心；应用交付版本随实现升版。

## 备选方案

- 全部通过 MCP：用户明确不采用，其工具解耦目标通过包与接口完成。
- 仅搬迁 `core/tool/`：不能切断领域反向依赖、Runtime 错误特判及具体工具分派，不采用。
- 以单 Run 多 Computer 为核心扩展：用户澄清该场景仅是环境组合的可能结果，本轮不为此先扩展多个固定 Computer scope。
- 每个模型工具独立 npm 包或另建通用工具生命周期：当前四个组件共享真实资源，保留 Nya 资源所有权及既有协调。

## 影响与代价

新增独立包、公开契约、环境快照与装配适配，构建和制品路径随所属资源调整。保存旧工具身份、定义与历史；新环境缺失、版本改变或无法查回原操作时必须明确拒绝继续或保留未知结果，不能自动换环境重放。工作区已有其他未提交修改，本轮以其当前状态为基础，不将其归为本轮变更。

## 验证

已完成独立包与通用环境实现、会话快照、Computer 适配、纯入口与生产资源迁移，删除原执行内核和仅重导出的旧入口。定向验证覆盖隔离生产闭包消费、仅新会话生效、真实原生 Loop 与非 Computer 环境、混合环境、取消双退出屏障、原操作观察恢复与默认拒绝重放，以及恢复中清理失败不能被旧成功提案覆盖。

首轮根检查发现历史恢复测试未明确声明退役工具、旧手工初始化与 mock 接口和迁移版本断言需要同步；修正样本后相应 43 项会话/恢复测试通过。另定位 macOS 原生进程组只剩退出成员时的暂态 EPERM：仅在原期限内保守保留并继续等 ESRCH，不据 EPERM 证明退出。相关两文件重复 10 轮 180 项通过，并逐轮验证 240 次真实父子退出；原 TERM→KILL grace 保持 40ms。原生专项 29 项中 27 通过、2 个既有 Windows 门控跳过。证据为[真实进程回归](../../../../tests/native-tool-platform.test.mjs)、[进程 scope](../../../../tests/process-tools.test.mjs)与 [Apple XNU killpg1](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c)。

最终在 macOS arm64、Node.js v24.16.0 运行根 `npm run check` 通过类型检查、全部 workspace 构建、浏览器资源闭包校验及完整测试：2309 项，2292 通过、17 个既有条件跳过、0 失败。`git diff --check` 通过，更新的工具/执行/会话文档及本记录本地链接有效。真实其他操作系统、跨机器设备与正式桌面签名成品未在本轮实测。

## 关联

- [后续：收口工具环境的描述、绑定与 Computer 兼容边界](2026-11-15-tool-environment-boundaries.md)将纯描述与执行绑定分离，替代原注册表中的 Computer 特判与运行期覆盖；原工具拆包及耐久事务方向继续保留。
- [工具模块](../../../../docs/modules/tools/README.md)
- [工具库](../../../../docs/tools-library-design.md)
- [环境提供工具与接入示例](../../../../docs/tool-environments.md)
- [真实环境执行与恢复测试](../../../../tests/tool-environment-runtime.test.mjs)
- [隔离生产包消费](../../../../packages/computer-tools/tests/package-consumer.test.mjs)
- [Computer Operations](../../../../docs/modules/computers/computer-operations.md)
- [执行环境](../../../../docs/modules/computers/environments.md)
- [工具清单方向](../../implemented/feature/2026-11-14-computer-tool-manifest.md)
- [退役计划工具](../../implemented/simplification/2026-11-14-retire-planning-tools.md)
