import type { FunctionBindingTarget, FunctionBindings } from '@anybox/execution-environments/bindings'
import type { ToolEnvironmentCatalog } from '@anybox/execution-environments/catalog'
import type { EnvironmentTool } from '@anybox/execution-environments/contracts'
import type { Project, ProjectWorkspace } from '../project/component.js'
import type { PromptSnapshot } from '../prompt/domain.js'
import type { Session } from '../session/domain.js'
import type { RunUnitBindings, UnitAttachment, UnitAttachmentsPort } from '../unit/port.js'

export type { ToolEnvironmentCatalog, ToolEnvironmentCatalogEntry, ToolEnvironmentRegistry, ToolEnvironmentRun, ToolEnvironmentRunContext, ToolEnvironmentRuntimeBinding } from '@anybox/execution-environments/catalog'

export interface ToolEnvironmentAssembly {
  readonly inject: readonly string[]
  readonly trustedConfigurationEnvironmentIds: ReadonlySet<string>
  readonly prepareRun: PrepareRunToolEnvironment
  readonly runTargets: RunToolTargets
  inventoryTargets(units: readonly UnitAttachment[]): ReadonlyMap<string, readonly FunctionBindingTarget[]>
  describe(deps: Readonly<Record<string, unknown>>): { readonly catalog: ToolEnvironmentCatalog; readonly bindings: FunctionBindings }
}

export type RunToolTargets = (units: RunUnitBindings | undefined) => ReadonlyMap<string, string>

export type PrepareRunToolEnvironment = (input: {
  readonly project: Project
  readonly workspaces?: readonly ProjectWorkspace[]
  readonly session: Pick<Session, 'toolEnvironments' | 'toolSelection'>
  readonly modelSupportsTools: boolean
}, attachments: Pick<UnitAttachmentsPort, 'local' | 'binding' | 'get'>) => Promise<{
  readonly units?: RunUnitBindings
  readonly supports?: (tool: EnvironmentTool) => boolean
  readonly prompts?: readonly PromptSnapshot[]
}>
