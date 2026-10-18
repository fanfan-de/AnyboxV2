import { createProjectFilesComponent } from './project-files/component.js'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { Context, FiberState } from '@nya/core'
import type { Component, Fiber } from '@nya/core'
import { modelsServiceKey, modelsSettingsServiceKey, modelsError } from '@anybox/models'
import type { ModelsService, ModelsSettingsService } from '@anybox/models'
import type { RuntimeInputs } from './contracts.js'
import { validateAgents } from './agent/domain.js'
import type { AgentDefinition } from './agent/domain.js'
import { agentPromptServiceKey, createAgentPromptComponent } from './agent/prompt-binding-component.js'
import type { AgentPromptPort } from './agent/prompt-binding-component.js'
import { createRunComponent, runServiceKey } from './run/component.js'
import type { RunPort } from './run/component.js'
import { createRunRuntimeComponent } from './run/runtime-component.js'
import { protocolAgentServiceKey } from './run/program.js'
import { createProtocolAgentsComponent, createProtocolAgentBindingComponent, supportedProtocolIds } from './protocol-agents/registry.js'
import { createSessionComponent } from './session/component.js'
import { sessionServiceKey } from './session/port.js'
import type { SessionPort } from './session/port.js'
import { createPromptComponent, promptServiceKey } from './prompt/component.js'
import type { PromptPort } from './prompt/component.js'
import { createProjectComponent, projectServiceKey } from './project/component.js'
import type { ProjectPort } from './project/component.js'
import { createLocalComputerWorkerComponent } from './computer/worker-client.js'
import { createWorkerRouterComponent } from './computer/worker-router.js'
import { computerWorkerServiceKey, localComputerWorkerServiceKey } from './computer/worker-port.js'
import type { ComputerWorkerPort, ComputerWorkerOptions } from './computer/worker-port.js'
import { projectUnavailableError } from './project/component.js'
import { createComputersComponent } from './computer/component.js'
import { createWorkspacesComponent } from './workspace/component.js'
import { createComputerOperationsComponent } from './computer/operations-component.js'
import { listTools } from './tool/catalog.js'
import { createUnitAttachmentsComponent } from './unit/component.js'
import { createUnitTransportComponent } from './unit/transport-component.js'
import { unitAttachmentsServiceKey } from './unit/port.js'
import type { AttachCodeInput, UnitAttachment, UnitAttachmentsPort } from './unit/port.js'
import { localComputerUnitId, localModelsUnitId } from './unit/domain.js'

/** Which Computer unit this composition serves: its own worker over loopback, or one remote attachment through unit dial-out. */
export type ComputerUnitSelection = { readonly kind: 'local'; readonly claimTimeoutMs?: number; readonly replyTimeoutMs?: number } | {
  /** No local worker; projects bind to remote attachments, this one by default. */
  readonly kind: 'remote'; readonly attachmentId: string
  /** How long admission waits for a unit to claim a request before reporting it unavailable; transport defaults apply when omitted. */
  readonly claimTimeoutMs?: number; readonly replyTimeoutMs?: number
}

/** The root must provide Models, local storage and image assets before the harness server core starts. */
export interface HarnessServerCoreOptions extends Partial<RuntimeInputs> {
  readonly agents: readonly AgentDefinition[]
  /** Stable private directory shared with the independent worker, never a Session path. */
  readonly localWorkerDirectory?: string
  /** Optional package role adapter; standalone assembly retains its direct worker entry. */
  readonly localWorkerLaunch?: ComputerWorkerOptions['launch']
  /** Defaults to the local worker. Changing the form requires reassembling the harness server. */
  readonly computerUnit?: ComputerUnitSelection
  /** Host-supplied default for its directory picker; omission disables browsing for embedded callers. */
  readonly projectDirectoryHome?: string
  readonly initialProjects?: readonly string[]
  /** Optional one-time import of the previous Prompt JSON store. The source is left untouched. */
  readonly legacyPromptStorePath?: string
  /** Host-provided authorization for changing an Agent's prompt bindings. */
  readonly canManageAgent?: (actorId: string, agentId: string) => boolean
}

export interface HarnessServerApi extends RunPort, SessionPort, Omit<ProjectPort, 'requireAvailable' | 'getIn'>,
  Omit<PromptPort, 'getPublishedVersion'>,
  Omit<AgentPromptPort, 'resolveRunPrompts' | 'resolveInitialPrompts' | 'resolveTaskTemplate'> {
  listAgents(): readonly Readonly<{ id: string }>[]
  listTools(): ReturnType<typeof listTools>
  listUnitAttachments(): Promise<readonly UnitAttachment[]>
  createUnitAttachCode(input: AttachCodeInput): Promise<{ readonly attachment: UnitAttachment; readonly code: string }>
  revokeUnitAttachment(attachmentId: string): Promise<UnitAttachment>
}

function requireActive(fiber: Fiber): void {
  if (fiber.state === FiberState.ACTIVE) return
  if (fiber.state === FiberState.FAILED) throw fiber.error
  const missing = fiber.inspect().dependencies.filter(item => item.status === 'blocked').map(item => item.serviceName)
  throw new Error(missing.length
    ? `component ${fiber.name} is waiting for ${missing.join(', ')}`
    : `component ${fiber.name} is ${fiber.state}`)
}

export interface HarnessServerLifetime {
  isClosing(): boolean
  readonly signal?: AbortSignal
}

function runtimeInputs(options: HarnessServerCoreOptions): RuntimeInputs {
  return { now: options.now ?? (() => new Date().toISOString()), newId: options.newId ?? randomUUID }
}

/** Prompt capabilities do not require Models, Session or execution resources. */
export function createHarnessServerPromptComponents(options: HarnessServerCoreOptions): readonly Component<any, any>[] {
  const agents = validateAgents(options.agents), inputs = runtimeInputs(options)
  return [createPromptComponent(inputs, options.legacyPromptStorePath),
    createAgentPromptComponent(inputs, agents, options.canManageAgent ?? (() => true), options.legacyPromptStorePath)]
}

/** Describes the Agent component closure; callers keep every installation on their root. */
export function createHarnessServerAgentComponents(context: Context, options: HarnessServerCoreOptions, lifetime: HarnessServerLifetime): readonly Component<any, any>[] {
  const agents = validateAgents(options.agents), inputs = runtimeInputs(options)
  const configuredProtocols = context.get<ModelsSettingsService>(modelsSettingsServiceKey)?.protocols().map(value => value.id) ?? []
  const protocolComponents = context.get(protocolAgentServiceKey) ? [] : [createProtocolAgentsComponent(),
    ...supportedProtocolIds.filter(id => configuredProtocols.includes(id)).map(createProtocolAgentBindingComponent)]
  const computerUnit = options.computerUnit ?? { kind: 'local' }
  if (computerUnit.kind === 'remote' && (!computerUnit.attachmentId || computerUnit.attachmentId.startsWith('local:'))) throw new TypeError('remote Computer unit requires a remote attachment id')
  // The router serves `computer.worker` and `computer.instance-provider` in both forms; only the local form has a loopback worker behind it.
  const localWorkerComponents = computerUnit.kind === 'local' && !context.get(localComputerWorkerServiceKey)
    ? [createLocalComputerWorkerComponent({ directory: options.localWorkerDirectory ?? resolve('data/computer-worker'), ...(options.localWorkerLaunch ? { launch: options.localWorkerLaunch } : {}) })] : []
  const workerComponents = [...localWorkerComponents, createWorkerRouterComponent({ local: computerUnit.kind === 'local', claimTimeoutMs: computerUnit.claimTimeoutMs, replyTimeoutMs: computerUnit.replyTimeoutMs })]
  // The in-process Models component and, in the local form, this Authority's own worker attach as local units at startup.
  const attachmentComponents = [createUnitAttachmentsComponent(inputs, { localUnits: [{ unitKind: 'models', unitId: localModelsUnitId },
    ...(computerUnit.kind === 'local' ? [{ unitKind: 'computer' as const, unitId: localComputerUnitId }] : [])] }), createUnitTransportComponent(inputs)]
  // Remote-bound projects are checked through the current Computer contract; Projects stays a dependency of worker-root tools, so it resolves it per call.
  const computerQuery = (attachmentId: string, query: Parameters<ComputerWorkerPort['query']>[0]['query']) => {
    const worker = context.get<ComputerWorkerPort>(computerWorkerServiceKey)
    if (!worker) return Promise.reject(projectUnavailableError())
    return worker.query({ attachmentId, query })
  }
  return [...protocolComponents, ...attachmentComponents, ...workerComponents,
    createProjectComponent(inputs, { directoryHome: options.projectDirectoryHome, initialProjects: options.initialProjects, computerQuery,
      ...(computerUnit.kind === 'remote' ? { defaultComputerAttachmentId: computerUnit.attachmentId } : {}) }),
    createProjectFilesComponent(inputs),
    createComputersComponent(inputs), createWorkspacesComponent(inputs), createComputerOperationsComponent(inputs),
    createSessionComponent(inputs, agents), createRunRuntimeComponent(inputs),
    createRunComponent(inputs, agents, lifetime.isClosing, lifetime.signal)]
}

/** The facade resolves the current services and never owns the application root. */
export function createHarnessServerApi(context: Context, options: HarnessServerCoreOptions, lifetime: HarnessServerLifetime): HarnessServerApi {
  if (!Context.is(context) || context.root !== context) throw new TypeError('application root Context required')
  const agents = validateAgents(options.agents)
  const validateSelectedModel = (modelId: string, requireAvailable = false): string => {
    if (lifetime.isClosing()) throw new Error('harness server is closing')
    const models = context.get<ModelsService>(modelsServiceKey)
    if (!models) throw modelsError('unavailable')
    const model = models.get(modelId)
    if (!model) throw modelsError('not-found')
    if (requireAvailable && !model.available) throw modelsError('unavailable')
    return model.parameters.protocolId
  }
  const current = (): RunPort => {
    if (lifetime.isClosing()) throw new Error('harness server is closing')
    const service = context.get<RunPort>(runServiceKey)
    if (!service) throw new Error('run service is unavailable')
    return service
  }
  const currentSessions = (): SessionPort => {
    if (lifetime.isClosing()) throw new Error('harness server is closing')
    const service = context.get<SessionPort>(sessionServiceKey)
    if (!service) throw new Error('session service is unavailable')
    return service
  }
  const currentProjects = (): ProjectPort => {
    if (lifetime.isClosing()) throw new Error('harness server is closing')
    const service = context.get<ProjectPort>(projectServiceKey)
    if (!service) throw new Error('project service is unavailable')
    return service
  }
  const currentPrompts = (): PromptPort => {
    if (lifetime.isClosing()) throw new Error('harness server is closing')
    const service = context.get<PromptPort>(promptServiceKey)
    if (!service) throw new Error('prompt service is unavailable')
    return service
  }
  const currentAgentPrompts = (): AgentPromptPort => {
    if (lifetime.isClosing()) throw new Error('harness server is closing')
    const service = context.get<AgentPromptPort>(agentPromptServiceKey)
    if (!service) throw new Error('agent prompt service is unavailable')
    return service
  }
  const currentUnits = (): UnitAttachmentsPort => {
    if (lifetime.isClosing()) throw new Error('harness server is closing')
    const service = context.get<UnitAttachmentsPort>(unitAttachmentsServiceKey)
    if (!service) throw new Error('unit attachment service is unavailable')
    return service
  }
  return {
    listAgents: () => {
      if (lifetime.isClosing()) throw new Error('harness server is closing')
      return Object.freeze(agents.map(agent => Object.freeze({ id: agent.id })))
    },
    listTools: () => {
      if (lifetime.isClosing()) throw new Error('harness server is closing')
      return listTools()
    },
    listUnitAttachments: () => currentUnits().list(),
    createUnitAttachCode: input => currentUnits().createAttachCode(input),
    revokeUnitAttachment: attachmentId => currentUnits().revoke(attachmentId),
    getAgentTools: agentId => currentSessions().getAgentTools(agentId),
    setAgentTools: (agentId, input) => currentSessions().setAgentTools(agentId, input),
    openProject: (path, openOptions) => currentProjects().openProject(path, openOptions),
    get localDirectorySelectionSupported() { return currentProjects().localDirectorySelectionSupported },
    get directoryBrowsingSupported() { return currentProjects().directoryBrowsingSupported },
    get directoryCreationSupported() { return currentProjects().directoryCreationSupported },
    openDirectoryBrowse: (...args) => currentProjects().openDirectoryBrowse(...args),
    readDirectoryPage: (...args) => currentProjects().readDirectoryPage(...args),
    createDirectory: (...args) => currentProjects().createDirectory(...args),
    closeDirectoryBrowse: (...args) => currentProjects().closeDirectoryBrowse(...args),
    onDirectoryBrowseRetired: listener => currentProjects().onDirectoryBrowseRetired(listener),
    listProjects: () => currentProjects().listProjects(),
    getProject: id => currentProjects().getProject(id),
    getSessionDefaults: agentId => currentSessions().getSessionDefaults(agentId),
    setSessionDefaults: (agentId, modelId, expectedRevision) => {
      if (modelId !== null) validateSelectedModel(modelId, true)
      return currentSessions().setSessionDefaults(agentId, modelId, expectedRevision)
    },
    createSession: (projectId, agentId, modelId) => {
      if (modelId !== undefined) validateSelectedModel(modelId)
      return currentSessions().createSession(projectId, agentId, modelId)
    },
    selectSessionModel: (sessionId, modelId) => {
      const protocolId = validateSelectedModel(modelId)
      return currentSessions().selectSessionModel(sessionId, modelId, protocolId)
    },
    getSession: id => currentSessions().getSession(id),
    openProjectFileTree: (...args) => currentSessions().openProjectFileTree(...args),
    readProjectFileTreePage: (...args) => currentSessions().readProjectFileTreePage(...args),
    closeProjectFileTree: (...args) => currentSessions().closeProjectFileTree(...args),
    onProjectFileTreeRetired: listener => currentSessions().onProjectFileTreeRetired(listener),
    searchProjectFiles: (...args) => currentSessions().searchProjectFiles(...args),
    previewProjectFile: (...args) => currentSessions().previewProjectFile(...args),
    prepareProjectFiles: (...args) => currentSessions().prepareProjectFiles(...args),
    getFileSnapshot: (...args) => currentSessions().getFileSnapshot(...args),
    renewProjectFiles: (...args) => currentSessions().renewProjectFiles(...args),
    importImage: (sessionId, bytes, signal) => currentSessions().importImage(sessionId, bytes, signal),
    getImage: (sessionId, assetId, signal) => currentSessions().getImage(sessionId, assetId, signal),
    renewImages: (sessionId, assetIds) => currentSessions().renewImages(sessionId, assetIds),
    getNode: (sessionId, id) => currentSessions().getNode(sessionId, id),
    getNodePath: (sessionId, id) => currentSessions().getNodePath(sessionId, id),
    listNodes: (sessionId, parentId, query) => currentSessions().listNodes(sessionId, parentId, query),
    archiveSession: id => currentSessions().archiveSession(id),
    restoreSession: id => currentSessions().restoreSession(id),
    listArchivedSessions: () => currentSessions().listArchivedSessions(),
    listSessions: id => currentSessions().listSessions(id),
    startRun: input => current().startRun(input),
    getRun: id => currentSessions().getRun(id),
    getRunByKey: (id, key) => currentSessions().getRunByKey(id, key),
    listRuns: (id, query) => currentSessions().listRuns(id, query),
    getRunEvents: (id, afterSeq) => currentSessions().getRunEvents(id, afterSeq),
    getRunRecords: id => currentSessions().getRunRecords(id),
    getView: id => current().getView(id),
    cancelRun: id => current().cancelRun(id),
    waitRun: (id, signal) => current().waitRun(id, signal),
    createPrompt: (actorId, input) => currentPrompts().createPrompt(actorId, input),
    editPrompt: (actorId, id, revision, patch) => currentPrompts().editPrompt(actorId, id, revision, patch),
    publishPrompt: (actorId, id) => currentPrompts().publishPrompt(actorId, id),
    getPrompt: (actorId, id) => currentPrompts().getPrompt(actorId, id),
    listPrompts: actorId => currentPrompts().listPrompts(actorId),
    getPromptVersions: (actorId, id) => currentPrompts().getPromptVersions(actorId, id),
    bindPrompt: (actorId, agentId, versionId) => currentAgentPrompts().bindPrompt(actorId, agentId, versionId),
    getAgentPrompts: (actorId, agentId) => currentAgentPrompts().getAgentPrompts(actorId, agentId),
  }
}

export interface HarnessServerCoreInstallation {
  readonly api: HarnessServerApi
  /** Removes this installation only; application shutdown belongs to the host. */
  close(): Promise<void>
}

/** Installs only harness server core components. Closing this handle leaves host-owned dependencies running. */
export async function installHarnessServerCore(context: Context, options: HarnessServerCoreOptions): Promise<HarnessServerCoreInstallation> {
  if (!Context.is(context) || context.root !== context) throw new TypeError('application root Context required')
  const fibers: Fiber[] = [], abort = new AbortController()
  let closing = false, shutdown: Promise<void> | undefined
  const close = () => {
    if (shutdown) return shutdown
    closing = true; abort.abort()
    shutdown = Promise.allSettled([...fibers].reverse().map(fiber => fiber.dispose())).then(results => {
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'harness server core cleanup failed')
    })
    return shutdown
  }
  const lifetime: HarnessServerLifetime = { isClosing: () => closing, signal: abort.signal }
  try {
    // Prompt providers are available before their Agent consumers start.
    for (const component of [...createHarnessServerPromptComponents(options), ...createHarnessServerAgentComponents(context, options, lifetime)]) {
      const fiber = context.installComponent(component)
      fibers.push(fiber)
      await fiber
      requireActive(fiber)
    }
    return { api: createHarnessServerApi(context, options, lifetime), close }
  } catch (error) {
    try { await close() } catch (cleanup) { throw new AggregateError([error, cleanup], 'harness server core startup and cleanup failed') }
    throw error
  }
}
