# Agent Note: Personal Agent 统一从 Agent 设置选模

Status: implemented

## 问题

Composer 可以单击修改当前 Session 的模型，双击再修改 Agent 默认模型。已有 Session 或旧请求中的模型值可以优先生效，使 Agent 设置与下一轮使用的模型不同。

## 决策

Personal Agent 移除 Composer 的选模入口及保存逻辑。设置中的 Agent 默认模型决定连续会话的新 Run。浏览器从 Session 读取当前生效模型，用于输入能力判断，新提交由服务端选模。设置关闭后刷新当前会话。切换 API 沿同一条历史组包，已接纳 Run 保持其模型快照。

## 备选方案

旧设计提供会话级选模和 Agent 默认设置两种控制。用户明确要求在 Agent 设置中管理模型，Composer 只负责发送。

## 影响与代价

现有连续会话下次发送时采用 Agent 当前已设置的模型。默认模型缺省时保留旧 API 的请求和 Session 回退值；旧项目会话接口沿用原生历史绑定与选模规则。浏览器保留已经保存的待提交信息和幂等键。

## 验证

- Personal Agent 工作区构建通过，包内 17 项测试全部通过。覆盖已有 Session 和请求模型无法覆盖有效的 Agent 默认值，以及通过 Agent 设置换过四种 API 后的完整历史续接。
- 会话视图、Composer 默认设置及选模控制器相关的 85 项测试全部通过，覆盖选模入口移除、上下文用量仍可见，以及新提交和恢复请求省略模型字段。Personal Agent 的 65 个声明资源均可读取，`git diff --check` 通过。
- 界面使用本地 DOM 测试，模型使用回环替身。未做真实浏览器、桌面或线上提供方验收。

## 关联

- [Personal Agent 连续历史](../../../../docs/modules/personal-agent/history.md)
- [Agent 目录与设置](../../../../docs/modules/personal-agent/agent-directory.md)
- [Personal Agent 的跨协议历史](../feature/2026-11-21-personal-agent-cross-protocol-history.md)
- [Personal Agent 的连续历史](../feature/2026-11-19-personal-agent-continuous-session.md)
