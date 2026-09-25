import type { Component } from '@nya/core'
import { validateAgents } from './domain.js'
import type { AgentDefinition } from './domain.js'

export const agentServiceKey = 'harness.agents'

export interface AgentPort {
  get(id: string): AgentDefinition | undefined
  list(): readonly AgentDefinition[]
}

export function createAgentComponent(input: readonly AgentDefinition[]): Component.Object<void> {
  const agents = new Map(validateAgents(input).map(agent => [agent.id, agent]))
  return {
    name: 'harness-agents',
    apply(ctx) {
      const service: AgentPort = { get: id => agents.get(id), list: () => Object.freeze([...agents.values()]) }
      ctx.provide(agentServiceKey, service)
    },
  }
}
