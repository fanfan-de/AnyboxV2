import type { ActivityLease, ProductActivityPort } from '../../../host/applications/contracts.js'
import type { ApplicationHttpPort, ApplicationHttpContext } from '../../../host/applications/registration.js'
import type { SessionView, RunView, ProcessExitView } from '../core/api.js'
import { handleModelsApi } from './models-api.js'
import { failure, json, requestObject } from '../../../host/http-utils.js'
import { promptRevision } from './validation.js'
import type { SessionPort } from '../core/session/port.js'
import { validateFileSelections, validateSnapshotIds, validateFileTreePath, validId } from '../core/project-files/domain.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { OwnedCall } from '../core/contracts.js'
import type { ImageRef } from '../core/image/port.js'
import { imageLimits } from '../core/image/limits.js'
import type { Run } from '../core/run/domain.js'
import type { Session, SessionDefaults, AgentToolsSelection, AgentToolsInput } from '../core/session/domain.js'
import type { listTools } from '../core/tool/catalog.js'
import type { RunInput, RunQuery } from '../core/run/domain.js'
import type { ConversationNode, NodePage, NodeQuery } from '../core/session/domain.js'
import type { RunEvent } from '../core/run/execution.js'
import type { ValidatedToolRequest } from '../core/run/domain.js'
import { isModelsError } from '@anybox/models'
import { isModelFailure } from '../core/run/model.js'
import type { ModelsSettingsService, ModelsCatalogService, RunnableModelSummary, ProviderTemplate } from '@anybox/models'
import { isProjectUnavailableError } from '../core/project/component.js'
import type { Project } from '../core/project/component.js'
import type { DirectoryBrowseOptions, DirectoryBrowseOpened, DirectoryCreated, DirectoryPage } from '../core/project/directories.js'
import { DirectoryPickerFailure } from '../client/directory-picker.js'
import { openRunChangeStream } from './run-change-stream.js'
import type { RunChangeStream } from './run-change-stream.js'
import type { RunChange } from '../core/run/notifications.js'
import type { ProtocolViewFrame, ProtocolViewSnapshot } from '../core/view/types.js'
import type { PromptBinding, PromptCreateInput, PromptDocument, PromptEditInput,
  PromptSnapshot, PromptVersion } from '../core/prompt/domain.js'

export interface HarnessServerApiCommands extends Pick<SessionPort, 'searchProjectFiles' | 'previewProjectFile' | 'prepareProjectFiles' | 'getFileSnapshot' | 'renewProjectFiles' |
  'openProjectFileTree' | 'readProjectFileTreePage' | 'closeProjectFileTree' | 'onProjectFileTreeRetired'> {
  listAgents(): readonly { readonly id: string }[]
  listTools(): ReturnType<typeof listTools>
  directoryPickerSupported(): boolean
  directoryBrowsingSupported(): boolean
  directoryCreationSupported(): boolean
  openDirectoryBrowse(owner: string, input: DirectoryBrowseOptions, signal?: AbortSignal): OwnedCall<DirectoryBrowseOpened>
  readDirectoryPage(owner: string, browseId: string, page: number, signal?: AbortSignal): OwnedCall<DirectoryPage>
  createDirectory(owner: string, browseId: string, name: string, signal?: AbortSignal): OwnedCall<DirectoryCreated>
  closeDirectoryBrowse(owner: string, browseId: string): Promise<void>
  onDirectoryBrowseRetired(listener: (browseId: string) => void): () => void
  pickProject(signal: AbortSignal): Promise<Project | null>
  openProject?(path: string): Promise<Project>
  listProjects(): Promise<readonly Project[]>
  createSession(projectId: string, agentId: string, modelId?: string): Promise<Session>
  getSessionDefaults(agentId: string): Promise<SessionDefaults>
  setSessionDefaults(agentId: string, modelId: string | null, expectedRevision: number): Promise<SessionDefaults>
  getAgentTools(agentId: string): Promise<AgentToolsSelection>
  setAgentTools(agentId: string, input: AgentToolsInput): Promise<AgentToolsSelection>
  selectSessionModel(sessionId: string, modelId: string): Promise<Session>
  archiveSession(id: string): Promise<Session>
  restoreSession(id: string): Promise<Session>
  listArchivedSessions(): Promise<readonly Session[]>
  getSession(id: string): Promise<Session | undefined>
  listSessions(projectId: string): Promise<readonly Session[]>
  getNode(sessionId: string, id: string): Promise<ConversationNode | undefined>
  getNodePath(sessionId: string, id: string | null): Promise<readonly ConversationNode[]>
  listNodes(sessionId: string, parentId: string | null, query?: NodeQuery): Promise<NodePage>
  getRunByKey(sessionId: string, key: string): Promise<Run | undefined>
  waitRun(id: string, signal?: AbortSignal): Promise<Run | undefined>
  startRun(input: RunInput): Promise<Run>
  importImage(sessionId: string, bytes: AsyncIterable<Uint8Array>, signal?: AbortSignal): OwnedCall<ImageRef>
  getImage(sessionId: string, assetId: string, signal?: AbortSignal): OwnedCall<{ readonly image: ImageRef; readonly bytes: Uint8Array }>
  renewImages(sessionId: string, assetIds: readonly string[]): Promise<{ readonly valid: readonly ImageRef[]; readonly invalid: readonly string[] }>
  getRun(id: string): Promise<Run | undefined>
  getRunView(id: string): Promise<ProtocolViewSnapshot | undefined>
  listRuns(sessionId: string, query?: RunQuery): Promise<readonly Run[]>
  getRunEvents(id: string, afterSeq?: number): Promise<readonly RunEvent[] | undefined>
  cancelRun(id: string): Promise<Run | undefined>
  readonly modelsSettings: ModelsSettingsService
  readonly modelsCatalog: ModelsCatalogService
  listModels(): readonly RunnableModelSummary[]
  modelTemplates(): readonly ProviderTemplate[]
  listPrompts(): readonly PromptDocument[]
  getPrompt(id: string): PromptDocument | undefined
  createPrompt(input: PromptCreateInput): Promise<PromptDocument>
  editPrompt(id: string, revision: number, patch: PromptEditInput): Promise<PromptDocument>
  publishPrompt(id: string, revision: number): Promise<PromptVersion>
  getPromptVersions(id: string): readonly PromptVersion[]
  getAgentPrompts(id: string): readonly PromptSnapshot[]
  bindPrompt(id: string, versionId: string): Promise<PromptBinding>
}

export interface HarnessServerHttpHandler extends ApplicationHttpPort {
  notifyRunChange(change: RunChange): void
  notifyProtocolView(progress: ProtocolViewFrame): void
  close(): Promise<void>
}

interface HttpFailure extends Error {
  readonly status: number
  readonly code: string
}



function isFailure(error: unknown): error is HttpFailure {
  return error instanceof Error && 'status' in error && 'code' in error
}

function knownFailure(error: unknown): HttpFailure {
  if (isFailure(error)) return error
  if (error instanceof URIError) return failure(400, 'invalid-input')
  if (error instanceof TypeError) return failure(400, 'invalid-input')
  if (isModelsError(error)) {
    const status = error.code === 'conflict' || error.code === 'busy' ? 409
      : error.code === 'not-found' ? 404
      : error.code === 'invalid-config' || error.code === 'capability-unsupported' ? 400
      : error.code === 'timeout' ? 504 : 503
    return failure(status, error.code)
  }
  if (isModelFailure(error)) return failure(error.category === 'model-unavailable' ? 409
    : error.category === 'unsupported-request' ? 400 : error.category === 'timeout' ? 504 : 503, error.category)
  if (isProjectUnavailableError(error)) return failure(409, 'project-unavailable')
  if (error instanceof DirectoryPickerFailure) {
    if (error.code === 'busy') return failure(409, 'picker-busy')
    if (error.code === 'unsupported') return failure(503, 'picker-unsupported')
    return failure(503, 'picker-unavailable')
  }
  if (error instanceof Error) {
    if (error.name === 'DirectoryBrowseFailure' && 'code' in error) {
      const code = String(error.code)
      return failure(code === 'directory-permission-denied' ? 403 : code === 'directory-missing' ? 404
        : ['directory-browse-expired', 'directory-browse-conflict', 'directory-exists'].includes(code) ? 409
        : ['directory-browse-invalid', 'directory-not-directory', 'directory-link-loop', 'directory-name-invalid'].includes(code) ? 400 : 503, code)
    }
    if (error.name === 'ProjectFileError' && 'code' in error) {
      const code = String(error.code)
      return failure(code === 'file-too-large' ? 413 : code === 'file-missing' ? 404
        : ['file-expired', 'file-changed', 'file-preparation-conflict', 'file-tree-expired', 'file-tree-conflict', 'file-tree-busy'].includes(code) ? 409
        : ['file-invalid', 'file-range-invalid', 'file-unsupported', 'file-corrupt'].includes(code) ? 400 : 503, code)
    }
    if (error.name === 'ImageAssetError' && 'code' in error) {
      const code = String(error.code)
      return failure(code === 'asset-too-large' ? 413 : code === 'asset-missing' ? 404 : code === 'asset-expired' ? 409
        : ['asset-invalid', 'asset-unsupported', 'asset-corrupt'].includes(code) ? 400 : 503, code)
    }
    if (/^unknown (agent|session|project|prompt) /.test(error.message)) return failure(404, 'not-found')
    if (error.message === 'prompt draft revision conflict') return failure(409, 'prompt-conflict')
    if (error.message === 'prompt draft has no unpublished changes') return failure(409, 'prompt-publication-conflict')
    if (error.message === 'prompt access denied' || error.message === 'agent configuration access denied') {
      return failure(403, 'prompt-forbidden')
    }
    if ('code' in error && error.code === 'node-not-found') return failure(404, 'node-not-found')
    if ('code' in error && error.code === 'invalid-history') return failure(409, 'invalid-history')
    if ('code' in error && error.code === 'session-defaults-conflict') return failure(409, 'session-defaults-conflict')
    if ('code' in error && error.code === 'agent-tools-conflict') return failure(409, 'agent-tools-conflict')
    if ('code' in error && ['session-archived', 'session-has-active-runs', 'legacy-session-readonly', 'protocol-mismatch', 'history-incompatible', 'native-history-unavailable'].includes(String(error.code))) return failure(409, String(error.code))
    if (/idempotency key already used/.test(error.message)) {
      return failure(409, 'conflict')
    }
    if (/service is unavailable|harness server is closing|service is closing|prompt storage is closing|agent prompt bindings are closing/.test(error.message)) {
      return failure(503, 'service-unavailable')
    }
  }
  return failure(500, 'internal-error')
}



function sessionView(session: Session): SessionView {
  return {
    id: session.id, title: session.title, projectId: session.projectId, agentId: session.agentId, createdAt: session.createdAt,
    modelId: session.modelId, archivedAt: session.archivedAt, toolSelection: session.toolSelection,
    protocolId: session.protocolId, historyMode: session.historyMode,
  }
}

function runView(run: Run): RunView {
  return {
    id: run.id, sessionId: run.sessionId, input: run.input, images: run.images ?? [], files: run.files ?? [], status: run.status,
    createdAt: run.createdAt, updatedAt: run.updatedAt, revision: run.revision, history: run.history,
    modelId: run.modelId, requestedModelId: run.requestedModelId, modelSnapshot: run.modelSnapshot,
    ...(run.protocolBinding ? { protocolBinding: run.protocolBinding } : {}),
    ...(run.legacyModelSnapshot ? { legacyModelSnapshot: run.legacyModelSnapshot } : {}),
    ...(run.resultNodeId ? { resultNodeId: run.resultNodeId } : {}),
    ...(run.output === undefined ? {} : { output: run.output }),
    ...(run.error === undefined ? {} : { error: run.error }),
    ...(run.errorCategory === undefined ? {} : { errorCategory: run.errorCategory }),
  }
}

function promptView(document: PromptDocument): object {
  const { revision, kind, role, content } = document.draft
  return { id: document.id, name: document.name, description: document.description,
    draft: { revision, kind, role, content }, versionIds: document.versionIds,
    ...(document.publishedDraftRevision === undefined ? {} : { publishedDraftRevision: document.publishedDraftRevision }) }
}

function promptVersionView(version: PromptVersion): object {
  const { id, documentId, kind, role, content, createdAt } = version
  return { id, documentId, kind, role, content, createdAt }
}



function outputSummary(value: string): { readonly text: string; readonly truncated: boolean } {
  const parts: string[] = []
  let bytes = 0
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8')
    if (bytes + size > 2_048) return { text: parts.join(''), truncated: true }
    parts.push(character)
    bytes += size
  }
  return { text: value, truncated: false }
}

function toolCallView(call: ValidatedToolRequest): object {
  if (call.name === 'bash') return { id: call.id, name: call.name, command: call.arguments.command }
  if (call.name !== 'apply_patch') return { id: call.id, name: call.name, arguments: call.arguments }
  const patch = outputSummary(call.arguments.patch)
  return { id: call.id, name: call.name, patch: patch.text, patchTruncated: patch.truncated }
}

function runEventView(event: RunEvent): object {
  const base = { seq: event.seq, at: event.at, kind: event.kind }
  switch (event.kind) {
    case 'operation-started': return { ...base, operationId: event.operationId, operationKind: event.operationKind }
    case 'operation-observed': return { ...base, operationId: event.operationId, ...processExitProjection(event.result) }
    case 'operation-failed': return { ...base, operationId: event.operationId, category: event.category, ...processExitProjection(event.result) }
    case 'model-started': return base
    case 'model-tool-calls': return { ...base, calls: event.calls.map(toolCallView) }
    case 'tool-started': return { ...base, ...toolCallView(event.call), requestId: event.call.id }
    case 'tool-observed': {
      if (event.name === 'apply_patch') return { ...base, name: event.name, requestId: event.requestId, result: event.result }
      if (event.name !== 'bash') return { ...base, name: event.name, requestId: event.requestId, result: event.result,
        ...('images' in event && event.images?.length ? { images: event.images } : {}) }
      const stdout = outputSummary(event.result.stdout)
      const stderr = outputSummary(event.result.stderr)
      return { ...base, name: event.name, requestId: event.requestId, exitCode: event.result.exitCode,
        signal: event.result.signal, stdout: stdout.text, stderr: stderr.text,
        truncated: event.result.truncated || stdout.truncated || stderr.truncated }
    }
    case 'tool-failed': return { ...base, name: event.name, requestId: event.requestId, category: event.category,
      ...(event.result === undefined ? {} : { result: event.result }), ...(event.images?.length ? { images: event.images } : {}) }
    case 'terminal': return { ...base, status: event.status,
      ...(event.errorCategory ? { errorCategory: event.errorCategory } : {}) }
    case 'interrupted': return { ...base, previousPhase: event.previousPhase }
  }
}

function processExitProjection(value: import('@anybox/models').JsonValue | undefined): { readonly processes?: readonly ProcessExitView[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result = value as Readonly<Record<string, import('@anybox/models').JsonValue>>
  if (!Array.isArray(result.processes)) return {}
  const processes: ProcessExitView[] = []
  for (const raw of result.processes.slice(0, 64)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const item = raw as Readonly<Record<string, import('@anybox/models').JsonValue>>
    if (typeof item.session_id !== 'number' || !Number.isSafeInteger(item.session_id) || item.session_id < 1 ||
      (item.exit_code !== null && (typeof item.exit_code !== 'number' || !Number.isSafeInteger(item.exit_code))) ||
      (item.signal !== null && typeof item.signal !== 'string') || typeof item.output !== 'string') continue
    const output = outputSummary(item.output)
    processes.push({ sessionId: item.session_id, exitCode: item.exit_code, signal: item.signal, output: output.text,
      truncated: item.truncated === true || output.truncated, terminated: item.terminated === true, timedOut: item.timed_out === true,
      ...(typeof item.error === 'string' ? { error: outputSummary(item.error).text } : {}) })
  }
  return processes.length ? { processes } : {}
}



function integerQuery(url: URL, key: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(key)
  const value = raw === null ? fallback : /^\d+$/.test(raw) ? Number(raw) : NaN
  if (!Number.isSafeInteger(value) || value < min || value > max) throw failure(400, 'invalid-input')
  return value
}

/** Hosts model management DTOs and harness server commands; secret reads remain private to Models. */
export interface HarnessServerHttpOptions {
  readonly activity?: ProductActivityPort
  readonly currentCommands?: () => HarnessServerApiCommands
  readonly onRevoked?: (listener: (id: string) => void | Promise<void>) => (() => void)
}
export function createHarnessServerHttpHandler(initialCommands: HarnessServerApiCommands, options: HarnessServerHttpOptions = {}): HarnessServerHttpHandler {
  const signals = new WeakMap<ServerResponse, AbortSignal>()
  const cancelledByHost = (response: ServerResponse, cancel: () => void) => {
    const signal = signals.get(response)
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    return () => signal?.removeEventListener('abort', cancel)
  }
  const commands = initialCommands
  let closing = false
  const pickerRequests = new Set<AbortController>()
  const modelRequests = new Map<AbortController, Promise<unknown>>()
  const imageRequests = new Map<AbortController, Promise<unknown>>()
  const directoryRequests = new Map<AbortController, Promise<unknown>>()
  const treeRequests = new Map<AbortController, Promise<unknown>>()
  const resourceRequestOwners = new Map<AbortController, string>()
  const trees = new Map<string, { owner: string; sessionId: string;
    page: (page: number, signal: AbortSignal) => ReturnType<SessionPort['readProjectFileTreePage']>;
    close: () => Promise<void>; lease?: ActivityLease; unsubscribe?: () => void }>()
  const treeCleanups = new Set<Promise<void>>()
  const closeTree = (owner: string, sessionId: string, cursorId: string): Promise<void> => {
    const tree = trees.get(cursorId), matches = tree?.owner === owner && tree.sessionId === sessionId
    const task = matches ? tree.close() : (options.currentCommands?.() ?? commands).closeProjectFileTree(sessionId, owner, cursorId)
    treeCleanups.add(task)
    void task.then(() => {
      if (matches && trees.get(cursorId) === tree) { trees.delete(cursorId); tree.unsubscribe?.(); tree.lease?.release() }
    }, () => { if (matches) tree.lease?.release() }).finally(() => treeCleanups.delete(task)).catch(() => {})
    return task
  }
  const directoryBrowses = new Map<string, { owner: string;
    create: (name: string, signal: AbortSignal) => OwnedCall<DirectoryCreated>;
    close: () => Promise<void>; lease?: ActivityLease; unsubscribe?: () => void }>()
  const directoryCleanups = new Set<Promise<void>>()
  const closeDirectoryBrowse = (owner: string, browseId: string): Promise<void> => {
    const browse = directoryBrowses.get(browseId)
    const task = browse?.owner === owner ? browse.close() : (options.currentCommands?.() ?? commands).closeDirectoryBrowse(owner, browseId)
    directoryCleanups.add(task)
    void task.then(() => { if (directoryBrowses.get(browseId)?.owner === owner) { directoryBrowses.delete(browseId); browse?.unsubscribe?.(); browse?.lease?.release() } }, () => { browse?.lease?.release() })
      .finally(() => directoryCleanups.delete(task))
    return task
  }
  const imageRequest = async <T>(request: IncomingMessage, response: ServerResponse, work: (signal: AbortSignal) => Promise<T>, requests = imageRequests, owner?: string): Promise<T> => {
    if (closing) throw failure(503, 'service-unavailable')
    const abort = new AbortController()
    const disconnected = () => { if (!response.writableEnded) abort.abort() }
    const stopReading = () => { if (!request.complete) request.destroy() }
    response.once('close', disconnected)
    abort.signal.addEventListener('abort', stopReading, { once: true })
    const unsubscribe = cancelledByHost(response, () => abort.abort())
    if (response.destroyed) abort.abort()
    const task = Promise.resolve().then(() => work(abort.signal))
    requests.set(abort, task)
    if (owner !== undefined) resourceRequestOwners.set(abort, owner)
    try { return await task }
    finally { unsubscribe(); requests.delete(abort); resourceRequestOwners.delete(abort); response.off('close', disconnected); abort.signal.removeEventListener('abort', stopReading) }
  }
  const joinImageCall = async <T>(call: OwnedCall<T>, signal: AbortSignal, kind: 'image' | 'file' | 'directory' = 'image'): Promise<T> => {
    const cancel = () => call.cancel('Web resource request cancelled')
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    // A replacement service may fail during exit without ever settling result.
    // Observe both promises now; a done failure must not leave HTTP shutdown waiting forever.
    const exited = call.done.then(() => undefined, () => ({ error: failure(503, kind === 'directory' ? 'directory-browse-cleanup-failed' : kind === 'file' ? 'file-cleanup-failed' : 'asset-cleanup-failed') }))
    const exitFailure = exited.then(exit => {
      if (exit) { call.cancel('image resource cleanup failed'); throw exit.error }
      return new Promise<never>(() => {})
    })
    try { return await Promise.race([call.result, exitFailure]) }
    catch (error) { call.cancel('image request failed'); throw error }
    finally {
      const failure = await exited
      signal.removeEventListener('abort', cancel)
      if (failure) throw failure.error
    }
  }
  const modelRequest = async <T>(response: ServerResponse, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (closing) throw failure(503, 'service-unavailable')
    const controller = new AbortController()
    const disconnected = () => { if (!response.writableEnded) controller.abort() }
    response.once('close', disconnected)
    const unsubscribe = cancelledByHost(response, () => controller.abort())
    if (response.destroyed) controller.abort()
    // Register before invoking any asynchronous service work.
    const task = Promise.resolve().then(() => work(controller.signal))
    modelRequests.set(controller, task)
    try { return await task }
    finally { unsubscribe(); modelRequests.delete(controller); response.off('close', disconnected) }
  }
  const waitRequests = new Set<() => void>()
  const changeStreams = new Set<RunChangeStream>()
  const unsubscribe = options.onRevoked?.(async id => {
    const requests: Promise<unknown>[] = [], cleanups: Promise<void>[] = []
    for (const [controller, owner] of resourceRequestOwners) if (owner === id) {
      controller.abort('authentication revoked')
      const request = treeRequests.get(controller) ?? directoryRequests.get(controller)
      if (request) requests.push(request)
    }
    for (const [browseId, browse] of directoryBrowses) if (browse.owner === id) cleanups.push(closeDirectoryBrowse(browse.owner, browseId))
    for (const [cursorId, tree] of trees) if (tree.owner === id) cleanups.push(closeTree(tree.owner, tree.sessionId, cursorId))
    // Cancelled requests may publish a cursor only while their exit is being joined; their handlers close it.
    await Promise.allSettled(requests)
    const exits = await Promise.allSettled(cleanups)
    const failures = exits.flatMap(exit => exit.status === 'rejected' ? [exit.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'revoked directory cleanup failed')
  })
  const handlers = new Set<Promise<void>>(), bodies = new Set<IncomingMessage>()
  const handle = (request: IncomingMessage, response: ServerResponse, relative: URL, context: ApplicationHttpContext): Promise<void> => {
    signals.set(response, context.signal)
    bodies.add(request)
    request.once('end', () => bodies.delete(request)); request.once('close', () => bodies.delete(request))
    const handler = (async () => {
      if (closing || context.signal.aborted) throw failure(503, 'service-unavailable')
      const method = request.method ?? 'GET'
      const url = new URL(relative)
      url.pathname = '/api/v1' + (relative.pathname === '/' ? '' : relative.pathname)
      const path = url.pathname
      const commands = options.currentCommands?.() ?? initialCommands
      const directoryOwner = context.actorId, productId = context.appId
      if (method === 'POST' && path === '/api/v1/projects/directories/browse') {
        if (!commands.directoryBrowsingSupported?.()) throw failure(503, 'directory-browse-unsupported')
        if (url.search) throw failure(400, 'invalid-input')
        const body = await requestObject(request, ['action', 'path', 'query', 'showHidden', 'browseId', 'page'])
        const result = await imageRequest(request, response, async signal => {
          if (body.action === 'open') {
            if (body.browseId !== undefined || body.page !== undefined ||
                body.path !== undefined && typeof body.path !== 'string' || body.query !== undefined && typeof body.query !== 'string' ||
                body.showHidden !== undefined && typeof body.showHidden !== 'boolean') throw failure(400, 'invalid-input')
            const input: DirectoryBrowseOptions = {
              ...(body.path === undefined ? {} : { path: body.path as string }),
              ...(body.query === undefined ? {} : { query: body.query as string }),
              ...(body.showHidden === undefined ? {} : { showHidden: body.showHidden as boolean }),
            }
            const opened = await joinImageCall(commands.openDirectoryBrowse(directoryOwner, input, signal), signal, 'directory')
            const browse = { owner: directoryOwner,
              create: (name: string, signal: AbortSignal) => commands.createDirectory(directoryOwner, opened.browseId, name, signal),
              close: () => commands.closeDirectoryBrowse(directoryOwner, opened.browseId), lease: undefined as ActivityLease | undefined, unsubscribe: undefined as (() => void) | undefined }
            directoryBrowses.set(opened.browseId, browse)
            const unlisten = cancelledByHost(response, () => { void closeDirectoryBrowse(directoryOwner, opened.browseId).catch(() => {}) })
            browse.lease = options.activity?.enter(productId, { blocking: false, cancel: () => { void closeDirectoryBrowse(directoryOwner, opened.browseId).catch(() => {}) } })
            const retired = commands.onDirectoryBrowseRetired?.(id => {
              if (id === opened.browseId && directoryBrowses.get(id) === browse) { directoryBrowses.delete(id); browse.lease?.release(); browse.unsubscribe?.() }
            })
            browse.unsubscribe = () => { unlisten(); retired?.() }
            if (closing || signal.aborted) {
              await closeDirectoryBrowse(directoryOwner, opened.browseId)
              throw failure(503, 'directory-browse-cancelled')
            }
            return opened
          }
          if (body.action !== 'page' || body.path !== undefined || body.query !== undefined || body.showHidden !== undefined ||
              typeof body.browseId !== 'string' || !body.browseId || body.browseId.length > 200 ||
              typeof body.page !== 'number' || !Number.isSafeInteger(body.page) || body.page < 0) throw failure(400, 'invalid-input')
          return joinImageCall(commands.readDirectoryPage(directoryOwner, body.browseId, body.page, signal), signal, 'directory')
        }, directoryRequests, directoryOwner)
        json(response, 200, result); return
      }
      if (method === 'POST' && path === '/api/v1/projects/directories/close') {
        if (!commands.directoryBrowsingSupported?.()) throw failure(503, 'directory-browse-unsupported')
        if (url.search) throw failure(400, 'invalid-input')
        const body = await requestObject(request, ['browseId'])
        if (typeof body.browseId !== 'string' || !body.browseId || body.browseId.length > 200) throw failure(400, 'invalid-input')
        await imageRequest(request, response, () => closeDirectoryBrowse(directoryOwner, body.browseId as string), directoryRequests, directoryOwner)
        json(response, 200, { ok: true }); return
      }
      if (method === 'POST' && path === '/api/v1/projects/directories/create') {
        if (!commands.directoryCreationSupported?.()) throw failure(503, 'directory-create-unsupported')
        if (url.search) throw failure(400, 'invalid-input')
        const body = await requestObject(request, ['browseId', 'name'])
        if (typeof body.browseId !== 'string' || !body.browseId || body.browseId.length > 200 ||
            typeof body.name !== 'string') throw failure(400, 'invalid-input')
        const browse = directoryBrowses.get(body.browseId)
        if (!browse || browse.owner !== directoryOwner) throw failure(409, 'directory-browse-expired')
        const result = await imageRequest(request, response,
          signal => joinImageCall(browse.create(body.name as string, signal), signal, 'directory'), directoryRequests, directoryOwner)
        json(response, 201, result); return
      }
      if (method === 'POST' && path === '/api/v1/projects') {
        const body = await requestObject(request, ['path'])
        if (!commands.openProject) throw failure(503, 'service-unavailable')
        json(response, 200, await commands.openProject(body.path as string)); return
      }
      if (method === 'GET' && path === '/api/v1/changes') {
        const ids = url.searchParams.getAll('sessionId')
        if (ids.length < 1 || ids.length > 4 || new Set(ids).size !== ids.length ||
            ids.some(id => !id.trim() || id.length > 1024) ||
            [...url.searchParams.keys()].some(key => key !== 'sessionId')) throw failure(400, 'invalid-input')
        for (const id of ids) if (!await commands.getSession(id)) throw failure(404, 'not-found')
        // Validation yields: shutdown/disconnection may have happened before stream admission.
        if (closing || context.signal.aborted) throw failure(503, 'service-unavailable')
        if (response.destroyed) return
        if (changeStreams.size >= 64) throw failure(503, 'service-unavailable')
        const stream = openRunChangeStream(response, new Set(ids))
        changeStreams.add(stream)
        const unsubscribe = cancelledByHost(response, () => stream.close())
        try { await stream.done } finally { unsubscribe(); changeStreams.delete(stream) }
        return
      }
      if (method === 'GET' && path === '/api/v1/agents') {
        json(response, 200, commands.listAgents())
        return
      }
      if (method === 'GET' && path === '/api/v1/tools') {
        json(response, 200, commands.listTools()); return
      }
      const agentToolsMatch = /^\/api\/v1\/agents\/([^/]+)\/tools$/.exec(path)
      if (agentToolsMatch && method === 'GET') {
        json(response, 200, await commands.getAgentTools(decodeURIComponent(agentToolsMatch[1]))); return
      }
      if (agentToolsMatch && method === 'POST') {
        const body = await requestObject(request, ['toolIds', 'expectedRevision'])
        if (!Array.isArray(body.toolIds) || body.toolIds.some(id => typeof id !== 'string' || !id.trim()) ||
          typeof body.expectedRevision !== 'number' || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw failure(400, 'invalid-input')
        json(response, 200, await commands.setAgentTools(decodeURIComponent(agentToolsMatch[1]), {
          toolIds: body.toolIds as string[], expectedRevision: body.expectedRevision,
        })); return
      }
      const sessionDefaultsMatch = /^\/api\/v1\/agents\/([^/]+)\/session-defaults$/.exec(path)
      if (sessionDefaultsMatch && method === 'GET') {
        json(response, 200, await commands.getSessionDefaults(decodeURIComponent(sessionDefaultsMatch[1])))
        return
      }
      if (sessionDefaultsMatch && method === 'POST') {
        const body = await requestObject(request, ['modelId', 'expectedRevision'])
        if (body.modelId !== null && (typeof body.modelId !== 'string' || !body.modelId.trim()) ||
            typeof body.expectedRevision !== 'number' || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) {
          throw failure(400, 'invalid-input')
        }
        json(response, 200, await commands.setSessionDefaults(decodeURIComponent(sessionDefaultsMatch[1]),
          body.modelId as string | null, body.expectedRevision))
        return
      }
      const promptFields = ['name', 'description', 'kind', 'role', 'content']
      if (path === '/api/v1/prompts' && method === 'GET') {
        json(response, 200, commands.listPrompts().map(promptView))
        return
      }
      if (path === '/api/v1/prompts' && method === 'POST') {
        const body = await requestObject(request, promptFields, 1_048_576)
        json(response, 200, promptView(await commands.createPrompt(body as unknown as PromptCreateInput)))
        return
      }
      const promptMatch = /^\/api\/v1\/prompts\/([^/]+)$/.exec(path)
      if (promptMatch && method === 'GET') {
        const document = commands.getPrompt(decodeURIComponent(promptMatch[1]))
        if (!document) throw failure(404, 'not-found')
        json(response, 200, promptView(document))
        return
      }
      if (promptMatch && method === 'POST') {
        const { expectedRevision, ...patch } = await requestObject(request, [...promptFields, 'expectedRevision'], 1_048_576)
        json(response, 200, promptView(await commands.editPrompt(decodeURIComponent(promptMatch[1]),
          promptRevision(expectedRevision), patch as PromptEditInput)))
        return
      }
      const versionsMatch = /^\/api\/v1\/prompts\/([^/]+)\/versions$/.exec(path)
      if (versionsMatch && method === 'GET') {
        json(response, 200, commands.getPromptVersions(decodeURIComponent(versionsMatch[1])).map(promptVersionView))
        return
      }
      const publishMatch = /^\/api\/v1\/prompts\/([^/]+)\/publish$/.exec(path)
      if (publishMatch && method === 'POST') {
        const body = await requestObject(request, ['expectedRevision'])
        json(response, 200, promptVersionView(await commands.publishPrompt(decodeURIComponent(publishMatch[1]),
          promptRevision(body.expectedRevision))))
        return
      }
      const agentPromptsMatch = /^\/api\/v1\/agents\/([^/]+)\/prompts$/.exec(path)
      if (agentPromptsMatch && method === 'GET') {
        json(response, 200, commands.getAgentPrompts(decodeURIComponent(agentPromptsMatch[1])))
        return
      }
      if (agentPromptsMatch && method === 'POST') {
        const body = await requestObject(request, ['versionId'])
        if (typeof body.versionId !== 'string' || !body.versionId.trim()) throw failure(400, 'invalid-input')
        const binding = await commands.bindPrompt(decodeURIComponent(agentPromptsMatch[1]), body.versionId)
        json(response, 200, { kind: binding.kind, versionId: binding.versionId })
        return
      }
      if (method === 'GET' && path === '/api/v1/projects') {
        json(response, 200, await commands.listProjects())
        return
      }
      if (method === 'GET' && path === '/api/v1/projects/picker') {
        json(response, 200, { supported: commands.directoryPickerSupported() })
        return
      }
      if (method === 'POST' && path === '/api/v1/projects/pick') {
        await requestObject(request, [])
        const controller = new AbortController()
        const disconnected = () => { if (!response.writableEnded) controller.abort() }
        response.once('close', disconnected)
        const unsubscribe = cancelledByHost(response, () => controller.abort())
        pickerRequests.add(controller)
        try { json(response, 200, await commands.pickProject(controller.signal)) }
        finally {
          unsubscribe(); pickerRequests.delete(controller)
          response.off('close', disconnected)
        }
        return
      }
      const projectSessionsMatch = /^\/api\/v1\/projects\/([^/]+)\/sessions$/.exec(path)
      if (method === 'GET' && projectSessionsMatch) {
        json(response, 200, (await commands.listSessions(decodeURIComponent(projectSessionsMatch[1]))).map(sessionView))
        return
      }
      if (await handleModelsApi(commands, request, response, url, modelRequest)) return
      if (method === 'GET' && path === '/api/v1/sessions/archived') {
        json(response, 200, (await commands.listArchivedSessions()).map(sessionView)); return
      }
      const sessionArchiveMatch = /^\/api\/v1\/sessions\/([^/]+)\/(archive|restore)$/.exec(path)
      if (method === 'POST' && sessionArchiveMatch) {
        const id = decodeURIComponent(sessionArchiveMatch[1])
        const session = await (sessionArchiveMatch[2] === 'archive' ? commands.archiveSession(id) : commands.restoreSession(id))
        json(response, 200, sessionView(session)); return
      }
      if (method === 'POST' && path === '/api/v1/sessions') {
        const body = await requestObject(request, ['projectId', 'agentId', 'modelId'])
        json(response, 200, sessionView(await commands.createSession(body.projectId as string, body.agentId as string, body.modelId as string | undefined)))
        return
      }
      const sessionModelMatch = /^\/api\/v1\/sessions\/([^/]+)\/model$/.exec(path)
      if (method === 'POST' && sessionModelMatch) {
        const body = await requestObject(request, ['modelId'])
        json(response, 200, sessionView(await commands.selectSessionModel(decodeURIComponent(sessionModelMatch[1]), body.modelId as string)))
        return
      }
      const nodesMatch = /^\/api\/v1\/sessions\/([^/]+)\/nodes$/.exec(path)
      if (method === 'GET' && nodesMatch) {
        const parent = url.searchParams.get('parentNodeId')
        if (!parent) throw failure(400, 'invalid-input')
        json(response, 200, await commands.listNodes(decodeURIComponent(nodesMatch[1]), parent === 'root' ? null : parent, {
          ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor')! } : {}),
          ...(url.searchParams.has('limit') ? { limit: integerQuery(url, 'limit', 50, 1, 100) } : {}),
        }))
        return
      }
      const nodeMatch = /^\/api\/v1\/sessions\/([^/]+)\/nodes\/([^/]+)(\/path)?$/.exec(path)
      if (method === 'GET' && nodeMatch) {
        const sessionId = decodeURIComponent(nodeMatch[1]), id = decodeURIComponent(nodeMatch[2])
        const value = nodeMatch[3] ? await commands.getNodePath(sessionId, id === 'root' ? null : id)
          : await commands.getNode(sessionId, id)
        if (!value) throw failure(404, 'node-not-found')
        json(response, 200, value)
        return
      }
      const keyMatch = /^\/api\/v1\/sessions\/([^/]+)\/runs\/by-key\/([^/]+)$/.exec(path)
      if (method === 'GET' && keyMatch) {
        const run = await commands.getRunByKey(decodeURIComponent(keyMatch[1]), decodeURIComponent(keyMatch[2]))
        if (!run) throw failure(404, 'not-found')
        json(response, 200, runView(run))
        return
      }
      const sessionRunsMatch = /^\/api\/v1\/sessions\/([^/]+)\/runs$/.exec(path)
      if (method === 'GET' && sessionRunsMatch) {
        const status = url.searchParams.get('status')
        if (status !== null && status !== 'active') throw failure(400, 'invalid-input')
        const parent = url.searchParams.get('parentNodeId')
        if (parent === '') throw failure(400, 'invalid-input')
        json(response, 200, (await commands.listRuns(decodeURIComponent(sessionRunsMatch[1]), {
          ...(status ? { active: true } : {}),
          ...(parent !== null ? { parentNodeId: parent === 'root' ? null : parent } : {}),
        })).map(runView))
        return
      }
      const sessionMatch = /^\/api\/v1\/sessions\/([^/]+)$/.exec(path)
      if (method === 'GET' && sessionMatch) {
        const session = await commands.getSession(decodeURIComponent(sessionMatch[1]))
        if (!session) throw failure(404, 'not-found')
        json(response, 200, sessionView(session))
        return
      }
      const fileTreeMatch = /^\/api\/v1\/sessions\/([^/]+)\/project-files\/tree\/(open|page|close)$/.exec(path)
      if (fileTreeMatch) {
        if (method !== 'POST') throw failure(405, 'method-not-allowed')
        if (url.search) throw failure(400, 'invalid-input')
        const sessionId = decodeURIComponent(fileTreeMatch[1]), action = fileTreeMatch[2], owner = context.actorId
        if (action === 'open') {
          const body = await requestObject(request, ['path']), treePath = validateFileTreePath(body.path)
          const opened = await imageRequest(request, response, async signal => {
            const page = await joinImageCall(commands.openProjectFileTree(sessionId, treePath, owner, signal), signal, 'file')
            if (page.nextPage === null) return page
            const tree = { owner, sessionId,
              page: (number: number, readSignal: AbortSignal) => commands.readProjectFileTreePage(sessionId, owner, page.cursorId, number, readSignal),
              close: () => commands.closeProjectFileTree(sessionId, owner, page.cursorId),
              lease: undefined as ActivityLease | undefined, unsubscribe: undefined as (() => void) | undefined }
            trees.set(page.cursorId, tree)
            const unlisten = cancelledByHost(response, () => { void closeTree(owner, sessionId, page.cursorId).catch(() => {}) })
            const retired = commands.onProjectFileTreeRetired(id => {
              if (id === page.cursorId && trees.get(id) === tree) { trees.delete(id); tree.unsubscribe?.(); tree.lease?.release() }
            })
            tree.unsubscribe = () => { unlisten(); retired() }
            try {
              tree.lease = options.activity?.enter(productId, { blocking: false, cancel: () => { void closeTree(owner, sessionId, page.cursorId).catch(() => {}) } })
              if (closing || signal.aborted || context.signal.aborted) throw failure(503, 'file-cancelled')
              return page
            } catch (error) { await closeTree(owner, sessionId, page.cursorId); throw error }
          }, treeRequests, owner)
          json(response, 200, opened); return
        }
        const body = await requestObject(request, action === 'page' ? ['cursorId', 'page'] : ['cursorId'])
        if (!validId(body.cursorId)) throw failure(400, 'invalid-input')
        const cursorId = body.cursorId
        if (action === 'close') {
          await imageRequest(request, response, () => closeTree(owner, sessionId, cursorId), treeRequests, owner)
          json(response, 200, { ok: true }); return
        }
        if (!Number.isSafeInteger(body.page) || (body.page as number) < 0) throw failure(400, 'invalid-input')
        const number = body.page as number, tree = trees.get(cursorId)
        const result = await imageRequest(request, response, signal => joinImageCall(
          tree?.owner === owner && tree.sessionId === sessionId ? tree.page(number, signal)
            : commands.readProjectFileTreePage(sessionId, owner, cursorId, number, signal), signal, 'file'), treeRequests, owner)
        json(response, 200, result); return
      }
      const projectFilesMatch = /^\/api\/v1\/sessions\/([^/]+)\/project-files\/(search|preview|prepare|renew|snapshots\/([^/]+))$/.exec(path)
      if (projectFilesMatch) {
        const sessionId = decodeURIComponent(projectFilesMatch[1]), action = projectFilesMatch[2]
        if (method === 'GET' && action === 'search') {
          json(response, 200, await imageRequest(request, response, signal => joinImageCall(commands.searchProjectFiles(sessionId, url.searchParams.get('q') ?? '', signal), signal, 'file'))); return
        }
        if (method === 'POST' && action === 'preview') {
          const body = await requestObject(request, ['path', 'range'])
          const [selection] = validateFileSelections([{ kind: 'project-file', ...body }])
          if (selection.kind !== 'project-file') throw failure(400, 'invalid-input')
          json(response, 200, await imageRequest(request, response, signal => joinImageCall(commands.previewProjectFile(sessionId, selection, signal), signal, 'file'))); return
        }
        if (method === 'POST' && action === 'prepare') {
          const body = await requestObject(request, ['preparationKey', 'selections'])
          if (!validId(body.preparationKey)) throw failure(400, 'invalid-input')
          const selections = validateFileSelections(body.selections), key = body.preparationKey
          json(response, 200, await imageRequest(request, response, signal => joinImageCall(commands.prepareProjectFiles(sessionId, key, selections, signal), signal, 'file'))); return
        }
        if (method === 'POST' && action === 'renew') {
          const body = await requestObject(request, ['snapshotIds']), ids = validateSnapshotIds(body.snapshotIds)
          json(response, 200, await imageRequest(request, response, () => commands.renewProjectFiles(sessionId, ids))); return
        }
        if (method === 'GET' && projectFilesMatch[3]) {
          json(response, 200, await imageRequest(request, response, signal => joinImageCall(commands.getFileSnapshot(sessionId, decodeURIComponent(projectFilesMatch[3]), signal), signal, 'file'))); return
        }
        throw failure(405, 'method-not-allowed')
      }
      const imagesMatch = /^\/api\/v1\/sessions\/([^/]+)\/images(?:\/(renew)|\/([^/]+)\/content)?$/.exec(path)
      if (imagesMatch) {
        const sessionId = decodeURIComponent(imagesMatch[1])
        if (method === 'POST' && imagesMatch[2] === 'renew') {
          const body = await requestObject(request, ['assetIds'])
          if (!Array.isArray(body.assetIds) || body.assetIds.length > imageLimits.maxImages || body.assetIds.some(id => typeof id !== 'string' || !id || id.length > 1024)) throw failure(400, 'invalid-input')
          const renewal = await imageRequest(request, response, () => commands.renewImages(sessionId, body.assetIds as string[]))
          json(response, 200, renewal); return
        }
        if (method === 'POST' && !imagesMatch[2] && !imagesMatch[3]) {
          const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
          if (contentType !== 'application/octet-stream' && !imageLimits.acceptedMediaTypes.includes(contentType as ImageRef['mediaType'])) throw failure(415, 'image-required')
          if (Number(request.headers['content-length']) > imageLimits.maxBytes) throw failure(413, 'asset-too-large')
          const image = await imageRequest(request, response, async signal => {
            async function* bytes() {
              let length = 0
              for await (const chunk of request) {
                if (signal.aborted) throw failure(503, 'asset-cancelled')
                const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
                length += data.byteLength
                if (length > imageLimits.maxBytes) throw failure(413, 'asset-too-large')
                yield data
              }
            }
            return joinImageCall(commands.importImage(sessionId, bytes(), signal), signal)
          })
          json(response, 201, image); return
        }
        if (method === 'GET' && imagesMatch[3]) {
          const asset = await imageRequest(request, response, signal => joinImageCall(commands.getImage(sessionId, decodeURIComponent(imagesMatch[3]), signal), signal))
          response.writeHead(200, { 'Content-Type': asset.image.mediaType, 'Content-Length': asset.bytes.byteLength, 'Cross-Origin-Resource-Policy': 'same-origin' })
          response.end(asset.bytes); return
        }
      }
      const createRunMatch = /^\/api\/v1\/sessions\/([^/]+)\/runs$/.exec(path)
      if (method === 'POST' && createRunMatch) {
        const body = await requestObject(request, ['parentNodeId', 'input', 'images', 'files', 'idempotencyKey', 'modelId'])
        if (body.images !== undefined && (!Array.isArray(body.images) || body.images.length > imageLimits.maxImages || body.images.some(image =>
          !image || typeof image !== 'object' || Array.isArray(image) || Object.keys(image).some(key => key !== 'assetId') || typeof image.assetId !== 'string' || !image.assetId || image.assetId.length > 1024))) throw failure(400, 'invalid-input')
        const run = await commands.startRun({
          sessionId: decodeURIComponent(createRunMatch[1]),
          parentNodeId: body.parentNodeId as string | null,
          input: body.input as string,
          ...(body.files === undefined ? {} : { files: body.files as { snapshotId: string }[] }),
          ...(body.images === undefined ? {} : { images: body.images as { assetId: string }[] }),
          idempotencyKey: body.idempotencyKey as string,
          ...(body.modelId === undefined ? {} : { modelId: body.modelId as string }),
        })
        if (run.status === 'running' || run.status === 'cancelling') {
          context.retainUntil(Promise.resolve().then(() => commands.waitRun(run.id)))
        }
        json(response, 200, runView(run))
        return
      }
      const runViewMatch = /^\/api\/v1\/runs\/([^/]+)\/view$/.exec(path)
      if (method === 'GET' && runViewMatch) {
        const view = await commands.getRunView(decodeURIComponent(runViewMatch[1]))
        if (!view) throw failure(404, 'view-unavailable')
        json(response, 200, view)
        return
      }
      const runMatch = /^\/api\/v1\/runs\/([^/]+)$/.exec(path)
      if (method === 'GET' && runMatch) {
        const run = await commands.getRun(decodeURIComponent(runMatch[1]))
        if (!run) throw failure(404, 'not-found')
        json(response, 200, runView(run))
        return
      }
      const runEventsMatch = /^\/api\/v1\/runs\/([^/]+)\/events$/.exec(path)
      if (method === 'GET' && runEventsMatch) {
        const events = await commands.getRunEvents(decodeURIComponent(runEventsMatch[1]), integerQuery(url, 'afterSeq', 0, 0, Number.MAX_SAFE_INTEGER))
        if (!events) throw failure(404, 'not-found')
        json(response, 200, events.map(runEventView))
        return
      }
      const waitMatch = /^\/api\/v1\/runs\/([^/]+)\/wait$/.exec(path)
      if (method === 'GET' && waitMatch) {
        const id = decodeURIComponent(waitMatch[1])
        const timeout = integerQuery(url, 'timeoutMs', 25000, 0, 25000)
        if (!await commands.getRun(id)) throw failure(404, 'not-found')
        if (closing || context.signal.aborted) throw failure(503, 'service-unavailable')
        if (response.destroyed) return
        const waiter = new AbortController()
        let finish!: () => void
        const interrupted = new Promise<undefined>(resolve => { finish = () => resolve(undefined) })
        const timer = setTimeout(finish, timeout)
        response.once('close', finish)
        const unsubscribe = cancelledByHost(response, finish)
        waitRequests.add(finish)
        try {
          const terminal = await Promise.race([commands.waitRun(id, waiter.signal), interrupted])
          if (closing || context.signal.aborted || response.destroyed) {
            if (!response.destroyed) json(response, 503, { error: { code: 'service-unavailable' } })
            return
          }
          const run = terminal ?? await commands.getRun(id)
          const ended = run && run.status !== 'running' && run.status !== 'cancelling'
          json(response, 200, { done: Boolean(ended), timedOut: !ended, run: run ? runView(run) : null })
        } finally {
          unsubscribe(); waiter.abort()
          clearTimeout(timer)
          response.off('close', finish)
          waitRequests.delete(finish)
        }
        return
      }
      const cancelMatch = /^\/api\/v1\/runs\/([^/]+)\/cancel$/.exec(path)
      if (method === 'POST' && cancelMatch) {
        const body = await requestObject(request, [])
        void body
        const run = await commands.cancelRun(decodeURIComponent(cancelMatch[1]))
        if (!run) throw failure(404, 'not-found')
        json(response, 200, runView(run))
        return
      }
      throw failure(404, 'not-found')
    })().catch(error => {
      const safe = knownFailure(error)
      const fileIndex = error && typeof error === 'object' && 'fileIndex' in error && Number.isSafeInteger(error.fileIndex) && Number(error.fileIndex) >= 0 && Number(error.fileIndex) < 8 ? Number(error.fileIndex) : undefined
      if (!response.headersSent) json(response, safe.status, { error: { code: safe.code, ...(fileIndex === undefined ? {} : { fileIndex }) } })
      else response.destroy()
    })
    handlers.add(handler)
    void handler.finally(() => handlers.delete(handler)).catch(() => {})
    return handler
  }
  let shutdown: Promise<void> | undefined
  return {
    handle,
    capabilities: () => {
      const current = options.currentCommands?.() ?? commands
      return [...(current.directoryBrowsingSupported?.() ? ['projects.browse'] : []),
        ...(current.directoryCreationSupported?.() ? ['projects.create-directory'] : [])]
    },
    notifyRunChange(change) {
      if (!closing) for (const stream of changeStreams) stream.publish(change)
    },
    notifyProtocolView(progress) {
      if (!closing) for (const stream of changeStreams) stream.publishProtocolView(progress)
    },
    close() {
      if (shutdown) return shutdown
      closing = true
      unsubscribe?.()
      for (const request of bodies) if (!request.complete) request.destroy()
      for (const controller of pickerRequests) controller.abort()
      for (const controller of modelRequests.keys()) controller.abort()
      for (const controller of imageRequests.keys()) controller.abort()
      for (const controller of directoryRequests.keys()) controller.abort()
      for (const controller of treeRequests.keys()) controller.abort()
      for (const finish of waitRequests) finish()
      const streams = [...changeStreams]
      for (const stream of streams) stream.close()
      shutdown = Promise.all([
        ...[...handlers].map(task => task.catch(() => {})),
        ...streams.map(stream => stream.done),
        ...[...modelRequests.values()].map(task => task.then(() => {}, () => {})),
        ...[...imageRequests.values()].map(task => task.then(() => {}, () => {})),
        ...[...directoryRequests.values()].map(task => task.then(() => {}, () => {})),
        ...[...treeRequests.values()].map(task => task.then(() => {}, () => {})),
      ]).then(async () => {
        const cleanup = [...directoryBrowses].map(([browseId, browse]) => closeDirectoryBrowse(browse.owner, browseId))
        const treeCleanup = [...trees].map(([cursorId, tree]) => closeTree(tree.owner, tree.sessionId, cursorId))
        await Promise.all([...directoryCleanups, ...cleanup, ...treeCleanups, ...treeCleanup])
      })
      return shutdown
    },
  }
}
