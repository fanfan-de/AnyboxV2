import type { KernelError } from './errors.js'
import type { RunLimits } from './run.js'
import type { AgentInstance } from './agent.js'

export interface KernelDescription {
  readonly ready: boolean
  readonly stateDurability: 'memory' | 'persistent'
  readonly agent?: AgentInstance
  readonly recovery: { readonly interruptedRunIds: readonly string[] }
  readonly capabilities: { readonly text: true; readonly streaming: false; readonly tools: boolean; readonly events: true }
  readonly limits: RunLimits
  readonly fault?: KernelError
}
