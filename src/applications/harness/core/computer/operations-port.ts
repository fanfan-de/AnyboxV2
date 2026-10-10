import type { JsonValue } from '@anybox/models'
import type { OwnedCall } from '../contracts.js'
import type { StorageTransaction } from '../../../../storage/port.js'
import type { ToolObservation, ValidatedToolRequest } from '../run/domain.js'
import type { ComputerOperation } from './operations-domain.js'
import type { ComputerSpecification } from './port.js'
import type { ToolDefinition } from '../tool/definition.js'

export const computerOperationsServiceKey = 'harness.computer-operations'
export interface ComputerRunScope {
  execute(operationId: string): OwnedCall<ToolObservation>
  hasProcesses(): boolean
  cancel(): Promise<void>
  close(): OwnedCall<JsonValue>
}
export interface ComputerOperationsPort {
  acceptIn(tx: StorageTransaction, input: {
    readonly operationId: string; readonly runId: string; readonly sessionId: string; readonly projectId: string
    readonly request: ValidatedToolRequest
    readonly tool: { readonly toolId: string; readonly version: string; readonly definition: ToolDefinition }
    readonly runOwnerEpoch?: number
  }): ComputerOperation
  observeIn(tx: StorageTransaction, operationId: string, observation: JsonValue): void
  claimRunIn(tx: StorageTransaction, runId: string, runOwnerEpoch: number): void
  requestCancelIn(tx: StorageTransaction, runId: string): void
  get(operationId: string): Promise<ComputerOperation | undefined>
  hasRunResources(runId: string): Promise<boolean>
  /** Install the claimed owner fence at an already-used worker before continuing a Run. */
  authorizeRun(runId: string, runOwnerEpoch: number, signal: AbortSignal): Promise<void>
  /** Reconcile durable cancellation for terminal Runs; does not reopen Session history. */
  recoverCancelledRuns(excludeRunIds: readonly string[]): Promise<void>
  /** Synchronous ownership only: opening a scope does not activate or prepare resources. */
  openRun(input: { readonly runId: string; readonly runOwnerEpoch?: number; readonly imageInput?: boolean }): ComputerRunScope
}
export interface ComputerOperationsOptions {
  readonly computerId?: string
  readonly spec?: ComputerSpecification
}
