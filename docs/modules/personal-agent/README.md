# Personal Agent

[返回组件清单](../README.md) · [启动与配置](../../../packages/app-personal-agent/README.md)

Personal Agent 0.2 起以 Anybox Harness 的客户端、执行端和 Computer worker 为演化起点。`@anybox/app-personal-agent` 持有自己的实现和构建产物，稳定应用 ID 为 `personal-agent`。左侧头像打开当前执行设备上所选 Agent 的连续历史。执行端为每个 Agent 自动准备工作目录，工作区显示原始历史、工作文件和 Run 实时记录。

## 组件文档

下表链接各组件的独立手册。通用的接口、依赖、执行与清理规则沿用这些手册。阅读时以 [Personal Agent 装配与数据边界](runtime.md) 为准识别本应用的服务、路径和入口。手册中的 Harness 业务标识和兼容路由属于 Anybox Harness。

| 职责 | 组件手册 |
| --- | --- |
| 客户端设备连接、网关和本机 worker 管理 | [Client Connections](../web/client-connections.md) · [Client Gateway](../web/client-gateway.md) · [Client Computer](../web/client-computer.md) |
| 执行设备业务 HTTP 与流式观察 | [业务 HTTP](../web/harness-http.md) |
| 模型配置、凭据、协议和公开目录 | [Models 组件](../models/README.md) |
| Agent 身份、创建、编辑与头像 | [Agent 目录](agent-directory.md) |
| 工作目录、连续历史、文件和图片 | [工作目录](runtime.md#工作目录) · [连续历史与上下文](history.md) · [目录绑定](../sessions/projects.md) · [文件快照](../sessions/project-files.md) · [图片](../images/image-assets.md) |
| Prompt 内容、版本选择和 Agent 绑定 | [Prompts](../prompts/README.md) |
| Run 准入、Runtime 与原生协议循环 | [执行组件](../execution/README.md) |
| 工具环境、作用域、独立 worker 和远端附着 | [Computer 组件](../computers/README.md) · [工具组件](../tools/README.md) · [单元组件](../units/README.md) |

## 验证入口

包内 [客户端与执行端集成测试](../../../packages/app-personal-agent/tests/http.test.mjs) 覆盖 Personal Agent 的路由、存储及运行边界。[包测试](../../../packages/app-personal-agent/tests/package.test.mjs) 覆盖纯注册、浏览器资源闭包与应用包身份。根目录的统一入口为 `npm run check`。
