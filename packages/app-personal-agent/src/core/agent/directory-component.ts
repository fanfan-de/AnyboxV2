import { createHash } from 'node:crypto'
import type { Component } from '@nya/core'
import { modelsSettingsServiceKey } from '@anybox/models'
import type { ModelsSettingsService } from '@anybox/models'
import { localStorageServiceKey } from '@anybox/storage-sqlite/port'
import type { LocalStoragePort, StorageMigration, StorageRow } from '@anybox/storage-sqlite/port'
import type { RuntimeInputs } from '../contracts.js'
import { promptServiceKey } from '../prompt/component.js'
import type { PromptPort } from '../prompt/component.js'
import type { PromptBinding } from '../prompt/domain.js'
import { sessionDefaultsConflict } from '../session/domain.js'
import { agentSummary, validateAgentFields, validateAgentRequestId, validateAgentRevision } from './domain.js'
import type { AgentDefinition, AgentRecord, AgentSummary } from './domain.js'
import { openAgentPromptBindings } from './prompt-binding-storage.js'

export const agentDirectoryServiceKey = 'personal-agent.agents'

export interface AgentDirectoryPort {
  list(): readonly AgentSummary[]
  get(id: string): AgentRecord | undefined
  create(input: unknown): Promise<AgentRecord>
  update(id: string, input: unknown): Promise<AgentRecord>
  setDefaultModel(id: string, modelId: string | null, expectedRevision: number): Promise<AgentRecord>
  getContextBindings(id: string): readonly PromptBinding[]
  bindPrompt(id: string, binding: PromptBinding): Promise<void>
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
}]

function error(status: number, code: string): Error {
  return Object.assign(new Error(code), { status, code })
}

function storedAgent(row: StorageRow): AgentRecord {
  const { id, name, description, instructions, model_id: modelId, instruction_version_id: instructionVersionId,
    revision, environment_ids_json: environments, logo_shader: logoShader } = row
  if (typeof id !== 'string' || typeof name !== 'string' || typeof description !== 'string' || typeof instructions !== 'string' ||
    modelId !== null && typeof modelId !== 'string' || instructionVersionId !== null && typeof instructionVersionId !== 'string' ||
    logoShader !== null && typeof logoShader !== 'string') {
    throw new Error('invalid stored Agent')
  }
  const environmentIds: unknown = environments === null ? undefined : JSON.parse(String(environments))
  if (environmentIds !== undefined && (!Array.isArray(environmentIds) || environmentIds.some(id => typeof id !== 'string'))) {
    throw new Error('invalid stored Agent environments')
  }
  return Object.freeze({ id, name, description, instructions, modelId, instructionVersionId, revision: validateAgentRevision(revision),
    ...(logoShader === null ? {} : { logoShader }),
    ...(environmentIds === undefined ? {} : { environmentIds: Object.freeze(environmentIds as string[]) }) })
}

/** Owns the current effective Agent definition and its durable creation identity. */
export function createAgentDirectoryComponent(inputs: RuntimeInputs, seeds: readonly AgentDefinition[], legacyPromptStorePath?: string): Component.Object<void, {
  [localStorageServiceKey]: LocalStoragePort
  [promptServiceKey]: PromptPort
  [modelsSettingsServiceKey]: ModelsSettingsService
}> {
  return {
    name: 'personal-agent-directory',
    inject: [localStorageServiceKey, promptServiceKey, modelsSettingsServiceKey],
    async apply(ctx, _config, deps) {
      const db = deps[localStorageServiceKey], prompts = deps[promptServiceKey], models = deps[modelsSettingsServiceKey]
      const bindings = await openAgentPromptBindings(db, prompts, legacyPromptStorePath)
      let accepting = true, tail = Promise.resolve()
      ctx.effect(() => async () => {
        accepting = false
        await tail
        await bindings.close()
      }, 'join Agent directory and Prompt binding writes')
      const write = <T>(work: () => Promise<T>): Promise<T> => {
        if (!accepting) return Promise.reject(error(503, 'service-unavailable'))
        const result = tail.then(work)
        tail = result.then(() => {}, () => {})
        return result
      }

      await db.migrate('personal-agent-directory', migrations)
      const entries = await db.transaction(tx => {
        const hasLegacyDefaults = tx.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'harness_session_defaults'") !== undefined
        for (const seed of seeds) {
          if (tx.get('SELECT id FROM personal_agent_directory WHERE id = ?', [seed.id])) continue
          const binding = bindings.get(seed.id).find(value => value.kind === 'agent-instruction')
          const version = binding ? prompts.getPublishedVersion(binding.versionId) : undefined
          const saved = hasLegacyDefaults ? tx.get('SELECT model_id, revision FROM harness_session_defaults WHERE agent_id = ?', [seed.id]) : undefined
          tx.execute(`INSERT INTO personal_agent_directory
            (id, name, description, instructions, instruction_version_id, model_id, environment_ids_json, revision)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [seed.id, seed.name ?? seed.id, seed.description ?? '', version?.content ?? seed.instructions,
            version?.id ?? null, saved?.model_id ?? seed.modelId ?? null, seed.environmentIds === undefined ? null : JSON.stringify(seed.environmentIds),
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
      const update = async (prior: AgentRecord, changes: Partial<Pick<AgentRecord, 'name' | 'description' | 'instructions' | 'modelId' | 'instructionVersionId'>> & { logoShader?: string | null }): Promise<AgentRecord> => {
        const { logoShader: oldLogo, ...previous } = prior
        const { logoShader: requestedLogo, ...fields } = changes
        const logoShader = requestedLogo === undefined ? oldLogo : requestedLogo
        const next = Object.freeze({ ...previous, ...fields, revision: prior.revision + 1, ...(logoShader == null ? {} : { logoShader }) })
        await db.transaction(tx => {
          const result = tx.execute(`UPDATE personal_agent_directory SET name = ?, description = ?, instructions = ?,
            instruction_version_id = ?, model_id = ?, logo_shader = ?, revision = ? WHERE id = ? AND revision = ?`,
          [next.name, next.description, next.instructions, next.instructionVersionId, next.modelId, next.logoShader ?? null, next.revision, next.id, prior.revision])
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
              const agent = Object.freeze({ ...fields, id: inputs.newId(), revision: 0, instructionVersionId: null, environmentIds: Object.freeze([]) })
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
            return update(prior, { ...fields, instructionVersionId: fields.instructions === prior.instructions ? prior.instructionVersionId : null })
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
        getContextBindings: id => bindings.get(id).filter(binding => binding.kind !== 'agent-instruction'),
        bindPrompt(id, binding) {
          return write(async () => {
            const prior = requireAgent(id)
            if (binding.kind !== 'agent-instruction') return bindings.bind(id, binding)
            const version = prompts.getPublishedVersion(binding.versionId)
            if (!version || version.kind !== binding.kind) throw new Error('invalid Agent role instruction binding')
            await update(prior, { instructions: version.content, instructionVersionId: version.id })
          })
        },
      }
      ctx.provide(agentDirectoryServiceKey, service)
    },
  }
}
