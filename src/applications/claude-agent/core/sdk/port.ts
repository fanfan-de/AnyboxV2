import type { ApprovalQuestionView, ClaudeAgentEffort, EnvironmentView, HistoryMessageView, RunErrorView, RunEventView, RunResultView } from '../view.js'

export const claudeAgentSdkServiceKey = 'claude-agent.sdk'
/** Events the adapter produces; approval events are added by the runs component, which owns approval identity. */
export type SdkRunEvent = Exclude<RunEventView, { type: 'approval-requested' } | { type: 'approval-resolved' }>
export interface SdkRunRequest {
  readonly cwd: string
  readonly prompt: string
  /** Native session to continue; null starts a new session whose id arrives with the `init` event. */
  readonly resume: string | null
  readonly model?: string
  readonly effort?: ClaudeAgentEffort
}
export interface SdkPermissionRequest {
  readonly toolUseId: string
  readonly toolName: string
  readonly input: Readonly<Record<string, unknown>>
  readonly title: string | null
  readonly description: string | null
  readonly reason: string | null
  readonly defaultToNo: boolean
  readonly allowSessionAvailable: boolean
  /** Present for AskUserQuestion; the decision then carries answers instead of a plain allow. */
  readonly questions: readonly ApprovalQuestionView[] | null
  /** Aborted by the agent when the turn stops waiting for this answer. */
  readonly signal: AbortSignal
}
export type SdkPermissionDecision =
  | { readonly behavior: 'allow'; readonly session?: boolean; readonly answers?: Readonly<Record<string, string>> }
  | { readonly behavior: 'deny'; readonly message: string }
export interface SdkRunHooks {
  onEvent(event: SdkRunEvent): void
  canUseTool(request: SdkPermissionRequest): Promise<SdkPermissionDecision>
}
export type SdkRunOutcome =
  | { readonly kind: 'result'; readonly result: RunResultView }
  | { readonly kind: 'failed'; readonly error: RunErrorView }
/** `result` is the business outcome; `done` settles only after the agent process has actually exited. Neither rejects. */
export interface SdkRunHandle {
  readonly result: Promise<SdkRunOutcome>
  readonly done: Promise<void>
  /** Asks the agent to end the current turn gracefully; resolves when the request was delivered or the process is gone. */
  interrupt(): Promise<void>
  /** Terminates the process; `done` still reports the actual exit. */
  close(): void
}
/** One project directory the Claude environment recorded a session in, with the newest session's modification time. */
export interface SdkSessionProject { readonly path: string; readonly lastUsedAt: string }
/** The Claude environment's own title for a session: custom title, then summary, then first prompt. */
export interface SdkSessionInfo { readonly title: string | null }
export interface ClaudeAgentSdkPort {
  environment(): EnvironmentView
  /** Throws a ClaudeAgentError synchronously when no executable is available or the adapter is closing. */
  openRun(request: SdkRunRequest, hooks: SdkRunHooks): SdkRunHandle
  readSessionMessages(sessionId: string, dir: string, signal?: AbortSignal): Promise<readonly HistoryMessageView[]>
  /** Distinct project directories of the environment's interactive sessions, newest first. */
  listSessionProjects(signal?: AbortSignal): Promise<readonly SdkSessionProject[]>
  /** Undefined when the session file is missing or has no title yet. */
  readSessionInfo(sessionId: string, dir: string, signal?: AbortSignal): Promise<SdkSessionInfo | undefined>
}
