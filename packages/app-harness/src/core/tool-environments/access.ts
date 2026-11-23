import { createToolAccessPlanner } from '@anybox/execution-environments/run-policy'
import { checkedToolPreferences } from '@anybox/execution-environments/bindings'
import type { ToolEnvironmentDescriptor } from '@anybox/tool-api'
import type { NativeInitialization } from '../run/program.js'
import { getToolById } from '../tool/catalog.js'
import { legacyToolEnvironmentSnapshot } from './history.js'
import { computerToolEnvironmentId } from './computer.js'

export { managedModelTools } from '@anybox/execution-environments/run-policy'
export type { RunEnvironmentAccess } from '@anybox/execution-environments/bindings'

export const environmentManagerKey = 'harness.execution-environments' as const
export const planToolAccess = createToolAccessPlanner<NativeInitialization>(
  initialization => initialization.schemaVersion === 3 ? initialization.toolEnvironments : legacyToolEnvironmentSnapshot(initialization),
  tool => tool.environmentId === computerToolEnvironmentId ? getToolById(tool.toolId)?.dependencies ?? [] : [],
)

export function checkedAgentToolPreferences(input: unknown, catalog: readonly ToolEnvironmentDescriptor[]) {
  const allowed = new Map(catalog.filter(environment => environment.environmentId !== computerToolEnvironmentId)
    .map(environment => [environment.environmentId, environment.tools.map(tool => tool.toolId)]))
  allowed.set('model-search', ['web_search'])
  return checkedToolPreferences(input, allowed)
}
