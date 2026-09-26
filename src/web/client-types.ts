import type { ApplyPatchResult } from '../tool/apply-patch-types.js'

export interface AgentView { readonly id: string }
export interface SessionView {
  readonly id: string
  readonly projectId: string
  readonly agentId: string
  readonly createdAt: string
}
export type RunStatus = 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed' | 'interrupted'
export interface ProjectView {
  readonly id: string
  readonly path: string
  readonly name: string
  readonly available: boolean
}
export interface RunView {
  readonly id: string
  readonly sessionId: string
  readonly input: string
  readonly status: RunStatus
  readonly resultNodeId?: string
  readonly history: { readonly kind: 'tree'; readonly parentNodeId: string | null } | { readonly kind: 'legacy-unknown' }
  readonly revision: number
  readonly createdAt: string
  readonly output?: string
  readonly error?: string
  readonly errorCategory?: string
}
export type ToolCallView =
  | { readonly id: string; readonly name: 'bash'; readonly command: string }
  | { readonly id: string; readonly name: 'apply_patch'; readonly patch: string; readonly patchTruncated: boolean }
export type RunEventView = { readonly seq: number; readonly at: string } & (
  | { readonly kind: 'model-started' | 'terminal' | 'interrupted' }
  | { readonly kind: 'model-tool-calls'; readonly calls: readonly ToolCallView[] }
  | ({ readonly kind: 'tool-started'; readonly requestId: string } & ToolCallView)
  | { readonly kind: 'tool-observed'; readonly name: 'bash'; readonly requestId: string;
      readonly exitCode: number | null; readonly signal: string | null; readonly stdout: string;
      readonly stderr: string; readonly truncated: boolean }
  | { readonly kind: 'tool-observed'; readonly name: 'apply_patch'; readonly requestId: string;
      readonly result: ApplyPatchResult }
  | { readonly kind: 'tool-failed'; readonly name: 'bash' | 'apply_patch'; readonly requestId: string;
      readonly category: string; readonly result?: ApplyPatchResult }
)
export type ToolTraceState = 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled' | 'interrupted' |
  ApplyPatchResult['status']
interface ToolTraceBase { readonly id: string; state: ToolTraceState; category?: string }
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
  readonly sessionId: string
  readonly input: string
  readonly idempotencyKey: string
  readonly parentNodeId?: string | null
  readonly runId?: string
}
export interface ApiError extends Error { readonly status: number; readonly code: string }
export interface CredentialView {
  readonly id: string
  readonly label: string
  readonly category: string
  readonly configured: boolean
}

export type Api = <T>(path: string, body?: object, signal?: AbortSignal) => Promise<T>

export interface NodeView {
  readonly id: string
  readonly sessionId: string
  readonly parentId: string | null
  readonly input: string
  readonly output: string
  readonly sourceRunId: string | null
}
export interface NodePage { readonly nodes: readonly NodeView[]; readonly nextCursor?: string }
export interface SessionPosition {
  readonly viewNodeId: string | null
  readonly focusedRunId?: string
  readonly follow?: { readonly runId: string; readonly parentNodeId: string | null }
}
