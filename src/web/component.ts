import type { Component } from '@nya/core'
import { agentServiceKey } from '../agent/component.js'
import type { AgentPort } from '../agent/component.js'
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

export const webFrontendServiceKey = 'web.frontend'

export interface WebFrontendPort {
  readonly url: string
}

/** One Nya component owns the static client and its local HTTP listener. */
export function createWebFrontendComponent(port = 0): Component.Object<void, {
  [agentServiceKey]: AgentPort
  [sessionServiceKey]: SessionPort
  [runServiceKey]: RunPort
  [credentialSettingsServiceKey]: CredentialSettingsPort
  [projectServiceKey]: ProjectPort
}> {
  let listenPort = port
  return {
    name: 'web-frontend',
    inject: [agentServiceKey, sessionServiceKey, runServiceKey, credentialSettingsServiceKey, projectServiceKey],
    async apply(ctx, _config, deps) {
      let server: WebServer | undefined
      ctx.effect(() => async () => { await server?.close() }, 'stop and join Web requests')
      const commands: WebCommands = {
        listAgents: () => Object.freeze(deps[agentServiceKey].list().map(agent => Object.freeze({ id: agent.id }))),
        openProject: path => deps[projectServiceKey].openProject(path),
        listProjects: () => deps[projectServiceKey].listProjects(),
        createSession: (projectId, agentId) => deps[sessionServiceKey].createSession(projectId, agentId),
        getSession: id => deps[sessionServiceKey].getSession(id),
        listSessions: id => deps[sessionServiceKey].listSessions(id),
        startRun: input => deps[runServiceKey].startRun(input),
        getRun: id => deps[runServiceKey].getRun(id),
        listRuns: id => deps[runServiceKey].listRuns(id),
        cancelRun: id => deps[runServiceKey].cancelRun(id),
        listCredentials: () => deps[credentialSettingsServiceKey].list(),
        saveCredential: (id, secret) => deps[credentialSettingsServiceKey].write(id, secret),
        deleteCredential: id => deps[credentialSettingsServiceKey].delete(id),
      }
      server = await startWebServer(commands, listenPort)
      listenPort = Number(new URL(server.url).port)
      ctx.provide(webFrontendServiceKey, Object.freeze({ url: server.url }) satisfies WebFrontendPort)
    },
  }
}
