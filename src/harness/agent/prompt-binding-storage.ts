import { resolve } from 'node:path'
import type { LocalStoragePort, StorageMigration, StorageRow } from '../storage/port.js'
import type { PromptPort } from '../prompt/component.js'
import type { PromptBinding, PromptKind } from '../prompt/domain.js'
import { loadLegacyPromptStore } from '../prompt/legacy-json-import.js'

/** Agent Prompt owns the binding schema; versions are validated through the Prompt service. */
const agentPromptMigrations: readonly StorageMigration[] = [{
  version: 1,
  up(tx) {
    tx.execute(`CREATE TABLE agent_prompt_bindings (
      agent_id TEXT NOT NULL, kind TEXT NOT NULL, version_id TEXT NOT NULL,
      updated_at TEXT NOT NULL, updated_by TEXT NOT NULL,
      PRIMARY KEY(agent_id, kind)
    )`)
    tx.execute(`CREATE TABLE agent_prompt_json_import (
      id INTEGER PRIMARY KEY CHECK (id = 1), path TEXT NOT NULL
    )`)
  },
}]

function storedString(row: StorageRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string' || !value) throw new Error(`invalid stored prompt binding ${key}`)
  return value
}

/** Imports legacy bindings after Prompt has imported the versions they reference. */
async function importLegacyBindings(database: LocalStoragePort, prompts: PromptPort, legacyJsonPath: string) {
  const path = resolve(legacyJsonPath)
  const imported = await database.read(reader => reader.get(
    'SELECT path FROM agent_prompt_json_import WHERE id = 1'))
  if (imported) {
    if (imported.path !== path) throw new Error('a different prompt JSON file was already imported')
    return
  }
  const existing = await database.read(reader => reader.get('SELECT agent_id FROM agent_prompt_bindings LIMIT 1'))
  if (existing) throw new Error('prompt JSON import requires empty Agent prompt bindings')
  const { bindings } = loadLegacyPromptStore(path)
  for (const binding of bindings) {
    if (prompts.getPublishedVersion(binding.versionId)?.kind !== binding.kind) {
      throw new Error('imported prompt binding references an unavailable version')
    }
  }
  await database.transaction(tx => {
    for (const binding of bindings) {
      tx.execute('INSERT INTO agent_prompt_bindings VALUES (?, ?, ?, ?, ?)', [
        binding.agentId, binding.kind, binding.versionId, binding.updatedAt, binding.updatedBy,
      ])
    }
    tx.execute('INSERT INTO agent_prompt_json_import (id, path) VALUES (1, ?)', [path])
  })
}

/** Owns Agent prompt bindings and their committed read projection. */
export async function openAgentPromptBindings(
  database: LocalStoragePort, prompts: PromptPort, legacyJsonPath?: string,
): Promise<{
  get(agentId: string): readonly PromptBinding[]
  bind(agentId: string, binding: PromptBinding): Promise<void>
  close(): Promise<void>
}> {
  await database.migrate('agent-prompt', agentPromptMigrations)
  if (legacyJsonPath !== undefined) await importLegacyBindings(database, prompts, legacyJsonPath)
  const rows = await database.read(reader => reader.all('SELECT * FROM agent_prompt_bindings'))
  const bindings = new Map<string, Map<PromptKind, PromptBinding>>()
  for (const row of rows) {
    const agentId = storedString(row, 'agent_id')
    const kind = storedString(row, 'kind') as PromptKind
    const versionId = storedString(row, 'version_id')
    if (prompts.getPublishedVersion(versionId)?.kind !== kind) throw new Error('invalid stored prompt binding')
    const binding: PromptBinding = Object.freeze({
      kind, versionId, updatedAt: storedString(row, 'updated_at'),
      updatedBy: storedString(row, 'updated_by'),
    })
    const perAgent = bindings.get(agentId) ?? new Map<PromptKind, PromptBinding>()
    perAgent.set(kind, binding)
    bindings.set(agentId, perAgent)
  }

  let accepting = true
  let tail: Promise<void> = Promise.resolve()
  return {
    get(agentId) { return Object.freeze([...(bindings.get(agentId)?.values() ?? [])]) },
    bind(agentId, binding) {
      if (!accepting) return Promise.reject(new Error('agent prompt bindings are closing'))
      const result = tail.then(async () => {
        if (prompts.getPublishedVersion(binding.versionId)?.kind !== binding.kind) {
          throw new Error('invalid prompt binding')
        }
        await database.transaction(tx => {
          tx.execute(`INSERT INTO agent_prompt_bindings (agent_id, kind, version_id, updated_at, updated_by)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT(agent_id, kind) DO UPDATE SET
            version_id = excluded.version_id, updated_at = excluded.updated_at,
            updated_by = excluded.updated_by`, [
            agentId, binding.kind, binding.versionId, binding.updatedAt, binding.updatedBy,
          ])
        })
        const perAgent = new Map(bindings.get(agentId) ?? [])
        perAgent.set(binding.kind, binding)
        bindings.set(agentId, perAgent)
      })
      tail = result.then(() => {}, () => {})
      return result
    },
    async close() { accepting = false; await tail },
  }
}
