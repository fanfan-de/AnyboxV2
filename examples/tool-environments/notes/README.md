# 插入资料库环境：Agent 获得搜索与读取工具

这个例子新增一个 `notes` 环境，提供 `notes_search`、`notes_read`。提供方只依赖 `@anybox/tool-api`；已有 Agent、原生协议 Loop、RunRuntime 和 Computer worker 均无须修改。需要增加环境实现，并在受信组合根选择环境。

## 运行

在仓库根目录执行，沿用项目已安装的 workspace 依赖：

```sh
npm run build
node examples/tool-environments/notes/demo.mjs
```

脚本使用临时数据库与工作目录，退出时清理，不打开系统凭据，不使用现有业务库或配置。无需 API Key、Computer worker 或外部服务。

模型响应由明确的离线 fixture 生成；Markdown 数据、模型原生协议编解码、Agent Loop、工具调用、会话持久化与 Run 结算使用实际实现。这验证工具接入与调用链，不验证真实模型的工具选择能力。

## 接入的两个步骤

1. 实现环境，见 [`environment.mjs`](environment.mjs)。声明稳定环境 ID/版本、工具 ID/版本、模型可见的名称/描述/参数，并用 `openScope()` 提供执行、取消与清理。执行入口只处理工具请求，不认识 Agent、Session 或 Models。
2. 在组合根插入实例，并选择 Agent 可用的环境。下面使用已有 `root` 与 Agent 配置；完整启动装配见 [`demo.mjs`](demo.mjs)。

```js
import { installHarnessServerCore } from '@anybox/app-harness/core/index'
import { createNotesEnvironment } from './environment.mjs'

const notes = createNotesEnvironment(documents)
await installHarnessServerCore(root, {
  agents: [{ ...existingAgent, environmentIds: ['notes'] }],
  toolEnvironments: [notes],
})
```

`environmentIds` 是装配配置。Agent 的 instructions、协议实现与运行循环无须加入 `notes_search` 或 `notes_read` 分支：工具定义会进入新会话快照，随后传入模型请求；模型返回的调用经已有路由交给环境执行。

如果还需要 Computer 工具，选择 `environmentIds: ['computer', 'notes']`；Computer 的项目附着规则保持原样。显式 `[]` 表示没有工具环境，省略该字段沿用默认 Computer 环境。

## 实际观察

脚本使用同一个 Agent ID、instructions、任务与模型配置，先运行无环境版本，再关闭并重新装配含 `notes` 的版本：

| 场景 | 模型收到的工具 | 实际调用 |
| --- | --- | --- |
| 未插入环境的会话 | `[]` | 无 |
| 插入环境后新建会话 | `notes_search`、`notes_read` | 搜索“发布检查”，按命中 ID 读取文档 |
| 重新运行原来的旧会话 | `[]` | 无 |

新会话答案包含 [`data/release-checklist.md`](data/release-checklist.md) 的实际内容，例如“执行 `npm run check`”和“验证取消会等待调用和进程资源真正退出”。`computerOperations` 为 `0`，调用未借用 Computer 执行器。

## 生命周期边界

[`demo.mjs`](demo.mjs) 从两个固定 Markdown 文件加载资料，再创建提供方的私有不可变内存快照。查询是同步纯读取，没有持续文件句柄或后台连接，所以 `result` 与 `done` 可以立即完成；scope 取消、关闭或 signal 中止后拒绝新调用，已中止时仍能关闭。

资料字节固定在**这次提供方实例**内；Session 固定的是环境与工具契约，不承诺跨重装配保存旧资料内容。如果应用需要历史资料版本，应由环境自己提供版本化存储。

本例没有耐久原操作查询，不声明 `recovery: 'observe-existing'`。已提交的观察由 Harness 复用，缺少观察的未知调用按默认规则拒绝恢复，不以重读冒充查回原操作。异步环境必须实现实际取消、退出等待与资源清理，见[环境工具契约](../../../docs/tool-environments.md#执行取消与恢复)。

## 验证

```sh
node --test tests/tool-environment-example.test.mjs
npx tsc --allowJs --checkJs --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --types node examples/tool-environments/notes/environment.mjs examples/tool-environments/notes/demo.mjs
```

测试覆盖独立提供方的真实资料读取、快照隔离、取消/关闭准入、未知恢复拒绝，以及实际 Agent 的工具声明、两次调用、新旧会话差异和 Computer 零操作。
