import { createProjectFilesComponent } from './project-files/component.js'
import { randomUUID } from 'node:crypto'
import { Context, FiberState } from '@nya/core'
import type { Fiber } from '@nya/core'
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
import { createBashComponent } from './tool/bash-component.js'
import { createApplyPatchComponent } from './tool/apply-patch-component.js'

/** The application root must provide Models, local storage and image assets before the Harness starts. */
export interface HarnessOptions extends Partial<RuntimeInputs> {
  readonly agents: readonly AgentDefinition[]
  /** Optional one-time import of the previous Prompt JSON store. The source is left untouched. */
  readonly legacyPromptStorePath?: string
  /** Host-provided authorization for changing an Agent's prompt bindings. */
  readonly canManageAgent?: (actorId: string, agentId: string) => boolean
}

export interface Harness extends RunPort, SessionPort, Omit<ProjectPort, 'requireAvailable'>,
  Omit<PromptPort, 'getPublishedVersion'>,
  Omit<AgentPromptPort, 'resolveRunPrompts' | 'resolveInitialPrompts' | 'resolveTaskTemplate'> {
  listAgents(): readonly Readonly<{ id: string }>[]
  close(): Promise<void>
}

function requireActive(fiber: Fiber): void {
  if (fiber.state === FiberState.ACTIVE) return
  if (fiber.state === FiberState.FAILED) throw fiber.error
  const missing = fiber.inspect().dependencies.filter(item => item.status === 'blocked').map(item => item.serviceName)
  throw new Error(missing.length
    ? `component ${fiber.name} is waiting for ${missing.join(', ')}`
    : `component ${fiber.name} is ${fiber.state}`)
}

/** Installs the application services on one root. Each request obtains the current Nya service. */
export async function createHarness(context: Context, options: HarnessOptions): Promise<Harness> {
  if (!Context.is(context) || context.root !== context) throw new TypeError('application root Context required')
  const inputs: RuntimeInputs = {
    now: options.now ?? (() => new Date().toISOString()),
    newId: options.newId ?? randomUUID,
  }
  let closing = false
  let shutdown: Promise<void> | undefined
  const close = () => {
    if (shutdown) return shutdown
    closing = true
    shutdown = context.fiber.dispose()
    return shutdown
  }
  const validateSelectedModel = (modelId: string): string => {
    if (closing) throw new Error('harness is closing')
    const models = context.get<ModelsService>(modelsServiceKey)
    if (!models) throw modelsError('unavailable')
    const model = models.get(modelId)
    if (!model) throw modelsError('not-found')
    return model.parameters.protocolId
  }
  const current = (): RunPort => {
    if (closing) throw new Error('harness is closing')
    const service = context.get<RunPort>(runServiceKey)
    if (!service) throw new Error('run service is unavailable')
    return service
  }
  const currentSessions = (): SessionPort => {
    if (closing) throw new Error('harness is closing')
    const service = context.get<SessionPort>(sessionServiceKey)
    if (!service) throw new Error('session service is unavailable')
    return service
  }
  const currentProjects = (): ProjectPort => {
    if (closing) throw new Error('harness is closing')
    const service = context.get<ProjectPort>(projectServiceKey)
    if (!service) throw new Error('project service is unavailable')
    return service
  }
  const currentPrompts = (): PromptPort => {
    if (closing) throw new Error('harness is closing')
    const service = context.get<PromptPort>(promptServiceKey)
    if (!service) throw new Error('prompt service is unavailable')
    return service
  }
  const currentAgentPrompts = (): AgentPromptPort => {
    if (closing) throw new Error('harness is closing')
    const service = context.get<AgentPromptPort>(agentPromptServiceKey)
    if (!service) throw new Error('agent prompt service is unavailable')
    return service
  }
  let agents: readonly AgentDefinition[]
  try {
    agents = validateAgents(options.agents)
    const configuredProtocols = context.get<ModelsSettingsService>(modelsSettingsServiceKey)?.protocols().map(value => value.id) ?? []
    const protocolComponents = context.get(protocolAgentServiceKey) ? [] : [createProtocolAgentsComponent(),
      ...supportedProtocolIds.filter(id => configuredProtocols.includes(id)).map(createProtocolAgentBindingComponent)]
    for (const component of [
      ...protocolComponents,
      createProjectComponent(inputs),
      createProjectFilesComponent(inputs),
      createBashComponent(),
      createApplyPatchComponent(),
      createSessionComponent(inputs, agents),
      createPromptComponent(inputs, options.legacyPromptStorePath),
      createAgentPromptComponent(inputs, agents, options.canManageAgent ?? (() => true), options.legacyPromptStorePath),
      createRunRuntimeComponent(inputs),
      createRunComponent(inputs, agents, () => closing),
    ]) {
      const child = context.installComponent(component)
      await child
      requireActive(child)
    }
  } catch (error) {
    try { await close() } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'harness startup and cleanup failed')
    }
    throw error
  }
  return {
    listAgents: () => {
      if (closing) throw new Error('harness is closing')
      return Object.freeze(agents.map(agent => Object.freeze({ id: agent.id })))
    },
    openProject: path => currentProjects().openProject(path),
    listProjects: () => currentProjects().listProjects(),
    getProject: id => currentProjects().getProject(id),
    createSession: (projectId, agentId, modelId) => {
      if (modelId !== undefined) validateSelectedModel(modelId)
      return currentSessions().createSession(projectId, agentId, modelId)
    },
    selectSessionModel: (sessionId, modelId) => {
      const protocolId = validateSelectedModel(modelId)
      return currentSessions().selectSessionModel(sessionId, modelId, protocolId)
    },
    getSession: id => currentSessions().getSession(id),
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
    close,
  }
}
