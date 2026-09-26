import type { Component } from '@nya/core'
import { runServiceKey } from '../run/component.js'
import type { RunPort } from '../run/component.js'
import { sessionServiceKey } from '../run/session-component.js'
import type { SessionPort } from '../run/session-component.js'
import { startWebServer } from './server.js'
import { credentialSettingsServiceKey } from '../credentials/settings.js'
import type { CredentialSettingsPort } from '../credentials/settings.js'
import { projectServiceKey } from '../project/component.js'
import type { ProjectPort } from '../project/component.js'
import type { WebCommands, WebServer } from './server.js'
import { directoryPickerServiceKey } from './directory-picker.js'
import type { DirectoryPickerPort } from './directory-picker.js'
import { promptServiceKey } from '../prompt/component.js'
import type { PromptPort } from '../prompt/component.js'
import { agentPromptServiceKey } from '../agent/prompt-binding-component.js'
import type { AgentPromptPort } from '../agent/prompt-binding-component.js'

export const webFrontendServiceKey = 'web.frontend'
/** Stable identity owned by this single-user host, never supplied by the browser. */
const localActorId = 'local-web-user'

export interface WebFrontendPort {
  readonly url: string
}

/** One Nya component owns the static client and its local HTTP listener. */
export function createWebFrontendComponent(agents: readonly Readonly<{ id: string }>[], port = 0): Component.Object<void, {
  [sessionServiceKey]: SessionPort
  [runServiceKey]: RunPort
  [credentialSettingsServiceKey]: CredentialSettingsPort
  [projectServiceKey]: ProjectPort
  [directoryPickerServiceKey]: DirectoryPickerPort
  [promptServiceKey]: PromptPort
  [agentPromptServiceKey]: AgentPromptPort
}> {
  let listenPort = port
  const agentIds = Object.freeze(agents.map(agent => Object.freeze({ id: agent.id })))
  return {
    name: 'web-frontend',
    inject: [sessionServiceKey, runServiceKey, credentialSettingsServiceKey, projectServiceKey,
      directoryPickerServiceKey, promptServiceKey, agentPromptServiceKey],
    async apply(ctx, _config, deps) {
      let server: WebServer | undefined
      ctx.effect(() => async () => { await server?.close() }, 'stop and join Web requests')
      const commands: WebCommands = {
        listAgents: () => agentIds,
        directoryPickerSupported: () => deps[directoryPickerServiceKey].supported,
        async pickProject(signal) {
          const path = await deps[directoryPickerServiceKey].pick(signal)
          if (!path || signal.aborted) return null
          return deps[projectServiceKey].openProject(path)
        },
        listProjects: () => deps[projectServiceKey].listProjects(),
        createSession: (projectId, agentId) => deps[sessionServiceKey].createSession(projectId, agentId),
        getSession: id => deps[sessionServiceKey].getSession(id),
        listSessions: id => deps[sessionServiceKey].listSessions(id),
        getNode: (sessionId, id) => deps[sessionServiceKey].getNode(sessionId, id),
        getNodePath: (sessionId, id) => deps[sessionServiceKey].getNodePath(sessionId, id),
        listNodes: (sessionId, parentId, query) => deps[sessionServiceKey].listNodes(sessionId, parentId, query),
        getRunByKey: (id, key) => deps[runServiceKey].getRunByKey(id, key),
        waitRun: (id, signal) => deps[runServiceKey].waitRun(id, signal),
        startRun: input => deps[runServiceKey].startRun(input),
        getRun: id => deps[runServiceKey].getRun(id),
        listRuns: (id, query) => deps[runServiceKey].listRuns(id, query),
        getRunEvents: (id, afterSeq) => deps[runServiceKey].getRunEvents(id, afterSeq),
        cancelRun: id => deps[runServiceKey].cancelRun(id),
        listCredentials: () => deps[credentialSettingsServiceKey].list(),
        saveCredential: (id, secret) => deps[credentialSettingsServiceKey].write(id, secret),
        deleteCredential: id => deps[credentialSettingsServiceKey].delete(id),
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
      server = await startWebServer(commands, listenPort)
      listenPort = Number(new URL(server.url).port)
      ctx.provide(webFrontendServiceKey, Object.freeze({ url: server.url }) satisfies WebFrontendPort)
    },
  }
}
