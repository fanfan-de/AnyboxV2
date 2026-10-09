# 注册一个应用

[宿主设计](products-v1.md) · [组件导航](modules/README.md)

Anybox 是 NyaCore 应用的宿主应用。每个应用在 `src/applications/<id>/` 中组织注册入口、业务组件、HTTP/客户端适配器和自身界面。只有实际拥有服务、存储、请求或订阅资源的实现才是 Nya 组件；应用目录和运行时辅助函数不创建新 Context。

## 声明目录

实现 `ApplicationRegistration`（`src/host/applications/registration.ts`），将入口加入 `src/entrypoints/` 的正式组合目录。通用客户端 `src/host/client.ts` 与执行端 `src/host/execution.ts` 显式接收 `applications`，空数组是合法空宿主；它们不选择具体应用。默认 CLI 入口保留 Anybox Harness 目录和配置兼容，harness server 包装器位于 `src/applications/harness/server.ts`。保留 Anybox Harness 时加入 `harnessClientApplication(options)` 或 `harnessServerApplication(config,options)`；各入口的宿主资源仍只安装一次。

```ts
import { fileURLToPath } from 'node:url'
import type { ApplicationRegistration } from '../../host/applications/registration.js'
import { createApplicationRuntime } from '../../host/applications/runtime.js'
// 本例入口位于 src/applications/notes/registration.ts；组件工厂由应用提供。
const notes: ApplicationRegistration = {
  definition: { id: 'notes', name: 'Notes', icon: 'note',
    web: { entry: '/applications/notes/web/index.js', styles: ['/apps/notes/style.css'] } },
  assets: [
    { path: '/applications/notes/web/index.js', file: fileURLToPath(new URL('./web/index.js', import.meta.url)), type: 'text/javascript; charset=utf-8' },
    { path: '/apps/notes/style.css', file: fileURLToPath(new URL('../../../web/apps/notes/style.css', import.meta.url)), type: 'text/css; charset=utf-8' },
  ],
  http: { service: 'notes.http' },
  createRuntime: root => createApplicationRuntime(root, installation => {
    installation.install(createNotesComponent())
    installation.install(createNotesHttpComponent())
  }),
}
```

组件通过 inject 声明本轮依赖并使用 deps。业务持久化注入 `local-storage`，用唯一迁移域，不自行再开同一路径连接。共同提供方归宿主；不注入另一个可停止应用的专属服务。

## 运行时和退出

优先使用 `createApplicationRuntime`。每次安装仅通过 installation.install/track/effect 记录归属。track 必须在得到 Fiber 后同步调用，不能等其启动成功再登记。异步初始化在每次外部回调后检查 signal；清理需取消并等待实际退出，不只等待返回值。

应用直接领域入口也可能接受工作时，安装期用 Effect 注册 `app.activity.registerGuard(id, acquire)`。acquire 是同步无 await 的停止保护：忙碌返回 undefined，空闲冻结业务准入并返回幂等解冻函数。该 disposer 归本代安装。HTTP 操作由监听器按 ID 自动登记，应用自有长期操作可显式 enter/release；不要引入 Anybox Harness capability 参数。

runtime.closeAdmission 同步禁止新的初始化和业务调用；awaitIdle 等待已接受控制。stop 卸载拥有的 Fiber 和 Effect，保留数据；清理失败必须报告 phase:cleanup，不能假装 disabled 后覆盖资源。根关闭由宿主完成，应用不得关闭 root。

## HTTP 适配器

提供 `ApplicationHttpPort`。新地址自动挂载到 `/api/client/v1/apps/<id>` 或 `/api/v1/apps/<id>`，收到的 url.pathname 相对该前缀。只在确有兼容需要时声明 legacyRoutes，旧入口直接委托同一适配器。

每个请求使用收到的 context.appId/actorId。context.signal 在该监听器关闭时取消；浏览器断连可由 request/response 事件单独处理。handle Promise 必须等待上传、下载或 SSE 实际退出；订阅在 signal 和 disconnect 时结束并释放资源。已接受异步任务如果超出响应，调用 context.retainUntil(done)，并由任务自己的资源所有者保证取消与退出。不要因浏览器断连自动取消已接受业务。响应私密字段按应用 DTO 白名单输出。

注册项的 `http.capabilities` 声明随应用代码确定的静态能力，适配器可实现 `capabilities()` 补充当前安装实际具备的动态能力。实例信息合并宿主应用管理能力、目录静态声明和活动适配器动态声明；空宿主不宣称 Anybox Harness 能力。业务服务需要按请求从根捕获本代快照，捕获须在首次异步工作前完成；不要缓存跨重启服务，也不要向新一代透明重试旧调用。

## Web 入口

```ts
export async function mount(container, context): Promise<MountedApplication> {
  // 用 context.apiBase 请求本应用 API；所有 DOM 查询从 container 开始。
  // DOM ID / label / SVG 片段使用 context.domId('local-name')。
  const unsubscribe = context.route.subscribe(renderRoute)
  return {
    setActive(active, reason) { /* 暂停布局/快捷键/拖拽；激活后测量 */ },
    canClose() { return !hasUnsavedChanges() },
    async dispose() { unsubscribe(); await cancelAndJoinOwnedRequests() },
  }
}
```

外壳左侧窄条按目录顺序显示全部应用入口。窄条右侧全部由应用内部组件呈现，挂载容器从顶边开始，没有宿主标题栏、顶部应用标签栏或操作栏。应用自行提供所需标题、导航、布局和业务反馈。

每个应用最多一个已打开界面，左侧切换已有挂载使用 select。后台页面继续挂载和持有数据订阅，容器 hidden 且 inert。不要直接修改 location/history、调用 location.reload 或在后台抢焦点。setActive(false) 退出 modal 顶层、菜单和拖拽，保留编辑值；尺寸为零时不要写入布局。仅明确 open 激活可执行“打开业务目标”，select/restore/navigate 只恢复界面。canClose 同步返回能否关闭，不启动后台操作，外壳用于关闭、停止与浏览器离开保护。窄条底部“关闭界面”只等待前端 dispose，不停止后台；显式停止成功后再关闭界面。图标按钮的 title 和 aria-label 包含对应动作及应用名称。“我的应用”管理浮层承载宿主列表、状态、通知、加载失败和界面重载，不替换当前应用。

样式限定应用容器，资源清单包含所有相对 import、模板和样式引用。运行 `npm run build` 验证图；新增入口的工厂文件不可出现在浏览器图中。入口通过同源原生 ESM 导入，不公开本地磁盘路径。

浏览器 JavaScript 地址与编译目录层级一致：宿主为 `/host/web/`，应用为 `/applications/<id>/web/`，允许的纯业务资料为 `/applications/<id>/core/`。这样模块的相对 import 与本地源码解析一致。模板和样式可以登记在 `/apps/<id>/`，清单只公开应用实际使用的资源。

## 验证

参考 `tests/helpers/test-application.mjs` 与 `tests/fixtures/application/`：直接走正式目录，拥有真实 Nya 服务、独立持久行、HTTP 和 Web 页面。运行 `node --test tests/application-host.test.mjs tests/application-workspace.test.mjs`（先 build），再运行根 `npm run check`。

浏览器验收用 `node tests/helpers/products-browser-host.mjs`，输出临时地址，输入 quit 关闭并清理。验证左侧按目录顺序显示 Anybox Harness 和 Notes，右侧从顶边开始完全由应用呈现，没有宿主标题、操作栏或顶部标签栏；通过左侧打开两者、输入草稿后往返切换，检查当前应用标记、滚动位置、分屏与后台运行。切换已有挂载不应重复启动应用或触发 open 业务目标。验证窄条底部关闭/停止按钮的 title 和 aria-label，Notes 未保存内容阻止“关闭界面”，保存后关闭只销毁前端，左侧入口仍在，重新打开持久数据仍在。打开“我的应用”只显示管理浮层，保留当前应用及草稿；加载、失败、宿主通知和重载入口均在浮层中，全部界面关闭后右侧留空。用“后台导航”验证后台路由不抢全局地址；验证上/下方向键、Home/End 只移动左侧焦点，Enter/Space 才打开或切换应用。刷新和深链接应恢复工作区，不启动已停止应用；原有 anybox.apps.workspace.v1 的 tabs 记录仍可读取。连接编辑/删除只刷新 Anybox Harness。显式停止成功关闭对应界面，忙碌停止失败保留界面。界面加载失败应提供单独重载入口，不改后台目标。

为自有组件补齐 `docs/modules/<module>/<component>.md`，记录服务、依赖、配置、数据及资源所有权、准入、取消/退出、故障兼容与测试；加入模块 README 和总导航。
