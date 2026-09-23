# Agent Harness 最小公共契约草案

状态：保留逐项审计草案，第一版 Run 子集已实施，其余尚未冻结。日期：2026-09-22。

实施更新：第一版 Run 计划已确认并落地了本文的一个子集，见[实现说明](run-coordinator-v1.md)。本文保留原始草案用于逐项审计，不作为当前导出 API：本轮只有文本消息，没有 waiting、工具内容和事件游标；Run.basis 保存完整定义与限制。未使用的字段和 SPI 仍待审计，不能将下面所有条目视为已经批准。

本文用于审计项目自有的基础格式和行为边界。所有 TypeScript 声明都是候选设计，不是当前可导入的 API；通过审计并实施后进入 `packages/agent-contracts/` 的领域数据、API 或 SPI。当前已实施子集及兼容入口见[契约包说明](../packages/agent-contracts/README.md)。

[内核计划](agent-kernel-plan.md)仍是完整 v1 的范围和验收依据。本文只提出其中一小部分契约，不代表 G0 完成，也不缩减 v1 的工具、交互、模型适配及可替换性要求。既有行为约束和本轮新增的字段建议分别说明；有争议的地方先记录，不自动改写计划。

## 审计方式

每项使用固定编号，可以直接反馈“C03 修改”“C05 通过”或“C07 暂缓”。下面所有状态初始均为待审计，不因文档或类型检查通过而视为设计通过。

| 编号 | 契约 | 审计重点 | 状态 |
| --- | --- | --- | --- |
| C01 | 基础值与身份 | ID、时间、版本和 JSON 数据 | 待审计 |
| C02 | 公共错误 | 错误格式和业务失败的表达 | 待审计 |
| C03 | 消息与工具内容 | 角色、内容顺序和工具关联 | 待审计 |
| C04 | Agent 与模型选择 | 定义、活动实例和模型引用的区别 | 待审计 |
| C05 | Session | 会话归属、版本和数据寿命 | 待审计 |
| C06 | Run | 接受快照、状态和结果 | 待审计 |
| C07 | Run 操作 | 启动、查询、取消和等待 | 待审计 |
| C08 | 生命周期与装配 | 所有权、清理和实现替换 | 待审计 |

## C01：基础值与身份

归属：公共 `contracts/`。

```ts
export type JsonValue =
  | null | boolean | number | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

export type AgentDefinitionId = string
export type AgentId = string
export type SessionId = string
export type RunId = string
export type MessageId = string
export type ModelAttemptId = string
export type ToolCallId = string
export type ToolId = string
export type InteractionId = string

export type Timestamp = string
export type Revision = number
```

候选约定：

- ID 是不透明字符串；调用方不解析其中的业务信息。不同对象的 ID 分开命名。具体生成算法不属于公共契约。
- 上述别名不提供 TypeScript 层面的防混用保证；运行时仍要验证对象类型及归属关系。
- `Timestamp` 使用带 `Z` 的 UTC ISO 8601 字符串；版本和序号使用正的安全整数，尚无事件的游标允许为 0。
- `JsonValue` 中的数值必须有限。禁止 `undefined`、函数、循环引用、SDK 对象及运行资源；TypeScript 声明本身不能完成这些校验。
- 公共快照按只读值使用；`readonly` 不等于运行时冻结，实现不得泄漏可被外部修改的内部状态。

待审计：是否现在就使用 branded ID 防止编译期混用；时间格式是否接受统一 UTC 字符串。

## C02：公共错误

归属：公共 `contracts/`。

```ts
export type KernelErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'SESSION_BUSY'
  | 'CLOSED'
  | 'CAPABILITY_UNAVAILABLE'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'LIMIT_EXCEEDED'
  | 'CANCELLED'
  | 'TOOL_DENIED'
  | 'TOOL_FAILED'
  | 'MODEL_FAILED'
  | 'STATE_FAILED'
  | 'CLEANUP_FAILED'
  | 'SETTLEMENT_FAILED'
  | 'INTERNAL'

export interface KernelError {
  readonly code: KernelErrorCode
  readonly message: string
  readonly details?: Readonly<Record<string, JsonValue>>
}
```

候选约定：

- `KernelError` 是可保存、可返回的数据，区别于 JavaScript `Error` 实例。
- 调用方根据 `code` 判断错误，不解析 `message`。`details` 只用于有界、脱敏的诊断；需要依赖的字段以后进入对应错误的明确类型。
- 嵌入 API 的 Promise 拒绝值建议使用项目自有 `Error`，其 `error` 属性为 `KernelError`；具体类留待实现。供应商异常不直接成为公共错误。
- 这只是本轮错误码子集；协议细分、交互过期、事件游标等错误随相应契约补充，不默认用 `INTERNAL` 覆盖。
- 第一版不提供通用 `retryable` 标志。错误是否短暂与操作是否能安全重试是两个问题。

待审计：错误对象字段、Promise 拒绝形式，以及是否需要按领域拆分错误码。

## C03：消息与工具内容

归属：公共 `contracts/`；工具处理函数不放在这些数据对象中。

```ts
export interface TextPart {
  readonly type: 'text'
  readonly text: string
}

export interface ToolCallPart {
  readonly type: 'tool-call'
  readonly toolCallId: ToolCallId
  readonly toolId: ToolId
  readonly input: JsonValue
}

export type ToolOutcome =
  | { readonly status: 'succeeded'; readonly output: JsonValue }
  | { readonly status: 'failed'; readonly error: KernelError }

export interface ToolResultPart {
  readonly type: 'tool-result'
  readonly toolCallId: ToolCallId
  readonly outcome: ToolOutcome
}

export type ContentPart = TextPart | ToolCallPart | ToolResultPart

export interface MessageBase {
  readonly id: MessageId
  readonly sessionId: SessionId
  readonly runId: RunId
  readonly createdAt: Timestamp
}

export type Message = MessageBase & (
  | { readonly role: 'user'; readonly content: readonly TextPart[] }
  | {
      readonly role: 'assistant'
      readonly modelAttemptId: ModelAttemptId
      readonly content: readonly (TextPart | ToolCallPart)[]
    }
  | { readonly role: 'tool'; readonly content: readonly ToolResultPart[] }
)
```

候选约定：

- `content` 按顺序保存内容，数组非空。不把工具调用和结果拼成普通文本。
- 用户输入在 Run 被接受时写成用户消息。当前候选只覆盖由 Run 产生的会话历史；导入历史、手工预置消息的来源规则以后单独审计。
- Agent 指令暂不作为可由用户提交的 `system` 消息保存。模型请求将单独接收受信指令，消息角色本身不授予权限。
- `toolId` 指注册工具的稳定标识；供应商使用的函数名由适配器映射。`toolCallId` 在一个 Run 内唯一，工具结果必须关联同一 Run 中的确切调用。
- `ToolCallPart` 表示完整的参数值。参数是否符合工具 Schema、是否有权执行，仍由工具执行管线判断。
- 工具失败、拒绝和取消可以用结构化错误表达；是否继续 Run 由执行协调规则决定，不能把一次工具失败直接等同于 Run 失败。

既有约束：流中的完整工具帧不构成执行授权；必须等模型调用成功完成，并通过参数和权限校验后才能执行工具。

本轮缺口：图片和资源引用、模型续接数据、流增量、工具副作用不确定状态及完整调用记录尚未定义。`ToolOutcome` 只表示结果，不证明失败时没有外部副作用。真实模型和工具接入前必须补齐相应契约，不能静默丢弃这些信息。

待审计：工具调用是否直接作为消息内容块；工具结果是否保留独立角色；消息是否都必须归属某次 Run。

## C04：Agent 与模型选择

归属：公共 `contracts/`。凭据与客户端属于接入实现。

```ts
export interface ModelRef {
  readonly protocolId: string
  readonly providerId: string
  readonly modelId: string
  readonly configRevision: Revision
}

export interface AgentDefinition {
  readonly id: AgentDefinitionId
  readonly revision: Revision
  readonly instructions: string
  readonly model: ModelRef
  readonly toolIds: readonly ToolId[]
}

export interface AgentInstance {
  readonly id: AgentId
  readonly definitionId: AgentDefinitionId
  readonly definitionRevision: Revision
  readonly generation: string
  readonly createdAt: Timestamp
}
```

候选约定：

- `AgentDefinition` 是不可变的定义版本，更新产生新 revision。
- `AgentInstance` 是活动实例的描述，不包含 Nya Context、方法或资源句柄。`generation` 区分生命周期中的具体实例，避免旧请求或清理操作误作用于新实例。
- 此轮建议一个活动实例固定一个定义 revision；如何显式切换实例定义留给 Agent 操作契约。新定义不会改变已接受的 Run。
- 协议、连接提供方和具体模型分别标识；引用具体配置版本，不在执行中隐式切换模型或提供方。
- `toolIds` 是候选可见工具集，不是权限授权。是否可执行仍受受信策略限制。

本轮缺口：有效限制、上下文策略、模型参数及工具注册版本的固定方式尚未定义。这里的定义不能直接用于完整 v1 执行，也不表示只需这些配置。

待审计：定义与活动实例是否分开；是否接受固定 revision 的实例；指令是否先用一个字符串。

## C05：Session

归属：公共 `contracts/`；SessionService 管理会话规则，StateService 保存记录。

```ts
export interface Session {
  readonly id: SessionId
  readonly agentId: AgentId
  readonly version: Revision
  readonly createdAt: Timestamp
}
```

候选约定：

- 一个 Session 归属一个逻辑 Agent ID。Session 不保存活动 generation，数据寿命不依赖某个实例始终在线。
- 新会话 version 从 1 开始；每次改变会话或其历史的一次成功事务递增一次。具体事务影响集在存储契约中细化。
- 消息单独查询，不把无限增长的历史内嵌到 Session 对象中。

既有约束：同一 Session 最多一个非终态 Run，包括排队、运行、等待和取消中的 Run。关闭 Agent 不等于删除会话；内存后端不承诺应用重启后保留会话。

本轮缺口：已关闭 Agent 的同 ID 重建和会话继续执行规则尚未定义；不能仅凭相同 ID 自动接管旧会话。

待审计：会话是否固定归属一个 Agent；是否需要标题等产品字段进入内核，建议暂不加入。

## C06：Run

归属：公共 `contracts/`；只有 RunCoordinator 决定状态变化。

```ts
export interface RunBasis {
  readonly agentGeneration: string
  readonly definitionId: AgentDefinitionId
  readonly definitionRevision: Revision
  readonly model: ModelRef
}

export interface RunBase {
  readonly id: RunId
  readonly agentId: AgentId
  readonly sessionId: SessionId
  readonly basis: RunBasis
  readonly inputMessageId: MessageId
  readonly resultMessageIds: readonly MessageId[]
  readonly createdAt: Timestamp
  readonly lastEventSeq: number
}

export type RunTerminalState =
  | { readonly status: 'completed'; readonly endedAt: Timestamp }
  | {
      readonly status: 'failed'
      readonly endedAt: Timestamp
      readonly error: KernelError
    }
  | {
      readonly status: 'cancelled'
      readonly endedAt: Timestamp
      readonly reason?: string
    }

export type RunState =
  | { readonly status: 'queued' }
  | { readonly status: 'running' }
  | {
      readonly status: 'waiting'
      readonly waitingReason: 'approval' | 'input'
      readonly interactionId: InteractionId
    }
  | { readonly status: 'cancelling'; readonly reason?: string }
  | RunTerminalState

export type RunSnapshot = RunBase & RunState
export type RunResult = RunBase & RunTerminalState
```

候选约定：

- `basis` 记录接受时选定的执行身份和模型版本；它只是完整执行快照的基础部分，限制、策略和注册版本必须在后续契约中补齐。
- 所引用的定义 revision 在相关 Run 所需期间必须可解析；不能覆盖旧定义后声称保留了快照。
- `resultMessageIds` 按消息提交顺序列出该 Run 已提交的 assistant/tool 消息，不包含输入消息。失败或取消可以保留已有部分输出。
- `RunResult` 是 Run 的终态快照，没有另一套独立的结果状态。
- 当前 `waiting` 形态只表达一个待处理交互；多个同时等待的表示方式需要另行审计。

既有约束：

- 状态沿用内核计划：`queued`、`running`、`waiting`、`cancelling`、`completed`、`failed`、`cancelled`。
- 取消意图与工作停止分开；进入终态前必须停止真实工作并完成必要收尾。终态不接受迟到输出覆盖。
- 终态提交失败时不伪造终态，查询仍只能返回实际已提交状态，等待操作明确报告结算失败。
- `lastEventSeq` 是与该快照一致的 Run 事件游标，不等于 Session.version。事件载荷、保留和订阅接口另行定义。

待审计：是否接受状态判别联合；部分输出是否用消息引用表达；是否需要在第一轮就补充多个同时等待的交互。

## C07：Run 操作

归属：请求与回执数据放 `contracts/`；含 Promise、AbortSignal 的嵌入接口放单独的 API 入口。以下只定义 Run 操作，不是假定完整 Kernel API 已确定。

```ts
export interface StartRunRequest {
  readonly agentId: AgentId
  readonly agentGeneration: string
  readonly sessionId: SessionId
  readonly expectedSessionVersion: Revision
  readonly requestKey: string
  readonly input: readonly TextPart[]
}

export interface RunAccepted {
  readonly runId: RunId
  readonly inputMessageId: MessageId
  readonly sessionVersion: Revision
}

export type CancelRunReceipt =
  | { readonly runId: RunId; readonly outcome: 'requested' }
  | {
      readonly runId: RunId
      readonly outcome: 'already-terminal'
      readonly status: RunTerminalState['status']
    }

export interface RunsApi {
  start(request: StartRunRequest): Promise<RunAccepted>
  get(request: { readonly runId: RunId }): Promise<RunSnapshot>
  cancel(request: {
    readonly runId: RunId
    readonly reason?: string
  }): Promise<CancelRunReceipt>
  wait(request: {
    readonly runId: RunId
    readonly signal?: AbortSignal
  }): Promise<RunResult>
}
```

候选约定：

- `start` 显式检查活动 generation、Session 归属及版本。调用方不能用旧实例句柄无意启动新实例上的任务。
- 请求键作用域建议为 `(agentId, agentGeneration, sessionId, requestKey)`；同键同语义返回原接受回执，同键不同语义返回 `CONFLICT`。
- 同语义包括原请求的 generation、会话版本与有序输入内容；JSON 对象键顺序不造成语义差异。版本校验前识别已接受的相同请求，否则成功重试会被自己推进的版本拒绝。
- `cancel` 的 `requested` 表示停止意图已生效或此前已接受，不表示工作已经结束；重复取消复用第一次原因。自然结束已经胜出时返回实际终态。
- `wait` 在业务失败或业务取消时 resolve 相应 `RunResult`。找不到记录、取消等待、读取或结算故障时 reject 项目错误；因此调用方仍需检查返回的 `status`。

既有约束：

- `start` 只有在输入、Run、接受事件和请求键原子提交且控制句柄已登记后才返回成功；成功仅表示接受，不等待执行完成。提交之后发生登记或调度故障仍须结算该 Run。
- Memory 模式的接受成功只表示内存提交，不表示磁盘持久化。
- 第一版不自动淘汰接受请求键；记录达到配额时拒绝新增请求。
- 取消 `wait` 仅停止观察；只有显式 `cancel` 才请求取消 Run。

本轮缺口：接受响应丢失或登记失败后的查询与重试细节、完整错误映射及原子接受测试，需要在实现前继续审计；这里不承诺跨应用重启去重。

待审计：是否接受必填请求键和会话版本；是否接受 `wait` 返回失败终态而非因业务失败 reject；是否希望通过 Agent 句柄隐含 generation。

## C08：生命周期与 Nya 装配

归属：跨实现的行为契约；Nya 专用类型留在集成入口，不放进上述领域数据。

| 对象或操作 | 必须遵守的行为 | 来源 |
| --- | --- | --- |
| 组件启动 | `apply` 完成初始化后返回，不等待永久循环或用户 Run 完成 | 既有约束 |
| 依赖使用 | `inject` 声明服务，组件使用本轮 `deps`；根控制面每次外部请求通过 `context.get()` 取当前服务 | 既有约束 |
| 资源归属 | 连接、注册、订阅、任务都有明确所有者，清理通过 Effect 登记；单次调用有自己的取消和等待路径 | 既有约束 |
| 取消 | 请求停止与等待停止分开，不能把发出 AbortSignal 等同于实际停止 | 既有约束 |
| `close` | 先停止接收，再取消并等待受管工作；重复调用等待同一次关闭结果，独立清理失败聚合报告 | 既有约束 |
| 清理故障 | 不跳过其他独立清理，不声称失败的释放已成功；状态提交失败也不能阻止实际资源清理 | 既有约束 |
| 注册撤销 | 绑定确切 owner/generation，旧撤销不得删除同 ID 的新注册 | 既有约束 |
| 实现替换 | 组合根选择实现，共用项目契约及行为测试；默认先停止旧工作再切换，不承诺无损热切换 | 既有约束 |
| 领域与框架状态 | `Fiber.state` 不替代 Run 状态；组件卸载不等于删除会话历史 | 既有约束 |

这里不提前添加通用的 `Component.close()` 接口来重复 Nya 的组件生命周期。Kernel/Agent 的关闭接口、模型调用句柄和注册撤销接口将在各自契约中声明。

待审计：以上所有权与关闭语义是否可作为每个实现共同遵守的底线；存在第三方实现差异时应单独列出，不隐藏在适配器内。

## 后续审计清单

本轮优先审计 C01—C06 的数据边界，再审计 C07/C08 的行为。下面各项仍是完整 v1 的必要设计工作，本轮不填占位接口：

1. 工具定义、Schema 校验范围、调用记录、权限及副作用不确定状态。
2. 审批与提问的版本、回复、期限、失效和竞争规则。
3. 模型请求、能力、流事件、结果、用量、续接数据及调用清理句柄。
4. 所有组件的 SPI，包括 ModelResolver、StateStore、ExecutionStrategy、ContextProvider 及内部服务契约。
5. 原子事务、一致性快照、事件序号、订阅缓冲和补读。
6. 有效执行配置、预算限制、工具注册版本及接受时的完整快照。
7. Agent/Session 的创建、查询、关闭及内核能力描述。
8. 公共输入的运行时校验、合约测试及从第三方实现迁移的要求。

新增公共字段先明确使用方、修改者、保存位置和生命周期。没有实际消费者的字段暂不加入，也不提供无边界的 `metadata: any` 作为替代。
