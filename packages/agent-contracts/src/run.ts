import type { AgentId, SessionId, RunId, MessageId, Timestamp, Revision } from './identity.js'
import type { AgentDefinition } from './agent.js'
import type { KernelError } from './errors.js'
import type { TextPart } from './message.js'
import type { ToolDefinition } from './tool.js'

export interface RunLimits {
  readonly maxConcurrent: number
  readonly maxQueued: number
  readonly runTimeoutMs: number
  readonly maxInputBytes: number
  readonly maxOutputBytes: number
  readonly maxContextBytes: number
  readonly maxSessions: number
  readonly maxRuns: number
  readonly maxSteps: number
  readonly maxToolCalls: number
  readonly maxToolResultBytes: number
}
export interface RunBasis {
  readonly agentGeneration: string
  readonly definition: AgentDefinition
  readonly limits: RunLimits
  readonly tools: readonly ToolDefinition[]
}
export interface RunBase {
  readonly id: RunId
  readonly agentId: AgentId
  readonly sessionId: SessionId
  readonly basis: RunBasis
  readonly inputMessageId: MessageId
  readonly resultMessageIds: readonly MessageId[]
  readonly createdAt: Timestamp
  readonly deadlineAt: Timestamp
  readonly lastEventSeq: number
}
export type RunTerminalState =
  | { readonly status: 'completed'; readonly endedAt: Timestamp }
  | { readonly status: 'failed'; readonly endedAt: Timestamp; readonly error: KernelError }
  | { readonly status: 'interrupted'; readonly endedAt: Timestamp; readonly error: KernelError }
  | { readonly status: 'cancelled'; readonly endedAt: Timestamp; readonly reason?: string }
export type RunState = { readonly status: 'queued' | 'running' }
  | { readonly status: 'cancelling'; readonly reason?: string }
  | RunTerminalState
export type RunSnapshot = RunBase & RunState
export type RunResult = RunBase & RunTerminalState
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
  | { readonly runId: RunId; readonly outcome: 'already-terminal'; readonly status: RunTerminalState['status'] }
