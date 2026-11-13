# Agent Note: Personal Agent 最小产品验证版

Status: implemented

## 问题

用户希望用真实可用的最基础版本验证 Personal Agent：同级可配置 Agent、独立对话和任务、每次 Run 的配置及上下文事实、独立委派及成果管理。

## 决策

新增独立 workspace 应用 `@anybox/app-personal-agent` 0.1.0，稳定 ID `personal-agent`，首版只声明 client 角色。在该设备现有客户端根安装自有工作区与 HTTP 组件，直接使用通用 Models `generateText` 的执行、取消及实际退出契约，不依赖 Harness 业务，不增加 Context。模型 JSON 和系统 Vault 命名空间与 Harness 独立。

实现 Agent 配置及默认打开偏好、显式记忆和用户维护的 Skills 指令文本、独立对话与任务、串行推进及跨任务并行、可取消 Run、手动移交独立任务、人工进展/等待/完成状态，以及保存与下载文本成果。每次执行固定最新 Agent 配置及完整文本上下文；字符预算不足时保存等待，由用户显式建立新段或调整配置。异常启动把旧 running 标为 interrupted，绝不自动重放。取消原任务不级联下游任务。Run 参与 Activity guard，页面草稿参与 canClose；dispose 释放页面观察，不取消后台业务。

默认 distribution 客户端增加应用入口，执行端仍组合原有两个应用；`npm run personal-agent` 提供只含该应用的本机验证入口。正式注册只加载纯契约，用户打开时才动态导入 Models 与应用业务，保留原客户端角色导入防护。构建、资源图、默认发行 staging 与独立目录打包已接入；资源使用 `/apps/personal-agent/0.1.0/` 版本专属空间，显式本地信任安装无需额外别名策略。

## 备选方案

- 纯静态界面无法验证真实模型调用及取消与恢复，因此未采用。
- 在现有 execution 根直接装另一套 Models 会与固定服务名冲突，首版采用本机 client 角色应用；多设备绑定、迁移、自动委派与文件执行工具另列。
- Harness RunRuntime 依赖 Session、Computer 与原生 Loop；本次没有为文本验证强行提取它，而是复用 Models 已有的执行、取消及清理机制与 SQL/Nya/应用生命周期基础。
- 首轮注册直接导入 Models 导致既有客户端启动 guard 测试失败，改为显式打开后的动态导入；没有放松原导入门禁。
- 首轮资源沿旧应用兼容 URL，严格目录准备拒绝未授权别名；改为默认版本空间，没有扩大宿主信任策略。

## 影响与代价

应用数据通过自有 `personal-agent` 迁移域保存在客户端业务库；独立验证入口默认 `./data/personal-agent.sqlite`，模型配置另存相邻 `personal-agent-models.json`，Key 仅入系统 Vault。默认完整发行新增依赖，最小宿主生产闭包不变。卸载默认保留业务数据。

首版为中文、本机、单次完整文本模型调用，Skills 为用户指令文本，无文件工具、外部 Skills 加载、自动委派、定时唤醒、共享资源授权或跨设备交接。任务状态和成果保存由用户明确操作。应用持有文本上下文，不宣称原生 continuation 恢复。成功 Run 保存 Models 返回的模型修订与协议；失败接口未暴露确切快照时这两个字段为 null，不能猜测历史。字符预算不等同于模型 token 上限，HTTP 请求另有 UTF-8 字节限制。

## 验证

- 最终 `npm run check` 通过：2238 项测试，2217 通过、21 按已有平台/真实凭据等门控跳过、0 失败，包含全工作区类型/构建、静态资源图、依赖边界和既有桌面/CLI 角色防护。实际使用 Linux x64 glibc、Node 24.16.0；执行环境补齐已有 Node 和 Rust 工具 PATH，未修改构建门禁。
- 新应用 13 项测试通过：6 项核心、4 项真实宿主 API、3 项包与准备。覆盖并发/串行、取消及关闭等待实际退出、完整上下文和配置快照、容量暂停及新段、父子任务独立、清理失败保留 guard、重启不重放、模型凭据隔离、Vault 失败及恢复补 Key、纯注册和按需导入。
- 真实 Chromium 浏览器使用隔离数据和受控模型端点走通模型设置、Agent 配置/默认偏好、任务推进、成果保存、草稿切换、独立委派、进展/等待、父任务取消不影响下游及 Run 取消；无 pageerror。单独验证 canClose 保护配置和消息草稿、setActive 隐藏/恢复 dialog、dispose 后后台 Run 继续，最后显式取消完成。
- 桌面、760px 和 390px 布局已检查；修复通知遮标题、轮询收起成果和手机输入区裁切。最终 390×844 中发送按钮底边 815px，完整可见。
- 实际生成 `artifacts/personal-agent-0.1.0-linux-x64/`：8 个生产包、312 文件、9,592,267 字节；`anybox-host verify <目录> --trust-local` 的 client/web 均 prepared。临时空宿主真实安装、生效、确认新装 disabled 且未建 Models JSON、显式 open、配置本地 auth:none 受控 Chat Completions、任务成功、静态入口 200、stop/close 均通过；模型恰好请求一次。临时根已清理。
- 已启动正式本机验证入口 `http://127.0.0.1:3117/#/apps/personal-agent`，保留真实试用数据目录，未预填模型或读取旧 Harness Key。浏览器验收数据与此实例分开。
- 未验证真实付费模型账号、真实 OS Vault 的 Key 写入、macOS/Windows/Electron 安装运行或远端部署；不将受控网络/Vault 测试解释为上述验收。

## 关联

- [Personal Agent 使用与组件手册](../../../../docs/modules/personal-agent/README.md)
- [独立应用包](../../../../packages/app-personal-agent/README.md)
- [业务契约](../../../../packages/app-personal-agent/src/contracts.ts)
- [核心行为测试](../../../../packages/app-personal-agent/tests/core.test.mjs)
- [宿主 API 测试](../../../../packages/app-personal-agent/tests/http.test.mjs)
- [包与准备测试](../../../../packages/app-personal-agent/tests/package.test.mjs)
- [应用开发](../../../../docs/application-development.md)
- [Models](../../../../packages/models/README.md)
