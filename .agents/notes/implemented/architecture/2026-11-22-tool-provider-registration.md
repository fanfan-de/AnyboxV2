# Agent Note: 由提供方注册工具

Status: implemented

## 问题

Anybox Harness 和 Personal Agent 的组合根分别维护 Computer、MCP 和自定义环境的描述、目标查询和执行绑定。新增带目标的提供方也需要接入两份授权管理代码。用户希望参照 DeepSeek Harness，让具体组件拥有工具注册及执行资源，并供多个应用装配。

## 决策

两款应用通过 `registerTools` 和内置注册装配同一个工具注册表实现。每个受信提供方贡献一份声明，供共享注册表生成目录和运行分派。目录依赖和执行依赖按 Nya 当前代分别注入。单工具可用 `defineTool` 声明参数和执行函数。`@anybox/computer-tools/environment` 提供共用目录和执行作用域，应用适配其项目、Run 和 worker；MCP 组件提供自己的注册和连接目录。

## 备选方案

比较了运行期可变注册和受信组合时注册。采用装配期同步注册，利用 Nya 的依赖撤销和现有退出证明约束目录及执行引用的生命周期。DeepSeek 的注册表和工具提供方边界提供参照。

## 影响与代价

两款应用使用同一套目录、绑定和目标授权校验。授权事务重新读取注册的目标，旧目标失效后可以撤销其既有授权。应用持有独立配置、会话和授权，延续已有工具身份、持久快照和退出证明。既有 `toolEnvironments` 构造参数进入同一注册表。

## 验证

本机 macOS 的 `npm run check` 通过。类型检查与构建成功，2471 项测试通过，18 项依现有条件跳过。重点覆盖独立服务启动、两款应用的 MCP 目标和逐工具授权、直接注册的工具经过原生 Run 分派，以及 Computer worker 中断恢复和退出证明。Windows、真实模型、真实系统凭据和 Claude CLI 等门控用例沿用其独立验收条件。`git diff --check` 通过。

## 关联

- [DeepSeek Harness 工具设计](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/tools.md)
- [Anybox 环境契约](../../../../docs/tool-environments.md)
- [目标解析方向](2026-11-22-environment-adapter-target-resolution.md)
- [运行时注册测试](../../../../tests/tool-environment-runtime.test.mjs)
