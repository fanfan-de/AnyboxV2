import type { AgentGrants, EnvironmentTool, GrantChange } from './contracts.js'
import { checkedTools, environmentToolKey } from './contracts.js'

import type { EnvironmentSelection, SelectionInput } from './bindings.js'
export type { EnvironmentSelection } from './bindings.js'
export type SelectionUpdate = SelectionInput
export interface EnvironmentTarget {
  readonly environmentId: string
  readonly targetId: string
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
}
export interface GrantUpdate {
  readonly requestId: string
  readonly expectedRevision: number
  readonly tools: readonly EnvironmentTool[]
}
interface Grants {
  get(agentId: string): Promise<AgentGrants>
  pendingChanges(agentId: string): Promise<readonly GrantChange[]>
  set(input: GrantUpdate & { readonly agentId: string }): Promise<GrantChange>
  observe(requestId: string): Promise<GrantChange | undefined>
}
interface ManagementOptions {
  agents(): readonly AgentIdentity[]
  grants(): Grants
  tools(agentId?: string): Promise<readonly EnvironmentTool[]>
  names(tools: readonly EnvironmentTool[]): Promise<ReadonlyMap<string, string>>
  preference(agentId: string): Promise<EnvironmentSelection>
  setPreference(agentId: string, input: SelectionUpdate): Promise<EnvironmentSelection>
}
export const targetKey = (environmentId: string, targetId: string): string => JSON.stringify([environmentId, targetId])
const failure = (status: number, code: string) => Object.assign(new Error(code), { status, code })

export function environmentTargets(tools: readonly EnvironmentTool[], names: ReadonlyMap<string, string>): readonly EnvironmentTarget[] {
  const groups = new Map<string, EnvironmentTool[]>()
  for (const tool of tools) {
    const key = targetKey(tool.environmentId, tool.targetId)
    const group = groups.get(key)
    if (group) group.push(tool)
    else groups.set(key, [tool])
  }
  return [...groups].map(([key, entries]) => {
    const { environmentId, targetId } = entries[0]
    return { environmentId, targetId, name: names.get(key) ?? environmentId, tools: entries }
  })
}

export function createEnvironmentManagement(options: ManagementOptions) {
  async function targets(agentId?: string) {
    const tools = await options.tools(agentId)
    return environmentTargets(tools, await options.names(tools))
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
      return { targets: catalog, authorization, preference, pendingChanges }
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
      return manager.set({ ...input, agentId })
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

export function selectionUpdate(body: Record<string, unknown>): SelectionUpdate {
  const { expectedVersion, environmentIds } = body
  if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 ||
    !Array.isArray(environmentIds) || environmentIds.length > 32 ||
    environmentIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 256 || id.includes('\0')) ||
    new Set(environmentIds).size !== environmentIds.length) throw failure(400, 'invalid-input')
  return { environmentIds, expectedVersion }
}

export function preferenceUpdate(body: Record<string, unknown>): SelectionUpdate {
  const selection = selectionUpdate(body), raw = body.toolIdsByEnvironment
  if (raw === undefined) return selection
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw failure(400, 'invalid-input')
  const entries = Object.entries(raw)
  if (entries.length > 32 || entries.some(([env, ids]) => !env.trim() || env.length > 256 || env.includes('\0') ||
    env === 'computer' || !Array.isArray(ids) || ids.length > 1024 || new Set(ids).size !== ids.length ||
    ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 512 || id.includes('\0')))) throw failure(400, 'invalid-input')
  return { ...selection, toolIdsByEnvironment: Object.fromEntries(entries) }
}

export function grantUpdate(body: Record<string, unknown>): GrantUpdate {
  const { requestId, expectedRevision, tools } = body
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(requestId) ||
    typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
    !Array.isArray(tools)) throw failure(400, 'invalid-input')
  return { requestId, expectedRevision, tools: checkedTools(tools) }
}
