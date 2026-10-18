import { nonEmpty } from '../validation.js'

export type PromptKind = 'agent-instruction' | 'task-template' | 'context'
export type PromptRole = 'system' | 'developer' | 'user'

export interface PromptDraft {
  readonly revision: number
  readonly kind: PromptKind
  readonly role: PromptRole
  readonly content: string
  readonly updatedAt: string
  readonly updatedBy: string
}

export interface PromptDocument {
  readonly id: string
  readonly ownerId: string
  readonly name: string
  readonly description: string
  readonly draft: PromptDraft
  readonly publishedDraftRevision?: number
  readonly versionIds: readonly string[]
}

export interface PromptVersion {
  readonly id: string
  readonly documentId: string
  readonly ownerId: string
  readonly kind: PromptKind
  readonly role: PromptRole
  readonly content: string
  readonly createdAt: string
  readonly createdBy: string
}

export interface PromptSnapshot {
  readonly versionId: string
  readonly documentId: string
  readonly kind: PromptKind
  readonly role: PromptRole
  readonly content: string
}

export interface PromptBinding {
  readonly kind: PromptKind
  readonly versionId: string
  readonly updatedAt: string
  readonly updatedBy: string
}

export interface PromptCreateInput {
  readonly name: string
  readonly description?: string
  readonly kind: PromptKind
  readonly role: PromptRole
  readonly content: string
}

export interface PromptEditInput {
  readonly name?: string
  readonly description?: string
  readonly kind?: PromptKind
  readonly role?: PromptRole
  readonly content?: string
}

const rolesByKind: Readonly<Record<PromptKind, readonly PromptRole[]>> = {
  'agent-instruction': ['system', 'developer'],
  'task-template': ['user'],
  context: ['developer', 'user'],
}

function promptName(value: unknown): string {
  const name = nonEmpty(value, 'prompt name')
  if (name.length > 200) throw new TypeError('prompt name exceeds 200 characters')
  return name
}

function promptDescription(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value !== 'string') throw new TypeError('prompt description must be a string')
  if (value.length > 2000) throw new TypeError('prompt description exceeds 2000 characters')
  return value.trim()
}

export function validatePrompt(kind: PromptKind, role: PromptRole, content: string): void {
  if (!Object.hasOwn(rolesByKind, kind)) throw new TypeError(`unknown prompt kind ${String(kind)}`)
  if (!rolesByKind[kind].includes(role)) throw new TypeError(`role ${String(role)} is not allowed for ${kind}`)
  if (typeof content !== 'string' || !content.trim()) throw new TypeError('prompt content must be non-empty')
  if (content.length > 100_000) throw new TypeError('prompt content exceeds 100000 characters')
  if (kind === 'task-template' && content.split('{{input}}').length !== 2) {
    throw new TypeError('task-template must contain {{input}} exactly once')
  }
}

export function createPromptDocument(id: string, ownerId: string, raw: PromptCreateInput, now: string): PromptDocument {
  const name = promptName(raw?.name)
  const kind = raw?.kind
  const role = raw?.role
  const content = raw?.content
  validatePrompt(kind, role, content)
  return Object.freeze({
    id: nonEmpty(id, 'prompt id'), ownerId: nonEmpty(ownerId, 'actorId'), name,
    description: promptDescription(raw.description),
    draft: Object.freeze({ revision: 1, kind, role, content, updatedAt: nonEmpty(now, 'timestamp'), updatedBy: ownerId }),
    versionIds: Object.freeze([]),
  })
}

export function editPromptDocument(
  document: PromptDocument, expectedRevision: number, patch: PromptEditInput, actorId: string, now: string,
): PromptDocument {
  if (document.draft.revision !== expectedRevision) throw new Error('prompt draft revision conflict')
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('prompt edit must be an object')
  const name = patch.name === undefined ? document.name : promptName(patch.name)
  const kind = patch.kind === undefined ? document.draft.kind : patch.kind
  const role = patch.role === undefined ? document.draft.role : patch.role
  const content = patch.content === undefined ? document.draft.content : patch.content
  validatePrompt(kind, role, content)
  return Object.freeze({
    ...document, name,
    description: patch.description === undefined ? document.description : promptDescription(patch.description),
    draft: Object.freeze({ revision: expectedRevision + 1, kind, role, content, updatedAt: nonEmpty(now, 'timestamp'), updatedBy: actorId }),
  })
}

export function publishPromptDocument(
  document: PromptDocument, versionId: string, actorId: string, now: string,
): { readonly document: PromptDocument; readonly version: PromptVersion } {
  if (document.publishedDraftRevision === document.draft.revision) throw new Error('prompt draft has no unpublished changes')
  const version: PromptVersion = Object.freeze({
    id: nonEmpty(versionId, 'versionId'), documentId: document.id, ownerId: document.ownerId,
    kind: document.draft.kind, role: document.draft.role, content: document.draft.content,
    createdAt: nonEmpty(now, 'timestamp'), createdBy: actorId,
  })
  const next = Object.freeze({
    ...document, publishedDraftRevision: document.draft.revision,
    versionIds: Object.freeze([...document.versionIds, version.id]),
  })
  return { document: next, version }
}

export function promptSnapshot(version: PromptVersion): PromptSnapshot {
  return Object.freeze({
    versionId: version.id, documentId: version.documentId,
    kind: version.kind, role: version.role, content: version.content,
  })
}
