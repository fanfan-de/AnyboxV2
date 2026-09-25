import type { Component } from '@nya/core'
import type { RuntimeInputs } from '../contracts.js'
import { agentServiceKey } from '../agent/component.js'
import type { AgentPort } from '../agent/component.js'
import { nonEmpty } from '../validation.js'
import { projectServiceKey } from '../project/component.js'
import type { ProjectPort } from '../project/component.js'
import { stateServiceKey } from './sqlite-state.js'
import type { StatePort } from './sqlite-state.js'
import type { Session } from './domain.js'

export const sessionServiceKey = 'harness.sessions'

export interface SessionPort {
  createSession(projectId: string, agentId: string): Promise<Session>
  getSession(id: string): Promise<Session | undefined>
  listSessions(projectId: string): Promise<readonly Session[]>
}

/** Session commands have their own dependency boundary; state remains the data owner. */
export function createSessionComponent(inputs: RuntimeInputs): Component.Object<void, {
  [agentServiceKey]: AgentPort
  [stateServiceKey]: StatePort
  [projectServiceKey]: ProjectPort
}> {
  return {
    name: 'harness-sessions',
    inject: [agentServiceKey, stateServiceKey, projectServiceKey],
    apply(ctx, _config, deps) {
      const agents = deps[agentServiceKey]
      const state = deps[stateServiceKey]
      const projects = deps[projectServiceKey]
      const service: SessionPort = {
        async createSession(projectId, agentId) {
          const id = nonEmpty(agentId, 'agentId')
          if (!agents.get(id)) throw new Error(`unknown agent ${id}`)
          await projects.requireAvailable(nonEmpty(projectId, 'projectId'))
          return state.createSession(inputs.newId(), projectId, id, inputs.now())
        },
        getSession: id => state.getSession(id),
        async listSessions(projectId) {
          if (!await projects.getProject(projectId)) throw new Error(`unknown project ${projectId}`)
          return state.listSessions(projectId)
        },
      }
      ctx.provide(sessionServiceKey, service)
    },
  }
}
