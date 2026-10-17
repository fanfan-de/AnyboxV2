import type { JsonValue } from '@anybox/models'
import type { ComputerDeclaration, ComputerOperationState, ProcessRef } from './operations-domain.js'
import type { WorkspaceBinding } from '../workspace/port.js'
import type { ImageRef } from '../image/port.js'
import type { ComputerQuery, ComputerQueryResult } from './query-domain.js'

/** The Computer contract as the harness server core consumes it; the router behind it dispatches by attachment. */
export const computerWorkerServiceKey = 'computer.worker'
/** This harness server's own worker over loopback; only the router and host-side control consume it directly. */
export const localComputerWorkerServiceKey = 'computer.local-worker'
export const localComputerWorkerControlServiceKey = 'computer.local-worker-control'
/** The attachment that delivered the request fixes which harness server owns the Run; it stays outside declaration digests. */
export interface WorkerAuthorization { readonly runId: string; readonly runOwnerEpoch: number; readonly attachmentId: string }
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
/** Receipt of bytes the unit pushed to the harness server's byte channel before publishing the reference. */
export interface PushedBytes { readonly assetId: string; readonly sha256: string; readonly byteLength: number; readonly mimeType: string }
/** Over loopback the bytes travel inline as base64; over unit dial-out they are pushed first and only the receipt travels. */
export interface WorkerImage { readonly ref: ImageRef; readonly base64?: string; readonly pushed?: PushedBytes }
export interface WorkerOperation {
  readonly operationId: string
  readonly runId: string
  /** Session that owns the tool images of this operation; absent for control operations. */
  readonly sessionId?: string
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
  /** Read-only query surface outside any Run: directory listing, search and text reads on the unit, fixed by attachment only. */
  query(input: { readonly attachmentId: string; readonly query: ComputerQuery }, signal?: AbortSignal): Promise<ComputerQueryResult>
  /** Explicit application shutdown, separate from closing the local proxy observer. */
  shutdown(): Promise<void>
}
/** Device-owner control of the worker's own attachments, reachable only over the loopback bootstrap. */
export interface LocalComputerWorkerControl {
  listAttachments(signal?: AbortSignal): Promise<readonly JsonValue[]>
  consumeAttachCode(input: { readonly harnessUrl: string; readonly code: string; readonly ceiling: JsonValue }, signal?: AbortSignal): Promise<JsonValue>
  revokeAttachment(attachmentId: string, signal?: AbortSignal): Promise<JsonValue>
  updatePermissions(attachmentId: string, ceiling: unknown, signal?: AbortSignal): Promise<JsonValue>
}
export interface ComputerWorkerOptions {
  readonly directory: string
  readonly executable?: string
  readonly startupTimeoutMs?: number
  readonly requestTimeoutMs?: number
  /** Management observers never start a worker implicitly. Execution clients retain demand startup. */
  readonly autoStart?: boolean
}
export interface LocalComputerWorkerStatus {
  readonly state: 'stopped' | 'running' | 'unavailable'
  readonly supported: boolean
  readonly workerId?: string
  readonly bootId?: string
  readonly pid?: number
  readonly attachments: readonly JsonValue[]
}
export function workerError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(code), { name: 'ComputerWorkerError', code })
}
/** Provider reference of a worker instance: the stable worker identity and the boot that answered. */
export function workerProviderRef(info: { readonly workerId: string; readonly bootId: string }): string { return `${info.workerId}:${info.bootId}` }
export function workerBootOf(providerRef: string): string { return providerRef.slice(providerRef.lastIndexOf(':') + 1) }
/** The same worker answering with another boot proves the earlier boot exited: one worker directory has one live process. */
export function workerBootExited(previousRef: string, info: { readonly workerId: string; readonly bootId: string }): boolean {
  return previousRef.slice(0, previousRef.lastIndexOf(':')) === info.workerId && workerBootOf(previousRef) !== info.bootId
}
