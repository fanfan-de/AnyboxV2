import type { JsonValue } from './identity.js'

export type KernelErrorCode = 'INVALID_ARGUMENT' | 'NOT_FOUND' | 'NOT_READY' | 'CONFLICT'
  | 'SESSION_BUSY' | 'CLOSED' | 'CAPABILITY_UNAVAILABLE' | 'DEPENDENCY_UNAVAILABLE'
  | 'LIMIT_EXCEEDED' | 'CANCELLED' | 'MODEL_FAILED' | 'STATE_FAILED' | 'CLEANUP_FAILED'
  | 'SETTLEMENT_FAILED' | 'INTERNAL' | 'TOOL_FAILED' | 'TOOL_DENIED' | 'INTERACTION_UNAVAILABLE' | 'INTERRUPTED'
export interface KernelError {
  readonly code: KernelErrorCode
  readonly message: string
  readonly details?: Readonly<Record<string, JsonValue>>
}
