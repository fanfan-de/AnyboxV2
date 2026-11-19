# Personal Agent

`@anybox/app-personal-agent` 是 Anybox 的独立应用，稳定 ID 为 `personal-agent`。0.2 以当前 Anybox Harness 的项目、会话、设置和原生执行为起点，可以在自己的应用包内继续演化。

从仓库根启动 Personal Agent 的本机开发环境。

```sh
npm run personal-agent
```

终端打印 `#/apps/personal-agent` 的访问地址。本机模式启动 Personal Agent 的客户端和执行端。也可以运行 `npm run web:local` 并从 Anybox 应用菜单打开 Personal Agent。纯客户端 `npm run client` 可以通过应用的连接管理连接提供 Personal Agent 的执行设备。默认执行设备通过 `npm run harness:server` 启动并提供 Personal Agent、Anybox Harness 和 Claude Agent。

首次使用时，选择执行设备并打开其 Personal Agent，在设置的「模型管理」中添加模型服务和 API Key，再登记项目目录并创建会话。项目、会话、Run、设置、图片、Computer worker 和凭据由 Personal Agent 实例独立拥有。

旧版任务、对话和成果保留在原客户端数据库。新版工作区使用 Harness 原生会话与 Run 格式。模型配置继续使用 Personal Agent 的 JSON 和对应的系统 Vault。

角色、资源边界、组件手册及验证入口见 [Personal Agent 手册](../../docs/modules/personal-agent/README.md)。
