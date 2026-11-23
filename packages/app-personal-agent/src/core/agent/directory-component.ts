import { createHash } from 'node:crypto'
import type { Component } from '@nya/core'
import { modelsSettingsServiceKey } from '@anybox/models'
import type { ModelsSettingsService } from '@anybox/models'
import { localStorageServiceKey } from '@anybox/storage-sqlite/port'
import type { LocalStoragePort, StorageMigration, StorageReader, StorageRow } from '@anybox/storage-sqlite/port'
import type { RuntimeInputs } from '../contracts.js'
import { sessionDefaultsConflict } from '../session/domain.js'
import { agentSummary, validateAgentFields, validateAgentRequestId, validateAgentRevision } from './domain.js'
import type { AgentDefinition, AgentRecord, AgentSummary } from './domain.js'

export const agentDirectoryServiceKey = 'personal-agent.agents'

export interface AgentDirectoryPort {
  list(): readonly AgentSummary[]
  get(id: string): AgentRecord | undefined
  create(input: unknown): Promise<AgentRecord>
  update(id: string, input: unknown): Promise<AgentRecord>
  setDefaultModel(id: string, modelId: string | null, expectedRevision: number): Promise<AgentRecord>
}

const migrations: readonly StorageMigration[] = [{
  version: 1,
  up(tx) {
    tx.execute(`CREATE TABLE personal_agent_directory (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
      instructions TEXT NOT NULL, instruction_version_id TEXT, model_id TEXT, environment_ids_json TEXT,
      revision INTEGER NOT NULL,
      creation_request_id TEXT UNIQUE, creation_digest TEXT
    )`)
  },
}, {
  version: 2,
  up(tx) { tx.execute('ALTER TABLE personal_agent_directory ADD COLUMN logo_shader TEXT') },
}, {
  version: 3,
  up(tx) {
    tx.execute(`ALTER TABLE personal_agent_directory ADD COLUMN instruction_role TEXT NOT NULL DEFAULT 'system'
      CHECK (instruction_role IN ('system', 'developer'))`)
    if (hasTable(tx, 'prompt_versions')) {
      tx.execute(`UPDATE personal_agent_directory AS agent SET instruction_role = 'developer'
        WHERE EXISTS (SELECT 1 FROM prompt_versions AS version WHERE version.id = agent.instruction_version_id
          AND version.kind = 'agent-instruction' AND version.role = 'developer' AND version.content = agent.instructions)`)
    }
    tx.execute('ALTER TABLE personal_agent_directory DROP COLUMN instruction_version_id')
  },
}]

function hasTable(db: StorageReader, name: string): boolean {
  return db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [name]) !== undefined
}

function error(status: number, code: string): Error {
  return Object.assign(new Error(code), { status, code })
}

function storedAgent(row: StorageRow): AgentRecord {
  const { id, name, description, instructions, model_id: modelId, instruction_role: instructionRole,
    revision, environment_ids_json: environments, logo_shader: logoShader } = row
  if (typeof id !== 'string' || typeof name !== 'string' || typeof description !== 'string' || typeof instructions !== 'string' ||
    modelId !== null && typeof modelId !== 'string' || instructionRole !== 'system' && instructionRole !== 'developer' ||
    logoShader !== null && typeof logoShader !== 'string') {
    throw new Error('invalid stored Agent')
  }
  const environmentIds: unknown = environments === null ? undefined : JSON.parse(String(environments))
  if (environmentIds !== undefined && (!Array.isArray(environmentIds) || environmentIds.some(id => typeof id !== 'string'))) {
    throw new Error('invalid stored Agent environments')
  }
  return Object.freeze({ id, name, description, instructions, modelId, instructionRole, revision: validateAgentRevision(revision),
    ...(logoShader === null ? {} : { logoShader }),
    ...(environmentIds === undefined ? {} : { environmentIds: Object.freeze(environmentIds as string[]) }) })
}

/** Owns the current effective Agent definition and its durable creation identity. */
export function createAgentDirectoryComponent(inputs: RuntimeInputs, seeds: readonly AgentDefinition[]): Component.Object<void, {
  [localStorageServiceKey]: LocalStoragePort
  [modelsSettingsServiceKey]: ModelsSettingsService
}> {
  return {
    name: 'personal-agent-directory',
    inject: [localStorageServiceKey, modelsSettingsServiceKey],
    async apply(ctx, _config, deps) {
      const db = deps[localStorageServiceKey], models = deps[modelsSettingsServiceKey]
      let accepting = true, tail = Promise.resolve()
      ctx.effect(() => async () => {
        accepting = false
        await tail
      }, 'join Agent directory writes')
      const write = <T>(work: () => Promise<T>): Promise<T> => {
        if (!accepting) return Promise.reject(error(503, 'service-unavailable'))
        const result = tail.then(work)
        tail = result.then(() => {}, () => {})
        return result
      }

      await db.migrate('personal-agent-directory', migrations)
      const entries = await db.transaction(tx => {
        const hasLegacyDefaults = hasTable(tx, 'harness_session_defaults')
        const hasLegacyBindings = hasTable(tx, 'agent_prompt_bindings') && hasTable(tx, 'prompt_versions')
        for (const seed of seeds) {
          if (tx.get('SELECT id FROM personal_agent_directory WHERE id = ?', [seed.id])) continue
          const version = hasLegacyBindings ? tx.get(`SELECT version.content, version.role FROM agent_prompt_bindings AS binding
            JOIN prompt_versions AS version ON version.id = binding.version_id AND version.kind = binding.kind
            WHERE binding.agent_id = ? AND binding.kind = 'agent-instruction'`, [seed.id]) : undefined
          const saved = hasLegacyDefaults ? tx.get('SELECT model_id, revision FROM harness_session_defaults WHERE agent_id = ?', [seed.id]) : undefined
          tx.execute(`INSERT INTO personal_agent_directory
            (id, name, description, instructions, instruction_role, model_id, environment_ids_json, revision)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [seed.id, seed.name ?? seed.id, seed.description ?? '', version?.content ?? seed.instructions,
            version?.role ?? 'system', saved?.model_id ?? seed.modelId ?? null, seed.environmentIds === undefined ? null : JSON.stringify(seed.environmentIds),
            saved?.revision ?? 0])
        }
        return new Map(tx.all('SELECT * FROM personal_agent_directory ORDER BY rowid').map(row => {
          const entry = storedAgent(row)
          return [entry.id, entry]
        }))
      })
      const requireAgent = (id: string): AgentRecord => {
        const entry = entries.get(id)
        if (!entry) throw error(404, 'not-found')
        return entry
      }
      const validateModel = (modelId: string | null) => {
        if (modelId !== null && !models.modelSettings().some(model => model.runtimeModelId === modelId)) throw error(400, 'model-not-found')
      }
      const update = async (prior: AgentRecord, changes: Partial<Pick<AgentRecord, 'name' | 'description' | 'instructions' | 'modelId'>> & { logoShader?: string | null }): Promise<AgentRecord> => {
        const { logoShader: oldLogo, ...previous } = prior
        const { logoShader: requestedLogo, ...fields } = changes
        const logoShader = requestedLogo === undefined ? oldLogo : requestedLogo
        const instructionRole = fields.instructions === undefined || fields.instructions === prior.instructions ? prior.instructionRole : 'system'
        const next = Object.freeze({ ...previous, ...fields, instructionRole, revision: prior.revision + 1, ...(logoShader == null ? {} : { logoShader }) })
        await db.transaction(tx => {
          const result = tx.execute(`UPDATE personal_agent_directory SET name = ?, description = ?, instructions = ?,
            instruction_role = ?, model_id = ?, logo_shader = ?, revision = ? WHERE id = ? AND revision = ?`,
          [next.name, next.description, next.instructions, next.instructionRole, next.modelId, next.logoShader ?? null, next.revision, next.id, prior.revision])
          if (Number(result.changes) !== 1) throw error(409, 'agent-revision-conflict')
        })
        entries.set(next.id, next)
        return next
      }
      const service: AgentDirectoryPort = {
        list: () => Object.freeze([...entries.values()].map(agentSummary)),
        get: id => entries.get(id),
        create(raw) {
          const { logoShader, ...values } = validateAgentFields(raw)
          // A null logo and an omitted logo share the original creation digest.
          const fields = { ...values, ...(logoShader == null ? {} : { logoShader }) }
          const requestId = validateAgentRequestId((raw as { requestId?: unknown }).requestId)
          const digest = createHash('sha256').update(JSON.stringify(fields)).digest('hex')
          return write(async () => {
            const entry = await db.transaction(tx => {
              const existing = tx.get('SELECT id, creation_digest FROM personal_agent_directory WHERE creation_request_id = ?', [requestId])
              if (existing) {
                if (existing.creation_digest !== digest) throw error(409, 'agent-request-conflict')
                return requireAgent(String(existing.id))
              }
              validateModel(fields.modelId)
              const agent = Object.freeze({ ...fields, id: inputs.newId(), revision: 0, instructionRole: 'system' as const, environmentIds: Object.freeze([]) })
              tx.execute(`INSERT INTO personal_agent_directory
                (id, name, description, instructions, model_id, environment_ids_json, revision, creation_request_id, creation_digest, logo_shader)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [agent.id, agent.name, agent.description, agent.instructions, agent.modelId,
                JSON.stringify(agent.environmentIds), agent.revision, requestId, digest, agent.logoShader ?? null])
              return agent
            })
            entries.set(entry.id, entry)
            return entry
          })
        },
        update(id, raw) {
          const fields = validateAgentFields(raw)
          const expected = validateAgentRevision((raw as { expectedRevision?: unknown }).expectedRevision)
          return write(async () => {
            const prior = requireAgent(id)
            if (prior.revision !== expected) throw error(409, 'agent-revision-conflict')
            if (fields.modelId !== prior.modelId) validateModel(fields.modelId)
            return update(prior, fields)
          })
        },
        setDefaultModel(id, modelId, expectedRevision) {
          validateAgentRevision(expectedRevision)
          return write(async () => {
            const prior = requireAgent(id)
            if (prior.revision !== expectedRevision) throw sessionDefaultsConflict()
            if (modelId !== prior.modelId) validateModel(modelId)
            return update(prior, { modelId })
          })
        },
      }
      ctx.provide(agentDirectoryServiceKey, service)
    },
  }
}
