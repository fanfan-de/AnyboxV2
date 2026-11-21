import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { ToolDescriptor, ToolEnvironmentDescriptor } from '@anybox/tool-api'
import { environmentError, environmentToolKey, exactGrantKey, validateEnvironmentGrants } from './contracts.js'
import type { AgentGrants, EnvironmentGrant, EnvironmentTool } from './contracts.js'

export interface ComputerBinding {
  readonly attachmentId: string
  readonly unitId: string
  readonly allowedToolIds?: readonly string[]
  readonly epoch: number
}

export type ToolPreferences = Readonly<Record<string, readonly string[]>>
export interface EnvironmentSelection { readonly toolIdsByEnvironment?: ToolPreferences; readonly environmentIds: readonly string[]; readonly version: number }
export interface SelectionInput { readonly toolIdsByEnvironment?: ToolPreferences; readonly environmentIds: readonly string[]; readonly expectedVersion: number }
export interface AdoptionInput extends SelectionInput { readonly expectedGrantRevision: number }
export interface RunEnvironmentAccess {
  readonly agentId: string
  readonly functions: readonly { readonly name: string; readonly grant: EnvironmentGrant }[]
  readonly search?: EnvironmentGrant
}

export function computerToolTarget(binding: ComputerBinding, environmentVersion: string): string {
  return JSON.stringify([binding.attachmentId, binding.unitId, binding.epoch, environmentVersion])
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

// Legacy Runs have no grant generations. Only their original Computer and grants imported at cutover can prove their authority.
export function canBindLegacyComputerAccess(access: RunEnvironmentAccess, originalTargetProven: boolean): boolean {
  return !access.search && (access.functions.length === 0 || originalTargetProven && access.functions.every(({grant}) =>
    grant.tool.environmentId === 'computer' && grant.generation === 1 && grant.source === 'trusted-configuration'))
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

export function checkedToolPreferences(input: unknown, catalog: readonly ToolEnvironmentDescriptor[]): ToolPreferences {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw environmentError('invalid-environment-input', 400)
  const allowed = new Map(catalog.filter(e => e.environmentId !== 'computer').map(e => [e.environmentId, e.tools.map(t => t.toolId)]))
  allowed.set('model-search', ['web_search'])
  return Object.freeze(Object.fromEntries(Object.entries(input).map(([id, tools]) => {
    const offered = allowed.get(id)
    if (!offered || !Array.isArray(tools) || tools.length > offered.length || new Set(tools).size !== tools.length ||
      tools.some(tool => typeof tool !== 'string' || !offered.includes(tool))) throw environmentError('invalid-environment-input', 400)
    return [id, Object.freeze([...tools])]
  })))
}

export function validateDeclaredNames(access: RunEnvironmentAccess, tools: readonly { name: string }[]): void {
  if (!isDeepStrictEqual(access.functions.map(item => item.name), tools.map(tool => tool.name))) {
    throw environmentError('environment-authorization-changed', 409)
  }
}

/** Each attached Computer is a distinct environment instance. Other optional providers pin a trusted resource identity. */
export function createFunctionBindings(catalog: readonly ToolEnvironmentDescriptor[], generation: string) {
  const target = (environment: ToolEnvironmentDescriptor, computer?: ComputerBinding) => {
    if (environment.environmentId === 'computer') {
      if (!computer) throw environmentError('environment-target-unavailable', 409)
      return computerToolTarget(computer, environment.version)
    }
    return JSON.stringify([environment.environmentId, environment.version, environment.resourceId ?? generation])
  }
  return {
    recoverable(environmentId: string): boolean {
      return catalog.find(environment => environment.environmentId === environmentId)?.recovery === 'observe-existing'
    },
    available(computers: readonly ComputerBinding[]): readonly EnvironmentTool[] {
      return catalog.flatMap(environment => (environment.environmentId === 'computer' ? computers : [undefined])
        .flatMap(binding => environment.tools.filter(tool => !binding?.allowedToolIds || binding.allowedToolIds.includes(tool.toolId)).map(tool => functionKey(environment, target(environment, binding), tool))))
    },
    routes(snapshot: readonly ToolEnvironmentDescriptor[], names: readonly string[], computer?: ComputerBinding) {
      const byName = new Map<string, EnvironmentTool>()
      for (const selection of snapshot) {
        const environment = catalog.find(entry => entry.environmentId === selection.environmentId && entry.version === selection.version)
        if (!environment) throw environmentError('environment-target-unavailable', 409)
        for (const tool of selection.tools) {
          if (!names.includes(tool.definition.name)) continue
          byName.set(tool.definition.name, functionKey(environment, target(environment, computer), tool))
        }
      }
      return names.map(name => {
        const tool = byName.get(name)
        if (!tool) throw environmentError('environment-function-unavailable', 409)
        return { name, tool }
      })
    },
  }
}
export type FunctionBindings = ReturnType<typeof createFunctionBindings>
