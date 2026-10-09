import { productActivityServiceKey } from '../../../host/applications/contracts.js'
import type { ProductActivityPort } from '../../../host/applications/contracts.js'
import { failure } from '../../../host/http-utils.js'
import { hostAccessServiceKey } from '../../../host/access.js'
import type { HostAccessPort } from '../../../host/access.js'
import type { Component, Context } from '@nya/core'
import { runServiceKey } from '../core/run/component.js'
import type { RunPort } from '../core/run/component.js'
import { sessionServiceKey } from '../core/session/port.js'
import type { SessionPort } from '../core/session/port.js'
import { createHarnessServerHttpHandler } from './handler.js'
import { modelsError, modelsServiceKey, modelsSettingsServiceKey, modelsCatalogServiceKey } from '@anybox/models'
import type { ModelsService, ModelsSettingsService, ModelsCatalogService } from '@anybox/models'
import { harnessServerProviderTemplates } from '../server-models.js'
import { projectServiceKey } from '../core/project/component.js'
import type { ProjectPort } from '../core/project/component.js'
import type { HarnessServerApiCommands, HarnessServerHttpHandler } from './handler.js'
import { directoryPickerServiceKey } from '../client/directory-picker.js'
import type { DirectoryPickerPort } from '../client/directory-picker.js'
import { promptServiceKey } from '../core/prompt/component.js'
import type { PromptPort } from '../core/prompt/component.js'
import { agentPromptServiceKey } from '../core/agent/prompt-binding-component.js'
import type { AgentPromptPort } from '../core/agent/prompt-binding-component.js'
import { runChangedEvent, runViewEvent } from '../core/run/notifications.js'
import { decodeProtocolView } from '../core/view/decode.js'
import { projectProtocolRecords } from '../core/protocol-agents/projection.js'
import { listTools } from '../core/tool/catalog.js'

export const harnessServerHttpServiceKey = 'harness.http'
const localActorId = 'local-web-user'

type CommandDependencies = {
  [sessionServiceKey]: SessionPort
  [runServiceKey]: RunPort
  [modelsServiceKey]: ModelsService
  [modelsSettingsServiceKey]: ModelsSettingsService
  [modelsCatalogServiceKey]: ModelsCatalogService
  [projectServiceKey]: ProjectPort
  [directoryPickerServiceKey]: DirectoryPickerPort
  [promptServiceKey]: PromptPort
  [agentPromptServiceKey]: AgentPromptPort
}

function createCommands(agentIds: readonly Readonly<{ id: string }>[], deps: CommandDependencies): HarnessServerApiCommands {
  return {
    listAgents: () => agentIds,
    listTools,
    getAgentTools: agentId => deps[sessionServiceKey].getAgentTools(agentId),
    setAgentTools: (agentId, input) => deps[sessionServiceKey].setAgentTools(agentId, input),
    directoryPickerSupported: () => deps[directoryPickerServiceKey]?.supported ?? false,
    directoryBrowsingSupported: () => deps[projectServiceKey].directoryBrowsingSupported,
    directoryCreationSupported: () => deps[projectServiceKey].directoryCreationSupported,
    openDirectoryBrowse: (...args) => deps[projectServiceKey].openDirectoryBrowse(...args),
    readDirectoryPage: (...args) => deps[projectServiceKey].readDirectoryPage(...args),
    createDirectory: (...args) => deps[projectServiceKey].createDirectory(...args),
    closeDirectoryBrowse: (...args) => deps[projectServiceKey].closeDirectoryBrowse(...args),
    onDirectoryBrowseRetired: listener => deps[projectServiceKey].onDirectoryBrowseRetired(listener),
    async pickProject(signal) {
      const path = await deps[directoryPickerServiceKey]?.pick(signal)
      if (!path || signal.aborted) return null
      return deps[projectServiceKey].openProject(path)
    },
    openProject: path => deps[projectServiceKey].openProject(path),
    listProjects: () => deps[projectServiceKey].listProjects(),
    createSession(projectId, agentId, modelId) {
      if (modelId !== undefined && !deps[modelsServiceKey].get(modelId)) throw modelsError('not-found')
      return deps[sessionServiceKey].createSession(projectId, agentId, modelId)
    },
    getSessionDefaults: agentId => deps[sessionServiceKey].getSessionDefaults(agentId),
    setSessionDefaults(agentId, modelId, expectedRevision) {
      if (modelId !== null) {
        const model = deps[modelsServiceKey].get(modelId)
        if (!model) throw modelsError('not-found')
        if (!model.available) throw failure(409, 'model-unavailable')
      }
      return deps[sessionServiceKey].setSessionDefaults(agentId, modelId, expectedRevision)
    },
    selectSessionModel(sessionId, modelId) {
      const model = deps[modelsServiceKey].get(modelId)
      if (!model) throw modelsError('not-found')
      return deps[sessionServiceKey].selectSessionModel(sessionId, modelId, model.parameters.protocolId)
    },
    getSession: id => deps[sessionServiceKey].getSession(id),
    archiveSession: id => deps[sessionServiceKey].archiveSession(id),
    restoreSession: id => deps[sessionServiceKey].restoreSession(id),
    listArchivedSessions: () => deps[sessionServiceKey].listArchivedSessions(),
    listSessions: id => deps[sessionServiceKey].listSessions(id),
    getNode: (sessionId, id) => deps[sessionServiceKey].getNode(sessionId, id),
    getNodePath: (sessionId, id) => deps[sessionServiceKey].getNodePath(sessionId, id),
    listNodes: (sessionId, parentId, query) => deps[sessionServiceKey].listNodes(sessionId, parentId, query),
    getRunByKey: (id, key) => deps[sessionServiceKey].getRunByKey(id, key),
    waitRun: (id, signal) => deps[runServiceKey].waitRun(id, signal),
    startRun: input => deps[runServiceKey].startRun(input),
    openProjectFileTree: (...args) => deps[sessionServiceKey].openProjectFileTree(...args),
    readProjectFileTreePage: (...args) => deps[sessionServiceKey].readProjectFileTreePage(...args),
    closeProjectFileTree: (...args) => deps[sessionServiceKey].closeProjectFileTree(...args),
    onProjectFileTreeRetired: listener => deps[sessionServiceKey].onProjectFileTreeRetired(listener),
    searchProjectFiles: (...args) => deps[sessionServiceKey].searchProjectFiles(...args),
    previewProjectFile: (...args) => deps[sessionServiceKey].previewProjectFile(...args),
    prepareProjectFiles: (...args) => deps[sessionServiceKey].prepareProjectFiles(...args),
    getFileSnapshot: (...args) => deps[sessionServiceKey].getFileSnapshot(...args),
    renewProjectFiles: (...args) => deps[sessionServiceKey].renewProjectFiles(...args),
    importImage: (sessionId, bytes, signal) => deps[sessionServiceKey].importImage(sessionId, bytes, signal),
    getImage: (sessionId, assetId, signal) => deps[sessionServiceKey].getImage(sessionId, assetId, signal),
    renewImages: (sessionId, assetIds) => deps[sessionServiceKey].renewImages(sessionId, assetIds),
    getRun: id => deps[sessionServiceKey].getRun(id),
    async getRunView(id) {
      const run = await deps[sessionServiceKey].getRun(id)
      if (!run?.protocolBinding) return undefined
      const active = run.status === 'running' || run.status === 'cancelling'
      const live = active ? decodeProtocolView(deps[runServiceKey].getView(id)) : undefined
      if (live && live.sessionId === run.sessionId && live.runId === id && live.protocolId === run.protocolBinding.protocolId) return live
      const records = await deps[sessionServiceKey].getRunRecords(id)
      return {
        envelopeVersion: 1, protocolId: run.protocolBinding.protocolId, viewSchemaVersion: 2,
        sessionId: run.sessionId, runId: id, viewRevision: active ? 0 : run.revision,
        status: active ? 'provisional' : 'committed',
        exchanges: projectProtocolRecords(run.protocolBinding.protocolId, records, run.promptSnapshots),
      }
    },
    listRuns: (id, query) => deps[sessionServiceKey].listRuns(id, query),
    getRunEvents: (id, afterSeq) => deps[sessionServiceKey].getRunEvents(id, afterSeq),
    cancelRun: id => deps[runServiceKey].cancelRun(id),
    get modelsSettings() { return deps[modelsSettingsServiceKey] },
    get modelsCatalog() { return deps[modelsCatalogServiceKey] },
    listModels: () => deps[modelsServiceKey].list(),
    modelTemplates: () => harnessServerProviderTemplates,
    listPrompts: () => deps[promptServiceKey].listPrompts(localActorId),
    getPrompt: id => deps[promptServiceKey].getPrompt(localActorId, id),
    createPrompt: input => deps[promptServiceKey].createPrompt(localActorId, input),
    editPrompt: (id, revision, patch) => deps[promptServiceKey].editPrompt(localActorId, id, revision, patch),
    publishPrompt(id, revision) {
      const document = deps[promptServiceKey].getPrompt(localActorId, id)
      if (!document) throw new Error(`unknown prompt ${id}`)
      if (document.draft.revision !== revision) throw new Error('prompt draft revision conflict')
      return deps[promptServiceKey].publishPrompt(localActorId, id)
    },
    getPromptVersions: id => deps[promptServiceKey].getPromptVersions(localActorId, id),
    getAgentPrompts: id => deps[agentPromptServiceKey].getAgentPrompts(localActorId, id),
    bindPrompt: (id, versionId) => deps[agentPromptServiceKey].bindPrompt(localActorId, id, versionId),
  }
}

/** Owns harness server HTTP operations and subscriptions; Anybox owns the listener. */
export function createHarnessServerHttpComponent(root: Context, agents: readonly Readonly<{ id: string }>[],
  options: { authenticated?: boolean } = {}): Component.Object<void, {
    [productActivityServiceKey]: ProductActivityPort
    [hostAccessServiceKey]: HostAccessPort
  }> {
  if (root.root !== root) throw new TypeError('application root Context required')
  const agentIds = Object.freeze(agents.map(agent => Object.freeze({ id: agent.id })))
  const currentCommands = (): HarnessServerApiCommands => {
    const snapshots = new Map<string, unknown>()
    const services = {} as CommandDependencies
    for (const key of [sessionServiceKey, runServiceKey, modelsServiceKey, modelsSettingsServiceKey, modelsCatalogServiceKey,
      projectServiceKey, directoryPickerServiceKey, promptServiceKey, agentPromptServiceKey] as const) {
      snapshots.set(key, root.get(key))
      Object.defineProperty(services, key, { get() {
        const service = snapshots.get(key)
        if (!service) throw failure(503, 'service-unavailable')
        return service
      } })
    }
    const commands = createCommands(agentIds, services)
    commands.directoryBrowsingSupported = () => (snapshots.get(projectServiceKey) as ProjectPort | undefined)?.directoryBrowsingSupported ?? false
    commands.directoryCreationSupported = () => (snapshots.get(projectServiceKey) as ProjectPort | undefined)?.directoryCreationSupported ?? false
    commands.directoryPickerSupported = () => (snapshots.get(directoryPickerServiceKey) as DirectoryPickerPort | undefined)?.supported ?? false
    return commands
  }
  return {
    name: 'harness-http',
    inject: [productActivityServiceKey, ...(options.authenticated ? [hostAccessServiceKey] : [])],
    async apply(ctx, _config, deps) {
      let server: HarnessServerHttpHandler | undefined
      ctx.effect(() => async () => { await server?.close() }, 'stop and join application HTTP requests')
      server = createHarnessServerHttpHandler(currentCommands(), { currentCommands, activity: deps[productActivityServiceKey],
        onRevoked: options.authenticated ? listener => deps[hostAccessServiceKey].onRevoked(listener) : undefined })
      ctx.on(runChangedEvent, change => server?.notifyRunChange(change))
      ctx.on(runViewEvent, progress => {
        const snapshot = decodeProtocolView(progress.frame.payload)
        if (snapshot && snapshot.sessionId === progress.sessionId && snapshot.runId === progress.runId) {
          server?.notifyProtocolView({ sessionId: snapshot.sessionId, runId: snapshot.runId, snapshot })
        }
      })
      ctx.provide(harnessServerHttpServiceKey, server)
    },
  }
}
