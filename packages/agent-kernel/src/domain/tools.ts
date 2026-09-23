import type { KernelError, RunBasis, ToolCall, ToolOutcome } from '@anybox/agent-contracts'
import type { StateSnapshot } from '@anybox/agent-contracts/spi'
import { json, matches } from './content.js'
import { executionRun, executionStep } from './execution.js'
import { appendEvent, appendToolResult } from './records.js'
import { cloneState, type StateTransition } from './state.js'
import { fault } from '../shared/errors.js'

export function toolBatch(snapshot: StateSnapshot, runId: string, stepId: string): readonly ToolCall[] {
  executionRun(snapshot, runId)
  const calls = stepCalls(snapshot, runId, stepId)
  if (calls.some(call => call.status !== 'pending')) {
    throw fault('CONFLICT', 'tool batch was already dispatched')
  }
  return structuredClone(calls)
}

export function validateToolCall(basis: RunBasis, call: ToolCall): void {
  const definition = basis.tools.find(tool => tool.id === call.request.toolId && tool.revision === call.toolRevision)
  if (!definition) throw fault('TOOL_DENIED', 'model requested an unavailable tool')
  if (!matches(definition.inputSchema, call.request.input)) throw fault('INVALID_ARGUMENT', 'tool arguments do not match schema')
}

export function validateToolDecision(decision: unknown): void {
  if (decision === 'ask') throw fault('INTERACTION_UNAVAILABLE', 'tool requires approval but interactions are unavailable')
  if (decision !== 'allow') throw fault('TOOL_DENIED', 'tool policy denied execution')
}

export function normalizeToolOutcome(raw: ToolOutcome, maxBytes: number): ToolOutcome {
  if (raw?.status === 'succeeded') {
    json(raw.output)
    if (Buffer.byteLength(JSON.stringify(raw.output)) > maxBytes) throw fault('LIMIT_EXCEEDED', 'tool output exceeds limit')
    return { status: 'succeeded', output: structuredClone(raw.output) }
  }
  if (raw?.status === 'cancelled') return { status: 'cancelled' }
  if (raw?.status === 'failed' || raw?.status === 'uncertain') {
    return { status: raw.status, error: { code: 'TOOL_FAILED', message: 'tool execution did not succeed' } }
  }
  throw fault('TOOL_FAILED', 'invalid tool outcome')
}

export function unconfirmedToolOutcome(dispatched: boolean, error: KernelError): ToolOutcome {
  return dispatched ? { status: 'uncertain', error: { code: error.code, message: 'tool result could not be confirmed' } }
    : { status: 'cancelled' }
}

function stepCalls(snapshot: StateSnapshot, runId: string, stepId: string): readonly ToolCall[] {
  const step = executionStep(snapshot, runId, stepId)
  if (step.status !== 'tools' || !step.toolCallIds.length) throw fault('CONFLICT', 'step is not executing tools')
  return step.toolCallIds.map(id => {
    const call = snapshot.toolCalls.get(id)
    if (!call || call.runId !== runId || call.stepId !== stepId) throw fault('CONFLICT', 'tool does not belong to this step')
    return call
  })
}

export function planToolStarted(snapshot: StateSnapshot, input: {
  readonly runId: string; readonly stepId: string; readonly callId: string; readonly at: string
}): StateTransition<ToolCall> {
  executionRun(snapshot, input.runId)
  const calls = stepCalls(snapshot, input.runId, input.stepId)
  const index = calls.findIndex(call => call.id === input.callId)
  const call = calls[index]
  if (!call || call.status !== 'pending' || calls.slice(0, index).some(call => call.status !== 'succeeded' && call.status !== 'failed')) {
    throw fault('CONFLICT', 'tool must be dispatched once in step order')
  }
  const state = cloneState(snapshot)
  const saved: ToolCall = { ...state.toolCalls.get(call.id)!, status: 'running' }
  state.toolCalls.set(call.id, saved)
  appendEvent(state, input.runId, 'tool.started', 'running', input.at, { stepId: input.stepId, toolCallId: call.id })
  return { state, value: saved }
}

export function planToolFinished(snapshot: StateSnapshot, input: {
  readonly runId: string; readonly stepId: string; readonly callId: string
  readonly outcome: ToolOutcome; readonly messageId: string; readonly at: string
}): StateTransition<ToolCall> {
  // A confirmed effect must still be recorded while cancellation is in progress.
  executionRun(snapshot, input.runId, true)
  const call = stepCalls(snapshot, input.runId, input.stepId).find(call => call.id === input.callId)
  if (call?.status !== 'running') throw fault('CONFLICT', 'tool is not running')
  if (!input.messageId || snapshot.messages.has(input.messageId)) throw fault('CONFLICT', 'tool result message identity already exists')
  const state = cloneState(snapshot)
  const outcome = structuredClone(input.outcome)
  const saved: ToolCall = { ...state.toolCalls.get(call.id)!, status: outcome.status, outcome }
  state.toolCalls.set(call.id, saved)
  appendToolResult(state, saved, input.messageId, input.at)
  appendEvent(state, input.runId, 'tool.finished', saved.status, input.at, { stepId: input.stepId, toolCallId: call.id })
  return { state, value: saved }
}

export function planToolStepFinished(snapshot: StateSnapshot, input: {
  readonly runId: string; readonly stepId: string; readonly at: string
}): StateTransition<void> {
  executionRun(snapshot, input.runId, true)
  const calls = stepCalls(snapshot, input.runId, input.stepId)
  if (calls.some(call => call.status !== 'succeeded' && call.status !== 'failed')) throw fault('CONFLICT', 'step has unconfirmed tools')
  const state = cloneState(snapshot)
  state.steps.set(input.stepId, { ...state.steps.get(input.stepId)!, status: 'completed' })
  appendEvent(state, input.runId, 'step.finished', 'completed', input.at, { stepId: input.stepId })
  return { state, value: undefined }
}
