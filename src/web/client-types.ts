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
export interface RunEventView {
  readonly seq: number
  readonly at: string
  readonly kind: 'model-started' | 'model-tool-calls' | 'bash-started' | 'bash-observed' |
    'bash-failed' | 'terminal' | 'interrupted'
  readonly calls?: readonly { readonly id: string; readonly name: string; readonly command: string }[]
  readonly requestId?: string
  readonly command?: string
  readonly exitCode?: number | null
  readonly signal?: string | null
  readonly stdout?: string
  readonly stderr?: string
  readonly truncated?: boolean
  readonly category?: string
}
export interface BashTrace {
  readonly id: string
  readonly command: string
  state: 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled' | 'interrupted'
  exitCode?: number | null
  signal?: string | null
  stdout?: string
  stderr?: string
  truncated?: boolean
  category?: string
}
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
