import type { AgentDefinitionId, AgentId, Revision, Timestamp } from './identity.js'
import type { ToolRef } from './tool.js'

export interface ModelRef {
  readonly protocolId: string
  readonly providerId: string
  readonly modelId: string
  readonly configRevision: Revision
}
export interface AgentDefinition {
  readonly id: AgentDefinitionId
  readonly revision: Revision
  readonly instructions: string
  readonly model: ModelRef
  readonly tools?: readonly ToolRef[]
}
export interface AgentInstance {
  readonly id: AgentId
  readonly definitionId: AgentDefinitionId
  readonly definitionRevision: Revision
  readonly generation: string
  readonly createdAt: Timestamp
}
