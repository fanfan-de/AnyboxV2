import type { SessionId, AgentId, Revision, Timestamp } from './identity.js'
import type { Message } from './message.js'

export interface Session {
  readonly id: SessionId
  readonly agentId: AgentId
  readonly version: Revision
  readonly createdAt: Timestamp
}

export interface SessionHistory {
  readonly session: Session
  readonly messages: readonly Message[]
}
