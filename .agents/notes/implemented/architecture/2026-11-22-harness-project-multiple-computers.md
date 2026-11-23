# Agent Note: 一个 Harness 项目在同一 Run 使用多台 Computer

Status: implemented

## 问题

开发机持有项目源码，部署服务器持有服务和日志。现有项目的单个 Computer 绑定使两处操作无法在同一 Run 中分别授权、派发和查回。

## 决策

保留主工作区，为项目增加具名的附加电脑和目标侧工作目录。会话固定工具声明及每项工具的设备归属，Run 按目标取得实际使用的资源。部署示例用项目已有的发布渠道传递经过测试的固定版本。产品流程、协议适配、旧数据读法与验收见[方案](../../../../docs/harness-project-multiple-computers-design.md)。

## 备选方案

比较过让 Agent 切换全局当前电脑、为所有工具增加目标参数，以及让本机直接触发现有部署系统。采用按目标分配模型工具名的方向，以便用户、模型与恢复程序都能识别同一次操作的原目标。

## 影响与代价

本设计经后续[功能实施](../feature/2026-11-22-harness-project-workspace-execution.md)接入 Anybox Harness。项目配置、模型工具声明、Computer 工作区和 worker 操作身份均已扩展。保持已有会话的工具声明与已有操作的恢复身份。

## 验证

对照代码核对了项目绑定、原生协议工具声明、Session、Computer 操作账本和 worker 作用域，并检查了新增文档链接。现有实现的 `npm run check` 在隔离副本通过（macOS、Node v24.22.3），2474 项通过，18 项按运行条件跳过。设计阶段验证的是原有实现。后续双机发布、断线查回和跨协议用例见功能实施记录。

## 关联

[原项目单设备绑定](../../implemented/feature/2026-11-11-project-computer-environments.md) · [工具包归属与多 Computer 的前次范围](../../implemented/architecture/2026-11-15-environment-owned-tool-packages.md) · [执行环境授权设计](../../../../docs/agent-execution-environments-design.md)
