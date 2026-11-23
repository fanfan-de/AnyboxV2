import type { ToolEnvironment } from '@anybox/tool-api'
import { computerToolEnvironmentCatalogEntry, computerToolEnvironmentId, computerToolTarget,
  createComputerToolEnvironment as createComputerProvider } from '@anybox/computer-tools/environment'
import type { FunctionBindingTarget } from '@anybox/execution-environments/bindings'
import type { ToolRegistration } from '@anybox/execution-environments/catalog'
import { computerOperationsServiceKey } from '../computer/operations-port.js'
import type { ComputerOperationsPort } from '../computer/operations-port.js'
import { sessionRunServiceKey } from '../session/port.js'
import type { SessionRunPort } from '../session/port.js'
import { toolEnvironmentPrompt } from '../tool/environment.js'
import { updateToolPlan } from '../tool/plan-domain.js'
import { needsComputer } from '../computer/operations-domain.js'
import { createToolEnvironmentCatalog } from './registry.js'
import type { PrepareRunToolEnvironment, RunToolTargets, ToolEnvironmentRuntimeBinding } from './port.js'
import { localAttachmentId } from '../unit/domain.js'
import type { UnitAttachment } from '../unit/port.js'

export { computerToolEnvironmentCatalogEntry, computerToolEnvironmentDescriptor, computerToolEnvironmentId,
  computerToolEnvironmentVersion, computerToolTarget } from '@anybox/computer-tools/environment'

export const computerRunTargets: RunToolTargets = units =>
  new Map(units ? [[computerToolEnvironmentId, computerToolTarget(units.computer)]] : [])

export function computerInventoryTargets(units: readonly UnitAttachment[]): ReadonlyMap<string, readonly FunctionBindingTarget[]> {
  const targets = units.flatMap(unit =>
    unit.state === 'approved' && unit.unitKind === 'computer' && unit.unitId && unit.scope?.kind === 'computer'
      ? [{ targetId: computerToolTarget({ attachmentId: unit.attachmentId, unitId: unit.unitId, epoch: unit.epoch }),
          ...(unit.scope.tools === 'all' ? {} : { allowedToolIds: unit.scope.tools }) }]
      : [])
  return new Map([[computerToolEnvironmentId, targets]])
}

export function createComputerRunPreparation(
  reportedContracts?: (unit: UnitAttachment) => ReadonlyMap<string, string> | undefined,
): PrepareRunToolEnvironment {
  return async ({ project, session, modelSupportsTools }, attachments) => {
    if (session.toolEnvironments && !session.toolEnvironments.environments.some(environment => environment.environmentId === computerToolEnvironmentId)) return {}
    const attachmentId = project.computerAttachmentId
    const local = attachmentId === localAttachmentId('computer')
    const models = (await attachments.local('models')).binding
    const computer = local ? (await attachments.local('computer')).binding : await attachments.binding(attachmentId)
    const units = Object.freeze({ schemaVersion: 1 as const, models, computer })
    const attachment = await attachments.get(attachmentId)
    const allowed = attachment?.scope?.kind === 'computer' ? attachment.scope.tools : []
    const reported = attachment && reportedContracts?.(attachment)
    const capabilities = attachment?.capabilities
    const remotePlatform = capabilities && typeof capabilities === 'object' && 'platform' in capabilities && typeof capabilities.platform === 'string'
      ? capabilities.platform : 'unknown'
    // The generic command tool requires the platform's default shell instructions.
    const needsShellPrompt = modelSupportsTools && session.toolSelection.tools.some(tool => tool.toolId === 'codex.exec_command')
    return {
      units,
      supports: tool => tool.environmentId !== computerToolEnvironmentId ||
        (allowed === 'all' || allowed.includes(tool.toolId)) && (!reported || reported.get(tool.toolId) === tool.version),
      ...(needsShellPrompt ? { prompts: [toolEnvironmentPrompt(local ? process.platform : remotePlatform, project.path)] } : {}),
    }
  }
}

export const computerToolEnvironmentProvider = {
  inject: [computerOperationsServiceKey, sessionRunServiceKey],
  bind: (deps: Readonly<Record<string, unknown>>) => createComputerToolEnvironment({
    records: deps[sessionRunServiceKey] as SessionRunPort, operations: deps[computerOperationsServiceKey] as ComputerOperationsPort,
  }),
}

export const computerToolRegistration: ToolRegistration = {
  kind: 'static', catalog: computerToolEnvironmentCatalogEntry, contextualTarget: true, trustedConfiguration: true,
  runtime: computerToolEnvironmentProvider,
}

/** Assemble a Runtime with only the Computer provider. */
export function createComputerToolEnvironmentBinding(): ToolEnvironmentRuntimeBinding {
  const catalog = createToolEnvironmentCatalog([computerToolEnvironmentCatalogEntry])
  return {
    inject: computerToolEnvironmentProvider.inject,
    bind: deps => catalog.bind([computerToolEnvironmentProvider.bind(deps)]),
  }
}

/** Execution is constructed only after both dependencies are bound to the current Nya generation. */
export function createComputerToolEnvironment(dependencies: { readonly records: SessionRunPort; readonly operations: ComputerOperationsPort }): ToolEnvironment {
  if (!dependencies?.records || !dependencies.operations) throw new TypeError('Computer tool environment execution dependencies are required')
  const { records, operations } = dependencies
  return createComputerProvider({
    async openRunScope(context) {
      const run = await records.getRun(context.scopeId)
      if (!run) return undefined
      return operations.openRun({ runId: context.scopeId, runOwnerEpoch: context.ownerEpoch,
        imageInput: run.modelSnapshot?.schemaVersion === 3 && run.modelSnapshot.capabilities.imageInput === true,
        ...(run.units ? { unit: run.units.computer } : {}) })
    },
    async getAcceptedOperation(scopeId, operationId) {
      const request = (await records.getRunOperation(scopeId, operationId))?.start.tool
      if (!request) return undefined
      return needsComputer(request) ? { request } : {
        request, historicalResult: () => updateToolPlan(request.name, request.arguments),
      }
    },
    hasRunResources: scopeId => operations.hasRunResources(scopeId),
  })
}
