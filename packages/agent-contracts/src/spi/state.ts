import type { AgentDefinition, AgentInstance, Message, RunAccepted, RunSnapshot, Session } from '../index.js'
import type { Step, ModelAttempt, ToolCall, RunEvent } from '../index.js'

export interface RequestRecord { readonly fingerprint: string; readonly receipt: RunAccepted }
/** Read-only view. Providers still isolate snapshots at runtime; readonly is a type-level contract. */
export interface StateSnapshot {
  readonly agent?: AgentInstance
  readonly definition?: AgentDefinition
  readonly sessions: ReadonlyMap<string, Session>
  readonly messages: ReadonlyMap<string, Message>
  readonly runs: ReadonlyMap<string, RunSnapshot>
  readonly requests: ReadonlyMap<string, RequestRecord>
  readonly steps: ReadonlyMap<string, Step>
  readonly attempts: ReadonlyMap<string, ModelAttempt>
  readonly toolCalls: ReadonlyMap<string, ToolCall>
  readonly events: ReadonlyMap<string, readonly RunEvent[]>
}
/** 只在同步事务回调中修改副本。不得在事务内启动任务或执行 I/O。 */
export interface StateData extends StateSnapshot {
  agent?: AgentInstance
  definition?: AgentDefinition
  sessions: Map<string, Session>
  messages: Map<string, Message>
  runs: Map<string, RunSnapshot>
  requests: Map<string, RequestRecord>
  steps: Map<string, Step>
  attempts: Map<string, ModelAttempt>
  toolCalls: Map<string, ToolCall>
  events: Map<string, RunEvent[]>
}
/** Explicit name for the mutable transaction view; StateData remains a compatibility name. */
export type StateDraft = StateData
/** Snapshot transactions. A persistent provider must hold exclusive ownership until close. */
export interface StateService {
  readonly durability: 'memory' | 'persistent'
  readSnapshot(): Promise<StateSnapshot>
  /** Isolated values, synchronous pure callback, atomic commit. Persistent success means committed to storage. */
  transaction<T>(label: string, change: (draft: StateDraft) => T): Promise<T>
}
