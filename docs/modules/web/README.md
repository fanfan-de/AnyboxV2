# Web 宿主模块

[返回模块导航](../README.md)

Web 模块把本机应用服务提供给浏览器，包括项目选择、会话与分支、多 Run 状态、模型目录及配置、Prompt 管理和临时原生输出展示。HTTP 服务只监听本机回环地址，浏览器不是持久状态或运行期资源的所有者。

## 组件与内部单元

| 组件 | Nya 名称 | 服务 | 职责 |
| --- | --- | --- | --- |
| [Web Frontend](web-frontend.md) | `web-frontend` | `web.frontend` | 静态资源、HTTP API、SSE、浏览器展示投影 |
| [Directory Picker](directory-picker.md) | `host-directory-picker` | `host.directory-picker` | 单个本机目录选择对话框及进程退出等待 |

[DeepSeek 协议组件](../models/deepseek.md) 的源码虽然位于 `src/web/`，职责属于 Models 的宿主协议扩展，文档随 Models 模块归档。

以下代码是组合函数、纯函数、HTTP 适配器或浏览器模块，不是独立 Nya 组件：

| 入口 | 作用 |
| --- | --- |
| [serve.ts](../../../src/web/serve.ts) | 进程入口，装配应用根、注册进程信号、打印监听地址 |
| [startup-config.ts](../../../src/web/startup-config.ts) | `parseWebStartupConfig` 纯校验环境配置 |
| [models-startup.ts](../../../src/web/models-startup.ts) | `installWebModels` 安装 Models 组件，完成有限的一次旧配置引导 |
| [server.ts](../../../src/web/server.ts) | `startWebServer` 通过 `WebCommands` 适配业务接口；生命周期归 Web Frontend |
| [run-change-stream.ts](../../../src/web/run-change-stream.ts) | 每个 SSE 响应的缓冲、心跳、监听器和关闭 |
| [client.ts](../../../src/web/client.ts) | 页面启动与 API 客户端装配 |
| [workspace-client.ts](../../../src/web/workspace-client.ts)、[workspace-layout.ts](../../../src/web/workspace-layout.ts) | 项目列表、工作区和最多四个跨项目会话分屏，布局纯转换 |
| [session-client.ts](../../../src/web/session-client.ts)、[run-change-client.ts](../../../src/web/run-change-client.ts) | 每个会话的提交/恢复/读请求管理及 SSE 重连 |
| [models-client.ts](../../../src/web/models-client.ts)、[models-directory-client.ts](../../../src/web/models-directory-client.ts)、[prompt-client.ts](../../../src/web/prompt-client.ts) | 模型、目录与 Prompt 设置界面 |
| [protocols/modules.ts](../../../src/web/protocols/modules.ts)、[protocols/view.ts](../../../src/web/protocols/view.ts) | 五种协议的输入、白名单视图解码、合并和 DOM 挂载 |
| [tool-trace.ts](../../../src/web/tool-trace.ts)、[session-view.ts](../../../src/web/session-view.ts) | 工具过程卡片与会话展示派生数据 |

## 启动与关闭

从仓库根目录运行 `npm run web`，先构建 Models 和应用 TypeScript，再运行 `dist/web/serve.js`。启动先校验配置，创建唯一根 `Context`，随后安装 Models、业务 Local SQLite、Harness、Directory Picker 与 Web Frontend；没有 Web 专属或项目专属子 Context。默认注册 `assistant` Agent，存在迁入的 `default` 模型配置时把它作为 Agent 默认模型。

成功后标准输出为 `Anybox Web: http://127.0.0.1:<port>`。SIGINT/SIGTERM 调用 `harness.close()`，停止准入并让 Nya 卸载根上全部组件，等待请求、Run、工具、Models 和数据库退出。启动失败会尝试 dispose 根后报告原启动错误；关闭失败设置进程退出码 1。仅替换 Web Frontend 的行为见其组件文档。

## 当前启动配置

| 环境变量 | 默认值 / 规则 |
| --- | --- |
| `ANYBOX_WEB_PORT` | `0`，由系统分配；允许 `0..65535` |
| `ANYBOX_HARNESS_DATABASE` | `./data/harness.sqlite` |
| `ANYBOX_MODELS_DATABASE` | `./data/models.sqlite` |
| `ANYBOX_MODELS_CATALOG_DATABASE` | Models 文件旁的 `models-catalog.sqlite` |
| `ANYBOX_MODELS_NAMESPACE` | `anybox.models`，新 Vault 的系统凭据命名空间 |

三套数据库路径不能相同。普通环境值会 trim，显式空字符串或 NUL 被拒绝。宿主不加载 dotenv，密钥不通过这些环境配置进入数据库。

以下旧变量仅产生 `legacy` 引导输入；已保存连接和配置之后，运行配置由 Models 管理。不过启动解析仍会校验这些变量，应保留合法值或删除不再需要的设置。

| 旧环境变量 | 引导规则 |
| --- | --- |
| `ANYBOX_LLM_API` | `deepseek-chat-completions`（默认）或 `openai-responses` |
| `ANYBOX_LLM_MODEL` | DeepSeek 默认 `deepseek-flash`；Responses 必填 |
| `ANYBOX_LLM_BASE_URL` | 对应默认 `https://api.deepseek.com` 或 `https://api.openai.com/v1`；只允许不带用户名、密码、query、fragment 的 HTTP(S) 地址 |
| `ANYBOX_LLM_TIMEOUT_MS` | `30000`，正整数且不超过 `2147483647` |
| `ANYBOX_LLM_MAX_OUTPUT_TOKENS` | 可省略；正安全整数；映射到该协议的原生字段 |
| `ANYBOX_LLM_TEMPERATURE` | DeepSeek 默认 `0.7`，Responses 默认省略；显式值限 `0..2` |

## Models 装配与旧数据引导

`installWebModels(root, config, options?)` 安装配置存储、Vault、Models 服务，再进行受控引导，最后安装 Responses、Chat Completions、DeepSeek、Anthropic、Gemini 和目录来源/缓存/服务。其测试替换选项包括协议 `fetch`、Vault `openEntry`、旧凭据读取器 `readLegacyCredential`、目录 `catalogFetch` 和 `catalogAutoRefresh`。

首次引导创建显式用户 Provider/Model 定义、稳定连接 `anybox-imported-default` 和配置 `default`。旧 Key 从 `anybox` 命名空间读取并复制到新 Vault，不删除旧条目。旧凭据无法读取或新 Vault 写入失败时，仍尽可能保留可编辑的非秘密定义与缺 Key 状态。

是否首次使用同时查看连接、迁入连接历史和用户模型定义，避免用户主动删除所有连接后下次启动又自动恢复。只续接本宿主留下且协议匹配的中断引导，不把普通用户连接或变化后的协议当作可恢复导入。引导先保存稳定 `default` 配置，再注册协议，避免自动补齐基础配置抢先生成别的 ID。

## 浏览器状态边界

工作区保存面板布局和选中位置，Session 控制器保存待确认提交及各父节点草稿。浏览器位置不构成服务端全局 head；提交始终包含显式 `parentNodeId`。关闭面板或切换项目停止自身读请求与计时器，不取消已接受 Run；取消必须发专门的 Run 取消请求。

待提交记录先写浏览器存储再 POST，响应丢失后按幂等键只读查询恢复；无法确认的旧记录恢复输入等待用户决定，不自动重放副作用。SSE 只是刷新提示和有界临时视图，权威记录始终来自 Session/Run 查询。

## 相关验证

启动与迁入由 [web-startup-config.test.mjs](../../../tests/web-startup-config.test.mjs) 和 [models-startup.test.mjs](../../../tests/models-startup.test.mjs) 覆盖；布局与独立会话行为由 [workspace-layout.test.mjs](../../../tests/workspace-layout.test.mjs)、[session-client.test.mjs](../../../tests/session-client.test.mjs)、[project-navigation.test.mjs](../../../tests/project-navigation.test.mjs) 覆盖。HTTP、SSE 和原生目录选择的验证入口见两个组件文档。完整验收运行 `npm run check`。
