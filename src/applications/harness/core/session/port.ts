import type { FileSelection, FileContent, FileRef, FileSearch, FilePreview, FileRenewal, FileTreePage } from '../project-files/domain.js'
import type { Session, SessionDefaults, ConversationNode, NodePage, NodeQuery } from './domain.js'
import type { Run, RunInput, RunOutcome, RunQuery } from '../run/domain.js'
import type { RunEvent, RunExecution } from '../run/execution.js'
import type { NativeModelSnapshot, JsonValue } from '@anybox/models'
import type { ProtocolBindingSnapshot, NativeInitialization, NativeRunInput, NativeHistory, StoredProtocolRecord, ProtocolRecord } from '../run/program.js'
import type { ValidatedToolRequest, ToolObservation, RunFailureCategory } from '../run/domain.js'
import type { PromptSnapshot } from '../prompt/domain.js'
import type { OwnedCall } from '../contracts.js'
import type { ImageRef, ImageRenewal } from '../image/port.js'

export const sessionServiceKey = 'harness.sessions'
export const sessionRunServiceKey = 'harness.session-runs'

/** Public session facts. Run commands and in-flight resources belong to the execution components. */
export interface SessionPort {
  openProjectFileTree(sessionId: string, path: string, owner: string, signal?: AbortSignal): OwnedCall<FileTreePage>
  readProjectFileTreePage(sessionId: string, owner: string, cursorId: string, page: number, signal?: AbortSignal): OwnedCall<FileTreePage>
  closeProjectFileTree(sessionId: string, owner: string, cursorId: string): Promise<void>
  onProjectFileTreeRetired(listener: (cursorId: string) => void): () => void
  searchProjectFiles(sessionId: string, query: string, signal?: AbortSignal): OwnedCall<FileSearch>
  previewProjectFile(sessionId: string, selection: Extract<FileSelection, { kind: 'project-file' }>, signal?: AbortSignal): OwnedCall<FilePreview>
  prepareProjectFiles(sessionId: string, key: string, selections: readonly FileSelection[], signal?: AbortSignal): OwnedCall<readonly FileRef[]>
  getFileSnapshot(sessionId: string, snapshotId: string, signal?: AbortSignal): OwnedCall<FileContent>
  renewProjectFiles(sessionId: string, ids: readonly string[]): Promise<FileRenewal>
  importImage(sessionId: string, bytes: AsyncIterable<Uint8Array>, signal?: AbortSignal): OwnedCall<ImageRef>
  getImage(sessionId: string, assetId: string, signal?: AbortSignal): OwnedCall<{ readonly image: ImageRef; readonly bytes: Uint8Array }>
  renewImages(sessionId: string, assetIds: readonly string[]): Promise<ImageRenewal>
  getSessionDefaults(agentId: string): Promise<SessionDefaults>
  setSessionDefaults(agentId: string, modelId: string | null, expectedRevision: number): Promise<SessionDefaults>
  createSession(projectId: string, agentId: string, modelId?: string): Promise<Session>
  selectSessionModel(sessionId: string, modelId: string, protocolId?: string): Promise<Session>
  archiveSession(id: string): Promise<Session>
  restoreSession(id: string): Promise<Session>
  listArchivedSessions(): Promise<readonly Session[]>
  getSession(id: string): Promise<Session | undefined>
  listSessions(projectId: string): Promise<readonly Session[]>
  getNode(sessionId: string, id: string): Promise<ConversationNode | undefined>
  getNodePath(sessionId: string, id: string | null): Promise<readonly ConversationNode[]>
  listNodes(sessionId: string, parentId: string | null, query?: NodeQuery): Promise<NodePage>
  getRun(id: string): Promise<Run | undefined>
  getRunByKey(sessionId: string, key: string): Promise<Run | undefined>
  listRuns(sessionId: string, query?: RunQuery): Promise<readonly Run[]>
  getRunEvents(id: string, afterSeq?: number): Promise<readonly RunEvent[] | undefined>
  getRunRecords(id: string): Promise<readonly StoredProtocolRecord[]>
}

/** One read of an accepted Run's durable inputs; no live model plan or provider context. */
export interface RunContext {
  readonly run: Run
  readonly projectId: string
}

/** Trusted execution-facing operations on the same Session owner, not an access boundary. */
export interface SessionRunPort {
  readFileSnapshots(sessionId: string, ids: readonly string[], signal?: AbortSignal): OwnedCall<readonly FileContent[]>
  describeImages(sessionId: string, assetIds: readonly string[]): Promise<readonly ImageRef[]>
  findAcceptedRun(input: RunInput): Promise<Run | undefined>
  registerRun(id: string, input: RunInput, now: string,
    prompts: readonly PromptSnapshot[], model: NativeModelSnapshot, native: NativeRunRegistration): Promise<{ readonly run: Run; readonly created: boolean }>
  loadRunContext(id: string): Promise<RunContext | undefined>
  loadNativeInitialization(sessionId: string): Promise<NativeInitialization | undefined>
  loadNativeHistory(sessionId: string, parentNodeId: string | null): Promise<NativeHistory | undefined>
  startOperation(runId: string, operation: RunOperationStart, at: string): Promise<boolean>
  observeOperation(runId: string, operationId: string, observation: RunOperationObservation, at: string): Promise<void>
  getRun(id: string): Promise<Run | undefined>
  getRunExecution(id: string): Promise<RunExecution | undefined>
  requestCancellation(id: string, now: string): Promise<Run | undefined>
  /** Runtime must observe every owned call's actual exit before requesting a successful settlement. */
  settleRun(id: string, outcome: RunOutcome, now: string): Promise<Run>
}

export interface NativeRunRegistration {
  readonly binding: ProtocolBindingSnapshot
  readonly initialization: NativeInitialization
  readonly input: NativeRunInput
  readonly parentContextRef: string | null
}
export interface RunOperationStart {
  readonly id: string
  readonly kind: 'model' | 'operation' | 'tool'
  readonly intent: JsonValue
  readonly records?: readonly ProtocolRecord[]
  readonly tool?: ValidatedToolRequest
}
export interface RunOperationObservation {
  readonly kind: 'value' | 'error' | 'cleanup-failed'
  readonly records?: readonly ProtocolRecord[]
  readonly checkpoint?: JsonValue
  readonly tool?: ToolObservation
  readonly errorCategory?: RunFailureCategory
}
