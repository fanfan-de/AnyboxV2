import { createHash } from 'node:crypto'
import type { PromptSnapshot } from '../prompt/domain.js'
import { nonEmpty } from '../validation.js'

export interface AgentDefinition {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly instructions: string
  readonly modelId?: string
  /** Trusted environment IDs copied into newly created Sessions; omitted uses Computer. */
  readonly environmentIds?: readonly string[]
}

export interface AgentSummary {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly logoShader?: string
}

export interface AgentDetail extends AgentSummary {
  readonly instructions: string
  readonly modelId: string | null
  readonly revision: number
}

export interface AgentRecord extends AgentDetail {
  readonly instructionRole: 'system' | 'developer'
  readonly environmentIds?: readonly string[]
}

type AgentFields = Omit<AgentDetail, 'id' | 'revision' | 'logoShader'> & { readonly logoShader?: string | null }
const maxLogoShaderBytes = 32 * 1024

export function agentSummary({ id, name, description, logoShader }: AgentSummary): AgentSummary {
  return { id, name, description, ...(logoShader === undefined ? {} : { logoShader }) }
}

export function agentDetail(agent: AgentRecord): AgentDetail {
  return { ...agentSummary(agent), instructions: agent.instructions, modelId: agent.modelId, revision: agent.revision }
}

export function agentPrompt({ id, instructions, instructionRole }: AgentRecord): PromptSnapshot {
  const digest = createHash('sha256').update(JSON.stringify([instructionRole, instructions])).digest('hex')
  return Object.freeze({
    versionId: `agent:${id}:${digest}`, documentId: `agent:${id}`,
    kind: 'agent-instruction', role: instructionRole, content: instructions,
  })
}

function text(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.includes('\0') || !allowEmpty && !value.trim() || value.length > max) {
    throw new TypeError(`invalid Agent ${field}`)
  }
  return value
}

export function validateAgentFields(raw: unknown): AgentFields {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('invalid Agent configuration')
  const fields = raw as Record<string, unknown>
  const logoShader = fields.logoShader == null ? fields.logoShader : text(fields.logoShader, 'logoShader', maxLogoShaderBytes)
  if (typeof logoShader === 'string' && Buffer.byteLength(logoShader, 'utf8') > maxLogoShaderBytes) {
    throw new TypeError('invalid Agent logoShader')
  }
  return {
    name: text(fields.name, 'name', 100).trim(),
    description: text(fields.description, 'description', 500, true).trim(),
    instructions: text(fields.instructions, 'instructions', 100_000),
    modelId: fields.modelId === null ? null : text(fields.modelId, 'modelId', 256),
    ...(logoShader === undefined ? {} : { logoShader }),
  }
}

export function validateAgentRequestId(value: unknown): string {
  return text(value, 'requestId', 256)
}

export function validateAgentRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError('invalid Agent revision')
  return value
}

export function validateAgents(agents: readonly AgentDefinition[]): readonly AgentDefinition[] {
  if (!Array.isArray(agents) || agents.length === 0) throw new TypeError('agents must be a non-empty array')
  const ids = new Set<string>()
  return Object.freeze(agents.map(agent => {
    const id = nonEmpty(agent?.id, 'agent.id')
    const instructions = nonEmpty(agent?.instructions, 'agent.instructions')
    const name = agent.name === undefined ? id : text(agent.name, 'name', 100).trim()
    const description = agent.description === undefined ? '' : text(agent.description, 'description', 500, true).trim()
    const modelId = agent?.modelId === undefined ? undefined : nonEmpty(agent.modelId, 'agent.modelId')
    const environmentIds = agent?.environmentIds === undefined ? undefined : (() => {
      if (!Array.isArray(agent.environmentIds)) throw new TypeError('agent.environmentIds must be an array')
      const values = agent.environmentIds.map((id: unknown) => nonEmpty(id, 'agent.environmentIds'))
      if (new Set(values).size !== values.length) throw new TypeError('duplicate Agent environment')
      return Object.freeze(values)
    })()
    if (ids.has(id)) throw new TypeError(`duplicate agent ${id}`)
    ids.add(id)
    return Object.freeze({ id, name, description, instructions, ...(modelId === undefined ? {} : { modelId }), ...(environmentIds === undefined ? {} : { environmentIds }) })
  }))
}
