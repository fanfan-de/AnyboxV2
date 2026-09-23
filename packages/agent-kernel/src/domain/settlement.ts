import type { KernelError, RunResult, RunTerminalState, ToolOutcome } from '@anybox/agent-contracts'
import type { ModelOutput, StateData, StateSnapshot } from '@anybox/agent-contracts/spi'
import { fault } from '../shared/errors.js'
import { cloneState } from './state.js'
import { terminal } from '../shared/utils.js'
import { appendEvent, appendToolResult } from './records.js'

export type RunStop = { readonly kind: 'cancel'; readonly reason?: string }
  | { readonly kind: 'failure'; readonly error: KernelError }

export interface RunSettlementInput {
  readonly runId: string
  readonly endedAt: string
  readonly stop?: RunStop
  readonly cleanupError?: KernelError
  readonly executionError?: KernelError
  readonly final?: {
    readonly output: ModelOutput
    readonly attemptId: string
    readonly messageId: string
  }
  readonly toolResultMessageIds: ReadonlyMap<string, string>
}

/** Cleanup failure wins; an accepted cancellation wins over execution failure and deadline. */
export function selectRunTerminalState(deadlineAt: string, input: RunSettlementInput): RunTerminalState {
  const { endedAt, stop, cleanupError, executionError } = input
  const failure = cleanupError ?? (stop?.kind === 'failure' ? stop.error : undefined)
    ?? (!stop && Date.parse(endedAt) >= Date.parse(deadlineAt)
      ? { code: 'LIMIT_EXCEEDED' as const, message: 'run deadline exceeded' } : undefined)
  if (failure) return { status: 'failed', endedAt, error: failure }
  if (stop?.kind === 'cancel') return { status: 'cancelled', endedAt, reason: stop.reason }
  if (executionError) return { status: 'failed', endedAt, error: executionError }
  return { status: 'completed', endedAt }
}

interface ExecutionSettlement {
  readonly endedAt: string
  readonly status: 'cancelled' | 'failed'
  readonly uncertainError: KernelError
  readonly attemptError?: KernelError
  readonly toolResultMessageIds: ReadonlyMap<string, string>
}

/** Mutates only the owned draft supplied by a plan; no clock or external effects. */
export function settleExecutionDraft(state: StateData, runId: string, input: ExecutionSettlement) {
  for (const call of state.toolCalls.values()) {
    if (call.runId !== runId || (call.status !== 'pending' && call.status !== 'running')) continue
    const outcome: ToolOutcome = call.status === 'pending' ? { status: 'cancelled' }
      : { status: 'uncertain', error: input.uncertainError }
    const messageId = input.toolResultMessageIds.get(call.id)
    if (!messageId || state.messages.has(messageId)) throw fault('INTERNAL', 'settlement requires a unique tool result message ID')
    const saved = { ...call, status: outcome.status, outcome }
    state.toolCalls.set(call.id, saved)
    appendToolResult(state, saved, messageId, input.endedAt)
    appendEvent(state, runId, 'tool.finished', saved.status, input.endedAt, { stepId: call.stepId, toolCallId: call.id })
  }
  for (const step of state.steps.values()) {
    if (step.runId !== runId || (step.status !== 'model' && step.status !== 'tools')) continue
    const attempt = state.attempts.get(step.attemptId)!
    if (attempt.status === 'running') {
      state.attempts.set(attempt.id, { ...attempt, status: input.status,
        ...(input.attemptError ? { error: input.attemptError } : {}) })
      appendEvent(state, runId, 'model.finished', input.status, input.endedAt, { stepId: step.id, attemptId: attempt.id })
    }
    state.steps.set(step.id, { ...step, status: input.status })
    appendEvent(state, runId, 'step.finished', input.status, input.endedAt, { stepId: step.id })
  }
}

/** Caller supplies an owned draft and a terminal result with the latest execution event sequence. */
export function finishRunDraft(state: StateData, result: RunResult): RunResult {
  state.runs.set(result.id, result)
  appendEvent(state, result.id, 'run.finished', result.status, result.endedAt)
  const session = state.sessions.get(result.sessionId)!
  state.sessions.set(session.id, { ...session, version: session.version + 1 })
  return state.runs.get(result.id)! as RunResult
}

/** Pure, isolated and idempotent transition. No clock, random IDs, resources or storage access. */
export function planRunSettlement(snapshot: StateSnapshot, settlement: RunSettlementInput): {
  readonly state: StateData; readonly result: RunResult
} {
  const state = cloneState(snapshot)
  const run = state.runs.get(settlement.runId)
  if (!run) throw fault('NOT_FOUND', 'run not found')
  if (terminal(run)) return { state, result: run }
  const input = structuredClone(settlement)
  const terminalState = selectRunTerminalState(run.deadlineAt, input)
  let resultMessageIds = run.resultMessageIds
  if (terminalState.status === 'completed') {
    const final = input.final
    if (!final?.output || !final.attemptId) throw fault('INTERNAL', 'completed run requires a model result')
    if (!final.messageId || state.messages.has(final.messageId)) throw fault('INTERNAL', 'settlement requires a unique final message ID')
    state.messages.set(final.messageId, { id: final.messageId, sessionId: run.sessionId, runId: run.id,
      role: 'assistant', modelAttemptId: final.attemptId, content: final.output.content, createdAt: input.endedAt })
    resultMessageIds = [final.messageId]
  }
  settleExecutionDraft(state, run.id, {
    endedAt: input.endedAt, status: terminalState.status === 'cancelled' ? 'cancelled' : 'failed',
    uncertainError: { code: 'SETTLEMENT_FAILED', message: 'tool result was not committed' },
    toolResultMessageIds: input.toolResultMessageIds,
  })
  const result = finishRunDraft(state, { ...state.runs.get(run.id)!, ...terminalState, resultMessageIds })
  return { state, result }
}
