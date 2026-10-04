import { fileLimits, isFileRef, validateFileSelections } from '../core/project-files/domain.js'
import type { FileRef, FileSelection, FileSearch, FilePreview, FileContent, FileRenewal } from '../core/project-files/domain.js'
import { pendingFilesValid, pendingFileDrafts } from './file-client.js'
import type { RunnableModelSummary } from '@anybox/models'
import { canUseModel } from './models-client.js'
import type { Api, ApiError, PendingSubmission, RunEventView, RunView, SessionView, NodeView, NodePage, SessionPosition, SessionViewMode } from './client-types.js'
import type { SessionRef } from './workspace-layout.js'
import type { ProtocolViewSnapshot } from '../core/view/types.js'
import { getProtocolWebModule } from './protocols/modules.js'
import type { ImageRef } from './client-types.js'
import { applyImageRenewal, createImageUploads } from './image-client.js'
import { createDraftStore, draftFromInput, isImageRef } from './draft-client.js'
import type { DraftImage, DraftStore, DraftFile, MessageDraft } from './draft-client.js'
import type { ImageRenewal } from './image-client.js'
import { validateImageBatch } from '../core/image/limits.js'

export interface BrowserStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export const pendingKey = 'anybox.web.v3.pending'
export interface PendingStore {
  get(id: string): PendingSubmission | undefined
  set(id: string, value: PendingSubmission | undefined): void
  entries(): readonly PendingSubmission[]
}
export function createPendingStore(storage: BrowserStorage): PendingStore {
  const entries = new Map<string, PendingSubmission>()
  try {
    const data: unknown = JSON.parse(storage.getItem(pendingKey) ?? '{}')
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const [id, raw] of Object.entries(data)) {
        if (!raw || typeof raw !== 'object') continue
        const value = raw as Record<string, unknown>
        if (value.sessionId !== id || typeof value.input !== 'string' || typeof value.idempotencyKey !== 'string' ||
            (value.schemaVersion !== undefined && !Number.isSafeInteger(value.schemaVersion)) ||
            (value.runId !== undefined && typeof value.runId !== 'string') ||
            (value.modelId !== undefined && typeof value.modelId !== 'string') ||
            (value.parentNodeId !== undefined && value.parentNodeId !== null && typeof value.parentNodeId !== 'string')) continue
        const images = Array.isArray(value.images) ? value.images.filter(isImageRef) : []
        const invalidImages = value.invalidImages === true || (value.images !== undefined && (!Array.isArray(value.images) || images.length !== value.images.length)) || (![2, 3].includes(Number(value.schemaVersion)) && images.length > 0)
        entries.set(id, { ...value, images, ...(!pendingFilesValid(value as unknown as PendingSubmission) ? { invalidFiles: true } : {}), ...(invalidImages ? { invalidImages: true } : {}) } as unknown as PendingSubmission)
      }
    }
  } catch { /* A new submission still must be saved successfully before it is sent. */ }
  return {
    get: id => entries.get(id),
    entries: () => [...entries.values()],
    set(id, value) {
      const next = new Map(entries)
      if (value) next.set(id, value)
      else next.delete(id)
      storage.setItem(pendingKey, JSON.stringify(Object.fromEntries(next)))
      if (value) entries.set(id, value)
      else entries.delete(id)
    },
  }
}

export function isActive(run: RunView | undefined): boolean { return run?.status === 'running' || run?.status === 'cancelling' }
export function isApiError(error: unknown): error is ApiError { return error instanceof Error && 'status' in error && 'code' in error }
const protocolViewIncompatibilityNotice = '协议展示版本不兼容，请将执行设备与 Anybox Harness 客户端一起升级。'

export type TraceLoadState = 'unloaded' | 'loading' | 'loaded' | 'failed'
export interface TraceLoading {
  readonly total: number
  readonly loaded: number
  readonly pending: number
  readonly failed: number
  readonly states: ReadonlyMap<string, TraceLoadState>
  readonly errors: ReadonlyMap<string, string>
}
export interface SessionSnapshot {
  readonly session?: SessionView
  readonly runs: readonly RunView[]
  readonly run?: RunView
  readonly position: SessionPosition
  readonly path: readonly NodeView[]
  readonly children: readonly NodeView[]
  readonly moreChildren: boolean
  readonly pending?: PendingSubmission
  readonly busy: boolean
  readonly loading: boolean
  readonly notice: string
  readonly draft: string
  readonly images: readonly DraftImage[]
  readonly files: readonly DraftFile[]
  readonly events: ReadonlyMap<string, readonly RunEventView[]>
  readonly expanded: ReadonlySet<string>
  readonly views: ReadonlyMap<string, ProtocolViewSnapshot>
  readonly traceLoading: TraceLoading
}
export interface FileMention { readonly start: number; readonly end: number; readonly text: string }
/** The target and original chip are captured before a sidebar action can outlive its composer. */
export interface FileReferenceInput {
  readonly sessionId: string
  readonly parentNodeId: string | null
  readonly item: DraftFile
  readonly expectedItem?: DraftFile
  readonly mention?: FileMention
}
export function sameFileReference(a: DraftFile | undefined, b: DraftFile): boolean {
  return Boolean(a && a.id === b.id && JSON.stringify(a.selection) === JSON.stringify(b.selection) && a.file?.snapshotId === b.file?.snapshotId)
}
export interface SessionController {
  snapshot(): SessionSnapshot
  attach(listener: () => void): void
  detach(): void
  refresh(): Promise<void>
  notifyChange(): void
  setLive(connected: boolean): void
  setViewMode(mode: SessionViewMode): void
  setTraceViewport(ids: readonly string[]): void
  setTraceSearch(query: string): void
  retryTrace(id: string): void
  setModel(modelId: string): Promise<void>
  protocolView(snapshot: ProtocolViewSnapshot): void
  incompatibleView(runId: string): void
  setDraft(value: string): void
  addImages(files: readonly File[]): void
  removeImage(id: string): void
  retryImage(id: string): void
  imagesChanged(): void
  setFiles(files: readonly DraftFile[]): void
  applyFileReference(input: FileReferenceInput): boolean
  searchFiles(query: string, signal: AbortSignal): Promise<FileSearch>
  previewFile(selection: Extract<FileSelection, { kind: 'project-file' }>, signal: AbortSignal): Promise<FilePreview>
  readFile(id: string, signal: AbortSignal): Promise<FileContent>
  fileMessage(error: unknown): string
  dispose(): void
  submit(): Promise<void>
  cancel(id: string): Promise<void>
  toggleTrace(id: string): void
  navigate(id: string | null, draft?: string, images?: readonly ImageRef[], files?: readonly FileRef[]): Promise<void>
  focusRun(id: string): void
  moreChildren(): Promise<void>
  regenerate(node: NodeView): Promise<void>
}
export interface SessionEnvironment {
  readonly api: Api
  readonly pending: PendingStore
  readonly drafts?: DraftStore
  readonly uploadImage?: (sessionId: string, file: File, signal: AbortSignal) => Promise<ImageRef>
  readonly messageFor: (error: unknown) => string
  readonly newId: () => string
  readonly hidden: () => boolean
  readonly schedule: (callback: () => void, ms: number) => unknown
  readonly clear: (timer: unknown) => void
  readonly missing: (ref: SessionRef) => void
  readonly archived?: (ref: SessionRef) => void
  readonly models?: () => readonly RunnableModelSummary[]
  readonly position?: SessionPosition
  readonly savePosition?: (value: SessionPosition) => void
}

/** One controller per Session. A view may detach while its already-issued write still settles. */
export function createSessionController(ref: SessionRef, env: SessionEnvironment): SessionController {
  let session: SessionView | undefined, runs: readonly RunView[] = []
  const initialPosition = env.position ?? { viewNodeId: null }
  let position: SessionPosition = { ...initialPosition, viewMode: initialPosition.viewMode === 'runs' ? 'runs' : 'dialogue' }
  let pathNodes: readonly NodeView[] = [], children: readonly NodeView[] = [], childCursor: string | undefined
  let notice = '', busy = false, loading = true, locationVersion = 0
  let listener: (() => void) | undefined, generation = 0, timer: unknown, refreshJob: Promise<void> | undefined
  let refreshAgain = false, locationAgain = false, live = false, locationJob: Promise<void> | undefined
  const drafts = env.drafts ?? createDraftStore()
  const draftAt = (parent: string | null) => drafts.get(ref.sessionId, parent)
  const setDraftAt = (parent: string | null, draft: MessageDraft) => {
    try { drafts.set(ref.sessionId, parent, draft) }
    catch { notice = '浏览器无法保存草稿；请保持页面打开，发送前会再次保存待提交信息。' }
  }
  const reads = new Set<AbortController>()
  const views = new Map<string, ProtocolViewSnapshot>()
  const events = new Map<string, readonly RunEventView[]>(), expanded = new Set<string>()
  const eventRevisions = new Map<string, number>(), traceErrors = new Map<string, string>()
  const terminalTrace = new Set<string>()
  let traceViewport: readonly string[] = [], traceSearch = '', traceActive = 0
  interface TraceJob {
    readonly id: string
    readonly version: number
    readonly promise: Promise<void>
    readonly resolve: () => void
    readonly reject: (error: unknown) => void
    required: boolean
    started: boolean
  }
  const traceJobs = new Map<string, TraceJob>()
  const path = `/sessions/${encodeURIComponent(ref.sessionId)}`
  const pending = () => env.pending.get(ref.sessionId)
  const readOnly = () => !session || Boolean(session.archivedAt) || session.historyMode === 'dialogue-v1'
  const attached = () => listener !== undefined
  const emit = () => listener?.()
  const uploads = createImageUploads({ sessionId: ref.sessionId, drafts, newId: env.newId, changed: emit,
    upload: (file, signal) => env.uploadImage ? env.uploadImage(ref.sessionId, file, signal) : Promise.reject(new Error('图片上传暂不可用。')),
    error: error => {
      notice = error instanceof Error && error.name === 'ImageAssetError' ? '最多添加 8 张图片，每张最多 10 MiB、总计 20 MiB。'
        : error instanceof Error ? error.message : env.messageFor(error)
    },
  })
  const remember = () => env.savePosition?.(position)
  const stopFollowing = () => {
    if (position.follow) { position = { ...position, follow: undefined }; remember() }
  }
  const clearTimer = () => { if (timer !== undefined) env.clear(timer); timer = undefined }
  const invalidate = () => {
    generation++
    clearTimer()
    for (const request of reads) request.abort()
    reads.clear()
    cancelQueuedTrace()
  }
  const schedule = () => {
    clearTimer()
    if (attached() && !busy) timer = env.schedule(() => { void controller.refresh() }, live ? 30_000 : 5000)
  }
  const finishWrite = () => {
    busy = false
    emit()
    if (attached() && refreshAgain && !refreshJob) void controller.refresh()
    else { syncTraceReads(); schedule() }
  }
  const read = async <T>(url: string, version: number): Promise<T> => {
    const abort = new AbortController()
    reads.add(abort)
    try {
      const value = await env.api<T>(url, undefined, abort.signal)
      if (generation !== version || !attached()) throw new DOMException('Stale view', 'AbortError')
      return value
    } finally { reads.delete(abort) }
  }
  const save = (value: PendingSubmission | undefined): boolean => {
    try { env.pending.set(ref.sessionId, value); return true }
    catch { notice = '浏览器无法保存待提交信息，请启用此页面的会话存储后重试。'; emit(); return false }
  }
  const encodeInput = (text: string, modelId = session?.modelId, images: readonly ImageRef[] = [], fileCount = 0): string | undefined => {
    try { validateImageBatch(images) }
    catch { notice = '每次最多发送 8 张图片，每张最多 10 MiB、总计 20 MiB。请删减图片后重试。'; emit(); return undefined }
    const model = env.models?.().find(value => value.id === modelId)
    const protocolId = model?.parameters.protocolId ?? session?.protocolId
    if (session?.protocolId && protocolId !== session.protocolId) {
      notice = '此会话已固定协议，请新建会话使用其他协议。'; emit(); return undefined
    }
    const module = getProtocolWebModule(protocolId)
    if (!module) { notice = '此协议的输入组件尚不可用，请选择受支持的模型。'; emit(); return undefined }
    if (images.length && model && !model.effectiveCapabilities?.imageInput) { notice = '当前模型不支持图片，请切换模型或移除图片。'; emit(); return undefined }
    try { return module.encodeInput(text, images.length, fileCount) }
    catch (error) { notice = error instanceof Error ? error.message : env.messageFor(error); emit(); return undefined }
  }
  const decodeView = (run: RunView, value: unknown): ProtocolViewSnapshot | undefined => {
    const module = getProtocolWebModule(run.protocolBinding?.protocolId)
    if (!module) { notice = '此协议的展示组件尚不可用。'; return undefined }
    if (value && typeof value === 'object' && 'viewSchemaVersion' in value && value.viewSchemaVersion !== 2) {
      notice = protocolViewIncompatibilityNotice
      return undefined
    }
    const decoded = module.decode(value)
    if (!decoded) notice = '协议展示记录不兼容，无法显示此运行。'
    return decoded
  }
  const adopt = (value: RunView) => {
    if (value.sessionId !== ref.sessionId) return
    const previous = runs.find(item => item.id === value.id)
    if (previous && previous.revision > value.revision) return
    if (!isActive(value)) {
      if (isActive(previous) || views.get(value.id)?.status === 'provisional') terminalTrace.add(value.id)
      const followedResult = value.status === 'completed' && value.resultNodeId && position.follow?.runId === value.id &&
        position.viewNodeId === position.follow.parentNodeId
      // Keep the visible frame until the durable result can replace it without an empty render.
      if (views.get(value.id)?.status === 'provisional' && !followedResult) views.delete(value.id)
    }
    runs = [...runs.filter(item => item.id !== value.id), value]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  }
  const traceReady = (run: RunView): boolean => (eventRevisions.get(run.id) ?? -1) >= run.revision &&
    (!run.protocolBinding || Boolean(views.get(run.id) && (isActive(run) || views.get(run.id)?.status === 'committed')))
  const tracePriority = (id: string): number => {
    if (isActive(runs.find(run => run.id === id))) return 0
    if (position.focusedRunId === id) return 1
    if (position.viewMode === 'runs' && traceViewport.includes(id)) return 2
    if (pathNodes.some(node => node.sourceRunId === id) || expanded.has(id)) return 3
    return 4
  }
  const traceWanted = (): ReadonlySet<string> => new Set(runs.filter(run => isActive(run) || terminalTrace.has(run.id) || expanded.has(run.id) ||
    pathNodes.some(node => node.sourceRunId === run.id) || (position.viewMode === 'runs' &&
      (run.id === position.focusedRunId || traceViewport.includes(run.id) || Boolean(traceSearch.trim())))).map(run => run.id))
  const traceLoading = (): TraceLoading => {
    const states = new Map<string, TraceLoadState>()
    let loaded = 0, failed = 0
    for (const run of runs) {
      const state = traceErrors.has(run.id) ? 'failed' : traceJobs.has(`${generation}:${run.id}`) ? 'loading' : traceReady(run) ? 'loaded' : 'unloaded'
      states.set(run.id, state)
      if (state === 'loaded') loaded++
      if (state === 'failed') failed++
    }
    return { total: runs.length, loaded, pending: runs.length - loaded - failed, failed, states, errors: new Map(traceErrors) }
  }
  const cancelQueuedTrace = () => {
    const wanted = traceWanted()
    for (const [key, job] of traceJobs) {
      if (job.started || (job.version === generation && attached() && !env.hidden() && (job.required || wanted.has(job.id)))) continue
      traceJobs.delete(key)
      job.reject(new DOMException('Stale trajectory read', 'AbortError'))
    }
  }
  const readTrace = async (job: TraceJob) => {
    const run = runs.find(value => value.id === job.id)
    if (!run) return
    if (isActive(run) || (eventRevisions.get(run.id) ?? -1) < run.revision) {
      const prior = events.get(run.id) ?? []
      const loaded = await read<readonly RunEventView[]>(`/runs/${encodeURIComponent(run.id)}/events?afterSeq=${prior.at(-1)?.seq ?? 0}`, job.version)
      // An overlapping poll/SSE refresh must not append an event twice.
      const seen = new Set(prior.map(event => event.seq))
      events.set(run.id, [...prior, ...loaded.filter(event => !seen.has(event.seq))].sort((a, b) => a.seq - b.seq))
      eventRevisions.set(run.id, run.revision)
    }
    const current = runs.find(value => value.id === job.id)
    // Clearing search only stops work that has not started; do not begin its next read.
    if (env.hidden() || (!job.required && !traceWanted().has(job.id))) return
    if (current?.protocolBinding && views.get(current.id)?.status !== 'committed') {
      const view = decodeView(current, await read<unknown>(`/runs/${encodeURIComponent(current.id)}/view`, job.version))
      if (!view) throw new Error(notice || '轨迹展示记录暂不可用。')
      controller.protocolView(view)
    }
    if (current && traceReady(current)) terminalTrace.delete(current.id)
  }
  const pumpTrace = () => {
    cancelQueuedTrace()
    if (!attached() || busy || env.hidden()) return
    const queued = [...traceJobs.values()].filter(job => !job.started && job.version === generation)
      .sort((a, b) => tracePriority(a.id) - tracePriority(b.id))
    while (traceActive < 2 && queued.length) {
      const job = queued.shift()!
      if (traceJobs.get(`${job.version}:${job.id}`) !== job || job.version !== generation || !attached() || busy || env.hidden()) continue
      job.started = true
      traceActive++
      void readTrace(job).then(job.resolve, error => {
        if (job.version === generation && attached() && !(error instanceof Error && error.name === 'AbortError')) traceErrors.set(job.id, env.messageFor(error))
        job.reject(error)
      }).finally(() => {
        traceJobs.delete(`${job.version}:${job.id}`)
        traceActive--
        pumpTrace()
        if (job.version === generation) emit()
      })
    }
  }
  const loadTrace = (id: string, version: number, required = true): Promise<void> => {
    if (env.hidden()) return Promise.resolve()
    const run = runs.find(value => value.id === id)
    if (!run) return Promise.resolve()
    if (!isActive(run) && traceReady(run)) {
      terminalTrace.delete(id)
      traceErrors.delete(id)
      return Promise.resolve()
    }
    const key = `${version}:${id}`, existing = traceJobs.get(key)
    if (existing) { existing.required ||= required; return existing.promise }
    if (!required && traceErrors.has(id)) return Promise.resolve()
    if (required) traceErrors.delete(id)
    let resolve!: () => void, reject!: (error: unknown) => void
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    traceJobs.set(key, { id, version, required, started: false, promise, resolve, reject })
    // Background callers need no unhandled-rejection side channel on detach.
    void promise.catch(() => {})
    if (traceActive < 2) pumpTrace()
    return promise
  }
  const syncTraceReads = () => {
    cancelQueuedTrace()
    if (!attached() || busy || env.hidden()) return
    for (const id of [...traceWanted()].sort((a, b) => tracePriority(a) - tracePriority(b))) {
      const run = runs.find(value => value.id === id)
      // Active reads are polled by refresh; viewport changes must not create a hot loop.
      if (run && !traceReady(run)) void loadTrace(id, generation, false)
    }
    pumpTrace()
  }
  const readLocation = async (append = false): Promise<void> => {
    const version = generation, location = locationVersion, nodeId = position.viewNodeId
    const cursor = append ? childCursor : undefined
    try {
      const nodes = append ? pathNodes : await read<readonly NodeView[]>(`${path}/nodes/${encodeURIComponent(nodeId ?? 'root')}/path`, version)
      const page = await read<NodePage>(`${path}/nodes?parentNodeId=${encodeURIComponent(nodeId ?? 'root')}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, version)
      if (location !== locationVersion) return
      pathNodes = nodes
      children = append ? [...children, ...page.nodes] : page.nodes
      childCursor = page.nextCursor
      for (const node of nodes) {
        const run = runs.find(value => value.id === node.sourceRunId)
        if (run?.protocolBinding && views.get(run.id)?.status !== 'committed') await loadTrace(run.id, version)
      }
      if (location !== locationVersion) return
      loading = false
    } catch (error) {
      if (version !== generation || location !== locationVersion || !attached()) return
      if (isApiError(error) && error.status === 404 && nodeId !== null) {
        position = { viewNodeId: null, viewMode: position.viewMode }
        remember()
        pathNodes = []; children = []; childCursor = undefined
        notice = '原查看节点不存在，请从会话起点选择分支。'
      } else notice = env.messageFor(error)
      loading = false
    }
    emit()
  }
  const followResult = async () => {
    const follow = position.follow
    if (!follow || position.viewNodeId !== follow.parentNodeId) return
    const run = runs.find(item => item.id === follow.runId)
    if (!run || isActive(run)) return
    if (locationJob) { locationAgain = true; return }
    if (run.status === 'completed' && run.resultNodeId) {
      const version = generation, location = locationVersion, nodeId = run.resultNodeId
      const current = () => attached() && version === generation && location === locationVersion &&
        position.follow === follow && position.viewNodeId === follow.parentNodeId
      const job = (async () => {
        try {
          const nodes = await read<readonly NodeView[]>(`${path}/nodes/${encodeURIComponent(nodeId)}/path`, version)
          if (!current()) return
          const page = await read<NodePage>(`${path}/nodes?parentNodeId=${encodeURIComponent(nodeId)}`, version)
          if (!current()) return
          // Position and content become visible together; user navigation or typing cancels this follow.
          locationVersion++
          if (views.get(run.id)?.status === 'provisional') views.delete(run.id)
          position = { viewNodeId: nodeId, viewMode: position.viewMode }
          pathNodes = nodes
          children = page.nodes
          childCursor = page.nextCursor
          loading = false
          notice = ''
          remember()
          emit()
        } catch (error) {
          if (!current()) return
          notice = env.messageFor(error)
          emit()
        }
      })()
      locationJob = job
      await job
      finishLocation(job)
    }
    else {
      notice = run.status === 'cancelled' ? '本次运行已取消。' : run.status === 'interrupted' ? '本次运行意外中断，请重新发送。' : `本次运行失败${run.error ? `：${run.error}` : '，请检查模型配置后重试。'}`
      position = { ...position, follow: undefined }; remember()
    }
  }
  const finishLocation = (job: Promise<void>) => {
    if (locationJob !== job) return
    locationJob = undefined
    if (locationAgain) { locationAgain = false; void controller.refresh() }
  }
  const restoreUnaccepted = (submission: PendingSubmission) => {
    const parent = submission.parentNodeId ?? null
    const current = draftAt(parent), restored = { ...draftFromInput(submission.input, submission.images), files: pendingFileDrafts(submission) }
    // A user may have typed another draft while the uncertain submission was retained.
    const text = !current.text || current.text === restored.text ? restored.text
      : !restored.text ? current.text : `${restored.text}\n\n${current.text}`
    const originalIds = new Set(restored.images.map(image => image.image!.assetId))
    const images = [...restored.images.map(image => current.images.find(value => value.image?.assetId === image.image!.assetId) ?? image),
      ...current.images.filter(image => !image.image || !originalIds.has(image.image.assetId))]
    if (submission.invalidImages && !images.some(image => image.id === 'invalid-pending-image')) {
      images.push({ id: 'invalid-pending-image', name: '待恢复图片', status: 'failed', byteLength: 0, error: '图片信息不兼容，请移除后重新添加。' })
    }
    const fileIds = new Set(restored.files.map(file => file.id))
    const files = [...restored.files, ...current.files.filter(file => !fileIds.has(file.id))]
    setDraftAt(parent, { text, images, files })
    if (pending()?.idempotencyKey === submission.idempotencyKey) save(undefined)
    return Boolean(current.text && current.text !== restored.text) || images.length > restored.images.length || files.length > restored.files.length
  }
  const submitStored = async (submission: PendingSubmission, followVersion?: number) => {
    if (busy) return
    if (session?.archivedAt) { notice = '会话已归档，请先恢复后再继续。'; emit(); return }
    if (submission.invalidFiles || !pendingFilesValid(submission)) { notice = '待提交文件引用无效，请移除后重新添加。'; emit(); return }
    if (submission.invalidImages) { notice = '待提交图片信息不兼容，请移除后重新添加。'; emit(); return }
    const input = encodeInput(submission.input, submission.modelId, submission.images, submission.files?.length || submission.fileSelections?.length || 0)
    if (input === undefined) {
      // Existing submissions reach here only after their key was confirmed unaccepted.
      const combined = restoreUnaccepted(submission)
      notice += ' 待提交内容已恢复到原对话位置的草稿。'
      if (combined) notice += ' 该位置的新草稿也已同时保留，请确认内容后发送。'
      emit()
      return
    }
    busy = true
    invalidate()
    notice = ''
    emit()
    try {
      if (submission.fileSelections?.length && !submission.files?.length) {
        notice = '正在准备文件快照…'; emit()
        const files = await env.api<readonly FileRef[]>(`${path}/project-files/prepare`, { preparationKey: submission.preparationKey, selections: submission.fileSelections })
        if (!Array.isArray(files) || files.length !== submission.fileSelections.length || !files.every(isFileRef)) throw new Error('文件快照返回信息无效。')
        submission = { ...submission, files }
        // Never submit before the immutable identities are durably saved in the browser.
        if (!save(submission)) return
      }
      if (submission.files?.length) {
        const renewal = await env.api<FileRenewal>(`${path}/project-files/renew`, { snapshotIds: submission.files.map(file => file.snapshotId) })
        if (renewal.invalid.length) throw Object.assign(new Error('文件快照已失效，请更新为当前文件。'), { status: 409, code: 'file-expired' })
      }
      notice = ''; emit()
      if (submission.images?.length) {
        const renewed = await env.api<ImageRenewal>(`${path}/images/renew`, { assetIds: submission.images.map(image => image.assetId) })
        applyImageRenewal(drafts, ref.sessionId, renewed)
        if (renewed.invalid.length) throw Object.assign(new Error('图片已失效，请重新添加。'), { status: 409, code: 'asset-expired' })
      }
      const accepted = await env.api<RunView>(`${path}/runs`, {
        input, idempotencyKey: submission.idempotencyKey, parentNodeId: submission.parentNodeId,
        ...(submission.files?.length ? { files: submission.files.map(file => ({ snapshotId: file.snapshotId })) } : {}),
        ...(submission.images?.length ? { images: submission.images.map(image => ({ assetId: image.assetId })) } : {}),
        ...(submission.modelId !== undefined ? { modelId: submission.modelId } : {}),
      })
      if (accepted.sessionId !== ref.sessionId) throw new Error('session mismatch')
      adopt(accepted)
      refreshAgain = true
      expanded.add(accepted.id)
      if (followVersion !== undefined && followVersion === locationVersion && position.viewNodeId === submission.parentNodeId) {
        position = { ...position, focusedRunId: accepted.id, follow: { runId: accepted.id, parentNodeId: submission.parentNodeId! } }
        remember()
      }
      if (pending()?.idempotencyKey === submission.idempotencyKey) save(undefined)
    } catch (error) {
      notice = env.messageFor(error)
      if (isApiError(error) && error.code === 'session-archived') {
        restoreUnaccepted(submission); refreshAgain = true
      } else if (isApiError(error) && error.status < 500 && error.code !== 'project-unavailable') {
        const parent = submission.parentNodeId ?? null
        if (!draftAt(parent).text && !draftAt(parent).images.length && !draftAt(parent).files.length) {
          const restored = { ...draftFromInput(submission.input, submission.images), files: pendingFileDrafts(submission).map((file, index) =>
            error.fileIndex === index || (error.code === 'file-expired' && file.selection?.kind === 'snapshot') ? { ...file, error: env.messageFor(error) } : file) }
          setDraftAt(parent, error.code === 'asset-expired' ? { ...restored, images: restored.images.map(image => ({ ...image, status: 'expired', error: '图片已失效，请移除后重新添加。' })) } : restored)
        }
        if (pending()?.idempotencyKey === submission.idempotencyKey) save(undefined)
      }
    } finally { finishWrite() }
  }
  const recover = async (version: number) => {
    const submission = pending()
    if (!submission || busy) return
    let existing: RunView | undefined
    try { existing = await read<RunView>(`${path}/runs/by-key/${encodeURIComponent(submission.idempotencyKey)}`, version) }
    catch (error) { if (!isApiError(error) || error.status !== 404) throw error }
    if (existing) { adopt(existing); save(undefined) }
    else if (session?.archivedAt) {
      restoreUnaccepted(submission)
      notice = '会话已归档，未接受的消息已保留为草稿。恢复后可继续。'
    }
    else if (session?.historyMode === 'dialogue-v1' || ![1, 2, 3].includes(submission.schemaVersion ?? 0) || submission.invalidImages || submission.invalidFiles || submission.parentNodeId === undefined || (env.models && submission.modelId === undefined)) {
      notice = session?.historyMode === 'dialogue-v1' ? '旧版会话仅供查看。待提交消息已恢复为草稿；请新建原生会话。' : '旧版待提交消息尚未被接受，已保留输入。请选定对话位置与模型后确认发送。'
      if (!draftAt(position.viewNodeId).text && !draftAt(position.viewNodeId).images.length && !draftAt(position.viewNodeId).files.length) {
        const restored = { ...draftFromInput(submission.input, submission.images), files: pendingFileDrafts(submission) }
        setDraftAt(position.viewNodeId, submission.invalidImages ? { ...restored, images: [...restored.images, { id: 'invalid-pending-image', name: '待恢复图片', status: 'failed', byteLength: 0, error: '图片信息不兼容，请移除后重新添加。' }] } : restored)
      }
      save(undefined)
    } else await submitStored(submission)
  }
  const controller: SessionController = {
    snapshot: () => ({ session, runs, run: runs.find(item => item.id === position.focusedRunId), position,
      path: pathNodes, children, moreChildren: Boolean(childCursor), pending: pending(), busy, loading, notice,
      draft: draftAt(position.viewNodeId).text, images: draftAt(position.viewNodeId).images, files: draftAt(position.viewNodeId).files, events, expanded, views, traceLoading: traceLoading() }),
    attach(value) { listener = value; session = undefined; loading = true; invalidate(); void controller.refresh() },
    detach() {
      listener = undefined
      invalidate()
      locationVersion++
      for (const [id, view] of views) if (view.status === 'provisional') views.delete(id)
      position = { ...position, follow: undefined }
      remember()
      refreshAgain = false
      locationAgain = false
    },
    notifyChange() {
      if (!attached()) return
      refreshAgain = true
      if (!env.hidden()) void controller.refresh()
    },
    setLive(connected) {
      if (!connected) { emit() }
      live = connected
      if (!refreshJob) schedule()
    },
    setViewMode(mode) {
      position = { ...position, viewMode: mode }
      remember()
      syncTraceReads()
      emit()
    },
    setTraceViewport(ids) {
      const next = [...new Set(ids)]
      if (next.length === traceViewport.length && next.every((id, index) => traceViewport[index] === id)) return
      traceViewport = next
      syncTraceReads()
      emit()
    },
    setTraceSearch(query) {
      if (query === traceSearch) return
      traceSearch = query
      syncTraceReads()
      emit()
    },
    retryTrace(id) {
      if (!runs.some(run => run.id === id)) return
      traceErrors.delete(id)
      void loadTrace(id, generation).catch(() => {})
      emit()
    },
    async setModel(modelId) {
      if (readOnly() || !session || busy || pending() || !modelId) return
      if (session.historyMode === 'dialogue-v1') { notice = '旧版会话仅供查看，请新建原生会话。'; emit(); return }
      if (env.models && !canUseModel(env.models().find(value => value.id === modelId))) {
        notice = '此模型暂不可用，请检查提供方与模型配置。'; emit(); return
      }
      const candidate = env.models?.().find(value => value.id === modelId)
      if (session.protocolId && candidate && candidate.parameters.protocolId !== session.protocolId) { notice = '此会话已固定协议，请新建会话使用其他协议。'; emit(); return }
      if (!getProtocolWebModule(candidate?.parameters.protocolId ?? session.protocolId)) { notice = '此协议的输入组件尚不可用，请选择受支持的模型。'; emit(); return }
      busy = true; invalidate(); notice = ''; emit()
      try { session = await env.api<SessionView>(`${path}/model`, { modelId }); refreshAgain = true }
      catch (error) { notice = env.messageFor(error) }
      finally { finishWrite() }
    },
    protocolView(snapshot) {
      if (!attached() || snapshot.sessionId !== ref.sessionId) return
      if (snapshot.viewSchemaVersion !== 2) { controller.incompatibleView(snapshot.runId); return }
      const run = runs.find(value => value.id === snapshot.runId)
      if (run && !isActive(run) && snapshot.status === 'provisional') return
      if (run?.protocolBinding && run.protocolBinding.protocolId !== snapshot.protocolId) return
      const module = getProtocolWebModule(snapshot.protocolId)
      if (!module) { notice = '此协议的展示组件尚不可用。'; emit(); return }
      const decoded = module.decode(snapshot)
      if (!decoded) return
      const previous = views.get(snapshot.runId)
      const next = module.reduce(previous, decoded)
      if (!next || next === previous) return
      views.set(snapshot.runId, next)
      if (run && traceReady(run)) {
        traceErrors.delete(run.id)
        if (!isActive(run)) terminalTrace.delete(run.id)
      }
      // Cached views outside the visible path can be queried again when needed.
      if (views.size > 64 && position.viewMode !== 'runs' && !traceSearch.trim()) {
        const visible = new Set(pathNodes.map(node => node.sourceRunId))
        for (const id of views.keys()) if (!visible.has(id) && id !== position.follow?.runId && !expanded.has(id) && !isActive(runs.find(value => value.id === id))) { views.delete(id); break }
      }
      emit()
    },
    incompatibleView(runId) {
      if (!attached() || !runId || notice === protocolViewIncompatibilityNotice) return
      notice = protocolViewIncompatibilityNotice
      emit()
    },
    setDraft(value) {
      if (readOnly()) return
      setDraftAt(position.viewNodeId, { ...draftAt(position.viewNodeId), text: value })
      stopFollowing()
    },
    addImages(files) { if (!readOnly() && !busy && !pending() && files.length) { stopFollowing(); uploads.add(position.viewNodeId, files) } },
    removeImage(id) { if (!readOnly() && !busy && !pending()) { stopFollowing(); uploads.remove(position.viewNodeId, id) } },
    retryImage(id) { if (!readOnly() && !busy && !pending()) { stopFollowing(); uploads.retry(position.viewNodeId, id) } },
    imagesChanged: emit,
    setFiles(files) {
      if (readOnly() || busy || pending()) return
      if (files.length > fileLimits.maxFiles) { notice = '每次最多引用 8 个文件。'; emit(); return }
      stopFollowing()
      setDraftAt(position.viewNodeId, { ...draftAt(position.viewNodeId), files }); emit()
    },
    applyFileReference(input) {
      if (readOnly() || busy || loading || pending()) return false
      if (input.sessionId !== ref.sessionId || input.parentNodeId !== position.viewNodeId) {
        notice = '对话位置已改变，请在当前分支重新引用文件。'; emit(); return false
      }
      const draft = draftAt(position.viewNodeId), previous = draft.files.find(item => item.id === input.item.id)
      if (input.expectedItem && !sameFileReference(previous, input.expectedItem)) {
        notice = '此文件引用已改变或移除，请重新打开。'; emit(); return false
      }
      try {
        const [selection] = validateFileSelections([input.item.selection])
        if (selection.kind === 'snapshot' && (!isFileRef(input.item.file) || input.item.file.snapshotId !== selection.snapshotId || input.item.file.projectId !== ref.projectId)) throw new Error()
      } catch { notice = '文件引用信息无效，请重新打开文件。'; emit(); return false }
      if (draft.files.some(item => item.id !== input.item.id && JSON.stringify(item.selection) === JSON.stringify(input.item.selection))) {
        notice = '已添加相同文件与范围。'; emit(); return false
      }
      if (!previous && draft.files.length >= fileLimits.maxFiles) { notice = '每次最多引用 8 个文件。'; emit(); return false }
      const mention = input.mention
      const matchingMention = mention && Number.isSafeInteger(mention.start) && Number.isSafeInteger(mention.end) && mention.start >= 0 && mention.end >= mention.start &&
        draft.text.slice(mention.start, mention.end) === mention.text && mention.text.length === mention.end - mention.start
      const text = matchingMention ? draft.text.slice(0, mention.start) + draft.text.slice(mention.end) : draft.text
      const files = previous ? draft.files.map(item => item.id === input.item.id ? input.item : item) : [...draft.files, input.item]
      setDraftAt(position.viewNodeId, { ...draft, text, files })
      stopFollowing()
      notice = mention && !matchingMention ? '文件已引用；输入已变化，原 @ 文本已保留。' : ''
      emit()
      return true
    },
    searchFiles: (query, signal) => env.api(`${path}/project-files/search?q=${encodeURIComponent(query)}`, undefined, signal),
    previewFile: (selection, signal) => env.api(`${path}/project-files/preview`, { path: selection.path, ...(selection.range ? { range: selection.range } : {}) }, signal),
    readFile: (id, signal) => env.api(`${path}/project-files/snapshots/${encodeURIComponent(id)}`, undefined, signal),
    fileMessage: env.messageFor,
    dispose() { controller.detach(); uploads.dispose() },
    async navigate(id, draft, images, files) {
      if (draft !== undefined && readOnly()) return
      locationVersion++
      position = { viewNodeId: id, viewMode: position.viewMode }
      if (draft !== undefined) setDraftAt(id, draftFromInput(draft, images, files))
      pathNodes = []; children = []; childCursor = undefined
      loading = true
      notice = ''
      remember()
      emit()
      const job = readLocation()
      locationJob = job
      await job
      finishLocation(job)
    },
    focusRun(id) {
      locationVersion++
      position = { ...position, focusedRunId: id, follow: undefined }
      remember()
      if (expanded.has(id)) expanded.delete(id)
      controller.toggleTrace(id)
    },
    async moreChildren() {
      if (!childCursor || locationJob) return
      const job = readLocation(true)
      locationJob = job
      await job
      finishLocation(job)
    },
    refresh() {
      clearTimer()
      pumpTrace()
      if (!attached()) return Promise.resolve()
      if (busy) { refreshAgain = true; return Promise.resolve() }
      if (refreshJob) { refreshAgain = true; return refreshJob }
      refreshJob = Promise.resolve().then(async () => {
        do {
          refreshAgain = false
          const version = generation
          try {
            const currentSession = await read<SessionView>(path, version)
            if (currentSession.projectId !== ref.projectId) { env.missing(ref); return }
            const becameArchived = Boolean(session && !session.archivedAt && currentSession.archivedAt)
            session = currentSession
            if (becameArchived && env.archived) {
              // Reconcile uncertainty before closing; a failed read leaves pending input intact.
              try { await recover(version) }
              finally { if (version === generation && attached()) env.archived(ref) }
              return
            }
            // Discover every run, including work started through another tab or host.
            const loaded = await read<readonly RunView[]>(`${path}/runs`, version)
            for (const value of loaded) adopt(value)
            // A display read failure must not prevent pending reconciliation or following a successful result.
            await Promise.allSettled(runs.filter(value => isActive(value) || terminalTrace.has(value.id) || expanded.has(value.id)).map(value => loadTrace(value.id, version)))
            if (locationJob) locationAgain = true
            else await readLocation()
            syncTraceReads()
            await recover(version)
            await followResult()
          } catch (error) {
            if (version === generation && attached()) {
              if (isApiError(error) && error.status === 404 && !session) env.missing(ref)
              else { loading = false; notice = env.messageFor(error) }
            }
          }
        } while (refreshAgain && attached() && !busy)
      }).finally(() => { refreshJob = undefined; syncTraceReads(); emit(); schedule() })
      return refreshJob
    },
    async submit() {
      if (!session || busy || loading) return
      if (session.archivedAt) { await recover(generation); notice = '会话已归档，请先恢复后再继续。'; emit(); return }
      if (session.historyMode === 'dialogue-v1') { notice = '旧版会话仅供查看，请新建原生会话。'; emit(); return }
      let submission = pending()
      if (!submission) {
        if (env.models && !canUseModel(env.models().find(value => value.id === session?.modelId))) {
          notice = '请先选择一个可用模型；没有可用模型时，请打开“Anybox Harness 设置”的“模型管理”配置提供方和模型。'; emit(); return
        }
        const draft = draftAt(position.viewNodeId)
        if (draft.images.some(image => image.status !== 'ready' || !image.image)) { notice = '请等待图片上传完成，或移除无法使用的图片。'; emit(); return }
        if (draft.files.some(file => !file.selection || file.error)) { notice = '请修复或移除无法使用的文件引用。'; emit(); return }
        const fileSelections = validateFileSelections(draft.files.map(file => file.selection))
        const images = draft.images.map(image => image.image!)
        const input = encodeInput(draft.text.trim(), session.modelId, images, fileSelections.length)
        if (input === undefined) return
        submission = { schemaVersion: 3, sessionId: ref.sessionId, input, images, fileSelections, ...(fileSelections.length ? { preparationKey: env.newId() } : {}), idempotencyKey: env.newId(), parentNodeId: position.viewNodeId, ...(session.modelId ? { modelId: session.modelId } : {}) }
        if (!save(submission)) return
        setDraftAt(position.viewNodeId, draftFromInput(''))
      }
      else {
        // Resolve a possibly accepted request before current capabilities or image TTL are consulted.
        try { const accepted = await env.api<RunView>(`${path}/runs/by-key/${encodeURIComponent(submission.idempotencyKey)}`); adopt(accepted); save(undefined); emit(); return }
        catch (error) { if (!isApiError(error) || error.status !== 404) { notice = env.messageFor(error); emit(); return } }
      }
      await submitStored(submission, locationVersion)
    },
    async regenerate(node) {
      if (readOnly() || busy || pending() || node.sessionId !== ref.sessionId) return
      if (session?.historyMode === 'dialogue-v1') { notice = '旧版会话仅供查看，请新建原生会话。'; emit(); return }
      if (env.models && !canUseModel(env.models().find(value => value.id === session?.modelId))) {
        notice = '请先选择一个可用模型。'; emit(); return
      }
      const input = encodeInput(node.input, session?.modelId, node.images, node.files?.length ?? 0)
      if (input === undefined) return
      const submission: PendingSubmission = { schemaVersion: 3, files: node.files ?? [], sessionId: ref.sessionId, input, images: node.images ?? [], parentNodeId: node.parentId, idempotencyKey: env.newId(), ...(session?.modelId ? { modelId: session.modelId } : {}) }
      if (!save(submission)) return
      await controller.navigate(node.parentId)
      await submitStored(submission, locationVersion)
    },
    async cancel(id) {
      if (!runs.some(item => item.id === id && isActive(item)) || busy) return
      busy = true
      invalidate()
      emit()
      try { adopt(await env.api<RunView>(`/runs/${encodeURIComponent(id)}/cancel`, {})); refreshAgain = true; notice = '' }
      catch (error) { notice = env.messageFor(error) }
      finally { finishWrite() }
    },
    toggleTrace(id) {
      if (expanded.has(id)) { expanded.delete(id); emit(); return }
      expanded.add(id)
      const version = generation
      void loadTrace(id, version).catch(error => {
        if (version === generation && attached()) notice = env.messageFor(error)
      }).finally(() => { if (version === generation) emit() })
      emit()
    },
  }
  return controller
}
