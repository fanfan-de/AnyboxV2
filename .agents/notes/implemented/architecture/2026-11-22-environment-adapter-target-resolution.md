# Agent Note: 由环境适配器解析工具目标

Status: implemented

## 问题

共享工具绑定解释 Computer 附着身份，Session 和 Run 直接导入 MCP 接线。新增多目标提供方时，通用执行链需要了解具体提供方。

## 决策

用户已确认先收口目标解析与应用装配。两款应用的组合根向 Session、Run 提供通用目录与绑定，并在当前 Nya 依赖代装配执行入口。Computer 适配器负责项目附着、目标身份、工具上限与报告契约，以及 Shell 提示。MCP 适配器提供连接目标，共享路由统一校验目标与工具契约。接受事务仍用原项目绑定核对授权，旧快照沿用历史适配。

## 备选方案

通用路由继续按环境名分派，需要随着提供方增加修改共享代码。将解析委托给适配器有明确的依赖边界。

## 影响与代价

现有目标身份、授权代次、偏好和普通会话快照兼容。静态环境继续通过 `toolEnvironments` 接入。新多目标环境在应用组合根贡献目录、Nya 依赖和执行绑定。

## 验证

构建和 69 项定向测试通过，覆盖通用上下文目标、静态 Notes、两款应用的 HTTP/stdio MCP、远端 Computer 项目与旧快照恢复。最终 `npm run check` 通过类型检查、构建和浏览器资源闭包校验，2483 项测试中 2465 项通过、18 项按条件跳过、0 项失败。验证在 macOS 本机完成，未实测 Windows/Linux 部署。

## 关联

- [工具环境描述与执行绑定](../../implemented/architecture/2026-11-15-tool-environment-boundaries.md)
- [后续逐目标退出确认](../bug-fix/2026-11-22-tool-environment-target-exit-proof.md)
- [执行环境授权](../../../../docs/modules/tools/execution-environments.md)
- [Computer 适配器](../../../../packages/app-harness/src/core/tool-environments/computer.ts)
- [目标路由测试](../../../../packages/execution-environments/tests/targets.test.mjs)
