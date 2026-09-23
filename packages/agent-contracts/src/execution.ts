import type { KernelError } from './errors.js'
import type { AssistantPart, ToolCallPart } from './message.js'
import type { RunSnapshot } from './run.js'
import type { ToolOutcome } from './tool.js'

export interface Step {
  readonly id: string
  readonly runId: string
  readonly index: number
  readonly attemptId: string
  readonly status: 'model' | 'tools' | 'completed' | 'failed' | 'cancelled'
  readonly toolCallIds: readonly string[]
}
export interface ModelAttempt {
  readonly id: string
  readonly runId: string
  readonly stepId: string
  readonly status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  readonly content?: readonly AssistantPart[]
  readonly error?: KernelError
}
export interface ToolCall {
  readonly id: string
  readonly runId: string
  readonly stepId: string
  readonly request: ToolCallPart
  readonly toolRevision?: number
  readonly status: 'pending' | 'running' | ToolOutcome['status']
  readonly outcome?: ToolOutcome
}
export type RunEventType = 'run.accepted' | 'run.running' | 'run.cancelling' | 'run.finished'
  | 'model.started' | 'model.finished' | 'tool.started' | 'tool.finished' | 'step.finished'
/** References point to records in an inspection; events never contain raw provider data. */
export interface RunEvent {
  readonly runId: string
  readonly seq: number
  readonly type: RunEventType
  readonly createdAt: string
  readonly stepId?: string
  readonly attemptId?: string
  readonly toolCallId?: string
  readonly status: string
}
export interface RunInspection {
  readonly run: RunSnapshot
  readonly steps: readonly Step[]
  readonly attempts: readonly ModelAttempt[]
  readonly toolCalls: readonly ToolCall[]
}
export interface RunEventPage {
  readonly events: readonly RunEvent[]
  readonly lastEventSeq: number
  readonly hasMore: boolean
}
