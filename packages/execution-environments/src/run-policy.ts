import { isDeepStrictEqual } from 'node:util'
import type { ToolDefinition } from '@anybox/tool-api'
import type { EnvironmentWork, ExecutionEnvironmentManager } from './index.js'
import { environmentError } from './contracts.js'
import type { AgentGrants, EnvironmentTool } from './contracts.js'
import { resolveRunAccess, runGrants, validateDeclaredNames } from './bindings.js'
import type { ComputerBinding, FunctionBindings, RunEnvironmentAccess } from './bindings.js'
import type { ToolEnvironmentSnapshot } from './snapshot.js'

interface DeclaredTools {
  readonly tools: readonly ToolDefinition[]
}

/** The app decodes its own history and supplies any prerequisites of its tool contracts. */
export function createToolAccessPlanner<I extends DeclaredTools>(snapshotFor: (initialization: I) => ToolEnvironmentSnapshot,
  prerequisites: (tool: EnvironmentTool) => readonly string[]) {
  return (bindings: FunctionBindings, grants: AgentGrants, initialization: I, computer: ComputerBinding | undefined,
    search: EnvironmentTool | undefined, fixed: boolean, supports: (tool: EnvironmentTool) => boolean = () => true) => {
    const snapshot = snapshotFor(initialization)
    const definitions = new Map(snapshot.environments.flatMap(environment => environment.tools.map(tool => [tool.definition.name, tool.definition] as const)))
    const names = initialization.tools.map(tool => tool.name)
    if (initialization.tools.some(tool => !isDeepStrictEqual(tool, definitions.get(tool.name)))) throw environmentError('environment-authorization-changed', 409)
    const routes = bindings.routes(snapshot.environments, names, computer).filter(route => supports(route.tool))
    const resolved = resolveRunAccess(grants, routes, search)
    const functions = resolved.functions.filter(({ grant }) => prerequisites(grant.tool).every(required =>
      resolved.functions.some(({ grant: candidate }) => candidate.tool.toolId === required &&
        candidate.tool.environmentId === grant.tool.environmentId && candidate.tool.targetId === grant.tool.targetId)))
    const selected = new Set(functions.map(route => route.name))
    const tools = initialization.tools.filter(tool => selected.has(tool.name))
    if (fixed && tools.length !== names.length) throw environmentError('environment-authorization-changed', 409)
    return { access: { ...resolved, functions }, initialization: tools.length === names.length ? initialization : Object.freeze({ ...initialization, tools }) }
  }
}

/** Models consumes the frozen declarations structurally. Provider-specific encoding stays in the protocol driver. */
export function managedModelTools(manager: ExecutionEnvironmentManager, runId: string, access: RunEnvironmentAccess,
  initialization: DeclaredTools) {
  validateDeclaredNames(access, initialization.tools)
  const grants = runGrants(access)
  return {
    functions: initialization.tools,
    bindingId: JSON.stringify(grants),
    ...(access.search ? { hostedSearchTarget: access.search.tool.targetId } : {}),
    runSend<T>(exchangeId: string, start: (signal: AbortSignal) => EnvironmentWork<T>, signal: AbortSignal) {
      return manager.runModel(access.agentId, grants, JSON.stringify([runId, 'model', exchangeId]), start, signal)
    },
  }
}
