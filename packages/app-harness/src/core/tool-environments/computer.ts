import type { ToolDescriptor } from '@anybox/tool-api'
import type { ContextualToolEnvironment, ToolEnvironmentSnapshot, ToolEnvironmentSnapshotTool } from '@anybox/execution-environments/catalog'
import { parseToolEnvironmentSnapshot, originalToolDescriptor } from '@anybox/execution-environments/catalog'
import { targetKey, environmentError } from '@anybox/execution-environments/contracts'
import type { ProjectWorkspace } from '../project/component.js'
import type { NativeInitialization } from '../run/program.js'
import { getToolById, legacyToolSelection } from '../tool/catalog.js'
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
import { attachmentBinding, localAttachmentId } from '../unit/domain.js'
import type { RunUnitBinding, RunUnitBindings, UnitAttachment } from '../unit/port.js'

export { computerToolEnvironmentCatalogEntry, computerToolEnvironmentDescriptor, computerToolEnvironmentId,
  computerToolEnvironmentVersion, computerToolTarget } from '@anybox/computer-tools/environment'

export const computerRunTargets: RunToolTargets = units => {
  const targets = new Map<string, string>()
  if (units) targets.set(computerToolEnvironmentId, computerToolTarget(units.computer))
  for (const member of units?.workspaces ?? []) targets.set(targetKey(computerToolEnvironmentId, member.id), computerToolTarget(member.unit))
  return targets
}

/** Bind the model's declarations at Session creation while keeping grants keyed by the original contract. */
export function bindComputerWorkspaces(snapshot: ToolEnvironmentSnapshot, selected: readonly ProjectWorkspace[],
  attachmentFor: (attachmentId: string) => UnitAttachment | undefined): ToolEnvironmentSnapshot {
  if (selected.length < 2) return snapshot
  if (!snapshot.environments.some(entry => entry.environmentId === computerToolEnvironmentId)) throw environmentError('environment-target-unavailable', 409)
  const ordered = orderedWorkspaces(selected)
  return parseToolEnvironmentSnapshot({ schemaVersion: 3, environments: snapshot.environments.map(entry => {
    if (entry.environmentId !== computerToolEnvironmentId) return entry
    const tools = ordered.flatMap((workspace, index) => {
      const attachment = attachmentFor(workspace.computerAttachmentId)
      if (!attachment || attachment.unitKind !== 'computer') throw environmentError('environment-target-unavailable', 409)
      const targetId = computerToolTarget(attachmentBinding(attachment))
      const ceiling = attachment.scope?.kind === 'computer' ? attachment.scope.tools : []
      const candidates = entry.tools.filter(tool => ceiling === 'all' || ceiling.includes(tool.toolId))
      const supported = new Set(candidates.map(tool => tool.toolId))
      const tools = candidates.filter(tool => getToolById(tool.toolId)?.dependencies.every(id => supported.has(id)))
      if (!tools.length) throw environmentError('environment-target-unavailable', 409)
      const prefix = workspace.primary ? 'main__' : 'workspace' + (index + 1) + '__'
      return tools.map(tool => {
        const originalName = tool.definition.name
        const name = prefix + originalName
        return { ...tool, definition: { ...tool.definition, name }, targetId, workspaceBindingId: workspace.id, originalName }
      })
    })
    return { ...entry, tools }
  }) })
}

function orderedWorkspaces(workspaces: readonly ProjectWorkspace[]): ProjectWorkspace[] {
  return [...workspaces].sort((a, b) => Number(b.primary) - Number(a.primary) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function computerOperationBinding(initialization: NativeInitialization, name: string, units: RunUnitBindings | undefined):
  { tool: ToolDescriptor; unit?: RunUnitBinding; workspaceBindingId?: string; workspaceBindingRevision?: number } | undefined {
  const selection = initialization.schemaVersion === 3
    ? initialization.toolEnvironments.environments.find(entry => entry.environmentId === computerToolEnvironmentId)
    : initialization.schemaVersion === 2 ? initialization.toolSelection : legacyToolSelection
  const tool: ToolEnvironmentSnapshotTool | undefined = selection?.tools.find(item => item.definition.name === name)
  if (!tool) return
  if (tool.workspaceBindingId === undefined) {
    if (units?.workspaces) throw environmentError('environment-target-unavailable', 409)
    return { tool, unit: units?.computer }
  }
  const member = units?.workspaces?.find(member => member.id === tool.workspaceBindingId)
  if (!member || tool.targetId !== computerToolTarget(member.unit)) throw environmentError('environment-target-unavailable', 409)
  return { tool: originalToolDescriptor(tool), unit: member.unit, workspaceBindingId: member.id, workspaceBindingRevision: member.revision }
}

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
  return async ({ project, session, modelSupportsTools, workspaces }, attachments) => {
    if (session.toolEnvironments && !session.toolEnvironments.environments.some(environment => environment.environmentId === computerToolEnvironmentId)) return {}
    if (workspaces && workspaces.length > 1) {
      const models = (await attachments.local('models')).binding
      const members = await Promise.all(orderedWorkspaces(workspaces).map(async workspace => {
        const attachment = await attachments.get(workspace.computerAttachmentId)
        if (!attachment || attachment.unitKind !== 'computer' || attachment.scope?.kind !== 'computer') throw environmentError('environment-target-unavailable', 409)
        const unit = attachmentBinding(attachment), target = computerToolTarget(unit)
        return { member: { id: workspace.id, revision: workspace.revision, name: workspace.name, path: workspace.path, unit },
          target, allowed: attachment.scope.tools, reported: reportedContracts?.(attachment), platform: computerPlatform(attachment) }
      }))
      const selection = session.toolEnvironments?.environments.find(environment => environment.environmentId === computerToolEnvironmentId)
      const primary = members[0]!.member
      const units: RunUnitBindings = { schemaVersion: 2, models, computer: primary.unit, workspaces: members.map(row => row.member) }
      return {
        units,
        supports: tool => tool.environmentId !== computerToolEnvironmentId || members.some(member => member.target === tool.targetId &&
          (member.allowed === 'all' || member.allowed.includes(tool.toolId)) && (!member.reported || member.reported.get(tool.toolId) === tool.version)),
        prompts: modelSupportsTools ? members.map(({ member, platform }) => {
          const sample = selection?.tools.find(tool => tool.workspaceBindingId === member.id)
          if (!sample?.originalName || !sample.definition.name.endsWith(sample.originalName)) throw environmentError('environment-target-unavailable', 409)
          const prefix = sample.definition.name.slice(0, -sample.originalName.length)
          return toolEnvironmentPrompt(platform, member.path, { name: member.name, prefix, primary: member.id === primary.id })
        }) : [],
      }
    }
    const attachmentId = project.computerAttachmentId
    const local = attachmentId === localAttachmentId('computer')
    const models = (await attachments.local('models')).binding
    const computer = local ? (await attachments.local('computer')).binding : await attachments.binding(attachmentId)
    const units = Object.freeze({ schemaVersion: 1 as const, models, computer })
    const attachment = await attachments.get(attachmentId)
    const allowed = attachment?.scope?.kind === 'computer' ? attachment.scope.tools : []
    const reported = attachment && reportedContracts?.(attachment)
    const remotePlatform = attachment ? computerPlatform(attachment) : 'unknown'
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

function computerPlatform(attachment: UnitAttachment): string {
  if (attachment.origin === 'local') return process.platform
  const value = attachment.capabilities
  return value && typeof value === 'object' && 'platform' in value && typeof value.platform === 'string' ? value.platform : 'unknown'
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
  const catalog = createToolEnvironmentCatalog([{ ...computerToolEnvironmentCatalogEntry, contextualTarget: true }])
  return {
    inject: computerToolEnvironmentProvider.inject,
    bind: deps => catalog.bind([computerToolEnvironmentProvider.bind(deps)]),
  }
}

/** Execution is constructed only after both dependencies are bound to the current Nya generation. */
export function createComputerToolEnvironment(dependencies: { readonly records: SessionRunPort; readonly operations: ComputerOperationsPort }): ContextualToolEnvironment {
  if (!dependencies?.records || !dependencies.operations) throw new TypeError('Computer tool environment execution dependencies are required')
  const { records, operations } = dependencies
  const forTarget = (targetId?: string) => createComputerProvider({
    async openRunScope(context) {
      const run = await records.getRun(context.scopeId)
      if (!run) return undefined
      if (targetId !== undefined) {
        const member = run.units?.workspaces?.find(item => computerToolTarget(item.unit) === targetId)
        if (!member) return undefined
        return operations.openRun({ runId: context.scopeId, runOwnerEpoch: context.ownerEpoch, workspaceBindingId: member.id,
          unit: member.unit, imageInput: run.modelSnapshot?.schemaVersion === 3 && run.modelSnapshot.capabilities.imageInput === true })
      }
      if (run.units?.workspaces) return undefined
      return operations.openRun({ runId: context.scopeId, runOwnerEpoch: context.ownerEpoch,
        imageInput: run.modelSnapshot?.schemaVersion === 3 && run.modelSnapshot.capabilities.imageInput === true,
        ...(run.units ? { unit: run.units.computer } : {}) })
    },
    async getAcceptedOperation(scopeId, operationId) {
      const request = (await records.getRunOperation(scopeId, operationId))?.start.tool
      if (!request) return undefined
      if (targetId !== undefined) {
        const declaration = (await operations.get(operationId))?.declaration
        if (declaration?.schemaVersion !== 2 || declaration.workspaceScope.parentRunId !== scopeId ||
          computerToolTarget({ attachmentId: declaration.workspaceScope.attachmentId, unitId: declaration.workspaceScope.unitId,
            epoch: declaration.workspaceScope.unitEpoch }) !== targetId) return undefined
        // The worker sees its native process handle. The provider checks the original model-facing arguments.
        return { request: { ...request, name: declaration.request.name } }
      }
      return needsComputer(request) ? { request } : {
        request, historicalResult: () => updateToolPlan(request.name, request.arguments),
      }
    },
    async hasRunResources(scopeId) {
      if (targetId === undefined) return operations.hasRunResources(scopeId)
      const run = await records.getRun(scopeId)
      const member = run?.units?.workspaces?.find(item => computerToolTarget(item.unit) === targetId)
      if (!member) throw environmentError('environment-target-unavailable', 409)
      return operations.hasRunResources(scopeId, member.id)
    },
  })
  return { ...forTarget(),
    openBoundScope: (target, context) => forTarget(target).openScope(context),
    restoreBoundScope: (target, context) => forTarget(target).restoreScope!(context) }
}
