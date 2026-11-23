# Agent Note: 按实际工具目标确认退出与恢复

Status: implemented

## 问题

Run 为全部已声明工具共用一条耐久作用域准入。混用 Computer 和 Notes 时，只执行 Computer 的 Run 异常退出后，未调用的 Notes 缺少原操作查询也会让恢复放弃确认整条作用域，随后 Computer 工具被未知退出状态阻断。此前已在授权层复现。

## 决策

用户已确认按实际目标处理退出和恢复。首次派发前保存确切目标的作用域准入，再登记耐久工具意图。恢复按原目标接回已有作用域，各目标凭真实 `done` 清除占用。工具结果继续用原操作查询。模型响应未保存的 Run 保持 `interrupted`，启动清理接回已登记目标并证明退出。旧聚合占用保留原身份和保守恢复规则。

## 备选方案

继续以整轮作用域为退出证明单位会把不同提供方的未知状态绑定在一起。仅清除未知标记无法证明资源实际退出。

## 影响与代价

授权账本 v3 增加未退出作用域索引，保留已有授权、历史与原关闭回执。Run 继续协调整轮取消与最终结算。提供方可独立实现原作用域恢复，缺少退出证据的目标保留未知占用。Anybox Harness 与 Personal Agent 分别升至 0.1.11 和 0.2.5。

## 验证

旧构建复现真实进程中断后的整轮恢复失败，以及模型请求待定时遗留 Computer 占用。修复后两条 SIGKILL 回归均通过，覆盖 Notes 无作用域、原 Computer 回执、单次副作用以及同目标后续准入。69 项定向测试全部通过。首轮完整检查发现 Personal Agent 版本化资源路径滞后，已同步到 0.2.5。最终 `npm run check` 的 2483 项测试中，2465 项通过、18 项按条件跳过、0 失败。验证使用 macOS、本机模型对端及独立 worker，未实测其他平台部署。

## 关联

- [环境授权管理](../../implemented/architecture/2026-11-22-implement-execution-environment-management.md)
- [前项目标解析](../architecture/2026-11-22-environment-adapter-target-resolution.md)
- [RunRuntime](../../../../docs/modules/execution/run-runtime.md)
- [混合环境 SIGKILL 回归](../../../../tests/computer-unit-faults.test.mjs)
- [授权作用域测试](../../../../packages/execution-environments/tests/authority.test.mjs)
