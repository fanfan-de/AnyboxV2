import { nonEmpty } from '../validation.js'

export interface AgentDefinition {
  readonly id: string
  readonly instructions: string
  readonly modelId?: string
  /** Trusted environment IDs copied into newly created Sessions; omitted uses Computer. */
  readonly environmentIds?: readonly string[]
}

export function validateAgents(agents: readonly AgentDefinition[]): readonly AgentDefinition[] {
  if (!Array.isArray(agents) || agents.length === 0) throw new TypeError('agents must be a non-empty array')
  const ids = new Set<string>()
  return Object.freeze(agents.map(agent => {
    const id = nonEmpty(agent?.id, 'agent.id')
    const instructions = nonEmpty(agent?.instructions, 'agent.instructions')
    const modelId = agent?.modelId === undefined ? undefined : nonEmpty(agent.modelId, 'agent.modelId')
    const environmentIds = agent?.environmentIds === undefined ? undefined : (() => {
      if (!Array.isArray(agent.environmentIds)) throw new TypeError('agent.environmentIds must be an array')
      const values = agent.environmentIds.map((id: unknown) => nonEmpty(id, 'agent.environmentIds'))
      if (new Set(values).size !== values.length) throw new TypeError('duplicate Agent environment')
      return Object.freeze(values)
    })()
    if (ids.has(id)) throw new TypeError(`duplicate agent ${id}`)
    ids.add(id)
    return Object.freeze({ id, instructions, ...(modelId === undefined ? {} : { modelId }), ...(environmentIds === undefined ? {} : { environmentIds }) })
  }))
}
