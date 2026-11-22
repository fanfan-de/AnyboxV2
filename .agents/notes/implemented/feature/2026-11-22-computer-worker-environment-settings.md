# Agent Note: 在执行环境中管理本机 Computer worker

Status: implemented

## 问题

Anybox Harness 和 Personal Agent 的「管理连接」里同时出现执行服务连接和本机 Computer worker，容易把工具执行设备和应用的执行服务混为一谈。

## 决策

「管理本机 Computer worker」位于两款应用的「执行环境」，点击后才读取本机状态。该页分别展示所选执行服务可使用的环境与客户端服务所在设备提供的 Computer 工具。即使尚未连接执行服务，也可管理本机 worker。「管理连接」提供执行服务地址、访问凭据、连接检查及 Agent 启停。

## 备选方案

曾讨论将入口留在「管理连接」。Worker 管理与工具执行和附着权限同属 Computer 环境流程，合并到「执行环境」可以在同一分类找到接入步骤的两端。

## 影响与代价

附着码引导和当前使用文档已更新。管理请求走各应用的本机客户端 API。关闭设置会清除附着码，退出界面会等待已提交的变更结束。应用版本升级为 Anybox Harness 0.1.10 和 Personal Agent 0.2.4。

## 验证

`npm run check` 共 2476 项，2458 通过、18 跳过、0 失败。回归覆盖两款应用的入口、无连接时的独立本机 HTTP 管理、关闭清码与已提交写入排空。

本机 Web 重启后两个执行目标均恢复运行。Chrome 分别检查两款应用在已接入执行服务和测试页模拟无连接时的入口，确认状态读取发往各自本机 `/computer/status`，且已接入时环境列表继续走所选连接。浏览器验证范围为 Web。Personal Agent 的现有 worker 在变更前后均报告 `worker-build-mismatch`，本轮只观察该状态。

## 关联

[Computer worker 独立管理](../../../../docs/computer-worker-management.md) · [执行环境](../../../../docs/modules/tools/execution-environments.md) · [界面回归](../../../../tests/units-client.test.mjs) · [MCP 执行环境](2026-11-22-mcp-execution-environment.md)
