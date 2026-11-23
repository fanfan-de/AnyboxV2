# MCP 执行环境组件

[工具模块](README.md) · [执行环境授权](execution-environments.md) · [环境契约](../../tool-environments.md)

## 使用

Anybox Harness 和 Personal Agent 各自提供一个 `mcp` 环境。连接对应授权目标，同一 Agent 可以同时使用多条连接上的具体工具。两款应用各自在其执行端保存连接和授权。

1. 在「Agent 工具」的「MCP 连接」中添加名称并选择传输方式。Streamable HTTP 使用匿名 HTTPS 或回环 HTTP。stdio 使用执行设备上的可执行文件绝对路径、JSON 字符串数组格式的参数，以及可选的工作目录绝对路径。省略目录时，保存执行服务创建连接时的工作目录。
2. 点击该连接的「发现工具」。组件握手并取得服务端目录。连接显示就绪后，在该 Agent 的环境授权中按连接勾选具体工具并保存授权。
3. 在环境偏好中选用 MCP，再勾选各连接中希望声明的工具。普通项目会话从新建时采用。Personal Agent 已有连续会话需要显式应用新目标集合。

连接配置在执行库持久保存。保存配置后由操作员发起发现，执行端重新启动后也需要再次发现工具。刷新同一连接保留其目标身份，工具契约相同的授权可以继续使用。停用连接封闭新调用并等待本地工作退出，退出仍未确认的连接会显示对应错误。通过添加新的连接切换配置或重新启用，原连接的历史可继续查看。

两种传输均支持普通请求响应工具及文本、结构化 JSON 结果。工具 schema 经过 `@anybox/tool-api` 支持范围和本组件的大小、结构校验，不兼容的工具不进入可授权目录。Streamable HTTP 响应可以使用 JSON 或 SSE。stdio 以逐行 JSON-RPC 消息通信，执行服务以自己的系统账号直接启动配置的可执行文件并传递参数数组。stdio 选项需要执行设备提供匹配的平台原生进程监督器。OAuth、凭据配置、旧 HTTP+SSE 传输、服务端任务和 MCP 资源及提示词接入留待后续。 [MCP 传输规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

## 工厂与资源所有权

`@anybox/mcp-environment` 提供 `createMcpEnvironmentComponent({ serviceKey })`。两款应用在自己的执行 Nya 根分别以 `harness.mcp-environment` 和 `personal-agent.mcp-environment` 提供 `McpEnvironmentPort`，依赖各自的 `local-storage`。服务持有连接配置、经验证的工具目录、Streamable HTTP 会话、stdio 进程及在途操作。Session 读取纯目录，RunRuntime 注入当前 MCP 服务并绑定提供方。stdio 复用 `@anybox/computer-tools/platform/process-runtime` 的本地进程监督模块。独立 Computer worker 和 Anybox 宿主不装配 MCP 服务。

同包的 `createMcpToolRegistration(serviceKey)` 向共享注册表贡献纯目录和执行绑定。连接名称、目标及稳定选择 ID 来自提供方，应用的工具管理接口使用同一目录列出目标，并在授权事务中复核具体工具。

组件分批读取 `tools/list`，校验后发布完整目录。连接 ID 稳定，确切目标 ID 由连接身份和配置代次组成。模型名称由连接和原始工具名确定，在两条连接公布同名工具时保持可区分。发出 `tools/call` 前再次确认固定目标和工具版本，发送的原始工具名由绑定取得。模型参数只用于原工具的 schema。 [工具发现与调用规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

## 执行、取消与恢复

每个 Run 按确切目标拥有调用 scope。HTTP 连接可共享一个服务端会话。stdio 发现启动短期进程，发现结束并确认进程树退出后才发布工具目录。Run 第一次获得准入并调用 stdio 工具时，为该 Run 和目标启动自己的进程，并核对发现的工具契约。该作用域可复用进程处理后续调用。运行结算前，作用域关闭并等待所持进程树和管道退出。

逐工具撤权关闭该授权的新调用，并按现有整 Run 语义取消受影响的在途工作。连接停用或组件退出会封闭相应连接的准入，取消并等待实际持有的本地操作和传输资源退出。stdio 取消尽力发送协议通知，关闭输入并在必要时终止持有的进程树，等待进程监督器完成退出确认。正常关闭也等待相同的退出证明。 [MCP 关闭规则](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#shutdown)

发送前拒绝可以确认工具未调用。HTTP 在缺少远端终态和本地清理证明时保留 `exit-unknown`。stdio 在拉起进程前登记启动配置和资源持有记录，取得受控进程树实际退出的证明后才释放。执行服务异常退出时，未确认的 stdio 进程继续限制相同启动配置的发现与执行。相同连接资源及原始工具的未确认调用也继续限制准入。刷新目录或重新添加相同配置时，原限制仍有效。恢复只查原操作，通用 MCP 调用不会重新发送 `tools/call`。 [授权与退出状态](execution-environments.md#撤权与发送的先后关系) · [MCP 取消规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation)

## 管理接口

路径相对于该应用执行端的 `/api/v1`，通过客户端调用时沿用该连接的实例及访问权限。

| 方法与路径 | 行为 |
| --- | --- |
| `GET /mcp-connections` | 列出连接与目标身份、名称、传输配置、状态、工具数和可选错误码。 |
| `POST /mcp-connections` | HTTP 接收 `{ "name": "资料库", "endpoint": "https://example.com/mcp" }`，可带 `"transport": "http"`。stdio 接收 `{ "name": "本地服务", "transport": "stdio", "command": "/path/to/node", "args": ["server.mjs"], "cwd": "/path/to/server" }`，`cwd` 可选。新连接记录为 `unverified`。 |
| `POST /mcp-connections/:id/refresh` | 空对象请求，发现并发布工具。连接可观察为 `ready` 或 `unavailable`。 |
| `POST /mcp-connections/:id/disable` | 空对象请求，停用连接并封闭该目标。 |

逐工具授权通过现有 `/agents/:id/environment-access/grants` 提交，使用目标目录给出的完整 `tool` 身份。偏好的 `toolIdsByTarget` 键为 `JSON.stringify(["mcp", selectionId])`，值为选中的稳定工具 ID 数组。`selectionId` 为连接 ID，可在可授权目标投影读到。

## 验证入口

共享包的[多目标测试](../../../packages/execution-environments/tests/targets.test.mjs)覆盖确切路由、连接版本失配、混合环境恢复和模型请求发送前拒绝。[MCP HTTP 测试](../../../packages/mcp-environment/tests/http.test.mjs)覆盖 JSON 和 SSE，以及未知操作跨刷新和重启的保护。[两款应用端到端测试](../../../tests/mcp-execution-environment.test.mjs)通过正式管理与 Run 接口验证实际的 HTTP 及 stdio 服务、同名工具的分派和授权隔离，以及 stdio 的进程退出等待。
