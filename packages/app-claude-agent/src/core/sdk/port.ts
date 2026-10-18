import type { ApprovalQuestionView, AvailableModelsView, ClaudeAgentEffort, EnvironmentView, HistoryMessageView, RunErrorView, RunEventView, RunResultView } from '../view.js'
import type { CapabilitiesView, PermissionModeView, RunControlInput } from '../view.js'
import type { SessionPermissionSpec } from '../permissions.js'
import type { SessionOptions, SessionInspection, SessionInspectionResult, ElicitationView, ElicitationAnswer } from '../workspace.js'

export const claudeAgentSdkServiceKey = 'claude-agent.sdk'
/** Events the adapter produces; approval events are added by the runs component, which owns approval identity. */
export type SdkRunEvent = Exclude<RunEventView, { type: 'approval-requested' } | { type: 'approval-resolved' }>
export interface SdkRunRequest {
  readonly options?: SessionOptions
  readonly sessionPermissions?: SessionPermissionSpec
  readonly permissionMode?: PermissionModeView
  readonly cwd: string
  readonly attachments?: readonly import('../attachments.js').AttachmentData[]
  readonly prompt: string
  /** Native session to continue; null starts a new session whose id arrives with the `init` event. */
  readonly resume: string | null
  readonly model?: string
  readonly effort?: ClaudeAgentEffort
}
export interface SdkPermissionRequest {
  readonly reusablePermissions?: SessionPermissionSpec
  readonly rememberRules?: readonly string[]
  readonly blockedPath?: string | null
  readonly rememberUnavailableReason?: string | null
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
  onElicitation?(request: Omit<ElicitationView, 'id' | 'threadId'>, signal: AbortSignal): Promise<ElicitationAnswer>
  onEvent(event: SdkRunEvent): void
  canUseTool(request: SdkPermissionRequest): Promise<SdkPermissionDecision>
}
export type SdkRunOutcome =
  | { readonly kind: 'result'; readonly result: RunResultView }
  | { readonly kind: 'failed'; readonly error: RunErrorView }
/** `result` is the business outcome; `done` settles only after the agent process has actually exited. Neither rejects. */
export interface SdkRunHandle {
  enqueue?(message: import('../view.js').QueuedMessageView, attachments: readonly import('../attachments.js').AttachmentData[]): void
  cancelInput?(id: string): boolean
  inspect?(input: SessionInspection): Promise<SessionInspectionResult>
  capabilities?(): Promise<CapabilitiesView>
  control?(input: RunControlInput): Promise<void>
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
  readAccountUsage?(cwd?: string, signal?: AbortSignal): Promise<import('../account.js').AccountUsageView>
  inspectSession?(request: SdkRunRequest, input: SessionInspection, hooks: Pick<SdkRunHooks, 'onElicitation'>, signal?: AbortSignal): Promise<SessionInspectionResult>
  listNativeSessions?(dir:string,offset:number,signal?:AbortSignal):Promise<readonly {sessionId:string;title:string;updatedAt:string}[]>
  readSessionPage?(sessionId:string,dir:string,offset:number,signal?:AbortSignal):Promise<{messages:readonly HistoryMessageView[];hasMore:boolean;nextOffset:number;previousOffset?:number|null}>
  listSubagents?(sessionId: string, dir: string, signal?: AbortSignal): Promise<readonly string[]>
  readSubagentMessages?(sessionId: string, dir: string, agentId: string, offset: number, signal?: AbortSignal): Promise<{ readonly messages: readonly HistoryMessageView[]; readonly hasMore: boolean }>
  mutateSession?(sessionId: string, dir: string, input: { readonly action: 'rename' | 'tag'; readonly value: string } | { readonly action: 'fork'; readonly messageId?: string; readonly title: string } | { readonly action: 'delete' }, signal?: AbortSignal): Promise<{ readonly sessionId?: string }>
  listCapabilities?(cwd?: string, signal?: AbortSignal): Promise<CapabilitiesView>
  environment(): EnvironmentView
  /** Initializes the environment without sending a prompt; resolves only after the discovery process exits. */
  listAvailableModels(cwd?: string, signal?: AbortSignal): Promise<AvailableModelsView>
  /** Throws a ClaudeAgentError synchronously when no executable is available or the adapter is closing. */
  openRun(request: SdkRunRequest, hooks: SdkRunHooks): SdkRunHandle
  readSessionMessages(sessionId: string, dir: string, signal?: AbortSignal): Promise<readonly HistoryMessageView[]>
  /** Distinct project directories of the environment's interactive sessions, newest first. */
  listSessionProjects(signal?: AbortSignal): Promise<readonly SdkSessionProject[]>
  /** Undefined when the session file is missing or has no title yet. */
  readSessionInfo(sessionId: string, dir: string, signal?: AbortSignal): Promise<SdkSessionInfo | undefined>
}
