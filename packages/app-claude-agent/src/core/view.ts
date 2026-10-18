/** Versioned, whitelisted projections shared by HTTP, SSE and the browser. No SDK object crosses this boundary. */
export const defaultSessionOptions: import('./workspace.js').SessionOptions = Object.freeze({ maxBudgetUsd: null, maxTurns: null, fallbackModel: null, checkpointing: true, mcpServers: Object.freeze({}) })
export type ClaudeAgentRunStatus = 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export type ClaudeAgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const claudeAgentEfforts: readonly ClaudeAgentEffort[] = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'])
export type PermissionModeView = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk'
export const permissionModes: readonly PermissionModeView[] = Object.freeze(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk'])
export interface CapabilitiesView {
  readonly schemaVersion: 1
  readonly source: 'project' | 'run'
  readonly permissionMode: string
  readonly skills: readonly { readonly name: string; readonly description: string; readonly argumentHint: string; readonly builtin: boolean }[]
  readonly agents: readonly { readonly name: string; readonly description: string; readonly model: string | null }[]
  readonly mcp: readonly { readonly name: string; readonly status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'; readonly source: string | null; readonly tools: readonly string[] }[]
}
export interface QueuedMessageView { readonly id: string; readonly runId: string; readonly prompt: string; readonly attachments: readonly import('./attachments.js').AttachmentView[]; readonly status: 'queued' | 'sent' | 'completed' | 'failed' | 'cancelled' | 'unknown'; readonly createdAt: string }
export interface ToolProgressView { readonly id: string; readonly name: string; readonly elapsedSeconds: number; readonly parentToolUseId: string | null; readonly taskId?: string; readonly done?: boolean }
export type RunControlInput =
  | { readonly action: 'background-tasks'; readonly toolUseId?: string }
  | { readonly action: 'mcp-set'; readonly servers: import('./workspace.js').SessionOptions['mcpServers'] }
  | { readonly action: 'mcp-permission'; readonly name: string; readonly mode: 'default' | 'auto' | null }
  | { readonly action: 'permission-mode'; readonly mode: PermissionModeView }
  | { readonly action: 'reload-skills' }
  | { readonly action: 'mcp-reconnect'; readonly name: string }
  | { readonly action: 'mcp-toggle'; readonly name: string; readonly enabled: boolean }
  | { readonly action: 'stop-task'; readonly taskId: string }
export interface AgentTaskView {
  readonly id: string
  readonly generation?: string
  readonly toolUseId?: string
  readonly description?: string
  readonly agentType?: string
  readonly taskType?: string
  readonly status?: 'running' | 'pending' | 'paused' | 'completed' | 'failed' | 'stopped'
  readonly summary?: string
  readonly lastTool?: string
  readonly tokens?: number
  readonly toolUses?: number
  readonly durationMs?: number
}

export interface EnvironmentView {
  readonly schemaVersion: 1
  readonly platform: string
  readonly executable: {
    readonly path: string | null
    readonly source: 'override' | 'path' | 'fallback' | null
    readonly error?: { readonly code: string; readonly message: string }
  }
}
/** Who named the thread: the directory name, the first prompt, the Claude environment's own session title, or the user (never overwritten). */
export type ThreadTitleSource = 'default' | 'prompt' | 'claude' | 'user'
export interface ThreadView { readonly deleted?: boolean;
  readonly optionsRevision?: number
  readonly options?: import('./workspace.js').SessionOptions
  readonly archived?: boolean
  readonly tag?: string | null
  readonly forkedFrom?: string | null
  readonly permissionMode?: PermissionModeView
  readonly schemaVersion: 1
  readonly id: string
  readonly projectPath: string
  readonly title: string
  readonly titleSource: ThreadTitleSource
  readonly nativeSessionId: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastRun: { readonly id: string; readonly status: ClaudeAgentRunStatus } | null
  /** Approvals waiting for an answer in this thread's active Run; in-memory, so 0 after a restart. */
  readonly pendingApprovals: number
}
export interface RunUsageView {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadInputTokens: number
  readonly cacheCreationInputTokens: number
}
export interface RunResultView {
  readonly modelUsage?: readonly { readonly model: string; readonly inputTokens: number; readonly outputTokens: number; readonly costUsd: number; readonly thinkingTokens?: number; readonly cacheReadTokens?: number; readonly cacheWriteTokens?: number; readonly webSearchRequests?: number; readonly provider?: string; readonly costBasis?: string }[]
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
  readonly attachments?: readonly import('./attachments.js').AttachmentView[]
  readonly options?: import('./workspace.js').SessionOptions
  readonly contextUsage?: import('./workspace.js').ContextUsage | null
  readonly permissionMode?: PermissionModeView
  readonly schemaVersion: 1
  readonly id: string
  readonly threadId: string
  readonly status: ClaudeAgentRunStatus
  readonly prompt: string
  readonly model: string | null
  /** Model the agent reported in its init frame; the CLI default when `model` was not given. */
  readonly resolvedModel: string | null
  readonly effort: ClaudeAgentEffort | null
  readonly nativeSessionId: string | null
  readonly createdAt: string
  readonly finishedAt: string | null
  readonly result: RunResultView | null
  readonly error: RunErrorView | null
}
/** Older installed clients use these history suggestions; current availability is AvailableModelsView. */
export interface RecentModelsView { readonly schemaVersion: 1; readonly models: readonly string[] }
/** Models the execution device's current Claude environment advertises for the selected project. */
export interface AvailableModelView {
  readonly value: string
  readonly displayName: string
  readonly description: string
  readonly resolvedModel?: string
  readonly supportsEffort?: boolean
  readonly supportedEffortLevels?: readonly ClaudeAgentEffort[]
}
export interface AvailableModelsView { readonly schemaVersion: 1; readonly models: readonly AvailableModelView[] }
export type ApprovalDecision = 'allow' | 'allow-session' | 'deny'
export interface SessionPermissionsView {
  readonly schemaVersion: 1
  readonly threadId: string
  readonly grants: readonly { readonly id: string; readonly rules: readonly string[]; readonly createdAt: string }[]
  readonly canRevoke: boolean
}
export type ApprovalOutcome = ApprovalDecision | 'cancelled'
export interface ApprovalQuestionView {
  readonly question: string
  readonly header: string
  readonly options: readonly { readonly label: string; readonly description: string }[]
  readonly multiSelect: boolean
}
export interface ApprovalView {
  /** Exact CLI suggestions, for display only; native updates remain inside the SDK adapter. */
  readonly rememberRules?: readonly string[]
  readonly blockedPath?: string | null
  readonly rememberUnavailableReason?: string | null
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
  | { readonly kind: 'attachment'; readonly name: string; readonly mime: string }
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
  | { readonly type: 'mcp-configuration'; readonly servers: import('./workspace.js').SessionOptions['mcpServers'] }
  | { readonly type: 'input'; readonly message: QueuedMessageView }
  | { readonly type: 'tool-progress'; readonly progress: ToolProgressView }
  | { readonly type: 'background-tasks'; readonly ids: readonly string[] }
  | { readonly type: 'auth'; readonly authenticating: boolean; readonly failed: boolean }
  | { readonly type: 'agent-stream'; readonly parentToolUseId: string; readonly event: { readonly type: 'start' | 'delta' | 'stop'; readonly messageId: string; readonly index?: number; readonly block?: 'text' | 'thinking' | 'tool_use'; readonly toolUseId?: string; readonly name?: string; readonly text?: string } }
  | { readonly type: 'context'; readonly context: import('./workspace.js').ContextUsage }
  | { readonly type: 'checkpoint'; readonly messageId: string }
  | { readonly type: 'permission-mode'; readonly mode: string }
  | { readonly type: 'task'; readonly task: AgentTaskView }
  | { readonly type: 'agent-message'; readonly parentToolUseId: string; readonly message: TranscriptItemView }
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
  readonly mcpServers?: import('./workspace.js').SessionOptions['mcpServers']
  readonly inputs?: readonly QueuedMessageView[]
  readonly toolProgress?: readonly ToolProgressView[]
  readonly backgroundTaskIds?: readonly string[]
  readonly auth?: { readonly authenticating: boolean; readonly failed: boolean }
  readonly contextUsage?: import('./workspace.js').ContextUsage
  readonly tasks?: readonly AgentTaskView[]
  readonly agentMessages?: readonly { readonly parentToolUseId: string; readonly message: TranscriptItemView }[]
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
export interface ThreadMessagesView { readonly hasMore?: boolean; readonly nextOffset?: number; readonly previousOffset?: number|null; readonly nativeSessionId: string | null; readonly messages: readonly HistoryMessageView[] }
/** A project directory recently used on the execution device: by this application's threads, by the Claude environment, or both. */
export interface RecentProjectView {
  readonly path: string
  readonly name: string
  readonly lastUsedAt: string
  readonly source: 'threads' | 'claude' | 'both'
}
/** `partial` is true when the Claude environment's session list could not be read and only thread directories are included. */
export interface RecentProjectsView { readonly schemaVersion: 1; readonly projects: readonly RecentProjectView[]; readonly partial: boolean }
export interface DirectoryEntryView { readonly name: string; readonly path: string }
/** Subdirectories of one directory on the execution device; symbolic links are not followed and the list is bounded. */
export interface DirectoryListingView {
  readonly schemaVersion: 1
  readonly path: string
  readonly parent: string | null
  readonly entries: readonly DirectoryEntryView[]
  readonly truncated: boolean
}
