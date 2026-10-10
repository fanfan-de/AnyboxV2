import type { StorageReader, StorageTransaction } from '../../../../storage/port.js'
import type { OwnedCall, RuntimeInputs } from '../contracts.js'
import type { ComputerInstance } from '../computer/port.js'
import type { PreparedWorkspaceBinding, Workspace, WorkspaceBinding, WorkspaceReservation } from './domain.js'

export const workspacesServiceKey = 'harness.workspaces'

export interface WorkspacesPort {
  /** Queries never activate a computer or check the project directory. */
  get(workspaceId: string): Promise<Workspace | undefined>
  getForProject(projectId: string): Promise<Workspace | undefined>
  getBinding(reservationId: string): Promise<WorkspaceBinding | undefined>
  /** Synchronous participant in the same business transaction as the operation/resource reservation. */
  reserveIn(tx: StorageTransaction, input: {
    readonly reservationId: string
    readonly scopeId: string
    readonly projectId: string
  }): WorkspaceReservation
  /** Only explicit computer tools call prepare. Local readiness checks happen outside a transaction. */
  prepare(input: { readonly reservationId: string; readonly instance: ComputerInstance }, signal?: AbortSignal): OwnedCall<PreparedWorkspaceBinding>
  /** The caller also pins the exact computer instance in this transaction. */
  bindIn(tx: StorageTransaction, input: {
    readonly reservationId: string
    readonly prepared: PreparedWorkspaceBinding
  }): WorkspaceBinding
  /** Verify the current scope and all placement fences immediately before executing a tool. */
  requireBindingIn(tx: StorageReader, input: {
    readonly reservationId: string
    readonly scopeId: string
    readonly computerInstanceId: string
    readonly instanceGeneration: number
    readonly workspaceEpoch: number
  }): WorkspaceBinding
  /** Release only after the Run scope has actually exited; pair with releasePinIn in this transaction. */
  releaseIn(tx: StorageTransaction, reservationId: string, scopeId: string): void
}

export interface WorkspacesOptions extends Partial<RuntimeInputs> {
  /** A trusted replacement must still resolve directories on this host; no remote preparation exists yet. */
  readonly localProviderId?: string
}

export type { PreparedWorkspaceBinding, Workspace, WorkspaceBinding, WorkspaceReservation } from './domain.js'
