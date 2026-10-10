import type { JsonValue } from '@anybox/models'
import type { ComputerDeclaration, ComputerOperationState, ProcessRef } from './operations-domain.js'
import type { WorkspaceBinding } from '../workspace/port.js'
import type { ImageRef } from '../image/port.js'

export const computerWorkerServiceKey = 'computer.worker'
export interface WorkerAuthorization { readonly runId: string; readonly runOwnerEpoch: number }
/** Owner authorization is excluded from the immutable declaration digest. */
export interface WorkerSubmission extends WorkerAuthorization {
  readonly operationId: string
  readonly declarationDigest: string
  readonly kind: 'tool' | 'close-scope' | 'cancel'
  readonly declaration?: ComputerDeclaration
  readonly binding?: WorkspaceBinding
  /** Required for a first tool acceptance; retries of an existing ID return its original fact. */
  readonly workerBootId?: string
  readonly imageInput?: boolean
  readonly targetOperationId?: string
}
export interface WorkerImage { readonly ref: ImageRef; readonly base64: string }
export interface WorkerOperation {
  readonly operationId: string
  readonly runId: string
  readonly declarationDigest: string
  readonly receipt: string
  readonly state: ComputerOperationState
  /** Counts durable dispatches, including executions that later become unknown. */
  readonly executeCount: number
  readonly observation?: JsonValue
  readonly error?: { readonly name: string; readonly message: string; readonly code?: string; readonly category?: string }
  readonly processRef?: ProcessRef
  readonly images?: readonly WorkerImage[]
}
/** Promises confirm durable worker facts; losing a caller never cancels accepted execution. */
export interface ComputerWorkerPort {
  info(): Promise<{ readonly workerId: string; readonly bootId: string; readonly platform: string; readonly architecture: string }>
  claimRun(input: WorkerAuthorization): Promise<void>
  submit(input: WorkerSubmission): Promise<WorkerOperation>
  get(input: WorkerAuthorization & { readonly operationId: string }): Promise<WorkerOperation | undefined>
  /** Explicit application shutdown, separate from closing the local proxy observer. */
  shutdown(): Promise<void>
}
export interface ComputerWorkerOptions {
  readonly directory: string
  readonly executable?: string
  readonly startupTimeoutMs?: number
  readonly requestTimeoutMs?: number
}
export function workerError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(code), { name: 'ComputerWorkerError', code })
}
