import type { FileRef } from '../project-files/domain.js'
/** Immutable conversation facts, independent of persistence and execution. */
import type { ImageRef } from '../image/port.js'
import { createToolSelection } from '../tool/catalog.js'
import type { ToolSelectionSnapshot } from '../tool/catalog.js'
export interface Session {
  readonly id: string
  readonly title: string | null
  readonly projectId: string
  readonly agentId: string
  readonly modelId: string | null
  readonly toolSelection: ToolSelectionSnapshot
  readonly historyMode: 'dialogue-v1' | 'native-local-v1'
  readonly protocolId: string | null
  readonly archivedAt: string | null
  readonly createdAt: string
}

/** A bounded display label from the first durable user input, independent of the selected branch. */
export function deriveSessionTitle(input: string, imageCount = 0, fileCount = 0): string | null {
  const text = input.replace(/\s+/gu, ' ').trim()
  if (text) {
    const characters = Array.from(text)
    return characters.length > 120 ? `${characters.slice(0, 119).join('')}…` : text
  }
  const attachments = [imageCount ? `${imageCount} 张图片` : '', fileCount ? `${fileCount} 个文件` : ''].filter(Boolean)
  return attachments.length ? attachments.join(' · ') : null
}

/** Initialization preferences for future sessions; existing selections are independent. */
export interface SessionDefaults {
  readonly agentId: string
  readonly modelId: string | null
  readonly fallbackModelId: string | null
  readonly effectiveModelId: string | null
  readonly revision: number
}

/** Agent-owned tool defaults are copied into each newly created Session. */
export interface AgentToolsSelection {
  readonly agentId: string
  readonly toolIds: readonly string[]
  readonly revision: number
}

export interface AgentToolsInput {
  readonly toolIds: readonly string[]
  readonly expectedRevision: number
}

export function agentToolsConflict(): Error & { readonly code: string } {
  return Object.assign(new Error('Agent tools changed; reload before saving'), { code: 'agent-tools-conflict' })
}

export function resolveSessionModel(requested: string | undefined, saved: string | null, fallback: string | null): string | null {
  return requested ?? saved ?? fallback
}

export function sessionDefaultsConflict(): Error & { readonly code: string } {
  return Object.assign(new Error('session defaults changed; reload before saving'), { code: 'session-defaults-conflict' })
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

export function treeError(code: 'session-archived' | 'session-has-active-runs' | 'node-not-found' | 'invalid-history' | 'idempotency-conflict' | 'legacy-session-readonly' | 'protocol-mismatch' | 'history-incompatible'): Error & { readonly code: string } {
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

export function createSession(id: string, projectId: string, agentId: string, now: string, modelId: string | null = null,
  toolSelection: ToolSelectionSnapshot = createToolSelection()): Session {
  return Object.freeze({ id, title: null, projectId, agentId, modelId, toolSelection, archivedAt: null, createdAt: now, historyMode: 'native-local-v1' as const, protocolId: null })
}
