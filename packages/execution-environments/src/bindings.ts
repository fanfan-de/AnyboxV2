import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { ToolDescriptor, ToolEnvironmentDescriptor } from '@anybox/tool-api'
import type { StorageReader } from '@anybox/storage-sqlite/port'
import type { TargetedToolEnvironmentTarget, ToolEnvironmentCatalog } from './catalog-port.js'
import type { ToolEnvironmentSelection, ToolEnvironmentSnapshotTool } from './snapshot.js'
import { environmentError, environmentToolKey, exactGrantKey, targetKey, validateEnvironmentGrants } from './contracts.js'
import type { AgentGrants, EnvironmentGrant, EnvironmentTool } from './contracts.js'

export { targetKey } from './contracts.js'

export interface FunctionBindingTarget {
  readonly targetId: string
  readonly allowedToolIds?: readonly string[]
}

export type ToolPreferences = Readonly<Record<string, readonly string[]>>
export type ToolPreferencesByTarget = Readonly<Record<string, readonly string[]>>
export interface EnvironmentSelection {
  readonly toolIdsByEnvironment?: ToolPreferences
  readonly toolIdsByTarget?: ToolPreferencesByTarget
  readonly environmentIds: readonly string[]
  readonly version: number
}
export interface SelectionInput {
  readonly toolIdsByEnvironment?: ToolPreferences
  readonly toolIdsByTarget?: ToolPreferencesByTarget
  readonly environmentIds: readonly string[]
  readonly expectedVersion: number
}
export interface AdoptionInput extends SelectionInput { readonly expectedGrantRevision: number }
export interface RunEnvironmentAccess {
  readonly agentId: string
  readonly functions: readonly { readonly name: string; readonly grant: EnvironmentGrant }[]
  readonly search?: EnvironmentGrant
}

export function functionKey(environment: ToolEnvironmentDescriptor, targetId: string, tool: ToolDescriptor): EnvironmentTool {
  const digest = createHash('sha256').update(JSON.stringify(tool.definition)).digest('hex')
  return { environmentId: environment.environmentId, targetId, toolId: tool.toolId, version: tool.version + '@' + digest }
}

export function runGrants(access: RunEnvironmentAccess): readonly EnvironmentGrant[] {
  const grants = access.functions.map(route => route.grant)
  if (access.search) grants.push(access.search)
  return grants
}

export function assertRunGrants(current: AgentGrants, access: RunEnvironmentAccess): void {
  const available = new Set(current.grants.map(exactGrantKey))
  if (current.agentId !== access.agentId || !runGrants(access).every(grant => available.has(exactGrantKey(grant)))) {
    throw environmentError('environment-authorization-changed', 409)
  }
}

export function parseRunAccess(json: string): RunEnvironmentAccess {
  const raw = JSON.parse(json) as RunEnvironmentAccess
  if (!raw || typeof raw.agentId !== 'string' || !Array.isArray(raw.functions)) throw new TypeError('invalid Run environment binding')
  const names = new Set<string>()
  for (const route of raw.functions) {
    if (typeof route?.name !== 'string' || !route.name.length || names.has(route.name)) throw new TypeError('invalid Run environment function')
    names.add(route.name)
  }
  validateEnvironmentGrants(runGrants(raw))
  if (raw.search && (raw.search.tool.environmentId !== 'model-search' || names.has('web_search'))) throw new TypeError('invalid Run search binding')
  return raw
}

/** Only exact tool definitions from the application's trusted catalog can become function declarations. */
export function resolveRunAccess(current: AgentGrants,
  functions: readonly { name: string; tool: EnvironmentTool }[], search?: EnvironmentTool): RunEnvironmentAccess {
  const available = new Map(current.grants.map(grant => [environmentToolKey(grant.tool), grant]))
  const routes = functions.flatMap(({ name, tool }) => {
    const grant = available.get(environmentToolKey(tool))
    return grant ? [{ name, grant }] : []
  })
  const hosted = search && available.get(environmentToolKey(search))
  if (hosted && routes.some(item => item.name === 'web_search')) throw environmentError('environment-tool-name-conflict', 409)
  return Object.freeze({ agentId: current.agentId, functions: Object.freeze(routes), ...(hosted ? { search: hosted } : {}) })
}

export function checkedEnvironmentIds(values: unknown, offered: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length > 32 || new Set(values).size !== values.length ||
    values.some(id => typeof id !== 'string' || !offered.includes(id))) throw environmentError('invalid-environment-input', 400)
  return Object.freeze([...values])
}

export function checkedToolPreferences(input: unknown, allowed: ReadonlyMap<string, readonly string[]>): ToolPreferences {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw environmentError('invalid-environment-input', 400)
  return Object.freeze(Object.fromEntries(Object.entries(input).map(([id, tools]) => {
    const offered = allowed.get(id)
    if (!offered || !Array.isArray(tools) || tools.length > offered.length || new Set(tools).size !== tools.length ||
      tools.some(tool => typeof tool !== 'string' || !offered.includes(tool))) throw environmentError('invalid-environment-input', 400)
    return [id, Object.freeze([...tools])]
  })))
}

export function checkedTargetToolPreferences(input: unknown, catalog: ToolEnvironmentCatalog | undefined, reader?: StorageReader,
  previous?: ToolPreferencesByTarget): ToolPreferencesByTarget {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw environmentError('invalid-environment-input', 400)
  const allowed = new Map(catalog?.environments.flatMap(environment => catalog.targets(environment.environmentId, reader).map(target =>
    [targetKey(environment.environmentId, target.selectionId), target.tools.map(tool => tool.toolId)] as const)))
  return Object.freeze(Object.fromEntries(Object.entries(input).map(([key, tools]) => {
    const offered = allowed.get(key), saved = previous && Object.hasOwn(previous, key) ? previous[key] : undefined
    const retained = new Set([...(offered ?? []), ...(saved ?? [])])
    if ((!offered && !saved) || !Array.isArray(tools) || tools.length > retained.size || new Set(tools).size !== tools.length ||
      tools.some(tool => typeof tool !== 'string' || !retained.has(tool))) throw environmentError('invalid-environment-input', 400)
    return [key, Object.freeze([...tools])]
  })))
}

export function validateDeclaredNames(access: RunEnvironmentAccess, tools: readonly { name: string }[]): void {
  if (!isDeepStrictEqual(access.functions.map(item => item.name), tools.map(tool => tool.name))) {
    throw environmentError('environment-authorization-changed', 409)
  }
}

/** Static providers pin a trusted resource identity. The app supplies targets for context-bound providers. */
export function createFunctionBindings(catalog: readonly ToolEnvironmentDescriptor[], generation: string,
  targets: ToolEnvironmentCatalog['targets'] = () => [], contextualEnvironmentIds: readonly string[] = []) {
  const contextual = new Set(contextualEnvironmentIds)
  const staticTarget = (environment: ToolEnvironmentDescriptor) =>
    JSON.stringify([environment.environmentId, environment.version, environment.resourceId ?? generation])
  const targetedTool = (environment: ToolEnvironmentDescriptor, tool: ToolEnvironmentSnapshotTool, current: readonly TargetedToolEnvironmentTarget[]) => {
    const { targetId, ...descriptor } = tool
    if (!targetId || !current.some(target => target.targetId === targetId &&
      target.tools.some(candidate => isDeepStrictEqual(candidate, descriptor)))) throw environmentError('environment-target-unavailable', 409)
    return functionKey(environment, targetId, descriptor)
  }
  return {
    recoverable(environmentId: string): boolean {
      return catalog.find(environment => environment.environmentId === environmentId)?.recovery === 'observe-existing'
    },
    available(contextualTargets?: ReadonlyMap<string, readonly FunctionBindingTarget[]>, reader?: StorageReader): readonly EnvironmentTool[] {
      return catalog.flatMap(environment => {
        const inventory: readonly FunctionBindingTarget[] = contextual.has(environment.environmentId)
          ? contextualTargets?.get(environment.environmentId) ?? []
          : [{ targetId: staticTarget(environment) }]
        return [
          ...targets(environment.environmentId, reader).flatMap(target => target.tools.map(tool => functionKey(environment, target.targetId, tool))),
          ...inventory.flatMap(({ targetId, allowedToolIds }) => environment.tools
            .filter(tool => !allowedToolIds || allowedToolIds.includes(tool.toolId)).map(tool => functionKey(environment, targetId, tool))),
        ]
      })
    },
    routes(snapshot: readonly ToolEnvironmentSelection[], names: readonly string[], contextualTargets?: ReadonlyMap<string, string>, reader?: StorageReader) {
      const byName = new Map<string, EnvironmentTool>()
      for (const selection of snapshot) {
        const selected = selection.tools.filter(tool => names.includes(tool.definition.name))
        if (!selected.length) continue
        const environment = catalog.find(entry => entry.environmentId === selection.environmentId && entry.version === selection.version)
        if (!environment) throw environmentError('environment-target-unavailable', 409)
        const current = selected.some(tool => tool.targetId !== undefined) ? targets(selection.environmentId, reader) : []
        for (const tool of selected) {
          if (tool.targetId !== undefined) {
            byName.set(tool.definition.name, targetedTool(environment, tool, current))
          } else {
            const targetId = contextual.has(environment.environmentId) ? contextualTargets?.get(environment.environmentId) : staticTarget(environment)
            if (!targetId) throw environmentError('environment-target-unavailable', 409)
            byName.set(tool.definition.name, functionKey(environment, targetId, tool))
          }
        }
      }
      return names.map(name => {
        const tool = byName.get(name)
        if (!tool) throw environmentError('environment-function-unavailable', 409)
        return { name, tool }
      })
    },
    assertCurrentTargetedAccess(snapshot: readonly ToolEnvironmentSelection[], access: RunEnvironmentAccess, reader?: StorageReader): void {
      const grants = new Map(access.functions.map(route => [route.name, route.grant.tool] as const))
      for (const selection of snapshot) {
        const selected = selection.tools.filter(tool => tool.targetId !== undefined && grants.has(tool.definition.name))
        if (!selected.length) continue
        const environment = catalog.find(entry => entry.environmentId === selection.environmentId && entry.version === selection.version)
        const current = targets(selection.environmentId, reader)
        for (const tool of selected) {
          if (!environment || environmentToolKey(grants.get(tool.definition.name)!) !== environmentToolKey(targetedTool(environment, tool, current))) {
            throw environmentError('environment-authorization-changed', 409)
          }
        }
      }
    },
  }
}
export type FunctionBindings = ReturnType<typeof createFunctionBindings>
