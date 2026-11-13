# Personal Agent

[返回组件清单](../README.md) · [应用说明](../../../packages/app-personal-agent/README.md)

Personal Agent 是独立 Anybox 应用；Agent 同级，用途由配置决定。当前是本机产品验证版，直接复用 Models 文本生成、系统凭据、SQL、Nya 与应用生命周期基础。

| 组件 | 名称与职责 |
| --- | --- |
| [工作区与执行](workspace.md) | `personal-agent-workspace`：Agent、对话、Task、Run、委派、成果、上下文、准入和恢复 |
| [HTTP 与界面](http.md) | `personal-agent-http`：应用自有 API、独立模型设置和浏览器主流程 |

从根运行 `npm run personal-agent` 启动只含该应用的 Anybox 客户端，或使用默认 `npm run client`。应用安装和打开分别由宿主处理。首次进入先设置模型，再在 Agent 配置中选择它。配置列表中的“可用”只表示本地配置就绪，实际账号权限在执行时由模型服务返回。

首版不提供执行工具、自动委派、定时任务、Skills 文件加载、远端实例绑定、设备迁移及共享资源权限。模型结果不会自动标记任务完成或写入记忆；用户决定下一次推进、等待、完成和成果保存。多角色部署不属于当前版本，不改变现有 Harness 或 Claude 的客户端/执行端组合。
