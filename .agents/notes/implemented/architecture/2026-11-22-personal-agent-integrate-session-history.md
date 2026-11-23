# Agent Note: 将子链分页与跨模型连续历史合入当前分支

Status: implemented

## 问题

远端提交 `9c9e076` 引入完整跨模型历史。本地正在开发同一 Session 的子链分页、旧项目会话只读、Agent 自有 Prompt。两方修改了同一组 Run 准入、历史存储、网关和工作区接口。现有执行库可能来自任一版本。

## 决策

按用户选择在当前分支合入两边功能。模型按当前 API 使用完整历史，工作区按稳定轮次游标分页。保留已有根、节点和 Run 身份，并让新成功轮次按原生续接边界归入子链。保留每个 Agent 的独立 Prompt 与设置中的默认模型入口。

## 备选方案

独立工作目录与临时搁置本地改动都可运行远端版本，但无法同时使用本地功能。

## 影响与代价

模型实际接收的历史范围独立于页面加载的轮次。执行库 v20 补齐两种 v15 及远端 v19 历史的子链边界。Personal Agent 应用和静态资源版本从本地 0.2.2 升至 0.2.3，使新快照可与旧安装区分。

## 验证

Linux、Node 24.22.3 的 `npm run check` 通过类型检查、工作区构建和浏览器资源校验。全仓 2427 项中 2405 项通过、22 项按条件跳过、0 项失败。

真实本机宿主与网关上的 8 项 HTTP 集成测试使用受控模型响应，覆盖四种 API 的历史续接、跨页游标、换模型与换 Key、重启恢复及各 Agent 指令。4 项 SQLite 迁移回归使用本地 v15 与上游 v15、v17、v18 的数据库约束，本地样本验证跨页取回两个原根及父锚。HTTP 测试另覆盖上游 v19 历史。未验证真实付费模型、Electron 或其他操作系统。

## 关联

- [会话子链](2026-11-20-personal-agent-session-subchains.md)
- [Agent 自有 Prompt](../simplification/2026-11-20-personal-agent-owned-prompts.md)
- [跨协议历史](../feature/2026-11-21-personal-agent-cross-protocol-history.md)
- [连续历史手册](../../../../docs/modules/personal-agent/history.md)
- [SQLite 迁移回归](../../../../packages/app-personal-agent/tests/session-migration.test.mjs) · [网关与执行端测试](../../../../packages/app-personal-agent/tests/http.test.mjs)
