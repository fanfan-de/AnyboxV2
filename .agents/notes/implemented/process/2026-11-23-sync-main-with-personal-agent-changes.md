# Agent Note: 同步 main 与本机 Personal Agent 改动

Status: implemented

## 问题

远端 `main` 已接入执行环境和多工作区运行。本机尚未提交的 Personal Agent 改动将 Prompt 收归 Agent，并调整连续会话历史与存储。三方合并在 17 个文件产生冲突。

## 决策

在隔离工作树合并并验证本机改动，再快进本地 `main` 并重放合并结果。保留连续会话和 Agent 配置契约，同时接入远端执行环境授权、管理和运行约束。合并结果在主工作树保留为未提交改动。

本地和远端各自使用 `run-state` v20 添加不同的表。合并版本以 v21 补齐布局并保留两边的已有记录。按确认沿用远端规则，缺少授权快照的旧在途 Run 只允许清理、结算或取消。

## 备选方案

比较过直接在主工作树重放的做法。隔离工作树能在验证期间保留原有改动，并在同步前检查完整结果。也比较过为可核验的旧 Run 建立兼容恢复，本轮沿用远端已有的授权边界。

## 影响与代价

同步涉及 Personal Agent 的 API、会话和执行存储、设置界面与包元数据。合并后的 Personal Agent 包版本为 `0.2.6`，以独立资源路径区分远端 `0.2.5`。旧项目会话继续作为只读历史，已有授权另行保存在原执行库中。

## 验证

已在隔离工作树解决 17 个冲突。在 Linux、Node.js v24.22.3 上，类型检查、构建及浏览器资源完整性校验通过。更新测试夹具后，以测试脚本相同的 Node 参数复跑全仓用例，2,509 项通过，22 项按条件跳过，0 项失败。其中包括两种 v20 布局迁移、授权快照缺失时的恢复行为及两款应用的 MCP 授权和退出。未进行桌面实机或在线服务验收。

提交前在主工作树补齐本地 npm 工作区链接，复跑类型检查和 `npm test`。构建与浏览器资源校验通过，全仓测试 2,509 项通过、22 项跳过、0 项失败。暂存差异通过 `git diff --cached --check`。

## 关联

- [执行环境合入记录](../../implemented/process/2026-11-23-merge-execution-environments.md)
- [会话历史整合记录](../../implemented/architecture/2026-11-22-personal-agent-integrate-session-history.md)
- [Agent 自有 Prompt](../../implemented/simplification/2026-11-20-personal-agent-owned-prompts.md)
