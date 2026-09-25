import type { Component } from '@nya/core'
import type { RuntimeInputs } from '../contracts.js'
import { agentServiceKey } from '../agent/component.js'
import type { AgentPort } from '../agent/component.js'
import { nonEmpty } from '../validation.js'
import { stateServiceKey } from './memory-state.js'
import type { StatePort } from './memory-state.js'
import type { Session } from './domain.js'

export const sessionServiceKey = 'harness.sessions'

export interface SessionPort {
  createSession(agentId: string): Session
  getSession(id: string): Session | undefined
}

/** Session commands have their own dependency boundary; state remains the data owner. */
export function createSessionComponent(inputs: RuntimeInputs): Component.Object<void, {
  [agentServiceKey]: AgentPort
  [stateServiceKey]: StatePort
}> {
  return {
    name: 'harness-sessions',
    inject: [agentServiceKey, stateServiceKey],
    apply(ctx, _config, deps) {
      const agents = deps[agentServiceKey]
      const state = deps[stateServiceKey]
      const service: SessionPort = {
        createSession(agentId) {
          const id = nonEmpty(agentId, 'agentId')
          if (!agents.get(id)) throw new Error(`unknown agent ${id}`)
          return state.createSession(inputs.newId(), id, inputs.now())
        },
        getSession: id => state.getSession(id),
      }
      ctx.provide(sessionServiceKey, service)
    },
  }
}
