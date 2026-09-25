/** Harness domain values and transitions are independent of Nya and providers. */
import type { LLMFailureCategory, LLMMessage, LLMPlan, LLMSnapshot } from '../llm/port.js'
import type { PromptSnapshot } from '../prompt/domain.js'
import { nonEmpty } from '../validation.js'

export interface Turn {
  readonly input: string
  readonly output: string
}

export interface Session {
  readonly id: string
  readonly projectId: string
  readonly agentId: string
  readonly createdAt: string
  readonly turns: readonly Turn[]
}

export type RunStatus = 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed' | 'interrupted'

export interface Run {
  readonly id: string
  readonly sessionId: string
  readonly input: string
  readonly idempotencyKey: string
  readonly status: RunStatus
  readonly createdAt: string
  readonly updatedAt: string
  readonly promptVersionIds: readonly string[]
  readonly llmSnapshot: LLMSnapshot
  readonly errorCategory?: LLMFailureCategory
  readonly output?: string
  readonly error?: string
}

export interface RunInput {
  readonly sessionId: string
  readonly input: string
  readonly idempotencyKey: string
}

export type RunOutcome =
  | { readonly kind: 'completed'; readonly output: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'cleanup-failed'; readonly error: string; readonly category: LLMFailureCategory }
  | { readonly kind: 'failed'; readonly error: string; readonly category: LLMFailureCategory }

export function validateRunInput(input: RunInput): RunInput {
  if (input && ('modelProfileId' in input || 'model' in input || 'selection' in input || 'llmPlan' in input)) {
    throw new TypeError('RunInput cannot override LLM selection')
  }
  return Object.freeze({
    sessionId: nonEmpty(input?.sessionId, 'sessionId'),
    input: nonEmpty(input?.input, 'input'),
    idempotencyKey: nonEmpty(input?.idempotencyKey, 'idempotencyKey'),
  })
}

export function createSession(id: string, projectId: string, agentId: string, now: string): Session {
  return Object.freeze({ id, projectId, agentId, createdAt: now, turns: Object.freeze([]) })
}

export function createRun(id: string, input: RunInput, prompts: readonly PromptSnapshot[], plan: LLMPlan, now: string): Run {
  return Object.freeze({
    id, ...input, llmSnapshot: plan.snapshot, promptVersionIds: Object.freeze(prompts.map(prompt => prompt.versionId)),
    status: 'running', createdAt: now, updatedAt: now,
  })
}

export function requestCancellation(run: Run, now: string): Run {
  return run.status === 'running' ? Object.freeze({ ...run, status: 'cancelling', updatedAt: now }) : run
}

export function settleRun(run: Run, outcome: RunOutcome, now: string): Run {
  if (run.status !== 'running' && run.status !== 'cancelling') return run
  if (outcome.kind === 'cleanup-failed') {
    return Object.freeze({ ...run, status: 'failed', error: outcome.error, errorCategory: outcome.category, updatedAt: now })
  }
  if (run.status === 'cancelling') return Object.freeze({ ...run, status: 'cancelled', updatedAt: now })
  if (outcome.kind === 'completed') {
    return Object.freeze({ ...run, status: 'completed', output: outcome.output, updatedAt: now })
  }
  if (outcome.kind === 'failed') {
    return Object.freeze({ ...run, status: 'failed', error: outcome.error, errorCategory: outcome.category, updatedAt: now })
  }
  return Object.freeze({ ...run, status: 'cancelled', updatedAt: now })
}

export function appendTurn(session: Session, input: string, output: string): Session {
  return Object.freeze({
    ...session,
    turns: Object.freeze([...session.turns, Object.freeze({ input, output })]),
  })
}

export function buildLLMMessages(prompts: readonly PromptSnapshot[], session: Session, input: string): readonly LLMMessage[] {
  const messages: LLMMessage[] = []
  for (const kind of ['agent-instruction', 'context'] as const) {
    const prompt = prompts.find(item => item.kind === kind)
    if (prompt) messages.push(Object.freeze({ role: prompt.role, content: prompt.content }))
  }
  for (const turn of session.turns) {
    messages.push(Object.freeze({ role: 'user', content: turn.input }))
    messages.push(Object.freeze({ role: 'assistant', content: turn.output }))
  }
  const template = prompts.find(item => item.kind === 'task-template')
  messages.push(Object.freeze({ role: 'user', content: template ? template.content.replace('{{input}}', input) : input }))
  return Object.freeze(messages)
}
