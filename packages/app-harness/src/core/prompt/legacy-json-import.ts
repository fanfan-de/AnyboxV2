import { existsSync, readFileSync } from 'node:fs'
import { validatePrompt } from './domain.js'
import type { PromptBinding, PromptDocument, PromptKind, PromptVersion } from './domain.js'

export interface StoredBinding extends PromptBinding { readonly agentId: string }
export interface StoredData {
  readonly schemaVersion: 1
  readonly documents: readonly PromptDocument[]
  readonly versions: readonly PromptVersion[]
  readonly bindings: readonly StoredBinding[]
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function string(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function readStoredData(path: string): StoredData {
  let raw: unknown
  try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch (error) {
    throw new Error(`cannot read prompt storage ${path}`, { cause: error })
  }
  if (!object(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.documents) ||
    !Array.isArray(raw.versions) || !Array.isArray(raw.bindings)) {
    throw new Error('unsupported or invalid prompt storage format')
  }

  const documents: PromptDocument[] = []
  const versions: PromptVersion[] = []
  const bindings: StoredBinding[] = []
  const documentIds = new Set<string>()
  const versionIds = new Set<string>()
  const bindingKeys = new Set<string>()
  for (const item of raw.documents) {
    if (!object(item) || !string(item.id) || !string(item.ownerId) || !string(item.name) ||
      typeof item.description !== 'string' || !object(item.draft) ||
      !Number.isSafeInteger(item.draft.revision) || (item.draft.revision as number) < 1 ||
      !string(item.draft.updatedAt) || !string(item.draft.updatedBy) ||
      !Array.isArray(item.versionIds) || !item.versionIds.every(string) ||
      new Set(item.versionIds).size !== item.versionIds.length ||
      (item.publishedDraftRevision !== undefined &&
        (!Number.isSafeInteger(item.publishedDraftRevision) ||
          (item.publishedDraftRevision as number) < 1 ||
          (item.publishedDraftRevision as number) > (item.draft.revision as number))) ||
      (item.versionIds.length === 0) !== (item.publishedDraftRevision === undefined) ||
      documentIds.has(item.id)) throw new Error('invalid prompt document in storage')
    validatePrompt(item.draft.kind as PromptKind, item.draft.role as PromptVersion['role'], item.draft.content as string)
    documentIds.add(item.id)
    documents.push(Object.freeze({
      ...item, draft: Object.freeze({ ...item.draft }), versionIds: Object.freeze([...item.versionIds]),
    }) as unknown as PromptDocument)
  }
  const documentById = new Map(documents.map(document => [document.id, document]))
  for (const item of raw.versions) {
    const document = object(item) && string(item.documentId) ? documentById.get(item.documentId) : undefined
    if (!object(item) || !string(item.id) || !string(item.documentId) || !string(item.ownerId) ||
      typeof item.content !== 'string' || !string(item.createdAt) || !string(item.createdBy) ||
      !document || document.ownerId !== item.ownerId || !document.versionIds.includes(item.id) ||
      versionIds.has(item.id)) {
      throw new Error('invalid prompt version in storage')
    }
    validatePrompt(item.kind as PromptKind, item.role as PromptVersion['role'], item.content)
    versionIds.add(item.id)
    versions.push(Object.freeze({ ...item }) as unknown as PromptVersion)
  }
  for (const document of documents) {
    if (document.versionIds.some(id => !versionIds.has(id))) throw new Error('prompt document references a missing version')
  }
  const versionById = new Map(versions.map(version => [version.id, version]))
  for (const item of raw.bindings) {
    if (!object(item) || !string(item.agentId) || !string(item.versionId) ||
      !string(item.updatedAt) || !string(item.updatedBy) || !string(item.kind)) {
      throw new Error('invalid prompt binding in storage')
    }
    const version = versionById.get(item.versionId)
    const key = JSON.stringify([item.agentId, item.kind])
    if (!version || version.kind !== item.kind || bindingKeys.has(key)) {
      throw new Error('prompt binding references an invalid version')
    }
    bindingKeys.add(key)
    bindings.push(Object.freeze({ ...item }) as unknown as StoredBinding)
  }
  return Object.freeze({ schemaVersion: 1, documents, versions, bindings })
}

/** Reads a resolved legacy store path that the old JSON provider no longer owns. */
export function loadLegacyPromptStore(path: string): StoredData {
  if (!existsSync(path)) throw new Error(`prompt JSON import file does not exist: ${path}`)
  if (existsSync(`${path}.lock`)) throw new Error('prompt JSON import file is currently owned')
  return readStoredData(path)
}
