import type { FileSelection, FileRef } from '../core/project-files/domain.js'
import type { ApplyPatchResult } from '@anybox/computer-tools/apply-patch-types'
import type { ImageRef } from '../core/image/port.js'
import type { JsonValue } from '@anybox/models'
export type * from '../core/api.js'
export type { DirectoryPage } from '../core/project/directories.js'

export type ToolTraceState = 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled' | 'interrupted' |
  ApplyPatchResult['status']
interface ToolTraceBase {
  readonly id: string
  state: ToolTraceState
  category?: string
  /** Position in the supplied event sequence, including legacy queued batches. */
  eventIndex?: number
  startedAt?: string
  finishedAt?: string
}
export interface BashTrace extends ToolTraceBase {
  readonly name: 'bash'
  readonly command: string
  exitCode?: number | null
  signal?: string | null
  stdout?: string
  stderr?: string
  truncated?: boolean
}
export interface ApplyPatchTrace extends ToolTraceBase {
  readonly name: 'apply_patch'
  readonly patch: string
  readonly patchTruncated: boolean
  result?: ApplyPatchResult
}
export interface LibraryToolTrace extends ToolTraceBase {
  readonly name: string
  readonly arguments: Readonly<Record<string, JsonValue>>
  result?: JsonValue
  images?: readonly ImageRef[]
}
export type ToolTrace = BashTrace | ApplyPatchTrace | LibraryToolTrace

/** Legacy presentation is identified by its wire shape; generic tools may use any name. */
export function isBashTrace(value: ToolTrace | undefined): value is BashTrace {
  return value !== undefined && value.name === 'bash' && 'command' in value && typeof value.command === 'string'
}
export function isApplyPatchTrace(value: ToolTrace | undefined): value is ApplyPatchTrace {
  return value !== undefined && value.name === 'apply_patch' && 'patch' in value && typeof value.patch === 'string'
}
export function isLibraryToolTrace(value: ToolTrace | undefined): value is LibraryToolTrace {
  return value !== undefined && 'arguments' in value
}
export interface PendingSubmission {
  /** Missing on old pending inputs, which must be confirmed again. */
  readonly schemaVersion?: number
  readonly modelId?: string
  readonly sessionId: string
  readonly input: string
  readonly images?: readonly ImageRef[]
  readonly files?: readonly FileRef[]
  /** Unknown image data must never be silently submitted as text only. */
  readonly invalidImages?: boolean
  readonly invalidFiles?: boolean
  readonly fileSelections?: readonly FileSelection[]
  readonly preparationKey?: string
  readonly idempotencyKey: string
  readonly parentNodeId?: string | null
  readonly runId?: string
}
export interface ApiError extends Error { readonly status: number; readonly code: string; readonly fileIndex?: number }
export type Api = <T>(path: string, body?: object, signal?: AbortSignal) => Promise<T>

export type SessionViewMode = 'dialogue' | 'runs'
export interface SessionPosition {
  readonly viewNodeId: string | null
  readonly viewMode?: SessionViewMode
  readonly focusedRunId?: string
  readonly follow?: { readonly runId: string; readonly parentNodeId: string | null }
}
