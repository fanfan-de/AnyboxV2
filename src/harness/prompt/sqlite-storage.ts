import { resolve } from 'node:path'
import type { LocalStoragePort, StorageMigration, StorageRow } from '../storage/port.js'
import { validatePrompt } from './domain.js'
import type { PromptDocument, PromptKind, PromptRole, PromptVersion } from './domain.js'
import { loadLegacyPromptStore } from './legacy-json-import.js'

interface PromptStoragePort {
  createDocument(document: PromptDocument): void | Promise<void>
  updateDocument(document: PromptDocument): void | Promise<void>
  publish(document: PromptDocument, version: PromptVersion): void | Promise<void>
  getDocument(id: string): PromptDocument | undefined
  listDocuments(ownerId: string): readonly PromptDocument[]
  getVersion(id: string): PromptVersion | undefined
  getVersions(documentId: string): readonly PromptVersion[]
}

/** Prompt owns its schema; the SQLite provider only records this domain's applied version. */
const promptMigrations: readonly StorageMigration[] = [{
  version: 1,
  up(tx) {
    tx.execute(`CREATE TABLE prompt_documents (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT NOT NULL, draft_revision INTEGER NOT NULL,
      draft_kind TEXT NOT NULL, draft_role TEXT NOT NULL, draft_content TEXT NOT NULL,
      draft_updated_at TEXT NOT NULL, draft_updated_by TEXT NOT NULL,
      published_revision INTEGER
    )`)
    tx.execute(`CREATE TABLE prompt_versions (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES prompt_documents(id),
      ordinal INTEGER NOT NULL, owner_id TEXT NOT NULL, kind TEXT NOT NULL,
      role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL,
      created_by TEXT NOT NULL, UNIQUE(document_id, ordinal)
    )`)
    tx.execute('CREATE INDEX prompt_documents_owner ON prompt_documents(owner_id)')
    tx.execute(`CREATE TABLE prompt_json_import (
      id INTEGER PRIMARY KEY CHECK (id = 1), path TEXT NOT NULL
    )`)
  },
}]

function requiredString(row: StorageRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string' || !value) throw new Error(`invalid stored prompt ${key}`)
  return value
}

function text(row: StorageRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new Error(`invalid stored prompt ${key}`)
  return value
}

function positiveInteger(row: StorageRow, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`invalid stored prompt ${key}`)
  }
  return value
}

function documentFromRow(row: StorageRow): PromptDocument {
  const kind = requiredString(row, 'draft_kind') as PromptKind
  const role = requiredString(row, 'draft_role') as PromptRole
  const content = text(row, 'draft_content')
  validatePrompt(kind, role, content)
  const revision = positiveInteger(row, 'draft_revision')
  const published = row.published_revision === null ? undefined : positiveInteger(row, 'published_revision')
  if (published !== undefined && published > revision) throw new Error('invalid stored prompt publication')
  return Object.freeze({
    id: requiredString(row, 'id'), ownerId: requiredString(row, 'owner_id'),
    name: requiredString(row, 'name'), description: text(row, 'description'),
    draft: Object.freeze({
      revision, kind, role, content,
      updatedAt: requiredString(row, 'draft_updated_at'),
      updatedBy: requiredString(row, 'draft_updated_by'),
    }),
    ...(published === undefined ? {} : { publishedDraftRevision: published }),
    versionIds: Object.freeze([]) as readonly string[],
  })
}

function versionFromRow(row: StorageRow): PromptVersion {
  const kind = requiredString(row, 'kind') as PromptKind
  const role = requiredString(row, 'role') as PromptRole
  const content = text(row, 'content')
  validatePrompt(kind, role, content)
  return Object.freeze({
    id: requiredString(row, 'id'), documentId: requiredString(row, 'document_id'),
    ownerId: requiredString(row, 'owner_id'), kind, role, content,
    createdAt: requiredString(row, 'created_at'), createdBy: requiredString(row, 'created_by'),
  })
}

/** Prompt-owned document and version persistence with a committed read projection. */
export async function openSqlitePromptStorage(
  database: LocalStoragePort, legacyJsonPath?: string,
): Promise<{ readonly service: PromptStoragePort; close(): Promise<void> }> {
  await database.migrate('prompt', promptMigrations)
  if (legacyJsonPath !== undefined) {
    const path = resolve(legacyJsonPath)
    const imported = await database.read(reader => reader.get(
      'SELECT path FROM prompt_json_import WHERE id = 1'))
    if (imported) {
      if (imported.path !== path) throw new Error('a different prompt JSON file was already imported')
    } else {
      const existing = await database.read(reader => reader.get(
        'SELECT id FROM prompt_documents LIMIT 1'))
      if (existing) throw new Error('prompt JSON import requires an empty Prompt database')
      const legacy = loadLegacyPromptStore(path)
      const versions = new Map(legacy.versions.map(version => [version.id, version]))
      await database.transaction(tx => {
        for (const document of legacy.documents) {
          tx.execute('INSERT INTO prompt_documents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
            document.id, document.ownerId, document.name, document.description,
            document.draft.revision, document.draft.kind, document.draft.role,
            document.draft.content, document.draft.updatedAt, document.draft.updatedBy,
            document.publishedDraftRevision ?? null,
          ])
        }
        for (const document of legacy.documents) {
          for (const [index, id] of document.versionIds.entries()) {
            const version = versions.get(id)!
            tx.execute('INSERT INTO prompt_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
              version.id, version.documentId, index + 1, version.ownerId,
              version.kind, version.role, version.content, version.createdAt, version.createdBy,
            ])
          }
        }
        tx.execute('INSERT INTO prompt_json_import (id, path) VALUES (1, ?)', [path])
      })
    }
  }
  const rows = await database.read(reader => ({
    documents: reader.all('SELECT * FROM prompt_documents'),
    versions: reader.all('SELECT * FROM prompt_versions ORDER BY document_id, ordinal'),
  }))
  const documents = new Map<string, PromptDocument>()
  const versions = new Map<string, PromptVersion>()
  const versionIds = new Map<string, string[]>()
  for (const row of rows.documents) {
    const document = documentFromRow(row)
    documents.set(document.id, document)
  }
  for (const row of rows.versions) {
    const version = versionFromRow(row)
    const document = documents.get(version.documentId)
    if (!document || document.ownerId !== version.ownerId) throw new Error('invalid stored prompt version owner')
    const ids = versionIds.get(document.id) ?? []
    if (positiveInteger(row, 'ordinal') !== ids.length + 1) throw new Error('invalid stored prompt version order')
    ids.push(version.id)
    versionIds.set(document.id, ids)
    versions.set(version.id, version)
  }
  for (const [id, document] of documents) {
    const ids = versionIds.get(id) ?? []
    if ((ids.length === 0) !== (document.publishedDraftRevision === undefined)) {
      throw new Error('invalid stored prompt publication')
    }
    documents.set(id, Object.freeze({ ...document, versionIds: Object.freeze(ids) }))
  }
  let tail: Promise<void> = Promise.resolve()
  let accepting = true
  const close = async () => {
    accepting = false
    await tail
  }
  const mutate = (work: () => Promise<void>): Promise<void> => {
    if (!accepting) return Promise.reject(new Error('prompt storage is closing'))
    const result = tail.then(work)
    tail = result.then(() => {}, () => {})
    return result
  }
  const service: PromptStoragePort = {
    createDocument(document) {
      return mutate(async () => {
        if (documents.has(document.id)) throw new Error(`prompt id ${document.id} already exists`)
        await database.transaction(tx => {
          tx.execute(`INSERT INTO prompt_documents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`, [
            document.id, document.ownerId, document.name, document.description,
            document.draft.revision, document.draft.kind, document.draft.role,
            document.draft.content, document.draft.updatedAt, document.draft.updatedBy,
          ])
        })
        documents.set(document.id, document)
      })
    },
    updateDocument(document) {
      return mutate(async () => {
        const prior = documents.get(document.id)
        if (!prior) throw new Error(`unknown prompt ${document.id}`)
        if (prior.draft.revision !== document.draft.revision - 1) throw new Error('prompt draft revision conflict')
        await database.transaction(tx => {
          const result = tx.execute(`UPDATE prompt_documents SET name = ?, description = ?,
            draft_revision = ?, draft_kind = ?, draft_role = ?, draft_content = ?,
            draft_updated_at = ?, draft_updated_by = ? WHERE id = ? AND draft_revision = ?`, [
            document.name, document.description, document.draft.revision,
            document.draft.kind, document.draft.role, document.draft.content,
            document.draft.updatedAt, document.draft.updatedBy, document.id, prior.draft.revision,
          ])
          if (result.changes !== 1) throw new Error('prompt draft revision conflict')
        })
        const { publishedDraftRevision: _published, versionIds: _versionIds, ...fields } = document
        documents.set(document.id, Object.freeze({
          ...fields, versionIds: prior.versionIds,
          ...(prior.publishedDraftRevision === undefined ? {} : {
            publishedDraftRevision: prior.publishedDraftRevision,
          }),
        }))
      })
    },
    publish(document, version) {
      return mutate(async () => {
        const prior = documents.get(document.id)
        if (!prior) throw new Error(`unknown prompt ${document.id}`)
        if (versions.has(version.id)) throw new Error(`prompt version id ${version.id} already exists`)
        if (prior.publishedDraftRevision === prior.draft.revision ||
          prior.draft.revision !== document.draft.revision ||
          document.versionIds.length !== prior.versionIds.length + 1) {
          throw new Error('prompt draft has no unpublished changes')
        }
        await database.transaction(tx => {
          tx.execute(`INSERT INTO prompt_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            version.id, version.documentId, prior.versionIds.length + 1, version.ownerId,
            version.kind, version.role, version.content, version.createdAt, version.createdBy,
          ])
          const result = tx.execute(`UPDATE prompt_documents SET published_revision = ?
            WHERE id = ? AND draft_revision = ?`, [
            document.publishedDraftRevision!, document.id, prior.draft.revision,
          ])
          if (result.changes !== 1) throw new Error('prompt draft revision conflict')
        })
        documents.set(document.id, document)
        versions.set(version.id, version)
      })
    },
    getDocument(id) { return documents.get(id) },
    listDocuments(ownerId) {
      return Object.freeze([...documents.values()].filter(document => document.ownerId === ownerId))
    },
    getVersion(id) { return versions.get(id) },
    getVersions(documentId) {
      return Object.freeze((documents.get(documentId)?.versionIds ?? []).map(id => versions.get(id)!))
    },
  }
  return { service, close }
}
