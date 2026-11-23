# Personal Agent

0.2.4 将本机 Computer worker 管理移到「执行环境」。尚未选择执行服务时也可管理本机 worker。 [独立管理](../../docs/computer-worker-management.md)

0.2.3 为「Agent 工具」的 [MCP 多连接环境](../../docs/modules/tools/mcp-environment.md) 增加 stdio，与 Streamable HTTP 一起支持逐工具授权。执行端管理本地 stdio 进程并等待退出。已有连续对话可显式采用新的 MCP 目标，影响后续 Run。[执行环境](../../docs/modules/tools/execution-environments.md)

`@anybox/app-personal-agent` 是 Anybox 的独立应用，稳定 ID 为 `personal-agent`。0.2 以 Anybox Harness 的原生会话和执行能力为起点。

从仓库根启动 Personal Agent 的本机开发环境。

```sh
npm run personal-agent
```

终端打印 `#/apps/personal-agent` 的访问地址。本机模式启动 Personal Agent 的客户端和执行端。也可以运行 `npm run web:local` 并从 Anybox 应用菜单打开 Personal Agent。纯客户端 `npm run client` 可以通过应用的连接管理连接提供 Personal Agent 的执行设备。默认执行设备通过 `npm run harness:server` 启动并提供 Personal Agent、Anybox Harness 和 Claude Agent。

首次使用时，在设置中选择执行设备，在「模型管理」中配置模型服务。点击左侧头像即可进入 Agent 的连续对话。顶部是该设备的主 Agent，其他 Agent 在下方。执行端首次打开对话时自动准备该 Agent 的工作目录。「Agent 管理」可创建和编辑 Agent。详见 [Agent 目录](../../docs/modules/personal-agent/agent-directory.md)和[连续历史与上下文](../../docs/modules/personal-agent/history.md)。

旧版任务、对话和成果保留在原客户端数据库。新版工作区使用 Harness 原生会话与 Run 格式。模型配置继续使用 Personal Agent 的 JSON 和对应的系统 Vault。

角色、资源边界、组件手册及验证入口见 [Personal Agent 手册](../../docs/modules/personal-agent/README.md)。
