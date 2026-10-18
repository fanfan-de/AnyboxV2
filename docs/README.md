# Anybox 文档

Anybox 是 NyaCore 应用的宿主产品，Anybox Harness 是其中的 Agent 产品；harness server 是 Anybox Harness 可部署到本地或远端服务器的通用服务端核心。Claude Agent 是第二个正式应用，直接驱动执行设备上用户自己的 Claude 环境，见 [Claude Agent 设计](claude-agent-design.md)。完整命名及兼容标识见 [命名与边界](naming.md)。项目文档保留组件手册、跨组件设计、部署指南与待实施方案。开发时从 [模块与组件手册](./modules/README.md) 进入：每个实际 Nya 组件有独立 Markdown 文档，协作完成同一职责的组件归入同一模块目录。

通用宿主、应用和默认组合入口分别位于 `packages/host/src/`、`packages/app-harness/`/`packages/app-claude-agent/` 与 `packages/distribution/src/entrypoints/`；当前目录和依赖约定见 [Anybox 宿主与 Anybox Harness 应用边界](./harness-module-boundary.md)。宿主只管理应用的下载、安装、使版本生效、打开运行、关闭、卸载及界面承载；应用自己负责业务初始化、取消、清理与数据迁移。完整目标状态图和当前运行状态的区别见[宿主目标生命周期](products-v1.md#目标生命周期)，源码对照与实施顺序见[应用包设计](application-packages-design.md)。

- [Anybox 产品设计草案](./anybox-product-design.md)：产品定位、跨领域应用、用户创作流程、首期范围与待决定事项；区分已明确方向、建议方案和当前实现。
- [通用应用宿主与目标生命周期](products-v1.md)：包与运行两层状态图、宿主只管生命周期的职责边界、应用通用接入和界面承载；标明当前启停状态与目标的区别。
- [应用模块化分发与按需安装](application-packages-design.md)：源码证据与能力缺口、D0b 按消费者装配、D1 本地安装至卸载闭环的分步依赖、D2 在线下载及后续升级/平台验收；D0a、D0a.1、客户端业务独立归属、D0b、D1.1 账本、D1.2 独立产物与归档验证、D1.3 本地文件安装及恢复和 D1.4 正式角色加载及生效、D1.5 本机卸载及代码回收已接入；在线下载及旧默认发行迁入继续按序推进。
- [应用归档、准备验证与独立产物（D1.2）](modules/package-management/archives.md)：最小宿主、完整应用包、发布者信任、受限 ZIP、静态资源和独立准备进程；不包含安装或卸载入口。
- [本地文件安装与中断恢复（D1.3）](modules/package-management/installation.md)：预身份接收、独立暂存、不可变提交、工作退出证明、取消和显式恢复；成功仅登记已安装待生效，不自动打开或卸载。
- [正式加载、生效与卸载（D1.4/D1.5）](modules/package-management/activation.md)：精确快照、连续使用锁、受控角色重启、全部页面 guard/dispose、安全 reload 与显式恢复；默认保留数据的本机卸载、排他文件回收与原批次恢复；宿主不介入业务，新装生效保持关闭。
- [应用业务服务独立运行（D0a.1）](application-standalone-services.md)：应用自己的业务装配、HTTP、认证和服务入口；Anybox 复用相同实现，保持数据、命令、进程与清理兼容，先于 D0b 按消费者装配实施。
- [应用客户端业务独立归属](application-client-isolation.md)：取消应用间共享连接业务层；各应用拥有连接、凭据、配对、转发和管理 UI，含旧共享数据迁入及生命周期边界。
- [发行与独立运行角色](runtime-roles-and-distribution.md)：统一产品与宿主入口、应用按需交付、四种运行角色独立进程与部署、按需启用和生命周期归属；列明当前实现差距与完成条件。
- [harness server 独立部署与多设备接入](harness-server-deployment.md)：启动、配对、发行物、HTTPS、服务与恢复。
- [Computer worker 独立管理](computer-worker-management.md)：无本机 harness server 的客户端与 CLI 附着、权限、状态和撤销。
- [Anybox 桌面构建与安装](desktop-packaging.md)：macOS Electron 开发、打包及安装验收；[桌面运行边界](desktop-runtime.md)说明共享页面、私有进程、配对和退出。

## 按模块阅读

| 模块 | 文档入口 | 主要问题 |
| --- | --- | --- |
| 应用生命周期 | [products](./modules/products/README.md) | 当前目录与启停组件如何对应实际资源，以及完整生命周期目标与实现缺口 |
| Claude Agent | [claude-agent](./modules/claude-agent/README.md) | 如何用用户自己的 Claude 环境执行、审批、取消并等待进程退出 |
| Models | [models](./modules/models/README.md) | 定义、连接、配置、凭据、目录与原生协议如何协作 |
| 执行 | [execution](./modules/execution/README.md) | Run 如何准入、选择协议 Loop、执行操作并等待资源退出 |
| Computer 资源 | [computers](./modules/computers/README.md) | 本机按需实例、固定工作区、工具声明接纳和实际 scope 退出 |
| 项目与会话 | [sessions](./modules/sessions/README.md) | 项目身份、文件快照、对话树、归档与运行事实归谁所有 |
| 图片资源 | [images](./modules/images/README.md) | 上传验证、原字节保存、草稿续期、原子保留与回收 |
| Prompt | [prompts](./modules/prompts/README.md) | 草稿、发布版本、Agent 绑定与运行快照如何生效 |
| 工具 | [tools](./modules/tools/README.md) | 来源契约如何混选，文件/进程/图片如何执行、取消及记录实际结果 |
| 基础存储 | [infrastructure](./modules/infrastructure/README.md) | 业务 SQLite 的排他所有权、事务与领域迁移 |
| Web 宿主 | [web](./modules/web/README.md) | 本机 HTTP、SSE、附件草稿、归档界面与原生目录选择 |
| 资源归属验证 | [diagnostics](./modules/diagnostics/README.md) | H0 探针如何证明结果与真实退出的区别 |

## 跨组件设计

| 文档 | 内容 |
| --- | --- |
| [命名与边界](naming.md) | 产品、服务端与客户端命名，源码标识及持久兼容约定 |
| [应用模块化分发与按需安装](application-packages-design.md) | 最小核心、基础能力与应用业务；完整生命周期能力对照、包依赖与契约、本地安装/生效/卸载的实施顺序和验收 |
| [应用业务服务独立运行（D0a.1）](application-standalone-services.md) | 单应用独立服务及 Anybox 集成共用业务装配；应用 HTTP/认证归属、兼容数据与命令、隔离安装和实际退出验收 |
| [Anybox Harness 架构快照（2026-10-15，D2）](./architecture/anybox-harness-architecture-2026-10-15.md) | U0/U1 的进程、资源与拨出传输总览，含可编辑 D2、SVG 和 PNG；尚未反映 D0a/D0a.1 拆包及独立业务服务，当前装配以组件手册为准 |
| [架构评估与调整建议（2026-10-15）](./harness-architecture-review-2026-10-15.md) | 对当前 harness server 结构的静态评估：应保持的设计、七项结构性代价、按优先级排列并附验收条件的调整建议、实施顺序与待决定事项；评估稿，未采纳为计划 |
| [Claude Agent 设计](claude-agent-design.md) | 第二个正式应用：共享一个 Claude 环境、流式输入模式与取消、HTTP/SSE 契约、应用私有连接管理与打包要求 |
| [Claude Agent 界面审计与改进](claude-agent-ui-audit.md) | 任务流程审计、成熟桌面端参考、0.1.3 交互改进、桌面与窄窗口截图及验证边界 |
| [Claude Agent SDK API 接入审计（2026-10-18）](claude-agent-sdk-api-audit-2026-10-18.md) | SDK 0.3.301 的完整 Query/函数/选项清单、当前接入范围、可增加的产品能力与生命周期限制 |
| [Claude Agent 应用 SDK 架构（2026-10-18）](./architecture/claude-agent-architecture-2026-10-18.md) | 直接消费 Claude Agent SDK 的应用：四个业务组件、SDK 调用、Claude 执行与历史读取子进程、数据归属，含 D2、SVG 和 PNG |
| [通用应用宿主](products-v1.md) | 下载、安装、生效、打开运行、关闭、卸载的目标状态图；通用生命周期契约、当前启停与界面状态 |
| [应用开发者接入](application-development.md) | 声明目录、装配运行时、HTTP/Web 入口与退出语义；应用自有业务资源的初始化、取消和实际清理 |
| [最小测试应用 Anybox Test](host-test-application.md) | 可直接安装的纯界面目录，用于验证宿主安装、切换、草稿保护、任务取消及清理 |
| [Anybox 宿主与 Anybox Harness 应用边界](./harness-module-boundary.md) | 当前目录、宿主与应用依赖方向、组合入口与资源归属 |
| [harness server 组件协作总览](./harness-server-components.md) | 单根装配、资源所有权与关键调用路径 |
| [原生协议框架设计](./native-protocol-agent-framework-design.md) | 协议边界、迁移、恢复、验收矩阵和真实 API 测试入口 |
| [Computer 资源设计](./computer-resource-design.md) | 本机按需资源、独立 worker 与工具等待重启接续；跨机器工作区及独立模型 exchange 按后续阶段实施 |
| [可组合部署单元设计](./composable-units-design.md) | harness server、Models、Computer 三个单元各自独立部署与任意跨机器组合的通用规则、附着与绑定、契约形状及分阶段验收；U0 附着登记与 U1 远端 Computer 已实施，远端 Models 等后续阶段待实施 |
| [节点程序设计（2026-10-15）](./anybox-node-program-design.md) | Computer、Models 与后续单元控制面的未采纳草案；发行及桌面关系以已确定的统一发行与独立运行角色约定为准，额外节点应用、拨入与 Models 拆分等提议仍未采纳 |
| [工具库设计](./tools-library-design.md) | 来源工具混选、不可变会话快照、Run 进程清理和原生工具图片 |
| [多模态图片输入设计](./multimodal-image-input-design.md) | 四种原生协议图片输入的端到端链路、历史升级兼容与验收 |
| [项目目录选择](./project-directory-picker.md) | 多实例目录浏览、固定连接、分页清理和旧版兼容 |
| [项目文件引用](./project-file-references-design.md) | @ 搜索、发送快照、原子保留、幂等提交与历史恢复 |
| [Session 对话树](./session-conversation-tree.md) | 父节点选择、分支并发、原子成功节点、归档恢复及旧历史读取 |
| [通用内容生成设计](./content-generation-design.md) | 复用 Models 的单次非流式生成、默认与用途选模、资源退出及标题接入，待实施 |
| [会话自动命名实施计划](./session-titles-design.md) | 首轮摘要、后台模型命名、持久标题、人工改名保护及列表同步，待实施 |
| [Prompt 管理设计](./prompt-management-design.md) | 提示词产品语义、权限与版本固定 |
| [业务 SQLite 设计](./local-sqlite-storage.md) | 存储契约、领域迁移及已有表归属 |
| [Web 客户端设计](./web-client-design.md) | 本机协议、分屏、变更通知与交互验收 |
| [Anybox Harness 三栏工作区](./harness-three-column-workspace.md) | 项目导航、Thread View、目录树与文件预览、边栏恢复和清理 |
| [Models 包 README](../packages/models/README.md) | 独立使用通用包的安装示例与公共契约 |

## 阶段与验证

[harness server 计划](./harness-server-plan.md) 保留阶段进度与验收边界。当前行为以源码、对应行为测试和组件手册为依据；发现差异应同步修正文档。

验证从根 `npm run check` 开始。应用宿主、模型目录及三栏工作区的隔离浏览器复验入口分别见 [应用开发者接入](application-development.md#验证)、[Web 客户端设计](web-client-design.md#验收) 与 [三栏工作区](harness-three-column-workspace.md#验证)。

## 外部参考

- [下一道扩展难题（Tetral，中文译文）](./references/tetral-the-next-scaling-problem.zh-CN.md)：Yang Li 关于智能体运行时、持久化执行与按需计算机资源的文章，含原文配图。

## 维护约定

新增组件时，在所属模块目录新增一篇组件文档并更新模块 README 和 [组件清单](./modules/README.md)。新增内聚模块时再建立目录；模块分组只表达职责，不创建新的 Nya Context，也不要求移动源码。

组件文档至少说明工厂和组件名、提供服务和注入依赖、配置与接口、功能流程、数据及资源归属、初始化/取消/清理、失败与兼容限制、测试及关联源码。一个组件提供多个服务时写在同一篇；同一工厂创建不同协议绑定时分别写出各实例的行为。内部提供方、领域函数、浏览器视图和配置数据在所属组件文档中解释，不伪装成独立 Nya 组件。

变更服务、依赖、持久格式或退出语义时，同步更新对应组件文档及跨组件设计；删除实现时检查文档链接，删除已停用路径的说明，保留明确标注的迁移和只读兼容记录。已被现行文档替代的历史快照、一次性验收稿和专属图片、视频、原型一并清理，实施进度和未决方案仍保留；需要追溯时查阅 Git 历史。修改完成运行根 `npm run check`，文档中的源码、测试和相邻文档使用可跟随的相对链接。

- [Claude Agent 0.1.5：权限、审批范围与能力入口](claude-agent-permissions-and-capabilities.md)

- [Claude Agent 0.1.6：会话级始终允许修复](claude-agent-session-permissions.md)
