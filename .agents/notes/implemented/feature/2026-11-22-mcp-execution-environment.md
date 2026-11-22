# Agent Note: MCP 多连接执行环境

Status: implemented

## 问题

Anybox Harness 和 Personal Agent 的 Agent 工具目录需要接入多条 MCP Streamable HTTP 连接。每条连接可以公布同名工具，授权与实际分派需要固定到正确的连接及工具契约。

## 决策

两款应用各自在执行根装配 `@anybox/mcp-environment`。共享目录将一个 `mcp` 环境接到多个连接目标，沿用确切工具授权、Run 准入和退出账本。应用提供连接添加、发现和停用，以及按连接保存的工具偏好。授权、发现和偏好各自独立。Personal Agent 连续会话显式采用新的目标集合。

## 备选方案

讨论过按每条连接定义单独环境。采用同一环境下的多目标模型，使 Agent 能按环境选用能力，并按连接和工具授权。

## 影响与代价

带目标的会话使用 v2 快照，保留 v1 读取和既有 Computer 目标身份。首版支持匿名 HTTPS 和字面回环 HTTP 的普通 Streamable HTTP 工具。执行端重启后由操作员再次发现工具。已发送但缺少远端退出证据的操作保留未知状态，刷新或重建同一端点的连接不会重放或解除原限制。两款应用版本提升到 0.1.8 和 0.2.2。

## 验证

`npm run check` 完成类型检查、构建及测试，2444 项通过、18 项跳过、0 项失败。端到端测试通过两款应用的实际客户端网关和 Run 入口访问两台回环 MCP Server，分别使用 JSON 和 SSE 响应。测试确认未授权工具调用未发出、双授权按目标正确分派，以及停用后旧会话拒绝续跑。MCP 包测试另验证取消通知、断连和重启后的未知状态。macOS arm64 的两个本地应用目录已临时构建，确认复制后的 MCP 依赖和纯执行注册入口可读。验收使用离线模型夹具，签名发布、外部 MCP 服务及其他平台未验证。

## 关联

- [MCP 执行环境组件](../../../../docs/modules/tools/mcp-environment.md)
- [两款应用端到端测试](../../../../tests/mcp-execution-environment.test.mjs)
- [执行环境管理方向](../architecture/2026-11-22-implement-execution-environment-management.md)
