import type { FileSelection, FileRef } from '../core/project-files/domain.js'
import type { ApplyPatchResult } from '../core/tool/apply-patch-types.js'
import type { ImageRef } from '../core/image/port.js'
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
export type ToolTrace = BashTrace | ApplyPatchTrace
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
