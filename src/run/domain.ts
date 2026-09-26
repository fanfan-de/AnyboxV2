/** Harness domain values and transitions are independent of Nya and providers. */
import type { LLMFailureCategory, LLMMessage, LLMPlan, LLMSnapshot, ToolRequest } from '../llm/port.js'
import type { BashResult } from '../tool/bash-component.js'
import type { PromptSnapshot } from '../prompt/domain.js'
import { nonEmpty } from '../validation.js'

export interface ConversationNode {
  readonly id: string
  readonly sessionId: string
  readonly parentId: string | null
  readonly input: string
  readonly output: string
  readonly sourceRunId: string | null
}

export type RunHistory =
  | { readonly kind: 'tree'; readonly parentNodeId: string | null }
  | { readonly kind: 'legacy-unknown' }

export interface NodePage {
  readonly nodes: readonly ConversationNode[]
  readonly nextCursor?: string
}

export interface NodeQuery { readonly cursor?: string; readonly limit?: number }
export interface RunQuery { readonly active?: boolean; readonly parentNodeId?: string | null }

export function treeError(code: 'node-not-found' | 'invalid-history' | 'idempotency-conflict'): Error & { readonly code: string } {
  return Object.assign(new Error(code === 'idempotency-conflict' ? 'idempotency key already used with different input or history' : code), { code })
}

/** Input is leaf-to-root; validate before exposing a root-to-leaf history. */
export function assemblePath(sessionId: string, parentId: string | null, ancestors: readonly ConversationNode[]): readonly ConversationNode[] {
  const seen = new Set<string>()
  let expected = parentId
  for (const node of ancestors) {
    if (node.sessionId !== sessionId || node.id !== expected || seen.has(node.id)) throw treeError('invalid-history')
    seen.add(node.id)
    expected = node.parentId
  }
  if (expected !== null) throw treeError('invalid-history')
  return Object.freeze([...ancestors].reverse())
}

export interface Session {
  readonly id: string
  readonly projectId: string
  readonly agentId: string
  readonly createdAt: string
}

export type RunStatus = 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed' | 'interrupted'

export type RunFailureCategory = LLMFailureCategory |
  'invalid-tool-request' | 'limit-exceeded' | 'tool-unavailable' | 'tool-timeout' | 'tool-cancelled' | 'tool-cleanup-failure' | 'state-write-failure'

export class RunFailure extends Error {
  constructor(readonly category: Exclude<RunFailureCategory, LLMFailureCategory>) {
    super({
      'invalid-tool-request': 'model tool request is invalid',
      'limit-exceeded': 'run limit was exceeded',
      'tool-unavailable': 'bash tool is unavailable',
      'tool-timeout': 'bash command timed out',
      'tool-cancelled': 'bash command was cancelled',
      'tool-cleanup-failure': 'bash command cleanup failed',
      'state-write-failure': 'run state could not be persisted',
    }[category])
    this.name = 'RunFailure'
  }
}

export const runLimits = Object.freeze({
  finalBytes: 65_536,
  totalToolOutputBytes: 131_072,
})

export interface ValidatedBashRequest extends ToolRequest {
  readonly name: 'bash'
  readonly arguments: Readonly<{ command: string }>
}

/** Validate a whole model batch before acquiring any tool resource. */
export function validateBashBatch(calls: unknown): readonly ValidatedBashRequest[] {
  if (!Array.isArray(calls) || calls.length === 0) {
    throw new RunFailure('invalid-tool-request')
  }
  const ids = new Set<string>()
  return Object.freeze(calls.map((call: unknown) => {
    if (!call || typeof call !== 'object' || Array.isArray(call) ||
      !('id' in call) || typeof call.id !== 'string' || !call.id.trim() || call.id.length > 256 ||
      ids.has(call.id) || !('name' in call) || call.name !== 'bash' ||
      !('arguments' in call) || !call.arguments || typeof call.arguments !== 'object' ||
      Array.isArray(call.arguments) || Object.keys(call.arguments).length !== 1 ||
      !('command' in call.arguments) || typeof call.arguments.command !== 'string' ||
      !call.arguments.command.trim() || call.arguments.command.includes('\0')) {
      throw new RunFailure('invalid-tool-request')
    }
    ids.add(call.id)
    return Object.freeze({
      id: call.id, name: 'bash' as const,
      arguments: Object.freeze({ command: call.arguments.command }),
    })
  }))
}

export function bashObservationMessage(requestId: string, result: BashResult): LLMMessage {
  return Object.freeze({
    role: 'tool', toolCallId: requestId,
    content: JSON.stringify({
      exitCode: result.exitCode, signal: result.signal, stdout: result.stdout,
      stderr: result.stderr, truncated: result.truncated,
    }),
  })
}

export interface Run {
  readonly id: string
  readonly sessionId: string
  readonly input: string
  readonly idempotencyKey: string
  readonly status: RunStatus
  readonly history: RunHistory
  readonly contextVersion: 'dialogue-v1' | null
  readonly resultNodeId?: string
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly promptVersionIds: readonly string[]
  readonly llmSnapshot: LLMSnapshot
  readonly errorCategory?: RunFailureCategory
  readonly output?: string
  readonly error?: string
}

export interface RunInput {
  readonly sessionId: string
  readonly parentNodeId: string | null
  readonly input: string
  readonly idempotencyKey: string
}

export type RunOutcome =
  | { readonly kind: 'completed'; readonly output: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'cleanup-failed'; readonly error: string; readonly category: RunFailureCategory }
  | { readonly kind: 'failed'; readonly error: string; readonly category: RunFailureCategory }

export function validateRunInput(input: RunInput): RunInput {
  if (input && ('modelProfileId' in input || 'model' in input || 'selection' in input || 'llmPlan' in input)) {
    throw new TypeError('RunInput cannot override LLM selection')
  }
  return Object.freeze({
    sessionId: nonEmpty(input?.sessionId, 'sessionId'),
    parentNodeId: input?.parentNodeId === null ? null : nonEmpty(input?.parentNodeId, 'parentNodeId'),
    input: nonEmpty(input?.input, 'input'),
    idempotencyKey: nonEmpty(input?.idempotencyKey, 'idempotencyKey'),
  })
}

export function createSession(id: string, projectId: string, agentId: string, now: string): Session {
  return Object.freeze({ id, projectId, agentId, createdAt: now })
}

export function createRun(id: string, input: RunInput, prompts: readonly PromptSnapshot[], plan: LLMPlan, now: string): Run {
  return Object.freeze({
    id, sessionId: input.sessionId, input: input.input, idempotencyKey: input.idempotencyKey,
    history: Object.freeze({ kind: 'tree', parentNodeId: input.parentNodeId }), contextVersion: 'dialogue-v1', revision: 0,
    llmSnapshot: plan.snapshot, promptVersionIds: Object.freeze(prompts.map(prompt => prompt.versionId)),
    status: 'running', createdAt: now, updatedAt: now,
  })
}

export function requestCancellation(run: Run, now: string): Run {
  return run.status === 'running' ? Object.freeze({ ...run, status: 'cancelling', updatedAt: now }) : run
}

export function settleRun(run: Run, outcome: RunOutcome, now: string): Run {
  if (run.status !== 'running' && run.status !== 'cancelling') return run
  // Infrastructure failure must remain visible even if cancellation was already requested.
  if (outcome.kind === 'cleanup-failed' || (outcome.kind === 'failed' && outcome.category === 'state-write-failure')) {
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

export function buildLLMMessages(prompts: readonly PromptSnapshot[], history: readonly ConversationNode[], input: string): readonly LLMMessage[] {
  const messages: LLMMessage[] = []
  for (const kind of ['agent-instruction', 'context'] as const) {
    const prompt = prompts.find(item => item.kind === kind)
    if (prompt) messages.push(Object.freeze({ role: prompt.role, content: prompt.content }))
  }
  for (const turn of history) {
    messages.push(Object.freeze({ role: 'user', content: turn.input }))
    messages.push(Object.freeze({ role: 'assistant', content: turn.output }))
  }
  const template = prompts.find(item => item.kind === 'task-template')
  messages.push(Object.freeze({ role: 'user', content: template ? template.content.replace('{{input}}', input) : input }))
  return Object.freeze(messages)
}
