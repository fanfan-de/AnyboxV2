import { isAbsolute } from 'node:path'

/** Stage-one workspaces preserve the original shared local project directory. */
export interface Workspace {
  readonly workspaceId: string
  readonly projectId: string
  readonly mode: 'pinned-local'
  readonly revision: number
  readonly workspaceEpoch: number
  readonly createdAt: string
}

export interface WorkspaceReservation {
  readonly reservationId: string
  readonly workspaceId: string
  readonly projectId: string
  readonly scopeId: string
  readonly createdAt: string
  readonly releasedAt?: string
}

/** An exact local placement. It is never re-resolved to another instance. */
export interface WorkspaceBinding {
  readonly bindingId: string
  readonly reservationId: string
  readonly workspaceId: string
  readonly projectId: string
  readonly scopeId: string
  readonly computerId: string
  readonly computerInstanceId: string
  readonly instanceGeneration: number
  readonly workspaceEpoch: number
  readonly revision: number
  readonly path: string
  readonly preparedAt: string
}

/** A component-local preparation receipt, committed through bindIn. */
export interface PreparedWorkspaceBinding extends WorkspaceBinding {
  readonly preparationId: string
}

export type WorkspaceErrorCode = 'workspace-invalid' | 'workspace-missing' | 'workspace-unavailable' |
  'workspace-cancelled' | 'workspace-reservation-conflict' | 'workspace-released' |
  'workspace-binding-conflict' | 'workspace-stale-preparation'

export function workspaceError(code: WorkspaceErrorCode): Error & { readonly code: WorkspaceErrorCode } {
  return Object.assign(new Error(code), { name: 'WorkspaceError', code })
}

export function workspaceText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || value.includes('\0')) {
    throw workspaceError('workspace-invalid')
  }
  return value
}

export function workspacePath(value: unknown): string {
  const path = workspaceText(value)
  if (!isAbsolute(path)) throw workspaceError('workspace-invalid')
  return path
}

export function workspaceTimestamp(value: unknown): string {
  return workspaceText(value)
}

export function workspacePositive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw workspaceError('workspace-invalid')
  return value
}

/** Binding equality ignores the ephemeral receipt and compares only durable execution facts. */
export function sameWorkspaceBinding(left: WorkspaceBinding, right: WorkspaceBinding): boolean {
  return left.bindingId === right.bindingId && left.reservationId === right.reservationId &&
    left.workspaceId === right.workspaceId && left.projectId === right.projectId && left.scopeId === right.scopeId &&
    left.computerId === right.computerId && left.computerInstanceId === right.computerInstanceId &&
    left.instanceGeneration === right.instanceGeneration && left.workspaceEpoch === right.workspaceEpoch &&
    left.revision === right.revision && left.path === right.path && left.preparedAt === right.preparedAt
}
