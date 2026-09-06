# AnyboxV2

基于 NyaCore 的组件应用基础。当前仅保留 `@anybox/application`，统一装配 Core、Loader、Include、HMR、Timer 和 ConsoleLogger，提供 JSON 配置控制与应用生命周期。

旧的 Agent harness 已删除，Agent Runtime 将从零实现。当前没有模型调用、Agent 执行循环、会话历史或工具调用能力；默认配置为空，示例只验证启动和关闭，不访问网络。

当前内核开发以[通用 Agent 内核 v1 计划](docs/agent-kernel-plan.md)为范围和验收依据，包含预期组件、资源作用域、LLM API 适配、实施顺序与行为验收。[旧 Runtime 制作计划](docs/runtime-implementation-plan.md)保留 9 组 48 类组件的较大范围设计作为参考，不作为当前首版必须完成的组件数量。

产品方向参考[产品架构](docs/architecture.md)、[Runtime 协议草案](docs/runtime-protocol.md)、[Client SDK 设计](docs/client-sdk.md)和[开发计划](docs/development-plan.md)。这些文档中的 Agent/Runtime API 均为待开发设计；下文描述当前可用接口。

## 首次运行

使用 Node.js 22.12 或更高版本，保持两个仓库相邻：

```text
C:\Projects\
├── NyaCore\
└── AnyboxV2\
```

首次检出时先在 NyaCore 中执行 `npm ci`。然后在 AnyboxV2 根目录运行：

```powershell
npm run nya:build
npm install
npm run check
npm run demo
```

六个 Nya 包都使用相邻仓库的包目录依赖。`.npmrc` 中的 `install-links=false` 让 npm 建立目录链接；源码从公共包入口导入，运行时加载 NyaCore 构建后的 `lib`。lockfile 不固定相邻仓库的 Git 提交，本地开发需要该仓库及其依赖。

## 开发命令

| 命令 | 用途 |
| --- | --- |
| `npm run build` | 编译 application |
| `npm run check` | strict 类型检查及全部行为测试 |
| `npm run demo` | 从空 JSON 配置装配应用，启动后关闭 |
| `npm start` | 启动组件宿主，Ctrl+C 关闭 |
| `npm run dev` | 启动组件宿主并监听配置；代码入口须显式指定 |
| `npm run nya:build` | 构建相邻 NyaCore 仓库 |
| `npm run nya:watch` | 仅监听并编译 NyaCore 的 Core 源码 |

自定义配置和开发入口：

```powershell
npm start -- --config ./my-config.json
npm run dev -- --config ./my-config.json --entry ./components/example.ts
```

`--entry` 可重复传入。未指定入口时只监听配置；热替换的代码入口必须明确列出。`--once` 启动后立即关闭，便于验证启动和清理。普通 `npm start` 不监听文件；运行中可通过配置 API 更新，或关闭后重新启动。

修改 application 后重新运行命令进行编译。修改 NyaCore 后先停止 `nya:watch`，再运行 `npm run nya:build` 并重启应用。开发 HMR 面向显式列出的业务组件；框架包、npm 依赖、构建配置变化和 HMR 版本缓存上限要求宿主重启。终端宿主收到 `restart-required` 后清理并以 75 退出。

## 代码结构

```text
packages/application/src/index.ts   框架装配、配置控制与关闭
packages/application/src/types.ts   Application 公共接口
packages/application/tests/         应用、配置、HMR 与宿主行为测试
examples/application/config.json    Include 管理的组件声明，默认 entries 为空
examples/demo.mjs                   有限的启动和关闭示例
examples/host.mjs                   终端、进程信号与关闭期限
docs/agent-kernel-plan.md            当前通用 Agent 内核开发计划
docs/runtime-implementation-plan.md  较大范围的旧 Runtime 设计参考
```

## 嵌入应用

```js
import { createApplication } from '@anybox/application'

const application = createApplication({
  configPath: './examples/application/config.json',
})

try {
  await application.start()
  console.dir(application.context.loader.entries())
} finally {
  await application.close()
}
```

创建应用不加载业务组件、不注册进程信号，也不直接退出进程。`start()` 装配同一棵 Context 树并加载配置，检查基础设施及配置协调结果；空组件配置可以正常启动。初始化失败会清理已创建的资源。Application 不要求 Agent 服务，也不提供 `run()` 或模型注入选项。

`application.context` 提供 Nya 的公开日志、事件和诊断入口，例如 `context.logger.records()`、`context.fiber.inspect()`、`context.loader.entries()`。业务组件的就绪状态由实际依赖决定，应用启动不等于任意业务服务已经可用。服务引用只在对应组件运行期间有效，后续操作应重新从 Context 获取。

宿主还应观察 `failure` 和 `restartRequested`：前者以首次启动、生命周期或关闭错误 resolve，可能包含 Core 的 AggregateError；后者以 HMR 重启报告 resolve。它们都不会因正常关闭而完成。是否退出、何时重试和启动/关闭期限由宿主决定。[host.mjs](examples/host.mjs)演示终止路径；[demo.mjs](examples/demo.mjs)保留启动及清理两阶段的错误，避免清理错误覆盖原始失败。

## 配置控制

[示例配置](examples/application/config.json)为：

```json
{
  "version": 1,
  "entries": []
}
```

后续组件按 Include 声明加入 `entries`。组件模块相对所属 JSON 文件定位；供 Loader 使用的模块默认导出组件定义。子文件使用 `type: 'include'` 和 `path` 声明。

应用启动后可提交完整来源文档：

```js
const next = { version: 1, entries: [] }

console.dir(await application.previewConfig(next))
const report = await application.saveConfig(next)
console.log(report.saved, report.status)
```

`previewConfig()` 只预览树操作。`saveConfig()` 保存文件并协调组件运行；`saved: true` 表示文件已保存，`status: 'partial'` 表示运行协调仍有失败，应读取报告并处理。更新来源前有外部编辑时会报配置冲突；无效 JSON 不会替换上次接受的运行。

在条目上设置 `disabled: true` 后保存即可停用，移除或改为 `false` 后保存即可恢复。依赖此服务的组件会按 Nya 生命周期协调；组件自己负责取消并等待所拥有的任务。

`refreshConfig()` 重读磁盘来源；`recover(loaderId)` 显式重试受管失败条目。Loader ID 可用 `context.include.entryId('组件声明的 ID')` 取得。编辑已挂载子文件时，向 `previewConfig()` / `saveConfig()` 的第二个参数传入 `context.include.sources()` 返回的绝对文件路径。文件受管声明通过 Include 修改。

配置控制只在应用运行时可用；启动前返回 `ApplicationNotReadyError`，关闭开始后返回 `ApplicationClosedError`。`close()` 幂等，重复调用返回同一次关闭结果。

仅启用配置监听可设置 `development: {}`。同时热替换代码可设置 `development: { entries: [绝对文件URL或路径] }`；应用会先准备 HMR Resolver，再由 HMR 首次读取配置，因此声明可以指向受管 TypeScript 源文件。构建或导入失败时，候选错误通过 `development.onReport` 报告，原有健康代码继续运行；候选启动后的组件失败仍会进入生命周期失败通道。

## 生命周期与验证

组件 `apply()` 完成初始化后返回；长期资源交给 Effect，定时器使用 Timer。Timer 取消只停止未来调度，在途任务仍由所属组件显式取消并等待。库不强制中断 JavaScript Promise。终端宿主的关闭期限为 5 秒，超时退出不会声称资源已经清理完毕。

测试覆盖通用组件装配、配置预览与保存、依赖恢复、启动/关闭竞态、失败报告、JS/TS 同进程热替换及终端宿主退出。修改生命周期、取消或资源归属时同步更新测试，并运行 `npm run check`；修改示例后运行 `npm run demo`。未来 Runtime 的执行与取消行为由新增测试独立验收。

交付时将实际使用的 Nya 包统一切换到同批版本 tarball，保留安装包和 lockfile，再验证脱离相邻仓库的独立安装。NyaCore 的源码版本号不代表候选已发布到 npm。
