# Agent Note: Personal Agent 自有 Prompt

Status: implemented

## 问题

Personal Agent 的 Agent 目录已经保存各自的指令，共享 Prompt 库与绑定组件仍能为同一 Agent 提供另一条配置路径。

## 决策

把 Agent 目录作为 Personal Agent 的 Prompt 配置入口，使用现有的修订检查和退出保护。移除共享 Prompt 库、发布和绑定的组件、HTTP 路由与界面。Run 创建原生初始化时读取所选 Agent 的记录。

## 备选方案

保留共享库和发布绑定会让两个入口继续控制同一份指令。本轮移除完整共享流程。

## 影响与代价

连续对话的下一次新 Run 使用所选 Agent 当前的 Prompt。已固定原生初始化的项目会话、已接受 Run 及恢复仍沿用各自的快照。目录升级接续生效的旧指令文本和原生角色。旧共享库记录留在原数据库，后续的新 Run 直接使用用户本轮输入并忽略旧绑定。Personal Agent 应用与静态资源版本更新到 0.2.1。

## 验证

Linux 上全仓 TypeScript 检查、构建和浏览器资源闭包校验通过。首次全仓测试因 `/tmp` 的 inode 配额失败一项，将临时目录迁到有空间的文件系统后，以相同参数重跑全仓测试，2374 项通过、22 项跳过、0 项失败。

集成测试使用受控模型核对不同 Agent 的实际模型输入，并验证连续对话采用新 Prompt、旧项目初始化复用原快照、SQLite 迁移和旧路由退役。Linux Chrome 加载 0.2.1 进行独立本机验收，确认两份 Prompt 可分别保存和刷新读取，未保存时拦截切换。真实付费模型和 Electron 界面未验证。

## 关联

- [上一轮 Agent 目录决策](../../implemented/feature/2026-11-19-personal-agent-directory.md)
- [Agent 目录组件手册](../../../../docs/modules/personal-agent/agent-directory.md)
- [运行与升级集成测试](../../../../packages/app-personal-agent/tests/http.test.mjs)
