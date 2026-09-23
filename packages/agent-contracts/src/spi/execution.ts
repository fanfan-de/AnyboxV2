import type { RunBasis, RunSnapshot, Message, TextPart, ToolDefinition, ToolCall } from '../index.js'
import type { StateSnapshot } from './state.js'
import type { ModelOutput } from './model.js'

export interface ModelStepResult {
  readonly stepId: string
  readonly outcome: 'final' | 'tools'
  readonly output: ModelOutput
}
export interface ExecutionOutcome { readonly finalStepId: string }
export interface ExecutionContext {
  readonly signal: AbortSignal
  readonly basis: RunBasis
  modelStep(): Promise<ModelStepResult>
  executeTools(request: { readonly stepId: string }): Promise<readonly ToolCall[]>
}
/** The returned promise must cover all strategy-owned work and cleanup. */
export interface RunExecutionStrategy {
  execute(context: ExecutionContext): Promise<ExecutionOutcome>
}
export interface ContextInput {
  readonly state: StateSnapshot
  readonly run: RunSnapshot
  readonly history: readonly Message[]
}
export interface ModelContext {
  readonly instructions: string
  readonly history: readonly Message[]
  readonly input: readonly TextPart[]
  readonly continuation: readonly Message[]
  readonly tools: readonly ToolDefinition[]
}
/** Synchronous pure builder; Runtime independently checks size limits. */
export interface ContextBuilder { build(input: ContextInput): ModelContext }
export interface ToolPolicy {
  /** Synchronous trusted policy; cannot expand the tools pinned in RunBasis. */
  decide(request: { readonly basis: RunBasis; readonly call: ToolCall }): 'allow' | 'deny' | 'ask'
}
