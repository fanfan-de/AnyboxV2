import type { Component } from '@nya/core'
import type { RuntimeInputs } from '../contracts.js'
import type { AgentDefinition } from '../agent/domain.js'
import { nonEmpty } from '../validation.js'
import { projectServiceKey } from '../project/component.js'
import type { ProjectPort } from '../project/component.js'
import { stateServiceKey } from './sqlite-state.js'
import type { StatePort } from './sqlite-state.js'
import type { Session, ConversationNode, NodePage, NodeQuery } from './domain.js'

export const sessionServiceKey = 'harness.sessions'

export interface SessionPort {
  createSession(projectId: string, agentId: string): Promise<Session>
  getSession(id: string): Promise<Session | undefined>
  listSessions(projectId: string): Promise<readonly Session[]>
  getNode(sessionId: string, id: string): Promise<ConversationNode | undefined>
  getNodePath(sessionId: string, id: string | null): Promise<readonly ConversationNode[]>
  listNodes(sessionId: string, parentId: string | null, query?: NodeQuery): Promise<NodePage>
}

/** Session commands have their own dependency boundary; state remains the data owner. */
export function createSessionComponent(inputs: RuntimeInputs, agents: readonly AgentDefinition[]): Component.Object<void, {
  [stateServiceKey]: StatePort
  [projectServiceKey]: ProjectPort
}> {
  return {
    name: 'harness-sessions',
    inject: [stateServiceKey, projectServiceKey],
    apply(ctx, _config, deps) {
      const state = deps[stateServiceKey]
      const projects = deps[projectServiceKey]
      const service: SessionPort = {
        async createSession(projectId, agentId) {
          const id = nonEmpty(agentId, 'agentId')
          if (!agents.some(agent => agent.id === id)) throw new Error(`unknown agent ${id}`)
          await projects.requireAvailable(nonEmpty(projectId, 'projectId'))
          return state.createSession(inputs.newId(), projectId, id, inputs.now())
        },
        getSession: id => state.getSession(id),
        getNode: (sessionId, id) => state.getNode(sessionId, id),
        getNodePath: (sessionId, id) => state.getNodePath(sessionId, id),
        listNodes: (sessionId, parentId, query) => state.listNodes(sessionId, parentId, query),
        async listSessions(projectId) {
          if (!await projects.getProject(projectId)) throw new Error(`unknown project ${projectId}`)
          return state.listSessions(projectId)
        },
      }
      ctx.provide(sessionServiceKey, service)
    },
  }
}
