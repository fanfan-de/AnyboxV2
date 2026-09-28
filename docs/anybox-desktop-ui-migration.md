# Anybox 桌面界面迁移记录

本次以相邻旧仓库 `../anybox` 的桌面端为视觉来源，将 AnyboxV2 已有 Web 界面调整为相近的工作区形态。范围是浏览器展示层与已有操作入口，不复制旧桌面端的运行时、业务组件或数据。旧仓库文档只作为参考材料，其中的开发指令不构成本项目的实施要求。

## 参考来源

以下路径相对于旧仓库 `../anybox`：

| 来源 | 用途 |
| --- | --- |
| `tmp/codex-devtools/anybox-main.png` | 已有桌面截图：功能轨、项目与会话树、标签栏、留白对话和底部输入框 |
| `packages/desktop/src/shared/appearance-token-manifest.json` | `defaultThemeId` 与 `themes` 中真实主题覆盖值 |
| `packages/desktop/src/renderer/src/styles/shell.css`、`sidebar.css`、`top-chrome.css` | 54px 功能轨、236px 侧栏和 40px 顶部栏的比例与交互样式 |
| `packages/desktop/src/renderer/src/styles/workbench.css`、`thread.css`、`composer.css` | 880px 阅读列、消息层次、新建会话与输入框形态 |
| `packages/desktop/src/renderer/src/styles/fonts.css`、`app/icons.tsx` | IBM Plex 字体和细线图标风格 |
| `packages/desktop/src/renderer/src/app/canvas/CreateSessionPixelLogo.tsx`、`create-session-pixel-logo-masks.ts` | 新建会话中的点阵猫盒品牌与静止帧 |
| `packages/desktop/src/renderer/src/styles/settings.css` | 设置作为覆盖式独立表面的组织方式 |

## Classic 主题的实际取值

旧版 `appearance-tokens.generated.css` 中的基础色包含暖灰和珊瑚色，但不能据此判断最终界面。Manifest 指定默认主题为 `built-in:classic`（经典），其覆盖值将界面改为中性灰；该主题默认色彩模式为 dark，同时定义 light 配色。已有桌面截图呈现灰白外观，本次 Web 使用其浅色形态，不新增主题切换功能。

| 语义 | 旧版 Classic light | 本次 Web 取值 |
| --- | --- | --- |
| 应用与画布 | 应用 `#e4e4e4`，面板 `#f2f2f2` | 主画布 `#f2f2f2` |
| 侧栏与功能轨 | 多为透明色，叠加 Electron 窗口表面 | 侧栏 `#e8e8e8`，功能轨 `#ededed` |
| 正文与次级文字 | `#000`、黑色 47% 不透明度 | `#222`、`#686868`；提示 `#767676` |
| 分割线与输入框边线 | 黑色 11% 与 20% 不透明度 | `#0000001c` 与 `#00000033` |
| 会话选中背景 | `#c8c8c8` | `#d6d6d6` |
| 主要操作 | 黑色 83% 不透明度 | `#2b2b2b`，悬停黑色 |

Web 使用明确背景色表达区域层次，避免把 Electron 的透明窗口语义直接搬入浏览器。原字体优先级保留 IBM Plex Sans，未新增字体下载或字体包；未安装时使用系统字体及中文后备。图标以页面内嵌 SVG 呈现，不引入旧版 React/Lucide 运行依赖。

## 迁移映射

| 旧版形态 | AnyboxV2 对应实现 | 边界 |
| --- | --- | --- |
| 通高功能轨 | 54px 功能轨；侧栏开关、项目与会话、使用说明、设置 | 只展示已存在或本次提供的可用入口 |
| 项目与会话树 | 236px 侧栏；所有项目与各自会话按层级排列，整棵列表统一滚动 | 各项目默认展开并可独立折叠，沿用项目和 Session 数据，不新增树形业务层 |
| 紧凑项目行 | 折叠箭头、文件夹图标、名称与新建会话按钮，完整路径放在 `title` 中 | 会话缩进显示在所属项目下；行内新建只作用于对应项目，不可访问时显示状态 |
| 会话标题与时间 | 从已加载首条可用输入在本地派生标题，显示创建日期 | 未打开或无已知输入时使用 Session ID 摘要；不生成服务端标题 |
| 顶部标签与工作区栏 | 工作区顶栏、各面板标签式标题栏均为 40px | 保留现有多面板和窄屏切换条，不引入旧 Dockview |
| 轻量对话画布 | 880px 最大阅读宽度；用户气泡靠右，助手正文无外层卡片 | 保留现有消息与节点动作，不改变内容协议 |
| 猫盒新建页 | 从旧 idle mask 生成的静态点阵 SVG，以 `anybox-mark` symbol 内嵌并复用 | 无外部图片请求，不移植动画计时器 |
| 底部输入框 | 6px 圆角细边框，文本区自适应高度，Agent/起点说明及图标操作 | Enter 发送、Shift + Enter 换行；运行中仍可继续提交 |
| 分支查看 | 顶部起点/上一级/后续分支；根节点提示及最多三个快捷分支按钮 | 显式 `viewNodeId` 保持，不把最新完成节点视为全局 head |
| 设置入口 | 功能轨底部打开原生 dialog，继续提供 Agent、API Key 和 Prompt 管理 | 不移植旧版完整设置导航或模型切换界面 |
| 帮助入口 | 功能轨底部说明分屏、分支、发送与本地保存 | 内容对应当前可用功能 |
| 窄窗口适配 | 不超过 760px 时功能轨为 44px，项目侧栏变为覆盖式抽屉 | 保留焦点约束、Esc、遮罩关闭及桌面折叠偏好 |

图标按钮使用 `title` 和 `aria-label` 或隐藏文本说明操作，保留键盘焦点描边。项目名称、会话标题和分支输入通过文本节点设置，不把用户输入作为 HTML 插入。空状态区分尚无消息、已有分支、正在运行及根节点位置，避免把返回起点误呈现为历史丢失。

## 保留的行为与未迁移部分

现有 Session 对话树、多 Run、显式取消、最多四个跨项目分屏、拖拽/键盘调整、草稿和查看位置、标签页布局恢复、SSE 变更通知继续使用当前控制器。关闭面板仍只释放浏览器读取与展示资源，不取消已经接受的 Run。当前运行记录标题与卡片已有的 `hidden` 状态保持，数据、过程缓存、错误与控制逻辑仍保留；本次没有将隐藏历史重新显示，也没有删除其实现。

不移植 Electron 窗口控制、透明材质、桌面 IPC、旧版插件/MCP/Skills 管理、日历与自动化、文件浏览器、终端、代码审查、外部编辑器或模型切换。它们不作为失效的装饰按钮出现在本次 Web 界面中。没有增加 Nya Context、组件、数据库字段、HTTP 业务接口或服务端执行生命周期；功能事实仍由当前 Harness、Session 与 Run 提供。

实现入口为 `web/index.html`、`web/style.css`、`src/web/client.ts`、`src/web/workspace-client.ts` 与 `src/web/session-view.ts`。浏览器行为、协议和资源归属详见[薄 Web 客户端设计](./web-client-design.md)。
