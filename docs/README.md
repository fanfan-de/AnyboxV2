# AnyboxV2 文档

项目文档分为组件手册、跨组件设计和验收记录。开发时从 [模块与组件手册](./modules/README.md) 进入：每个实际 Nya 组件有独立 Markdown 文档，协作完成同一职责的组件归入同一模块目录。

Harness 独立模块的目标边界与源码目录约定见 [Harness 模块边界与目标目录结构](./harness-module-boundary.md)。该文档记录已初步认可的整理方向，尚不代表源码迁移或远程部署已经完成；下方组件手册继续描述当前实现。

- [Harness 独立部署与多设备接入](harness-deployment.md)：启动、配对、发行物、HTTPS、服务与恢复。

## 按模块阅读

| 模块 | 文档入口 | 主要问题 |
| --- | --- | --- |
| Models | [models](./modules/models/README.md) | 定义、连接、配置、凭据、目录与原生协议如何协作 |
| 执行 | [execution](./modules/execution/README.md) | Run 如何准入、选择协议 Loop、执行操作并等待资源退出 |
| 项目与会话 | [sessions](./modules/sessions/README.md) | 项目身份、文件快照、对话树、归档与运行事实归谁所有 |
| 图片资源 | [images](./modules/images/README.md) | 上传验证、原字节保存、草稿续期、原子保留与回收 |
| Prompt | [prompts](./modules/prompts/README.md) | 草稿、发布版本、Agent 绑定与运行快照如何生效 |
| 工具 | [tools](./modules/tools/README.md) | Bash 与 Apply Patch 如何执行、取消及记录实际结果 |
| 基础存储 | [infrastructure](./modules/infrastructure/README.md) | 业务 SQLite 的排他所有权、事务与领域迁移 |
| Web 宿主 | [web](./modules/web/README.md) | 本机 HTTP、SSE、附件草稿、归档界面与原生目录选择 |
| 资源归属验证 | [diagnostics](./modules/diagnostics/README.md) | H0 探针如何证明结果与真实退出的区别 |

## 跨组件设计

| 文档 | 内容 |
| --- | --- |
| [当前框架图（2026-09-29）](./architecture/anybox-current-framework-2026-09-29.md) | 当前单根装配、Harness 逻辑边界、Models、宿主与数据资源；含 SVG、PNG 和 Mermaid |
| [Harness 模块边界与目标目录结构](./harness-module-boundary.md) | 模块归属、易混淆边界、目标文件夹与当前路径映射、迁移约束 |
| [Harness 组件协作总览](./harness-components.md) | 单根装配、资源所有权与关键调用路径 |
| [原生协议框架设计](./native-protocol-agent-framework-design.md) | 协议边界、迁移、恢复、验收矩阵和真实 API 测试入口 |
| [多模态图片输入设计](./multimodal-image-input-design.md) | 五种原生协议图片输入的端到端链路、历史升级兼容与验收 |
| [项目文件引用](./project-file-references-design.md) | @ 搜索、发送快照、原子保留、幂等提交与历史恢复 |
| [Session 对话树](./session-conversation-tree.md) | 父节点选择、分支并发、原子成功节点、归档恢复及旧历史读取 |
| [Prompt 管理设计](./prompt-management-design.md) | 提示词产品语义、权限与版本固定 |
| [Run 状态转换](./run-state-machine-design.md) | Run 状态与执行/持久化边界 |
| [业务 SQLite 设计](./local-sqlite-storage.md) | 存储契约、领域迁移及已有表归属 |
| [Web 客户端设计](./web-client-design.md) | 本机协议、分屏、变更通知与交互验收 |
| [函数式开发方法](./functional-agent-harness-development.md) | 纯函数、决策、操作意图与资源所有者的拆分 |
| [Models 包 README](../packages/models/README.md) | 独立使用通用包的安装示例与公共契约 |

## 阶段与历史记录

[Harness 计划](./agent-harness-plan.md) 记录阶段和验收，[Models 目录验收](./models-catalog-validation.md) 记录自动化与浏览器验证，[桌面界面迁移](./anybox-desktop-ui-migration.md) 记录 UI 参考及实施范围。

[整体架构图](./architecture/current-framework.md) 与 [Models 架构图](./architecture/models-module.md) 保留原生协议迁移前的图示，不能用其中的旧执行接口代替当前组件契约。当前行为以源码、对应行为测试和组件手册为依据；发现差异应同步修正文档。

## 维护约定

新增组件时，在所属模块目录新增一篇组件文档并更新模块 README 和 [组件清单](./modules/README.md)。新增内聚模块时再建立目录；模块分组只表达职责，不创建新的 Nya Context，也不要求移动源码。

组件文档至少说明工厂和组件名、提供服务和注入依赖、配置与接口、功能流程、数据及资源归属、初始化/取消/清理、失败与兼容限制、测试及关联源码。一个组件提供多个服务时写在同一篇；同一工厂创建不同协议绑定时分别写出各实例的行为。内部提供方、领域函数、浏览器视图和配置数据在所属组件文档中解释，不伪装成独立 Nya 组件。

变更服务、依赖、持久格式或退出语义时，同步更新对应组件文档及跨组件设计；删除实现时检查文档链接，删除已停用路径的说明，保留明确标注的迁移和只读兼容记录。修改完成运行根 `npm run check`，文档中的源码、测试和相邻文档使用可跟随的相对链接。
