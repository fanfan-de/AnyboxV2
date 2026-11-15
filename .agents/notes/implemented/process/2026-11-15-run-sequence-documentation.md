# Agent Note: 保存 Run 执行时序图

Status: implemented

## 问题

用户要求把已在对话中确认的 Anybox Harness Run 时序图保存到项目合适的文档位置，便于后续查阅和维护。

## 决策

将可编辑的 Mermaid 时序图保存为执行模块的 `run-sequence.md`，从模块 README 的完整流程章节引入。保留准入、原生协议循环、通用工具环境与 Computer worker、清理和原子结算的主线，并说明合并泳道及 result/done 的含义。

## 备选方案

未保存为单独图片：Mermaid 可随源码修改，并可在支持 Mermaid 的 Markdown 阅读器中显示。未把跨组件说明加入组件目录表，避免将图中的泳道误认为新的 Nya 组件。

## 影响与代价

仅新增执行说明与导航，不改变运行代码、接口、数据或资源归属。后续调整 Run 生命周期时需要同步维护时序图；组件手册继续维护接口与完整恢复规则。

## 验证

- 对照当前准入、协议交换、Runtime 清理与 Session 结算源码，并经只读复核确认主图与生命周期说明一致。
- 新文档、执行模块导航与本记录共 36 个本地 Markdown 链接目标存在；Mermaid 的 alt/opt/loop 分支嵌套检查通过。沿用对话中已展示的时序图，未额外进行 Markdown 阅读器渲染或图片导出。
- `git diff --check` 通过；根 `npm run check` 通过，包含类型检查、所有 workspace 构建、Web 资源闭包校验及 2329 项测试：2312 通过、17 项条件跳过、0 失败或取消。
- 本轮为文档变更；未额外进行真实模型、跨机器部署或其他操作系统实测。

## 关联

- [Run 执行时序图](../../../../docs/modules/execution/run-sequence.md)
- [执行模块](../../../../docs/modules/execution/README.md)
- [RunRuntime](../../../../docs/modules/execution/run-runtime.md)
- [相关方向：工具环境的描述、绑定与 Computer 兼容边界](../../implemented/architecture/2026-11-15-tool-environment-boundaries.md)
