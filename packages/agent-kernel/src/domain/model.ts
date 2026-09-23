import type { AssistantPart, KernelError, ToolCall, ToolCallPart } from '@anybox/agent-contracts'
import type { ModelContext, ModelOutput, ModelStepResult, StateSnapshot } from '@anybox/agent-contracts/spi'
import { assistantParts, contentBytes } from './content.js'
import { executionRun, executionStep } from './execution.js'
import { appendEvent } from './records.js'
import { cloneState, type StateTransition } from './state.js'
import { fault, wrap } from '../shared/errors.js'
import { textBytes } from '../shared/utils.js'

/** Only committed model outputs consume the budget used to admit the next step. */
function outputBytes(state: StateSnapshot, runId: string): number {
  return [...state.attempts.values()].filter(attempt => attempt.runId === runId && attempt.status === 'succeeded')
    .reduce((sum, attempt) => sum + contentBytes(attempt.content ?? []), 0)
}

export function nextModelStep(state: StateSnapshot, runId: string): { readonly index: number; readonly maxOutputBytes: number } {
  const run = executionRun(state, runId)
  const steps = [...state.steps.values()].filter(step => step.runId === runId)
  if (steps.some(step => step.status !== 'completed' || !step.toolCallIds.length)) {
    throw fault('CONFLICT', 'previous step must be handled before another model call')
  }
  const index = steps.length + 1
  if (index > run.basis.limits.maxSteps) throw fault('LIMIT_EXCEEDED', 'step limit exceeded')
  const remaining = run.basis.limits.maxOutputBytes - outputBytes(state, runId)
  if (remaining <= 0) throw fault('LIMIT_EXCEEDED', 'model output budget exhausted')
  return { index, maxOutputBytes: remaining }
}

export function validateModelContext(context: ModelContext, maxBytes: number): void {
  const bytes = Buffer.byteLength(context.instructions) + textBytes(context.input)
    + [...context.history, ...context.continuation].reduce((sum, message) => sum + contentBytes(message.content), 0)
    + (context.tools.length ? Buffer.byteLength(JSON.stringify(context.tools)) : 0)
  if (bytes > maxBytes) throw fault('LIMIT_EXCEEDED', 'model context exceeds byte limit')
}

export function normalizeModelOutput(output: ModelOutput): ModelOutput {
  try { return { content: assistantParts(output?.content) } }
  catch (error) { throw wrap('MODEL_FAILED', 'model output is invalid', error) }
}

export function toolRequests(content: readonly AssistantPart[]): readonly ToolCallPart[] {
  return content.filter((part): part is ToolCallPart => part.type === 'tool-call')
}

export function planModelStarted(snapshot: StateSnapshot, input: {
  readonly runId: string; readonly stepId: string; readonly attemptId: string; readonly at: string
}): StateTransition<{ readonly maxOutputBytes: number }> {
  const { index, maxOutputBytes } = nextModelStep(snapshot, input.runId)
  if (!input.stepId || !input.attemptId || snapshot.steps.has(input.stepId) || snapshot.attempts.has(input.attemptId)) {
    throw fault('CONFLICT', 'model identities must be fresh and non-empty')
  }
  const state = cloneState(snapshot)
  state.steps.set(input.stepId, { id: input.stepId, runId: input.runId, index, attemptId: input.attemptId, status: 'model', toolCallIds: [] })
  state.attempts.set(input.attemptId, { id: input.attemptId, runId: input.runId, stepId: input.stepId, status: 'running' })
  appendEvent(state, input.runId, 'model.started', 'running', input.at, { stepId: input.stepId, attemptId: input.attemptId })
  return { state, value: { maxOutputBytes } }
}

export function planModelFinished(snapshot: StateSnapshot, input: {
  readonly runId: string; readonly stepId: string; readonly output: ModelOutput; readonly at: string
  readonly toolsAvailable: boolean; readonly toolCallIds: readonly string[]; readonly assistantMessageId: string
}): StateTransition<ModelStepResult> {
  const run = executionRun(snapshot, input.runId)
  const step = executionStep(snapshot, run.id, input.stepId)
  const attempt = snapshot.attempts.get(step.attemptId)
  if (step.status !== 'model' || attempt?.status !== 'running' || attempt.runId !== run.id || attempt.stepId !== step.id) {
    throw fault('CONFLICT', 'model step is not running')
  }
  const { content } = normalizeModelOutput(input.output)
  if (outputBytes(snapshot, run.id) + contentBytes(content) > run.basis.limits.maxOutputBytes) {
    throw fault('LIMIT_EXCEEDED', 'cumulative model output exceeds limit')
  }
  const requests = toolRequests(content)
  if (requests.length && !input.toolsAvailable) throw fault('CAPABILITY_UNAVAILABLE', 'tool calls are unavailable')
  const previousCalls = [...snapshot.toolCalls.values()].filter(call => call.runId === run.id)
  if (previousCalls.length + requests.length > run.basis.limits.maxToolCalls) throw fault('LIMIT_EXCEEDED', 'tool call limit exceeded')
  const protocolIds = new Set(previousCalls.map(call => call.request.toolCallId))
  for (const request of requests) {
    if (protocolIds.has(request.toolCallId)) throw fault('MODEL_FAILED', 'duplicate tool call ID')
    protocolIds.add(request.toolCallId)
  }
  if (input.toolCallIds.length !== requests.length || new Set(input.toolCallIds).size !== requests.length
    || input.toolCallIds.some(id => !id || snapshot.toolCalls.has(id))) throw fault('CONFLICT', 'tool identities must be fresh and unique')
  if (requests.length && (!input.assistantMessageId || snapshot.messages.has(input.assistantMessageId))) {
    throw fault('CONFLICT', 'assistant message identity already exists')
  }
  const state = cloneState(snapshot)
  const calls: ToolCall[] = requests.map((request, index) => ({ id: input.toolCallIds[index], runId: run.id, stepId: step.id,
    request, toolRevision: run.basis.tools.find(tool => tool.id === request.toolId)?.revision, status: 'pending' }))
  state.attempts.set(attempt.id, { ...state.attempts.get(attempt.id)!, status: 'succeeded', content })
  state.steps.set(step.id, { ...state.steps.get(step.id)!, status: calls.length ? 'tools' : 'completed', toolCallIds: calls.map(call => call.id) })
  for (const call of calls) state.toolCalls.set(call.id, call)
  if (calls.length) {
    state.messages.set(input.assistantMessageId, { id: input.assistantMessageId, sessionId: run.sessionId, runId: run.id,
      role: 'assistant', modelAttemptId: attempt.id, content, createdAt: input.at })
  }
  appendEvent(state, run.id, 'model.finished', 'succeeded', input.at, { stepId: step.id, attemptId: attempt.id })
  if (!calls.length) appendEvent(state, run.id, 'step.finished', 'completed', input.at, { stepId: step.id })
  return { state, value: { stepId: step.id, outcome: calls.length ? 'tools' : 'final', output: { content } } }
}

export function planModelFailed(snapshot: StateSnapshot, input: {
  readonly runId: string; readonly stepId: string; readonly error: KernelError; readonly cancelled: boolean; readonly at: string
}): StateTransition<void> {
  const step = executionStep(snapshot, input.runId, input.stepId)
  const attempt = snapshot.attempts.get(step.attemptId)
  if (!attempt || attempt.runId !== input.runId || attempt.stepId !== step.id) throw fault('CONFLICT', 'model attempt does not belong to this step')
  const state = cloneState(snapshot)
  // Late failure must never overwrite an already committed result or emit a second terminal event.
  if (attempt.status !== 'running') return { state, value: undefined }
  executionRun(snapshot, input.runId, true)
  const status = input.cancelled ? 'cancelled' : 'failed'
  state.attempts.set(attempt.id, { ...state.attempts.get(attempt.id)!, status, error: structuredClone(input.error) })
  state.steps.set(step.id, { ...state.steps.get(step.id)!, status })
  appendEvent(state, input.runId, 'model.finished', status, input.at, { stepId: step.id, attemptId: attempt.id })
  appendEvent(state, input.runId, 'step.finished', status, input.at, { stepId: step.id })
  return { state, value: undefined }
}
