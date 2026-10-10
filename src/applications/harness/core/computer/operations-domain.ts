import { createHash } from 'node:crypto'
import type { JsonValue } from '@anybox/models'
import type { ValidatedToolRequest } from '../run/domain.js'
import type { ToolDefinition } from '../tool/definition.js'
import type { WorkspaceBinding } from '../workspace/port.js'
import type { ComputerSpecification } from './port.js'

export interface ComputerDeclaration {
  readonly schemaVersion: 1
  readonly operationId: string
  readonly runId: string
  readonly sessionId: string
  readonly projectId: string
  readonly tool: { readonly toolId: string; readonly version: string; readonly definition: ToolDefinition }
  readonly request: ValidatedToolRequest
  readonly workspaceId: string
  readonly workspaceRevision: number
  readonly computerId: string
  readonly spec: ComputerSpecification
}
export type ComputerOperationState = 'accepted' | 'queued' | 'starting' | 'running' |
  'succeeded' | 'failed' | 'cancelled' | 'outcome-unknown'
/** A tool process session belongs to an exact Run placement, not to a reusable OS PID. */
export interface ProcessRef {
  readonly processId: string
  readonly runId: string
  readonly sessionId: number
  readonly computerInstanceId: string
  readonly instanceGeneration: number
}
export interface ComputerOperation {
  readonly declaration: ComputerDeclaration
  readonly declarationDigest: string
  readonly runOwnerEpoch: number
  readonly state: ComputerOperationState
  readonly binding?: WorkspaceBinding
  readonly observation?: JsonValue
  readonly processRef?: ProcessRef
  readonly observed: boolean
  readonly workerReceipt?: string
}
export function needsComputer(request: Pick<ValidatedToolRequest, 'name'>): boolean {
  return !['codex_update_plan', 'claude_code_TodoWrite', 'deepseek_harness_todo_write'].includes(request.name)
}
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  throw new TypeError('computer declaration must contain JSON values')
}
/** Authorization and placement are deliberately outside this immutable declaration. */
export function computerDeclarationDigest(declaration: ComputerDeclaration): string {
  const { schemaVersion, operationId, runId, sessionId, projectId, tool, request, workspaceId, workspaceRevision, computerId, spec } = declaration
  return createHash('sha256').update(canonical({ schemaVersion, operationId, runId, sessionId, projectId,
    tool, request, workspaceId, workspaceRevision, computerId, spec })).digest('hex')
}
export function operationError(code: 'computer-operation-conflict' | 'computer-operation-unavailable' | 'computer-operation-missing' | 'computer-operation-owner' | 'computer-operation-cleanup'): Error {
  return Object.assign(new Error(code), { name: 'ComputerOperationError', code })
}
