import type { Api, ApiError, PendingSubmission, RunEventView, RunView, SessionView, NodeView, NodePage, SessionPosition } from './client-types.js'
import type { SessionRef } from './workspace-layout.js'

export interface BrowserStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export const pendingKey = 'anybox.web.v2.pending'
export interface PendingStore {
  get(id: string): PendingSubmission | undefined
  set(id: string, value: PendingSubmission | undefined): void
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
            (value.runId !== undefined && typeof value.runId !== 'string') ||
            (value.parentNodeId !== undefined && value.parentNodeId !== null && typeof value.parentNodeId !== 'string')) continue
        entries.set(id, value as unknown as PendingSubmission)
      }
    }
  } catch { /* A new submission still must be saved successfully before it is sent. */ }
  return {
    get: id => entries.get(id),
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
  readonly events: ReadonlyMap<string, readonly RunEventView[]>
  readonly expanded: ReadonlySet<string>
}
export interface SessionController {
  snapshot(): SessionSnapshot
  attach(listener: () => void): void
  detach(): void
  refresh(): Promise<void>
  setDraft(value: string): void
  submit(): Promise<void>
  cancel(id: string): Promise<void>
  toggleTrace(id: string): void
  navigate(id: string | null, draft?: string): Promise<void>
  focusRun(id: string): void
  moreChildren(): Promise<void>
  regenerate(node: NodeView): Promise<void>
}
export interface SessionEnvironment {
  readonly api: Api
  readonly pending: PendingStore
  readonly messageFor: (error: unknown) => string
  readonly newId: () => string
  readonly hidden: () => boolean
  readonly schedule: (callback: () => void, ms: number) => unknown
  readonly clear: (timer: unknown) => void
  readonly missing: (ref: SessionRef) => void
  readonly position?: SessionPosition
  readonly savePosition?: (value: SessionPosition) => void
}

/** One controller per Session. A view may detach while its already-issued write still settles. */
export function createSessionController(ref: SessionRef, env: SessionEnvironment): SessionController {
  let session: SessionView | undefined, runs: readonly RunView[] = []
  let position: SessionPosition = env.position ?? { viewNodeId: null }
  let pathNodes: readonly NodeView[] = [], children: readonly NodeView[] = [], childCursor: string | undefined
  let notice = '', busy = false, loading = true, locationVersion = 0
  let listener: (() => void) | undefined, generation = 0, timer: unknown, refreshJob: Promise<void> | undefined
  let refreshAgain = false, locationJob: Promise<void> | undefined
  const drafts = new Map<string | null, string>()
  const reads = new Set<AbortController>()
  const events = new Map<string, readonly RunEventView[]>(), expanded = new Set<string>(), eventJobs = new Map<string, Promise<void>>()
  const path = `/sessions/${encodeURIComponent(ref.sessionId)}`
  const pending = () => env.pending.get(ref.sessionId)
  const attached = () => listener !== undefined
  const emit = () => listener?.()
  const remember = () => env.savePosition?.(position)
  const clearTimer = () => { if (timer !== undefined) env.clear(timer); timer = undefined }
  const invalidate = () => {
    generation++
    clearTimer()
    for (const request of reads) request.abort()
    reads.clear()
  }
  const schedule = () => {
    clearTimer()
    if (attached() && !busy) timer = env.schedule(() => { void controller.refresh() }, env.hidden() || !runs.some(isActive) ? 5000 : 1200)
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
  const adopt = (value: RunView) => {
    if (value.sessionId !== ref.sessionId) return
    const previous = runs.find(item => item.id === value.id)
    if (previous && previous.revision > value.revision) return
    runs = [...runs.filter(item => item.id !== value.id), value]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  }
  const loadEvents = (id: string, version: number): Promise<void> => {
    const key = `${version}:${id}`
    const existing = eventJobs.get(key)
    if (existing) return existing
    const job = (async () => {
      const prior = events.get(id) ?? []
      const loaded = await read<readonly RunEventView[]>(`/runs/${encodeURIComponent(id)}/events?afterSeq=${prior.at(-1)?.seq ?? 0}`, version)
      events.set(id, [...prior, ...loaded])
    })().finally(() => eventJobs.delete(key))
    eventJobs.set(key, job)
    return job
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
      loading = false
    } catch (error) {
      if (version !== generation || location !== locationVersion || !attached()) return
      if (isApiError(error) && error.status === 404 && nodeId !== null) {
        position = { viewNodeId: null }
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
    if (run.status === 'completed' && run.resultNodeId) await controller.navigate(run.resultNodeId)
    else { position = { ...position, follow: undefined }; remember() }
  }
  const submitStored = async (submission: PendingSubmission, followVersion?: number) => {
    if (busy) return
    busy = true
    invalidate()
    notice = ''
    emit()
    try {
      const accepted = await env.api<RunView>(`${path}/runs`, {
        input: submission.input, idempotencyKey: submission.idempotencyKey, parentNodeId: submission.parentNodeId,
      })
      if (accepted.sessionId !== ref.sessionId) throw new Error('session mismatch')
      adopt(accepted)
      expanded.add(accepted.id)
      if (followVersion !== undefined && followVersion === locationVersion && position.viewNodeId === submission.parentNodeId) {
        position = { ...position, focusedRunId: accepted.id, follow: { runId: accepted.id, parentNodeId: submission.parentNodeId! } }
        remember()
      }
      if (pending()?.idempotencyKey === submission.idempotencyKey) save(undefined)
    } catch (error) {
      notice = env.messageFor(error)
      if (isApiError(error) && error.status < 500 && error.code !== 'project-unavailable') {
        const parent = submission.parentNodeId ?? null
        if (!drafts.get(parent)) drafts.set(parent, submission.input)
        if (pending()?.idempotencyKey === submission.idempotencyKey) save(undefined)
      }
    } finally { busy = false; emit(); schedule() }
  }
  const recover = async (version: number) => {
    const submission = pending()
    if (!submission || busy) return
    let existing: RunView | undefined
    try { existing = await read<RunView>(`${path}/runs/by-key/${encodeURIComponent(submission.idempotencyKey)}`, version) }
    catch (error) { if (!isApiError(error) || error.status !== 404) throw error }
    if (existing) { adopt(existing); save(undefined) }
    else if (submission.parentNodeId === undefined) {
      notice = '旧版待提交消息尚未被接受，已保留输入。请选定对话位置后确认发送。'
      if (!drafts.get(position.viewNodeId)) drafts.set(position.viewNodeId, submission.input)
      save(undefined)
    } else await submitStored(submission)
  }
  const controller: SessionController = {
    snapshot: () => ({ session, runs, run: runs.find(item => item.id === position.focusedRunId), position,
      path: pathNodes, children, moreChildren: Boolean(childCursor), pending: pending(), busy, loading, notice,
      draft: drafts.get(position.viewNodeId) ?? '', events, expanded }),
    attach(value) { listener = value; session = undefined; loading = true; invalidate(); void controller.refresh() },
    detach() {
      listener = undefined
      invalidate()
      locationVersion++
      position = { ...position, follow: undefined }
      remember()
      refreshAgain = false
    },
    setDraft(value) {
      drafts.set(position.viewNodeId, value)
      if (position.follow) { position = { ...position, follow: undefined }; remember() }
    },
    async navigate(id, draft) {
      locationVersion++
      position = { viewNodeId: id }
      if (draft !== undefined) drafts.set(id, draft)
      pathNodes = []; children = []; childCursor = undefined
      loading = true
      notice = ''
      remember()
      emit()
      const job = readLocation()
      locationJob = job
      await job
      if (locationJob === job) locationJob = undefined
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
      if (locationJob === job) locationJob = undefined
    },
    refresh() {
      clearTimer()
      if (!attached() || busy) { schedule(); return Promise.resolve() }
      if (refreshJob) { refreshAgain = true; return refreshJob }
      refreshJob = Promise.resolve().then(async () => {
        do {
          refreshAgain = false
          const version = generation
          try {
            if (!session) {
              const loaded = await read<SessionView>(path, version)
              if (loaded.projectId !== ref.projectId) { env.missing(ref); return }
              session = loaded
            }
            // Discover every run, including work started through another tab or host.
            const loaded = await read<readonly RunView[]>(`${path}/runs`, version)
            for (const value of loaded) adopt(value)
            for (const value of runs) {
              if (isActive(value) || expanded.has(value.id)) await loadEvents(value.id, version)
            }
            if (!locationJob) await readLocation()
            await recover(version)
            await followResult()
          } catch (error) {
            if (version === generation && attached()) {
              if (isApiError(error) && error.status === 404 && !session) env.missing(ref)
              else { loading = false; notice = env.messageFor(error) }
            }
          }
        } while (refreshAgain && attached() && !busy)
      }).finally(() => { refreshJob = undefined; emit(); schedule() })
      return refreshJob
    },
    async submit() {
      if (!session || busy || loading) return
      let submission = pending()
      if (!submission) {
        const input = (drafts.get(position.viewNodeId) ?? '').trim()
        if (!input) { notice = '请输入消息。'; emit(); return }
        submission = { sessionId: ref.sessionId, input, idempotencyKey: env.newId(), parentNodeId: position.viewNodeId }
        if (!save(submission)) return
        drafts.set(position.viewNodeId, '')
      }
      await submitStored(submission, locationVersion)
    },
    async regenerate(node) {
      if (busy || pending() || node.sessionId !== ref.sessionId) return
      const submission: PendingSubmission = { sessionId: ref.sessionId, input: node.input, parentNodeId: node.parentId, idempotencyKey: env.newId() }
      if (!save(submission)) return
      await controller.navigate(node.parentId)
      await submitStored(submission, locationVersion)
    },
    async cancel(id) {
      if (!runs.some(item => item.id === id && isActive(item)) || busy) return
      busy = true
      invalidate()
      emit()
      try { adopt(await env.api<RunView>(`/runs/${encodeURIComponent(id)}/cancel`, {})); notice = '' }
      catch (error) { notice = env.messageFor(error) }
      finally { busy = false; emit(); schedule() }
    },
    toggleTrace(id) {
      if (expanded.has(id)) { expanded.delete(id); emit(); return }
      expanded.add(id)
      const version = generation
      void loadEvents(id, version).catch(error => {
        if (version === generation && attached()) notice = env.messageFor(error)
      }).finally(() => { if (version === generation) emit() })
      emit()
    },
  }
  return controller
}
