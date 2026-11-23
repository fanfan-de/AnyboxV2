# Agent Note: Personal Agent 的单 Session 子链

Status: implemented

## 问题

连续 Session 已有上下文滚动记录，网页仍按完整对话路径和全部 Run 刷新，旧的项目会话入口仍允许一个 Agent 新建多条可写对话。

## 决策

每个 Personal Agent 只开取一条可写 Session。历史树通过各 Run 已保存的上下文根确定成功轮次的子链归属，以首次成功前的末端连接前一子链。没有成功轮次的根可保留接纳与恢复证据，只有成功轮次进入历史树。对话按索引和稳定轮次游标分页，续写始终提交到当前末端。

## 备选方案

讨论过新建 Session 或把完整历史都放入模型上下文，均不符合单一 Session 和长历史目标。沿用已持久化的上下文根和 Run 归属，使子链可以直接在已有库查回，避免重写轮次。

## 影响与代价

旧项目会话保留只读，已接纳的 Run 沿用原请求查询与恢复。本轮使用已有 Session、轮次、Run 和上下文根身份。执行库 v15 增加索引用于首页读取当前末端的有限尝试。Personal Agent 应用与静态资源版本更新到 0.2.2。

## 验证

Personal Agent HTTP 集成已验证同 Agent Session 唯一、滚动子链和父锚、跨链翻页、活跃 Run、v14 升级、旧会话读取与新写拒绝、原幂等查询及重启接续。Chrome 以真实本机宿主和受控模型验证初始读取 24 轮、翻到更早轮次并保留滚动位置，以及分页后从同一 Session 的原末端发送第 30 轮。

Linux 上 `npm run check` 含类型检查、构建与静态资源闭包校验。测试总计 2398 项，2376 项通过、22 项按既有条件跳过、0 项失败。未验证 Electron、真实付费模型或跨版本远程设备。

## 关联

- [上一轮连续 Session](../../implemented/feature/2026-11-19-personal-agent-continuous-session.md)
- [Personal Agent 自有 Prompt](../../implemented/simplification/2026-11-20-personal-agent-owned-prompts.md)
- [连续历史手册](../../../../docs/modules/personal-agent/history.md)
- [历史分页和升级集成测试](../../../../packages/app-personal-agent/tests/http.test.mjs)
- [合入跨模型连续历史](2026-11-22-personal-agent-integrate-session-history.md) 保留分页与已有子链身份，新增子链按完整应用历史重新组包的边界划分。
