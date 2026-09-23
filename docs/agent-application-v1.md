# 持久运行的 Agent 应用 v1

状态：已实现本地单实例应用、SQLite 持久化、自动初始化、异常退出后的明确结算，以及 loopback HTTP 宿主。2026-09-22。

AgentApplication 表达长期可用的应用；Agent ID 表达跨重启身份；Session 和 Run 是保存的数据；Harness 是应用内的执行引擎。本版 tasks API 中的一项任务对应一个 Run，还没有跨多个 Run 的独立项目/任务编排对象。

## 运行

需要 Node.js 22.13+，本轮在 24.16.0 验证。默认模型仍是无网络 Mock。

```sh
npm run start:agent
# 可覆盖存储位置、端口与 Agent 定义
npm run start:agent -- --data .anybox/agent.sqlite --port 4318 --definition examples/agent-application/agent.json

# 有限示例：执行、关闭、重新打开、验证历史与请求去重
npm run demo:application
```

HTTP 宿主绑定 `127.0.0.1`，不依赖 stdin 存活。应用库不安装信号处理器、不强制退出；宿主处理 SIGINT/SIGTERM 和五秒关闭期限。HTTP 监听器登记到应用 Context 的 Effect；关闭先停止接收，再清理调用与存储。它是本地可运行的服务入口，尚未包含公网认证、TLS、集群或进程监督器。部署进程的拉起和异常重启由外部宿主管理。

配置文件中的 AgentDefinition 是业务定义，不包含凭据，不属于 Include 的组件部署声明。普通框架组件配置仍通过 application 的 Include 控制面修改。

## 函数式结构

| 模块 | 职责 | 编程边界 |
| --- | --- | --- |
| agent-contracts | AgentApi、应用状态、任务请求与 interrupted 终态 | 项目自有数据与函数接口 |
| agent-kernel/src/domain/recovery.ts | 计算未完成记录的恢复结果 | 纯函数 planRecovery(snapshot, recoveredAt)，不读取时间、不生成随机数、不执行 I/O、不修改输入 |
| agent-kernel/src/components/state/codec.ts | 快照编码、解码和结构校验 | 纯数据转换 |
| agent-kernel/src/components/state/sqlite.ts | 数据库打开、所有权、提交和关闭 | SQLite 类型只存在于副作用边界内 |
| agent-application/src/components/agent/component.ts | 自动初始化当前代 kernel，发布 AgentApi | 使用本轮注入快照，不缓存跨重启服务 |
| agent-application/src/application.ts | 组合提供方、生命周期与根控制面 | 函数组合和闭包，不新增业务类 |
| examples/agent-application-host.mjs | 路由、HTTP、信号与退出策略 | 纯路由选择与有副作用的请求执行分开 |

纯函数内部可创建和修改自己的副本；不会修改调用方的快照。启动状态、数据库句柄和取消资源保留在副作用边界的闭包中。存储事务的草稿写入仍按项目既有 SPI 执行，不能在事务回调中进行外部 I/O。

## 嵌入方式

```ts
import { createAgentApplication } from '@anybox/agent-application'
import { createSQLiteState, createMockModel } from '@anybox/agent-kernel'

const app = createAgentApplication({
  configPath: '/absolute/path/to/application/config.json',
  definition,
  state: () => createSQLiteState({ path: '/absolute/path/to/agent.sqlite' }),
  model: createMockModel,
})

await app.start() // 安装提供方、恢复记录、初始化 Agent，再对外就绪
const session = await app.sessions.create()
const accepted = await app.tasks.submit({
  sessionId: session.id,
  expectedSessionVersion: session.version,
  requestKey: 'external-request-1',
  input: [{ type: 'text', text: 'hello' }],
})
const result = await app.tasks.wait({ runId: accepted.runId })
await app.close()
```

state/model/tools 和 strategies 均由组合根选择。应用层拒绝 memory-only StateService，要求 persistent 提供方在整个打开期间拥有排他访问权。底层 MemoryStateComponent 和原 Harness 用法继续保留。

组件都在现有 application 的同一 Root Context 中，初始化后返回；没有在 apply 中运行永久循环。空闲时由宿主 HTTP 等事件来源维持可用性。根 facade 的每个请求重新通过 context.get('agent.application') 取当前服务；组件内部从 deps 使用当前代 kernel。依赖正常撤销/重建时自动初始化新一代 facade，旧 facade 明确拒绝请求。FAILED 不依赖变化自动恢复，仍需明确 restart/update/recover。

start/close 幂等；关闭后不能重新启动同一个应用对象，应重新创建。关闭与异步数据库获取竞争时，Effect 等获取完成并释放句柄，避免遗留数据库锁。状态服务最后关闭，已保存的数据不会因为资源清理被删除。

## 身份、任务与请求去重

- Agent id 和 createdAt 保持不变；每次初始化生成新的 generation。
- Session、消息、Run、步骤、模型调用、工具调用、事件和请求键全部保存。
- AgentDefinition 目前必须与保存的定义一致；不同定义/版本拒绝启动，不自动覆盖历史。在线业务定义更新与迁移后续另行交付。
- tasks.submit 自动填入当前 Agent ID/generation，调用方提供稳定 requestKey、原 expectedSessionVersion 和输入。
- 应用装配使用 `requestScope: 'agent'`。同一 Agent/Session/requestKey 在进程重启后仍去重；指纹不包含 generation，相同原请求返回原接受回执，内容或预期版本改变返回 CONFLICT。
- 原 kernel 默认仍使用 generation 范围的去重。原始 runs.start 的旧 generation 继续被拒绝，稳定重试使用应用任务入口。
- 请求键不淘汰；达到 maxRuns/maxSessions 或快照容量后明确拒绝，不通过删除去重记录腾出容量。

## 恢复语义

SQLite 提供方取得排他所有权后，应用以 `recovery: 'interrupt'` 初始化 kernel。首先验证定义和能力，然后在同一个初始化事务中应用纯函数恢复结果与新 generation。

| 保存时的状态 | 重启后的处理 |
| --- | --- |
| completed / failed / cancelled / interrupted | 原样保留 |
| queued / running / cancelling Run | 结算为 interrupted，错误码 INTERRUPTED |
| pending ToolCall | cancelled，表示未派发 |
| running ToolCall | uncertain，表示外部执行结果无法确认 |
| 已保存的工具结果 | 保留，不重放 |
| 未结束的模型 Attempt / Step | 标记失败，记录恢复事件 |

恢复生成缺少的工具结果消息，继续单调事件序号，并将对应 Session.version 增加一次。重复启动不再次结算，不重复追加恢复消息。initialize 提交失败则整体回滚，不能出现新 generation 搭配半份恢复记录。

`describe().recovery.interruptedRunIds` 报告本次初始化处理过的任务；`runs.wait` / `tasks.wait` 对 interrupted 正常返回终态。恢复后允许明确提交新请求，但不会自动重放原模型或工具，也不会自动继续排队工作。调用者应根据历史中的 uncertain 结果决定下一步。

正常 close 会取消并等待当前工作，保存 cancelled/failed；异常进程退出才在后续启动中产生 interrupted。两者都不会删除 Agent 身份和记录。

## SQLite 提交与所有权

本版使用单行版本化 JSON 快照，继续提供同步草稿事务。每次提交执行 SQLite 事务，成功返回表示数据库 COMMIT 已成功，而非只更新内存。使用 rollback journal、synchronous=FULL 和 connection 级 EXCLUSIVE 锁；另一个进程或连接不能同时成为此数据库的 Agent 所有者，进程退出后锁由操作系统释放。

打开时验证数据库 schema version、快照版本、集合结构及部分关联/事件序号。未知版本、损坏数据或非空的其他数据库会拒绝打开，不回退为空数据库。尚未提供跨 schema 版本迁移。请使用本地磁盘，并在关闭应用后复制/备份数据库。

快照默认上限 64 MiB，可通过 maxSnapshotBytes 配置。SQLite 调用和整个快照的编码是同步操作，适合有界的本地单实例应用；大规模历史、多个写入者、远程数据库和高吞吐部署需要后续的增量存储 SPI。本轮不宣称分布式恢复或 exactly-once 外部副作用。

Memory 和 SQLite 实现运行同一组状态事务行为测试，SQLite 另验证文件重开、所有权、损坏保护和容量回滚。数据库类型、语句和私有状态不进入领域数据或其他组件。

实现依据：[Node SQLite API](https://nodejs.org/api/sqlite.html)、[SQLite locking_mode](https://sqlite.org/pragma.html#pragma_locking_mode)、[SQLite synchronous](https://sqlite.org/pragma.html#pragma_synchronous)。Node 的内置 SQLite 从 22.13 起无需实验开关；较早的内存版本仍可在原 Node 下使用。

## HTTP 入口

POST 使用 `Content-Type: application/json`，请求体最多 64 KiB。默认不开放浏览器 Origin 访问。

| 方法与路径 | 行为 |
| --- | --- |
| GET /health | 应用生命周期与 ready；不就绪返回 503 |
| GET /agent | Agent 身份、能力、限制和本次恢复报告 |
| POST /sessions | 创建会话，body 为 `{}` |
| GET /sessions?offset=0&limit=100 | 保存的会话列表 |
| GET /sessions/:id/messages | 会话版本与消息 |
| POST /tasks | 接受任务，返回 202 与 RunAccepted |
| GET /tasks?sessionId=...&offset=0&limit=100 | 保存的任务列表 |
| GET /tasks/:id | Run 与步骤/调用快照 |
| GET /tasks/:id/events?afterSeq=0&limit=100 | 原子提交事件的分页查询 |
| POST /tasks/:id/cancel | 请求取消，body 可提供 reason |

列表 offset/limit 针对每次读取的当前快照，不保证跨并发写入的整组分页快照。事件游标仍按 Run.seq。错误通过项目 KernelError 返回，原始异常只留在宿主诊断中。

## 验证与后续范围

本轮测试覆盖：跨应用重启身份/历史/事件/去重；双所有者拒绝；定义不匹配保护；异步启动与关闭竞争；提供方重启；实际子进程 SIGKILL；副作用已发生但结果未提交；恢复事务失败回滚；HTTP 跨宿主进程恢复且无需 stdin。

尚未实现真实模型、定时触发器、自动重试/续跑、审批、长期记忆检索、在线 Agent 定义更新、多 Agent 应用或集群。它们可在当前应用生命周期和持久化任务入口上继续扩展，不能把目前的 Mock 常驻服务宣称为完整自主 Agent 产品。
