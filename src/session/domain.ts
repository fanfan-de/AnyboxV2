import type { FileRef } from '../project-files/domain.js'
/** Immutable conversation facts, independent of persistence and execution. */
import type { ImageRef } from '../image/port.js'
export interface Session {
  readonly id: string
  readonly projectId: string
  readonly agentId: string
  readonly modelId: string | null
  readonly historyMode: 'dialogue-v1' | 'native-local-v1'
  readonly protocolId: string | null
  readonly createdAt: string
}

export interface ConversationNode {
  readonly id: string
  readonly sessionId: string
  readonly parentId: string | null
  readonly input: string
  readonly images: readonly ImageRef[]
  readonly files: readonly FileRef[]
  readonly output: string
  readonly sourceRunId: string | null
}

export interface NodePage {
  readonly nodes: readonly ConversationNode[]
  readonly nextCursor?: string
}

export interface NodeQuery { readonly cursor?: string; readonly limit?: number }

export function treeError(code: 'node-not-found' | 'invalid-history' | 'idempotency-conflict' | 'legacy-session-readonly' | 'protocol-mismatch' | 'history-incompatible'): Error & { readonly code: string } {
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

export function createSession(id: string, projectId: string, agentId: string, now: string, modelId: string | null = null): Session {
  return Object.freeze({ id, projectId, agentId, modelId, createdAt: now, historyMode: 'native-local-v1' as const, protocolId: null })
}
