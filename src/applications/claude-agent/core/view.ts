/** Versioned, whitelisted projections shared by HTTP, SSE and the browser. No SDK object crosses this boundary. */
export type ClaudeAgentRunStatus = 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export type ClaudeAgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const claudeAgentEfforts: readonly ClaudeAgentEffort[] = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'])

export interface EnvironmentView {
  readonly schemaVersion: 1
  readonly platform: string
  readonly executable: {
    readonly path: string | null
    readonly source: 'override' | 'path' | 'fallback' | null
    readonly error?: { readonly code: string; readonly message: string }
  }
}
export interface ThreadView {
  readonly schemaVersion: 1
  readonly id: string
  readonly projectPath: string
  readonly title: string
  readonly nativeSessionId: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastRun: { readonly id: string; readonly status: ClaudeAgentRunStatus } | null
}
export interface RunUsageView {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadInputTokens: number
  readonly cacheCreationInputTokens: number
}
export interface RunResultView {
  readonly subtype: string
  readonly isError: boolean
  readonly durationMs: number
  readonly durationApiMs: number
  readonly numTurns: number
  readonly totalCostUsd: number
  readonly usage: RunUsageView
  readonly stopReason: string | null
  readonly text?: string
  readonly errors?: readonly string[]
}
export interface RunErrorView { readonly code: string; readonly message: string }
export interface RunView {
  readonly schemaVersion: 1
  readonly id: string
  readonly threadId: string
  readonly status: ClaudeAgentRunStatus
  readonly prompt: string
  readonly model: string | null
  readonly effort: ClaudeAgentEffort | null
  readonly nativeSessionId: string | null
  readonly createdAt: string
  readonly finishedAt: string | null
  readonly result: RunResultView | null
  readonly error: RunErrorView | null
}
export type ApprovalDecision = 'allow' | 'allow-session' | 'deny'
export type ApprovalOutcome = ApprovalDecision | 'cancelled'
export interface ApprovalQuestionView {
  readonly question: string
  readonly header: string
  readonly options: readonly { readonly label: string; readonly description: string }[]
  readonly multiSelect: boolean
}
export interface ApprovalView {
  readonly schemaVersion: 1
  readonly id: string
  readonly runId: string
  readonly threadId: string
  readonly toolUseId: string
  readonly toolName: string
  readonly kind: 'permission' | 'question'
  readonly title: string | null
  readonly description: string | null
  readonly reason: string | null
  /** JSON tool input, bounded for display; the agent keeps the authoritative copy. */
  readonly input: unknown
  readonly inputTruncated: boolean
  readonly questions: readonly ApprovalQuestionView[] | null
  readonly allowSessionAvailable: boolean
  readonly defaultToNo: boolean
  readonly requestedAt: string
  readonly decision: ApprovalOutcome | null
  readonly answers: Readonly<Record<string, string>> | null
  readonly resolvedAt: string | null
}
export type TranscriptBlockView =
  | { readonly kind: 'text'; readonly text: string; readonly truncated: boolean }
  | { readonly kind: 'thinking'; readonly text: string; readonly truncated: boolean }
  | { readonly kind: 'tool_use'; readonly toolUseId: string; readonly name: string; readonly input: unknown; readonly inputTruncated: boolean }
  | { readonly kind: 'tool_result'; readonly toolUseId: string; readonly text: string; readonly isError: boolean; readonly truncated: boolean }
  | { readonly kind: 'unsupported'; readonly type: string }
export interface TranscriptItemView {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly blocks: readonly TranscriptBlockView[]
}
export interface HistoryMessageView extends TranscriptItemView {}
export interface RunInitView {
  readonly nativeSessionId: string
  readonly model: string
  readonly cwd: string
  readonly permissionMode: string
  readonly claudeCodeVersion: string
  readonly toolCount: number
}
export interface RunNoticeView { readonly code: string; readonly message: string }
/** Events in the order the agent produced them. `seq` numbers them per Run. */
export type RunEventView =
  | { readonly type: 'init'; readonly init: RunInitView }
  | { readonly type: 'message-start'; readonly messageId: string }
  | { readonly type: 'block-start'; readonly messageId: string; readonly index: number; readonly block: 'text' | 'thinking' | 'tool_use'; readonly toolUseId?: string; readonly name?: string }
  | { readonly type: 'text-delta'; readonly messageId: string; readonly index: number; readonly text: string }
  | { readonly type: 'thinking-delta'; readonly messageId: string; readonly index: number; readonly text: string }
  | { readonly type: 'block-stop'; readonly messageId: string; readonly index: number }
  | { readonly type: 'assistant'; readonly messageId: string; readonly blocks: readonly TranscriptBlockView[] }
  | { readonly type: 'tool-result'; readonly toolUseId: string; readonly text: string; readonly isError: boolean; readonly truncated: boolean }
  | { readonly type: 'approval-requested'; readonly approval: ApprovalView }
  | { readonly type: 'approval-resolved'; readonly approval: ApprovalView }
  | { readonly type: 'status'; readonly status: 'compacting' | 'requesting' | null }
  | { readonly type: 'compact'; readonly trigger: 'manual' | 'auto'; readonly preTokens: number }
  | { readonly type: 'notice'; readonly notice: RunNoticeView }
  | { readonly type: 'result'; readonly result: RunResultView }
  | { readonly type: 'error'; readonly error: RunErrorView }
  | { readonly type: 'exit'; readonly code: number | null; readonly signal: string | null }
export interface LiveBlockView { readonly block: TranscriptBlockView; readonly state: 'streaming' | 'closed' | 'final' }
export interface LiveItemView { readonly id: string; readonly role: 'user' | 'assistant'; readonly blocks: readonly LiveBlockView[] }
/** Accumulated view of one Run, rebuilt by folding `RunEventView` in order. Bounded; never a recovery fact. */
export interface RunLiveView {
  readonly schemaVersion: 1
  readonly runId: string
  readonly threadId: string
  readonly seq: number
  readonly init: RunInitView | null
  readonly items: readonly LiveItemView[]
  readonly approvals: readonly ApprovalView[]
  readonly notices: readonly RunNoticeView[]
  readonly modelStatus: 'compacting' | 'requesting' | null
  readonly result: RunResultView | null
  readonly error: RunErrorView | null
}
export interface RunChangedView { readonly threadId: string; readonly runId: string; readonly status: ClaudeAgentRunStatus; readonly seq: number }
export interface RunEventFrameView { readonly threadId: string; readonly runId: string; readonly seq: number; readonly event: RunEventView }
export interface ThreadMessagesView { readonly nativeSessionId: string | null; readonly messages: readonly HistoryMessageView[] }
