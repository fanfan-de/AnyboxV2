import { createToolAccessPlanner } from '@anybox/execution-environments/run-policy'
import type { NativeInitialization } from '../run/program.js'
import { getToolById } from '../tool/catalog.js'
import { legacyToolEnvironmentSnapshot } from './history.js'

export { managedModelTools } from '@anybox/execution-environments/run-policy'
export { computerToolTarget } from '@anybox/execution-environments/bindings'
export type { RunEnvironmentAccess } from '@anybox/execution-environments/bindings'

export const environmentManagerKey = 'personal-agent.execution-environments' as const
export const planToolAccess = createToolAccessPlanner<NativeInitialization>(
  initialization => initialization.schemaVersion === 3 ? initialization.toolEnvironments : legacyToolEnvironmentSnapshot(initialization),
  tool => tool.environmentId === 'computer' ? getToolById(tool.toolId)?.dependencies ?? [] : [],
)
