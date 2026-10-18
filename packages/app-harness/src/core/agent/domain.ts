import { nonEmpty } from '../validation.js'

export interface AgentDefinition {
  readonly id: string
  readonly instructions: string
  readonly modelId?: string
}

export function validateAgents(agents: readonly AgentDefinition[]): readonly AgentDefinition[] {
  if (!Array.isArray(agents) || agents.length === 0) throw new TypeError('agents must be a non-empty array')
  const ids = new Set<string>()
  return Object.freeze(agents.map(agent => {
    const id = nonEmpty(agent?.id, 'agent.id')
    const instructions = nonEmpty(agent?.instructions, 'agent.instructions')
    const modelId = agent?.modelId === undefined ? undefined : nonEmpty(agent.modelId, 'agent.modelId')
    if (ids.has(id)) throw new TypeError(`duplicate agent ${id}`)
    ids.add(id)
    return Object.freeze({ id, instructions, ...(modelId === undefined ? {} : { modelId }) })
  }))
}
