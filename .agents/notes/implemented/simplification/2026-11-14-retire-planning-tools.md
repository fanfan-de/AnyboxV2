# Agent Note: 退役计划与待办工具

Status: implemented

## 问题

用户要求逐步精简 Anybox Harness 工具，先去掉 update_plan 与 todo_write 这两类计划/待办能力。当前对应 Codex、Claude Code、DeepSeek Harness 三个来源契约，默认集包含 Codex update_plan。

## 决策

公开目录与新工具选择移除三个计划契约，默认集由十项减为九项，其他工具维持原契约。已有 Agent 设置读取时只过滤已知退役项并保留修订号，新 Session 使用过滤后的选择；已有 Session 的不可变定义、历史事件及实际续跑/恢复保留最小兼容。工具设置去掉计划分类，历史结果展示仍可读取。

## 备选方案

- 仅修改默认集：仍可重新勾选计划工具，不能满足移除这类工具的要求。
- 直接删除所有定义及执行分支：会使固定过原契约的 Session 和恢复记录失效，因此只在新选择中退役，保留实际需要的历史读取与执行适配。
- 一次合并其余工具或重构 Agent 设置：用户要求慢慢改，本轮不扩大范围。

## 影响与代价

公开工具由 22 项减为 19 项，新会话不再声明计划/待办工具，界面不再显示计划分类。旧会话保持原选择及结果展示；无需改写历史快照或数据库迁移。worker 资源所有权、取消与实际退出规则不变。

## 验证

- 本轮定向运行目录、Agent 工具设置、HTTP、四协议工具库、Computer Operations、设置客户端及 Session 恢复七个测试文件，122 项全部通过。覆盖三项退役工具的新选择拒绝、旧设置过滤与修订号保持、四协议新调用拒绝、旧快照原调用及重启续跑、历史事件读取。
- 两次根 `npm run check` 的构建/类型检查通过。首次测试为 2268 项、2247 通过、4 失败、17 跳过；复跑为 2268 项、2248 通过、3 失败、17 跳过，均非全绿。首次失败涉及 unit restart、worker cancellation 和两个进程 scope 清理用例，复跑仍失败前三者中的 unit restart、worker cancellation 与 component disposal。两次 unit restart 超时后测试进程保留，均终止该测试子进程后取得完整结果。
- 四项失败用例使用当前构建产物隔离重跑全部通过（unit restart 单独运行，其余三项以 `--test-concurrency=1` 运行）。这些夹具只使用 Bash/进程工具，尚未定位并发全量执行时失败的原因，不能宣称全量检查通过；本轮未修改 worker 或进程实现。
- `git diff --check` 通过。测试使用临时目录、受控模型与内存凭据；未运行真实模型、用户业务数据或 Windows/Linux 平台验收。

## 关联

- 当前设计：[工具库](../../../../docs/tools-library-design.md)、[工具组件](../../../../docs/modules/tools/README.md)。
- 实现：[目录](../../../../packages/app-harness/src/core/tool/catalog.ts)、[Session 存储](../../../../packages/app-harness/src/core/session/sqlite-records.ts)、[Run 准入](../../../../packages/app-harness/src/core/run/component.ts)。
- 前项：[原生工具请求有界纠错](../bug-fix/2026-11-11-bounded-tool-request-correction.md)；本轮退役该记录中用于示例的计划契约，不改变整批预检与有界反馈方向。
