import type { AgentInstance } from './agent.js'
import type { KernelDescription } from './description.js'
import type { StartRunRequest } from './run.js'

export type AgentApplicationState = 'new' | 'starting' | 'running' | 'closing' | 'closed' | 'failed'
export interface AgentApplicationStatus {
  readonly state: AgentApplicationState
  readonly ready: boolean
  readonly agent?: AgentInstance
  readonly kernel?: KernelDescription
}
/** Stable across process generations; retry with the original version, key and input. */
export type SubmitTaskRequest = Omit<StartRunRequest, 'agentId' | 'agentGeneration'>
