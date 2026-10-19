# 注册一个应用

[宿主设计](products-v1.md) · [组件导航](modules/README.md)

本文描述受信静态组合与已安装角色目录共用的应用接入契约。D0a 已将每个正式应用拆为独立的 workspace 源码包，拥有自己的 `package.json`、依赖、公开入口、构建与测试；宿主仅保留最小接入与生命周期契约，D0b 已接入必需/可选能力的版本选择、缺失诊断、按消费者启停和通用桌面退出保护。SQL 与目录适配按明确能力需求使用，连接与凭据业务各归应用，纯界面应用无需后台或业务 HTTP。D1.3 已接入本地包安装，D1.4 已接入最小宿主的正式角色加载与受控生效，D1.5 已接入本机卸载、代码回收及显式恢复；在线下载仍待 D2。完整目标生命周期见[宿主设计](products-v1.md)，能力差距与实施顺序见[模块化分发与按需安装设计](application-packages-design.md)。

Anybox 是 NyaCore 应用的宿主应用。每个应用在 `packages/app-<name>/src/` 中组织注册入口、业务组件、HTTP/客户端适配器和自身界面。只有实际拥有服务、存储、请求或订阅资源的实现才是 Nya 组件；应用目录和运行时辅助函数不创建新 Context。

需要独立业务服务的应用按 [D0a.1](application-standalone-services.md)提供可复用业务装配及自己的服务入口、HTTP 和认证实现。业务装配只依赖应用自己的真实组件与所选提供方；`app.activity` 忙碌保护、应用注册和宿主启停留在 Anybox 接入适配。独立服务创建唯一根，Anybox 注册在已有根安装同一业务实现，不调用会另建根的独立服务工厂。

D1.2 的 `anybox.app.json`、应用自有 `src/package/` 纯注册工厂、完整依赖产物和资源索引见[目录、归档与准备契约](modules/package-management/archives.md)。Node 工厂仅构造注册描述，不能在导入或准备阶段初始化数据库、凭据、连接或其他业务；纯界面包无需增加工厂。发布签名或显式本地目录信任及完整静态验证完成后才允许准备，实际安装和正式角色加载已分别由 D1.3/D1.4 接入；旧 distribution 默认完整发行仍保留，不能把最小宿主路径的完成等同于默认桌面迁入完成。

## Agent 直接创建并安装应用文件夹

应用包首先是一套文件结构，`.anybox-app` ZIP 是可选的分发形式。Agent 可以直接在项目里写一个可运行的应用文件夹，再由用户或已获授权的 Agent 显式以本地信任安装；不需要发布私钥、生成签名或先压缩。最小纯界面应用只需要：

```text
notes/
  manifest.json
  payload/
    assets.json
    web/app.js
```

下面的脚本创建一个能直接安装的便签界面。示例使用原生 JavaScript，没有编译、依赖安装或后台服务；`target` 固定为创建时的设备平台，资源 URL 按应用版本隔离。

```sh
node --input-type=module <<'JS'
import { mkdir, writeFile } from 'node:fs/promises'
const directory = './notes'
await mkdir(`${directory}/payload/web`, { recursive: true })
await writeFile(`${directory}/manifest.json`, JSON.stringify({
  schemaVersion: 1, appId: 'notes', version: '1.0.0',
  publisher: 'local', displayName: 'Notes', applicationApi: '^0.1.0',
  target: { os: process.platform, arch: process.arch },
  web: { entry: 'payload/web/app.js', assets: 'payload/assets.json' },
}, null, 2))
await writeFile(`${directory}/payload/assets.json`, JSON.stringify({
  schemaVersion: 1,
  assets: [{ path: '/apps/notes/1.0.0/app.js', file: 'payload/web/app.js', type: 'text/javascript' }],
}, null, 2))
await writeFile(`${directory}/payload/web/app.js`, `
export async function mount(container) {
  const editor = document.createElement('textarea')
  editor.setAttribute('aria-label', 'Notes')
  editor.placeholder = 'Write a note'
  container.replaceChildren(editor)
  return {
    setActive() {},
    canClose: () => !editor.value,
    async dispose() { container.replaceChildren() },
  }
}
`)
JS

anybox-host install ./notes --endpoint http://127.0.0.1:3000 \
  --trust-local --request-id notes-1.0.0
```

`--trust-local` 仅用于显式信任本地文件夹；它不让归档、下载或其他上传自动受信。安装器为无签名目录计算文件索引，校验完整资源图并复制到宿主管理的不可变版本目录。源文件夹后续修改不会改变已经安装的代码。命令在本机读取目录，仅把快照传给明确指定的回环管理 origin，不把服务端路径交给 HTTP。在线结果不明时只观察原请求与任务，不重放上传。

安装后在“我的应用”中应用更改并手动打开，也可以运行 `anybox-host apply --endpoint http://127.0.0.1:3000 --request-id notes-apply-1.0.0 --app notes`。若创建应用的 Agent 自身仍有工作或页面有草稿，现有 guard 继续阻止生效，安装保留待生效，不能为了安装自身应用而绕过退出保护。离线安装将 `--endpoint` 换成 `--directory ./data/applications`，并先停止持有该包管理根的宿主。

Agent 迭代时修改工作目录，提升 `manifest.version`，同步资源索引的版本 URL，再使用新 `request-id` 安装并应用更改。同一版本与目标的不同内容不覆盖旧安装；安装不等于把工作目录挂载为实时源码。TypeScript、JSX 和有构建步骤的框架仍需由开发者或 Agent 先生成可运行 JavaScript、界面资源和完整依赖；宿主不替应用执行 npm、编译或安装脚本。未提供 `files.json` 时，本地目录载荷统一为 0644，以保证 CLI 和浏览器导入身份一致；有可执行文件时需显式索引及一致的文件模式。第三方依赖的许可证放在 `licenses/` 中，用户数据库、密钥与个人文件不进入安装目录。

跨设备分发时可以选择给同一目录增加 `files.json` 和 `signature.json`，由宿主外部发布者策略验证；也可以把已签名目录编码为 `.anybox-app`。签名目录与归档共享内容身份，压缩不会创造新的应用版本。完整生产应用构建器默认输出目录，`--archive` 才额外生成签名 ZIP，见[产物构建](modules/package-management/archives.md#构建与使用)。

## 生命周期职责

目标宿主管理应用的下载、包校验、安装、版本生效、打开运行、关闭和卸载，以及对应状态、失败与恢复。新安装应用默认关闭；安装、版本生效与打开分别操作。宿主只消费应用的通用生命周期反馈：能否关闭、是否就绪、是否实际退出及失败原因，不理解应用内部的业务状态。

应用负责初始化自己的业务、校验和迁移自己的数据、关闭业务准入、取消或排空已接受工作、释放实际资源，并如实报告完成。设备连接、配对、访问凭据、会话、Run、Models、Computer 等均由所属应用处理；宿主不得为了关闭或卸载应用直接调用这些业务服务。共享基础库按需选择，不构成所有应用必需的宿主业务层。

“关闭界面”只销毁该界面；目标中的“关闭应用”协调需要关闭的界面与受管运行入口。卸载先等待这些入口实际退出、安装版本无人使用，再删除代码和安装记录，默认保留业务数据。独立远端实例不因本机关闭或卸载而被停止；显式删除业务数据由数据所有者执行。以下 `ApplicationInstallation`、`installation.install` 和 `runtime.stop` 指当前进程内的组件装配与释放，不表示磁盘应用包已安装或卸载；文件安装、生效及各自恢复有独立生命周期端口；D1.5 用户卸载沿用包管理批次、通用保护与实际退出证明，不要求应用新增业务卸载端口；所有安装身份 removed 且 remove 操作完成才报告卸载，失败保留原批次恢复。

## 安装角色与纯注册工厂

签名包的 `createRegistration(context, config)` 只构造描述，`context.phase` 区分 prepare/runtime，`role` 区分 client/execution/computerWorker，不能在导入或构造时打开资源。配置由 `ANYBOX_APPLICATION_CONFIG` 指向的非秘密 JSON 按 `applications[appId][role]` 传入，应用自有 schema 和默认路径；宿主不解释这些业务配置，也不接收浏览器提供的配置或秘密。

含 Computer worker 的包须声明 `lifecycleVersion: 1`。正式 runtime 上下文在确有同包声明时提供 `startRole('computer-worker', { ownership: 'independent', args })`；准备时没有该能力。它只启动签名包自己的 main，不接受命令、路径或其他包。调用须属于存活的应用受管运行入口；父子 usage 连续持实际锚，成功确认后 worker 独立拥有生命周期，关闭客户端不停止它。原 worker 协议、数据、附着和凭据仍由应用自己持有。旧未声明版本的 worker 包须重新构建升级，不能回退旧 spawn 路径；当前宿主包管理的独立角色启动仅支持 Unix Node；这与 Harness 自有入口的[Windows 原生 Computer](native-platform-support.md)支持分开，应用内部后端不会替代宿主的代码使用锁和角色适配。

同包本机角色需要内部通信时，可在正式 runtime 客户端上下文使用 `context.channel.request(payload, signal)`，由执行端注册的 `channel.handle(root, payload, context)` 接收。宿主固定同一 appId、确切包身份及实际 ready 的角色，转送有界 JSON 并传播取消；应用定义协议和业务路由，负责 handler 在取消后的实际退出。准备阶段不提供通道，纯注册不得初始化业务。通道不要求创建执行设备连接或发行长期令牌；远端地址、认证及连接管理继续属于应用。角色未 ready、冻结、退出或版本不匹配时应显示不可用，不回退旧服务。完整界限见[同包角色私有通道](modules/package-management/activation.md#同包角色私有通道)。

正式加载器持确切快照使用锁，重新验证目录和签名后构造注册。它不调用业务 open；用户打开后才由 Products 与 Nya 安装实际组件。installed、pending、selected 与角色 ready 代次各表达不同事实。生效是同进程全部应用及所有页面的协调重启，默认不取消业务：应用 guard 忙碌或任一 mounted.canClose 拒绝时保留 pending；dispose 必须等资源实际退出，失败须阻止重启。界面 reload 仅在所有角色 ready 后发生，原工作区位置可恢复，新装应用不会自动打开。完整端口、失败和恢复边界见[正式加载与生效手册](modules/package-management/activation.md)。

## 声明目录

从 `@anybox/application-api/node` 导入 `ApplicationRegistration`；使用 Nya 根的应用从 `/nya` 导入对应特化类型，将入口加入 `packages/distribution/src/entrypoints/` 的正式组合目录。通用客户端 `packages/host/src/client.ts` 与执行端 `packages/host/src/execution.ts` 显式接收 `applications`，空数组是合法空宿主；它们不选择具体应用。默认 CLI 入口保留 Anybox Harness 目录和配置兼容，harness server 默认包装器位于 `packages/distribution/src/composition/harness-server.ts`。保留 Anybox Harness 时加入 `harnessClientApplication(options)` 或 `harnessServerApplication(config,options)`；各入口的宿主资源仍只安装一次。Claude Agent（`claudeAgentClientApplication` / `claudeAgentServerApplication`，见 [设计](claude-agent-design.md)）是正式目录里第二个完整示例：两侧分别注册。正式安装的本机角色通过应用自己的私有通道协议衔接，不建立设备连接或发行访问令牌；远端执行设备仍通过应用自己的连接存储、凭据、转发与管理界面访问，不依赖 Harness。旧 distribution 完整组合保留兼容连接路径，D3 迁入尚未完成。

客户端工厂从 `packages/app-harness/src/client/registration.ts` 导入，服务端工厂从 `packages/app-harness/src/registration.ts` 导入。两侧只共享 `definition.ts` 的纯产品元数据；不要使用重新导出双方运行时的聚合入口，否则纯客户端也会加载执行端依赖。

```ts
import { fileURLToPath } from 'node:url'
import { createApplicationRuntime, type ApplicationRegistration } from '@anybox/application-api/nya'
// 本例入口位于 packages/app-notes/src/registration.ts；组件工厂由应用提供。
const notes: ApplicationRegistration = {
  definition: { id: 'notes', name: 'Notes', icon: 'note',
    web: { entry: '/applications/notes/web/index.js', styles: ['/apps/notes/style.css'] } },
  assets: [
    { path: '/applications/notes/web/index.js', file: fileURLToPath(new URL('./web/index.js', import.meta.url)), type: 'text/javascript; charset=utf-8' },
    { path: '/apps/notes/style.css', file: fileURLToPath(new URL('../web/style.css', import.meta.url)), type: 'text/css; charset=utf-8' },
  ],
  capabilityRequirements: {
    required: { 'storage.sqlite': '^1.0.0' },
    optional: { 'system.directory-picker': '^1.0.0' },
  },
  http: { service: 'notes.http' },
  createRuntime: (root, context) => createApplicationRuntime(root, installation => {
    const hasPicker = !!context.capabilities['system.directory-picker']
    installation.install(createNotesComponent())
    // 此应用工厂按 hasPicker 条件声明 inject；缺失时不注入目录服务。
    installation.install(createNotesHttpComponent({ hasPicker }))
  }),
}
```

组件通过 inject 声明本轮依赖并使用 deps。SQL 业务持久化注入 `local-storage`，各自登记迁移域，不自行再开同路径连接。设备连接、访问凭据、配对、转发与管理 UI 必须位于应用内部，不依赖另一应用或跨应用业务提供方。SQL、系统凭据库和目录窗口仍可作为明确基础依赖；宿主接入 API 不强制它们。详情见[应用客户端业务独立归属](application-client-isolation.md)。

只提供界面的应用可以省略 `createRuntime`、`http` 和能力需求。宿主不为它创建空后台、不写后台期望状态，也不因查询或打开界面而初始化能力提供方；如声明能力需求，仍可获得兼容性诊断，必需项缺失时显示 blocked。`ApplicationWebContext.apiBase` 只有声明 HTTP 时才提供；业务 HTTP 界面可在挂载边界用 `@anybox/application-api/web` 的 `requireApplicationHttp(context)` 验证一次。

## 能力需求与按需提供方

`capabilityRequirements` 描述本次注册入口消费的基础能力，required 和 optional 的值均为 SemVer 范围，同一能力不能同时属于两组。宿主在调用应用 `createRuntime` 之前完成选择：选择阶段任一必需项不可用则 blocked，应用工厂及所有新提供方工厂都不执行；可选项缺失、平台不支持或版本不兼容时由应用降级。能力声明仅用于兼容与资源所有权协调，不是权限授予，也不能声明跨应用业务依赖。

受信组合向 `createClientHost` / `createExecutionHost` 传入 `providers`。提供方描述来自 `@anybox/application-api/nya`，声明稳定能力 ID、具体版本、所提供的 Nya 服务和惰性工厂，例如：

```ts
import type { ApplicationCapabilityProvider } from '@anybox/application-api/nya'
import {
  createDirectoryPickerComponent, directoryPickerSupported,
  directoryPickerCapabilityId, directoryPickerCapabilityVersion, directoryPickerServiceKey,
} from '@anybox/directory-picker'

const pickerProvider: ApplicationCapabilityProvider = {
  id: directoryPickerCapabilityId,
  version: directoryPickerCapabilityVersion,
  services: [directoryPickerServiceKey],
  supported: directoryPickerSupported(),
  create: () => createDirectoryPickerComponent(), // 此组件没有异步初始化；通用工厂仍接收 { signal }。
}
// await createClientHost({ path, applications: [notes], providers: [pickerProvider] })
```

`create({ signal })` 本身只构造组件，只有取得消费者后才执行；如果组件有异步初始化，必须响应该 signal、取消并等待已经开始的初始化实际退出。持有的资源仍由组件 Effect 清理，不能因收到取消信号就报告释放完成。`supported: false` 的工厂不会执行，因此默认 Windows/Linux 组合不会初始化当前仅支持 macOS 的目录能力。

宿主选择可用且兼容的最高版本；已有消费者时固定该版本。新应用不兼容当前固定版本，或两个提供方声明同一服务时，报告 conflict，不替换在用版本。按能力 ID 与服务名协调并发获取和最后释放，互不冲突的能力可独立启动。只有实际取得的提供方进入本代冻结的 `ApplicationRuntimeContext.capabilities: Readonly<Record<string, string>>`；它包含版本元数据，不包含服务句柄。应用工厂据此决定条件依赖，组件仍从本轮 `deps` 读取实际服务，不在缺少可选能力时留下必需 `inject`，也不跨重启缓存服务引用。正式写法可参考 `packages/app-harness/src/client/gateway.ts`：`inject` 中仅在本代取得目录能力时加入 `directoryPickerServiceKey`，`apply` 则仅在相同条件下从 `deps[directoryPickerServiceKey]` 读取并传给应用自己的网关。

`ProductView.capabilities` / 可选 `ApplicationRuntime.capabilities()` 返回安全状态：ready、missing、unsupported、incompatible、conflict 或 failed，以及需求范围、是否必需与已选版本。查询只计算诊断，不初始化提供方；这些状态不泄露密钥、路径、句柄或原始底层异常。

每代应用先完成实际停止和资源清理，再释放能力租约；最后一个消费者退出后才卸载非 resident 提供方，并等待其实际退出。宿主自用的 `storage.sqlite@1.0.0` 属于 resident 提供方，已有连接不因最后一个应用停止而关闭；宿主自己的控制记录仍需该存储。这不要求其他应用使用 SQL，也不迁移或合并应用业务。能力管理器只是宿主运行时的选择与归属辅助函数，不是新 Nya 组件，不另建 Context，依赖就绪和组件清理仍由 Nya 协调。

## 运行时装配和退出（当前实现）

优先使用 `createApplicationRuntime`。宿主每次干净打开或重试均调用新的应用工厂，传入本代冻结的能力选择；上代资源实际退出前不创建替代代次。每次运行时装配仅通过 installation.install/track/effect 记录归属。track 必须在得到 Fiber 后同步调用，不能等其启动成功再登记。异步初始化在每次外部回调后检查 signal；清理需取消并等待实际退出，不只等待返回值。

Anybox 集成中的应用直接领域入口也可能接受工作时，注册适配在安装期用 Effect 注册 `app.activity.registerGuard(id, acquire)`。acquire 是同步无 await 的停止保护：忙碌返回 undefined，空闲冻结业务准入并返回幂等解冻函数。该 disposer 归本代安装。HTTP 操作由宿主监听器按 ID 自动登记，应用自有长期操作可显式 enter/release；业务装配通过可选集成端口使用这些保护，不能要求独立入口安装活动管理。应用自身仍须关闭准入并取消、排空实际工作。

runtime.closeAdmission 同步禁止新的初始化和业务调用；awaitIdle 等待已接受控制。stop 释放拥有的 Fiber 和 Effect，保留代码和数据；清理失败必须报告 phase:cleanup，不能假装 disabled 后覆盖资源。初始化失败的 Fiber 不能证明回滚已完整释放时也保守保留清理栅栏；根关闭不能吞掉该错误后报告成功。异步迟到初始化不能注册到新代或重新开放准入。当前清理失败需重启宿主，尚无目标生命周期中的恢复清理入口。Anybox 集成中的根关闭由宿主完成，应用不得关闭宿主 root；独立服务工厂负责关闭自己创建的唯一根。

装配辅助函数按运行代观察 Nya Registry 中所属 Fiber 的失败事实，覆盖准入冻结后才完成的失败清理；成功停止解除观察，不保留旧代。该观察不重建依赖拓扑，也不改变 Nya 卸载顺序。

## HTTP 适配器

提供 `ApplicationHttpPort`。新地址自动挂载到 `/api/client/v1/apps/<id>` 或 `/api/v1/apps/<id>`，收到的 url.pathname 相对该前缀。只在确有兼容需要时声明 legacyRoutes，旧入口直接委托同一适配器。

每个请求使用收到的 context.appId/actorId。context.signal 在该监听器关闭时取消；浏览器断连可由 request/response 事件单独处理。handle Promise 必须等待上传、下载或 SSE 实际退出；订阅在 signal 和 disconnect 时结束并释放资源。已接受异步任务如果超出响应，调用 context.retainUntil(done)，并由任务自己的资源所有者保证取消与退出。不要因浏览器断连自动取消已接受业务。响应私密字段按应用 DTO 白名单输出。

注册项的 `http.capabilities` 声明随应用代码确定的静态能力，适配器可实现 `capabilities()` 补充当前安装实际具备的动态能力。实例信息合并宿主应用管理能力、目录静态声明和活动适配器动态声明；空宿主不宣称 Anybox Harness 能力。业务服务需要按请求从根捕获本代快照，捕获须在首次异步工作前完成；不要缓存跨重启服务，也不要向新一代透明重试旧调用。

## Web 入口

```ts
export async function mount(container, context): Promise<MountedApplication> {
  // 仅声明 HTTP 的应用使用 context.apiBase；纯界面应用不需要业务 API。
  // 所有 DOM 查询从 container 开始。
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

可直接安装的最小纯界面测试应用见 [Anybox Test](host-test-application.md)，目录为 `tests/fixtures/host-test-app/`。它通过计数、草稿保护、可取消任务和生命周期日志验证正式安装与 Web 契约，不进入生产应用目录，也不需要后台或模型配置。

参考 `tests/helpers/test-application.mjs` 与 `tests/fixtures/application/`：直接走正式目录，拥有真实 Nya 服务、独立持久行、HTTP 和 Web 页面。运行 `node --test tests/application-host.test.mjs tests/application-workspace.test.mjs`（先 build），能力与生命周期验证另见 `tests/application-capabilities.test.mjs`、`tests/application-optional-capabilities.test.mjs`、`packages/host/tests/providers.test.mjs`、`packages/application-api/tests/lifecycle.test.mjs` 与 `tests/desktop-application-lifecycle.test.mjs`；再运行根 `npm run check`。

浏览器验收用 `node tests/helpers/products-browser-host.mjs`，输出临时地址；`hold-model` / `release-model` 控制模型响应，`fail-ui` / `restore-ui` 注入并恢复临时界面加载失败，`state` 查看执行端状态，`quit` 关闭并清理。验证左侧按目录顺序显示 Anybox Harness 和 Notes，右侧从顶边开始完全由应用呈现，没有宿主标题、操作栏或顶部标签栏；通过左侧打开两者、输入草稿后往返切换，检查当前应用标记、滚动位置、分屏与后台运行。切换已有挂载不应重复启动应用或触发 open 业务目标。验证窄条底部关闭/停止按钮的 title 和 aria-label，Notes 未保存内容阻止“关闭界面”，保存后关闭只销毁前端，左侧入口仍在，重新打开持久数据仍在。打开“我的应用”只显示管理浮层，保留当前应用及草稿；加载、失败、宿主通知和重载入口均在浮层中，全部界面关闭后右侧留空。用“后台导航”验证后台路由不抢全局地址；验证上/下方向键、Home/End 只移动左侧焦点，Enter/Space 才打开或切换应用。刷新和深链接应恢复工作区，不启动已停止应用；原有 anybox.apps.workspace.v1 的 tabs 记录仍可读取。连接编辑/删除只刷新 Anybox Harness。显式停止成功关闭对应界面，忙碌停止失败保留界面。界面加载失败应提供单独重载入口，不改后台目标。

为自有组件补齐 `docs/modules/<module>/<component>.md`，记录服务、依赖、配置、数据及资源所有权、准入、取消/退出、故障兼容与测试；加入模块 README 和总导航。
