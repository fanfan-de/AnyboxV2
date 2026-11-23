import type { StorageReader } from '@anybox/storage-sqlite/port'
import type { ToolEnvironmentCatalog } from './catalog-port.js'
import type { AgentGrants, EnvironmentTool, GrantChange } from './contracts.js'
import { checkedTools, environmentError, environmentToolKey, targetKey } from './contracts.js'
import { functionKey } from './bindings.js'

import type { EnvironmentSelection, SelectionInput } from './bindings.js'
export type { EnvironmentSelection } from './bindings.js'
export { targetKey } from './contracts.js'
export type SelectionUpdate = SelectionInput
export interface EnvironmentTarget {
  readonly environmentId: string
  readonly targetId: string
  readonly selectionId?: string
  readonly name: string
  readonly tools: readonly EnvironmentTool[]
}
interface AgentIdentity { readonly id: string; readonly name?: string }
export interface EnvironmentInventoryTarget extends EnvironmentTarget {
  readonly agents: readonly { readonly id: string; readonly name?: string; readonly toolIds: readonly string[] }[]
}
export interface EnvironmentAccessView {
  readonly targets: readonly EnvironmentTarget[]
  readonly pendingChanges: readonly GrantChange[]
  readonly authorization: AgentGrants
  readonly preference: EnvironmentSelection
  readonly mcpManagement?: true
  readonly mcpStdio?: true
}
export interface GrantUpdate {
  readonly requestId: string
  readonly expectedRevision: number
  readonly tools: readonly EnvironmentTool[]
}
type GrantValidator = (reader: StorageReader, addedTools: readonly EnvironmentTool[]) => void
interface TargetChoice {
  readonly selectionId: string
  readonly name?: string
}

export function createTargetedToolManagement(catalog?: ToolEnvironmentCatalog) {
  const targeted = new Map(catalog?.environments.filter(environment => catalog.isTargeted(environment.environmentId))
    .map(environment => [environment.environmentId, environment]))
  return {
    isTargeted: (environmentId: string) => targeted.has(environmentId),
    choices(): ReadonlyMap<string, TargetChoice> {
      const choices = new Map<string, TargetChoice>()
      if (catalog) for (const environmentId of targeted.keys()) {
        for (const { targetId, selectionId, name } of catalog.targets(environmentId)) {
          choices.set(targetKey(environmentId, targetId), { selectionId, name })
        }
      }
      return choices
    },
    validateNewGrants(reader: StorageReader, addedTools: readonly EnvironmentTool[]): void {
      if (!catalog) return
      const offered = new Map<string, ReadonlySet<string>>()
      for (const tool of addedTools) {
        const environment = targeted.get(tool.environmentId)
        if (!environment) continue
        let keys = offered.get(tool.environmentId)
        if (!keys) {
          keys = new Set(catalog.targets(tool.environmentId, reader).flatMap(target =>
            target.tools.map(descriptor => environmentToolKey(functionKey(environment, target.targetId, descriptor)))))
          offered.set(tool.environmentId, keys)
        }
        if (!keys.has(environmentToolKey(tool))) throw environmentError('environment-tool-unavailable', 403)
      }
    },
  }
}
export type TargetedToolManagement = ReturnType<typeof createTargetedToolManagement>

interface Grants {
  get(agentId: string): Promise<AgentGrants>
  pendingChanges(agentId: string): Promise<readonly GrantChange[]>
  set(input: GrantUpdate & { readonly agentId: string }, validateNewGrants?: GrantValidator): Promise<GrantChange>
  observe(requestId: string): Promise<GrantChange | undefined>
}
interface ManagementOptions {
  agents(): readonly AgentIdentity[]
  grants(): Grants
  tools(agentId?: string): Promise<readonly EnvironmentTool[]>
  names(tools: readonly EnvironmentTool[]): Promise<ReadonlyMap<string, string>>
  readonly targetedTools?: TargetedToolManagement
  readonly mcpManagement?: boolean
  readonly mcpStdio?: boolean
  preference(agentId: string): Promise<EnvironmentSelection>
  setPreference(agentId: string, input: SelectionUpdate): Promise<EnvironmentSelection>
}
const failure = (status: number, code: string) => Object.assign(new Error(code), { status, code })

export function environmentTargets(tools: readonly EnvironmentTool[], names: ReadonlyMap<string, string>,
  selectionIds?: ReadonlyMap<string, string>): readonly EnvironmentTarget[] {
  const groups = new Map<string, EnvironmentTool[]>()
  for (const tool of tools) {
    const key = targetKey(tool.environmentId, tool.targetId)
    const group = groups.get(key)
    if (group) group.push(tool)
    else groups.set(key, [tool])
  }
  return [...groups].map(([key, entries]) => {
    const { environmentId, targetId } = entries[0]
    const selectionId = selectionIds?.get(key)
    return { environmentId, targetId, ...(selectionId === undefined ? {} : { selectionId }), name: names.get(key) ?? environmentId, tools: entries }
  })
}

export function createEnvironmentManagement(options: ManagementOptions) {
  async function targets(agentId?: string) {
    const tools = await options.tools(agentId)
    const names = new Map(await options.names(tools))
    const targeted = options.targetedTools
    const choices = targeted?.choices()
    const selectionIds = new Map<string, string>()
    for (const [id, choice] of choices ?? []) {
      if (choice.name !== undefined) names.set(id, choice.name)
      selectionIds.set(id, choice.selectionId)
    }
    const visible = tools.filter(tool => !targeted?.isTargeted(tool.environmentId) ||
      choices?.has(targetKey(tool.environmentId, tool.targetId)))
    return environmentTargets(visible, names, selectionIds)
  }
  return {
    async targets(): Promise<readonly EnvironmentInventoryTarget[]> {
      const [catalog, agents] = await Promise.all([targets(), Promise.all(options.agents().map(async agent =>
        ({ agent, grants: (await options.grants().get(agent.id)).grants })))])
      return catalog.map(target => {
        const allowed = new Set(target.tools.map(environmentToolKey))
        return { ...target, agents: agents.flatMap(({ agent, grants }) => {
          const toolIds = grants.filter(grant => allowed.has(environmentToolKey(grant.tool))).map(grant => grant.tool.toolId)
          return toolIds.length ? [{ id: agent.id, ...(agent.name ? { name: agent.name } : {}), toolIds }] : []
        }) }
      })
    },
    async view(agentId: string): Promise<EnvironmentAccessView> {
      const catalog = await targets(agentId)
      const grants = options.grants()
      const [authorization, preference, pendingChanges] = await Promise.all([
        grants.get(agentId), options.preference(agentId), grants.pendingChanges(agentId),
      ])
      return { targets: catalog, authorization, preference, pendingChanges,
        ...(options.mcpManagement ? { mcpManagement: true as const, ...(options.mcpStdio ? { mcpStdio: true as const } : {}) } : {}) }
    },
    async setGrants(agentId: string, input: GrantUpdate): Promise<GrantChange> {
      const manager = options.grants()
      // A repeated mutation observes the original digest even if the provider disappeared meanwhile.
      if (await manager.observe(input.requestId)) return manager.set({ ...input, agentId })
      const tools = await options.tools(agentId)
      const current = await manager.get(agentId)
      if (current.revision !== input.expectedRevision) throw failure(409, 'environment-grant-conflict')
      const allowed = new Set([...tools, ...current.grants.map(grant => grant.tool)].map(environmentToolKey))
      if (input.tools.some(tool => !allowed.has(environmentToolKey(tool)))) throw failure(403, 'environment-tool-unavailable')
      return manager.set({ ...input, agentId }, options.targetedTools?.validateNewGrants)
    },
    async observe(agentId: string, requestId: string): Promise<GrantChange> {
      const operation = await options.grants().observe(requestId)
      if (!operation || operation.agentId !== agentId) throw failure(404, 'environment-change-not-found')
      return operation
    },
    setPreference: options.setPreference,
  }
}
export type EnvironmentManagement = ReturnType<typeof createEnvironmentManagement>

const validId = (id: unknown, maxLength: number): id is string =>
  typeof id === 'string' && !!id.trim() && id.length <= maxLength && !id.includes('\0')

function preferenceMap(raw: unknown, validKey: (key: string) => boolean) {
  if (raw === undefined) return undefined
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw failure(400, 'invalid-input')
  const entries = Object.entries(raw)
  if (entries.length > 32 || entries.some(([key, ids]) => !validKey(key) || !Array.isArray(ids) || ids.length > 1024 ||
    new Set(ids).size !== ids.length || ids.some(id => !validId(id, 512)))) throw failure(400, 'invalid-input')
  return Object.fromEntries(entries) as Readonly<Record<string, readonly string[]>>
}

function validTargetKey(key: string) {
  if (key.length > 4096) return false
  try {
    const parts: unknown = JSON.parse(key)
    return Array.isArray(parts) && parts.length === 2 && validId(parts[0], 256) && validId(parts[1], 512) && key === targetKey(parts[0], parts[1])
  } catch { return false }
}

export function selectionUpdate(body: Record<string, unknown>): SelectionUpdate {
  const { expectedVersion, environmentIds } = body
  if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 ||
    !Array.isArray(environmentIds) || environmentIds.length > 32 ||
    environmentIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 256 || id.includes('\0')) ||
    new Set(environmentIds).size !== environmentIds.length) throw failure(400, 'invalid-input')
  const toolIdsByTarget = preferenceMap(body.toolIdsByTarget, validTargetKey)
  return { environmentIds, expectedVersion, ...(toolIdsByTarget === undefined ? {} : { toolIdsByTarget }) }
}

export function preferenceUpdate(body: Record<string, unknown>): SelectionUpdate {
  const selection = selectionUpdate(body)
  const toolIdsByEnvironment = preferenceMap(body.toolIdsByEnvironment, env => env !== 'computer' && validId(env, 256))
  return toolIdsByEnvironment === undefined ? selection : { ...selection, toolIdsByEnvironment }
}

export function grantUpdate(body: Record<string, unknown>): GrantUpdate {
  const { requestId, expectedRevision, tools } = body
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(requestId) ||
    typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
    !Array.isArray(tools)) throw failure(400, 'invalid-input')
  return { requestId, expectedRevision, tools: checkedTools(tools) }
}
