# 项目目录选择

[文档首页](README.md) · [Projects](modules/sessions/projects.md) · [Harness API](modules/web/web-frontend.md) · [客户端网关](modules/web/client-gateway.md)

## 归属与权限

所有实例默认使用应用内对话框，目标名称从打开到确认固定。文件系统操作发生在目标 Harness，浏览器只展示目录 DTO；默认主目录由执行宿主传入 `node:os.homedir()`，不读取客户端主目录来推断远端路径。`HarnessOptions.projectDirectoryHome` 可供嵌入宿主和测试显式配置；未配置的旧嵌入调用继续登记项目，但不提供目录浏览。

Projects 的内部目录提供方拥有浏览会话、目录句柄、扫描调度和过期回收，不注册额外 Nya 服务或创建数据库。浏览、取消和原生窗口返回路径都不登记项目；只有应用内确认后调用原有 `POST /projects {path}`。Projects 再次 realpath、校验目录并按规范路径去重，目录别名继续复用同一项目 ID。

权限以 Harness 进程的操作系统账户为准。设备令牌不是 root 权限，不自动提权或更改文件权限。项目目录是工具运行的相对路径基准，不是文件系统沙箱。目录选择只浏览已有目录，不创建、删除、移动或读取文件内容。

## API v1 与公开 DTO

认证后的 `GET /api/v1/instance` 在实际支持浏览时增加字符串能力 `projects.browse`，不改变 `apiVersion: 1`。以下接口仍要求 Bearer 和期望 `X-Anybox-Instance-Id`；浏览会话绑定当前认证调用方，不能使用另一令牌的会话。

| 方法与路径 | JSON 输入 | 结果 |
| --- | --- | --- |
| `POST /api/v1/projects/directories/browse` | `{action:"open",path?,query?,showHidden?}` | `{browseId,homePath}`；只预留会话，不打开目录句柄 |
| 同上 | `{action:"page",browseId,page}` | `DirectoryPage`；首页为 0，后续使用返回的 nextPage |
| `POST /api/v1/projects/directories/close` | `{browseId}` | 幂等关闭；等待读取和句柄实际退出 |

`DirectoryPage` 包含 `browseId`、`page`、realpath 后的 `path`、`homePath`、可空 `parentPath`、服务端按目标操作系统生成的 `breadcrumbs: {name,path}[]`、`entries` 和可空 `nextPage`。目录条目为 `{name,path,kind:"directory"|"symlink",reason?}`；reason 表示不可进入的原因。没有文件内容、stat 内部对象、认证头或运行句柄。

open 省略 path 时定位配置主目录。路径必须是目标操作系统的绝对路径，不展开 shell 表达式。无效主目录配置不阻止 Harness 启动；默认浏览时返回路径错误，用户仍可显式跳转到有效绝对路径。query 对名称作不区分大小写的子串筛选，showHidden 默认 false，隐藏目录指名称以点开头的目录。条件在会话中固定；切换条件必须关闭并新建会话。

## 分页、链接与资源退出

仅枚举当前层，普通目录使用 Dirent；目录符号链接显示标记并允许进入，进入后展示规范路径。指向普通文件的链接不列为目录；断链、链接循环和权限不足的链接显示原因。普通子目录的权限在进入时检查，枚举可见不代表一定可读。目录选择不沿用 Project Files 的链接禁用或依赖目录排除规则。

每页最多 100 项、扫描 1,000 个原始条目，200 ms 为软扫描预算；正在执行的系统调用仍须等待实际结束。最多 16 个浏览会话、2 个扫描同时执行；同一会话串行，只缓存最近完成的一页以支持同页重试。下一页顺序依据目录枚举顺序，每页内部按名称显示；不为全局排序扫描全部目录。零条目且 nextPage 非空表示仍可继续扫描，不能宣称整个目录为空。

客户端先取得服务端预留的 browseId 再请求首页。close 先撤销该标识的准入，然后取消并等待读取和句柄关闭；迟到的 page 不能重新创建已关闭会话。open 响应丢失只留下无句柄的有界会话。空闲会话 60 秒回收；HTTP 断开取消当前工作，客户端关闭、导航和修改筛选显式关闭会话。无法送达关闭请求时由过期回收兜底。

Projects Effect 停止准入、停止计时器、取消浏览并等待全部在途文件系统操作与句柄清理，同时继续等待原有项目登记事务。取消信号不代表实际退出。清理失败向等待者和关闭调用报告，不静默丢弃。

错误代码区分 `directory-browse-unsupported/invalid/busy/expired/conflict/cancelled/cleanup-failed` 与 `directory-permission-denied/missing/not-directory/link-loop/unavailable`。HTTP 只公开固定代码，不暴露原始系统错误或调用栈；身份、认证和网络错误沿用网关既有代码。

## 客户端与连接绑定

`project-directory-client.ts` 管理状态和请求，`project-directory-view.ts` 管理 DOM、键盘和焦点；两者是客户端实现，不是 Nya 组件。HarnessClient 只负责网络与固定目标，Workspace 沿用现有登记成功后的项目导航刷新。

打开时固定 `{connectionId,instanceId,revision,name}`。选择流程向本机网关发送 `X-Anybox-Expected-Instance-Id` 与 `X-Anybox-Connection-Revision`；网关使用同一次获取的连接租约比较后才允许上游请求。浏览器头不转发给 Harness，Bearer 与执行端实例头仍由网关生成。连接配置变化返回 `connection-changed`，不会向新地址登记原路径。旧客户端不发送这对头的请求继续兼容。

对话框提供路径编辑、面包屑、上一级、主目录、筛选、隐藏目录开关、分页、重试、取消和“选择当前文件夹”。单击聚焦目录，双击或 Enter 进入；方向键、Home/End 移动焦点，Alt+↑ 返回父目录，路径栏 Enter 跳转，Escape 关闭并恢复触发按钮焦点。路径尚未跳转、导航失败、加载或身份失效时不能确认旧目录。失败保留输入、位置及筛选条件。

每次切目录或关闭均中止旧请求，同时使用请求代号忽略迟到响应。本地位置仅保存最后成功的规范路径，按 instanceId 隔离，存储失败退回内存；浏览结果和请求状态不跨实例复用。保存位置失效时明确提示并允许回主目录。

只有组合启动器确认 localInstanceId 匹配且平台支持的实例，才显示“使用系统目录窗口”。原生入口返回路径后回到统一对话框确认，远程实例不会打开客户端电脑的窗口，不按 hostname 判断本机。

缺少 `projects.browse` 的 API v1 实例显示升级说明和应用内手动绝对路径输入；认证失败、连接中断、实例不匹配不会伪装成旧版本。真实目录浏览需要客户端、网关与目标 Harness 都升级，不涉及数据迁移。

## 验证

- [Projects 目录行为测试](../tests/project-directories.test.mjs)：目录事实、别名、筛选分页、容量、取消及实际清理。
- [多实例与网关测试](../tests/remote-harness.test.mjs)：认证、实例、连接版本、白名单和登记隔离。
- [HarnessClient 测试](../tests/harness-client.test.mjs)：固定目标与网络身份边界。
- [目录选择控制器测试](../tests/project-directory-client.test.mjs)：迟到响应、关闭释放、输入保留、旧版兼容与提交隔离。
- [临时浏览器宿主](../tests/helpers/project-directories-browser-host.mjs)：真实认证接口、网关与临时目录，内存凭据；启动后输出测试 URL 和非秘密测试路径，stdin `stop-b` 可制造连接中断，`quit` 清理退出。

完整自动检查为根 `npm run check`。真实浏览器验收覆盖目录选择至正确实例分组、隐藏和分页、键盘与焦点、错误恢复和旧版手动路径。临时多实例验收不代表真实跨机器部署或额外操作系统原生窗口已验收。

### 2026-09-29 浏览器验收记录

最终根 `npm run check` 通过：669 项测试，656 项通过、13 项按已有平台或凭据门控跳过、0 失败；`git diff --check` 及受影响文档的相对链接检查通过。

使用临时宿主在 macOS 的应用内浏览器完成以下操作，未访问生产服务或真实凭据：

- 从目标主目录进入子目录、确认登记，并在对应设备分组中显示项目；两实例登记相同路径仍保持各自身份。
- 隐藏目录、名称筛选、目录链接的规范路径、空目录，以及 115 个目录的 100/15 两页读取。
- 真实权限不足、失效路径及连接中断时保留位置和输入，禁止确认，提供重试和回主目录。
- Enter 进入、End 定位、Alt+↑ 返回、Escape 取消及焦点恢复；390px 窄屏关闭侧栏焦点约束后，Tab 正常留在对话框。
- 旧版能力说明、应用内手动登记，以及多实例项目列表分批返回时刷新页面不误报项目不存在。
- 仅启动器确认的本机显示原生快捷入口；测试使用受控窗口替身返回路径，再由统一确认登记。

本次浏览器工具的鼠标点击未稳定生效，因此目录进入和确认通过键盘完成；双击事件已实现，但未宣称鼠标双击及真实操作系统目录窗口通过本次交互验收。
