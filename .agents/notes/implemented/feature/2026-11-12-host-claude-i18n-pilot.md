# Agent Note: 宿主与 Claude Agent 中英文主流程试点

Status: implemented

## 问题

用户已确认先完成宿主和一个应用的中英文试点，再按实际重复提取共享代码，并明确要求开始实施。现有外壳与 Claude Agent 主流程的文案、状态和格式化固定中文，缺少保持草稿与运行观察的语言切换。

## 决策

沿用[试点规划](../../proposed/architecture/2026-11-12-i18n-pilot-first.md)，宿主与 Claude Agent 分别持有本地资源和独立翻译实例，直接使用 i18next 与 Intl，没有共享包或 Nya 组件。宿主保存 system/zh-CN/en 偏好，并通过可选的只读 ApplicationWebContext.locale 发布 preferredLocale 快照与订阅；应用自行匹配、回退和更新自有 DOM，旧应用/旧宿主保持兼容。

首批已覆盖宿主语言入口、应用打开/切换和外壳管理行，以及 Claude Agent 设备/项目/会话、草稿、Run 发送/观察/完成取消、权限、错误及基础日期/用量。语言变化不重挂载、不重放业务、不取消运行；通过显式文本/属性绑定保留审批和原文节点。静态资源随所属应用的确切版本交付，Claude Agent 升为 0.1.11，manifest、distribution 引用和 lock 同步。i18next 27.1.1 作为各 owner 的构建依赖，运行代码和许可证已完整打入各自 vendor 资源，不增加 Node 后台语言服务。

跨窗口 storage 回调重读最新持久值，避免排队的旧事件覆盖新选择；来源读取失败保留最后偏好。外壳语言刷新重建管理行时恢复同一应用的等价操作焦点，应用主流程则保留原始输入、审批和 transcript 节点身份。完整包管理、连接编辑、账号额度、详细工作区、技能/会话授权管理及原生桌面入口仍未迁移，对应现有中文面板标注源语言。

试点后比较了两套局部实现：宿主拥有持久偏好/跨窗口来源，Claude 拥有节点绑定/呈现清理，责任不同；当前重复主要是少量库初始化、局部参数类型及 vendor 构建包装。没有证据表明新增共享 API 和包依赖能降低总成本，因此保留局部实现，后续扩展时再评估。

## 备选方案

- 宿主统一提供业务翻译器或扫描替换应用 DOM：破坏资源与业务语义归属，不采用。
- reload/remount 切语言：影响草稿、焦点与本代观察，不采用。
- 先建设通用包、Nya 组件或全仓生成/扫描框架：用户已明确先以真实试点验证，不采用。

## 影响与代价

新增两个 owner 的局部资源、构建依赖及资源索引，允许少量相似初始化代码存在。公共接口为可选呈现契约，不扩展后台权限；同源受信运行模型及既有退出保护不改变。机器字段、业务历史、用户/模型/SDK 原文保持原有语义。中文显示的美元费用与日期/相对时间改用显式 locale 的 Intl 输出（例如 US$），没有换算或修改数值。应用包更新按现有版本与生命周期规则处理。

## 验证

本机 Linux 使用已安装 Node 24.16.0/npm 11.13.0 与 Rust 1.94.1，未修改系统或 shell 配置。最终根 `npm run check` 通过：类型/各 workspace 构建及浏览器精确资源图检查完成，2225 项测试中 2204 通过、21 跳过、0 失败、0 取消。

宿主偏好与 shell 集成聚焦测试 41/41 通过，包含来源失效/清理、只读快照、独立实例、复数/纯文本插值、双窗口交错写、旧宿主/未接入应用及无生命周期副作用；Claude 新 i18n、资源与既有客户端/转录等聚焦检查共 64/64 通过。这些是总测试的子集，不能相加作为另一份总数；最小 DOM 测试不等同于浏览器排版验收。

最终构建后重新启动[隔离浏览器夹具](../../../../tests/helpers/claude-agent-browser-host.mjs)，用实际 Chrome 156 执行两组驱动验证：中英切换、草稿/选区/原文节点身份、真实跨窗口通知与焦点、刷新记忆、审批输入及一次 deny；项目选择后原样提交，恰好创建一个 thread/Run，运行中切语言无额外 mutation，正常完成，第二轮一次 Stop/cancel 后进入 Cancelled。两组均无 pageerror；语言切换本身无业务 mutation。已视觉检查 1280px 与 520px 英文界面、审批及取消后布局；补齐英文侧栏标题与数量的间距后重新构建、完整检查并复验实际 8px 间距和窄窗无横向滚动。

这两组浏览器验证使用真实构建资源和内存业务样本，没有启动真实 Claude、读取真实凭据或操作业务数据；未验收 macOS/Windows、原生 Electron 菜单/偏好桥或全产品双语。首次根检查的缺失 PATH 工具和 vendor 类型重导出问题已修正，并在最终源码上完整复跑通过。最终 9 个相关 Markdown 文件的 212 个本地链接目标存在，记录状态、归档位置与必备章节一致，无行尾空白；`git diff --check` 通过。

提交前补充核验使用本机已有 Node 24.22.1：重新编译 application-api、host 与 app-claude-agent，重建两套 vendor，五个测试文件（宿主 locale、Claude i18n 与 package-assets、application-shell、claude-agent-web）共 56/56 通过，无跳过、失败或取消。同步修正设计中“本轮只修改规划”的过时表述；本次提交准备未重复完整根检查或浏览器验收，以上全量及浏览器结果保留为此前实施阶段的验证事实。

## 关联

- [当前规划](../../../../docs/i18n-governance-design.md)、[试点优先方向](../../proposed/architecture/2026-11-12-i18n-pilot-first.md)。
- [公共 Web 契约](../../../../packages/application-api/src/web.ts)、[宿主界面](../../../../packages/host/src/web/client.ts)、[Claude Agent 入口](../../../../packages/app-claude-agent/src/web/app.ts)。
- [宿主语言测试](../../../../packages/host/tests/locale.test.mjs)、[Shell 集成测试](../../../../tests/application-shell.test.mjs)、[Claude 语言测试](../../../../packages/app-claude-agent/tests/i18n.test.mjs)。
- [应用接入](../../../../docs/application-development.md#界面语言与应用归属)、[宿主组件手册](../../../../docs/modules/web/client-shell.md)、[Claude 模块说明](../../../../docs/modules/claude-agent/README.md#界面语言试点)。
