import type { DirectoryPage, ProjectView } from './client-types.js'
import type { ProjectDirectoryTarget } from './harness-client.js'

export interface DirectoryPositions { get(instanceId: string): string | undefined; set(instanceId: string, path: string): void }
export function createDirectoryPositions(storage?: { getItem(key: string): string | null; setItem(key: string, value: string): void }): DirectoryPositions {
  const memory = new Map<string, string>(), prefix = 'anybox.project-directory.v1.'
  return {
    get(id) {
      if (memory.has(id)) return memory.get(id)
      try { const value = storage?.getItem(prefix + id); if (value) { memory.set(id, value); return value } } catch { /* Private browsing may deny storage. */ }
      return undefined
    },
    set(id, path) { memory.set(id, path); try { storage?.setItem(prefix + id, path) } catch { /* Browsing still works in memory. */ } },
  }
}
export interface DirectorySnapshot {
  readonly mode: 'unknown' | 'browse' | 'manual'
  readonly loading: boolean
  readonly submitting: boolean
  readonly nativeAvailable: boolean
  readonly pathInput: string
  readonly query: string
  readonly showHidden: boolean
  readonly homePath?: string
  readonly page?: DirectoryPage
  readonly error?: unknown
  readonly blocked: boolean
  readonly canSelect: boolean
  readonly closed: boolean
}
const browsePath = '/projects/directories/browse'
function errorCode(error: unknown): string { return error instanceof Error && 'code' in error ? String(error.code) : '' }
const bindingFailure = (error: unknown) => ['connection-changed', 'instance-mismatch', 'instance-unavailable', 'version-incompatible', 'client-disposed'].includes(errorCode(error))

/** Browser independent state; every response belongs to one dialog and one captured instance. */
export function createProjectDirectoryController(target: ProjectDirectoryTarget, env: {
  positions: DirectoryPositions
  changed(): void
  selected(project: ProjectView): void
}) {
  let mode: DirectorySnapshot['mode'] = 'unknown', loading = false, submitting = false, nativeAvailable = false
  let pathInput = env.positions.get(target.connection.instanceId) ?? '', query = '', showHidden = false
  let homePath: string | undefined, page: DirectoryPage | undefined, error: unknown, blocked = false, closed = false
  let read: AbortController | undefined, generation = 0, inputRevision = 0, browseId: string | undefined
  let attemptedPath: string | undefined = pathInput || undefined
  let retry: (() => Promise<void>) | undefined
  const notify = () => { if (!closed) env.changed() }
  const release = (id: string | undefined) => { if (id) void target.api('/projects/directories/close', { browseId: id }).catch(() => {}) }
  const cancelRead = () => { generation++; read?.abort(); read = undefined }
  const startRead = () => { cancelRead(); const controller = new AbortController(); read = controller; return { controller, token: generation } }
  const current = (token: number) => !closed && generation === token
  const fail = (failure: unknown, again: () => Promise<void>) => {
    error = failure; blocked ||= bindingFailure(failure); retry = again
  }
  const canSelect = () => !closed && !loading && !submitting && !blocked && !error &&
    (mode === 'manual' ? !!pathInput.trim() : mode === 'browse' && !!page && pathInput === page.path)
  async function readPage(id: string, number: number, token: number, signal: AbortSignal, input: number): Promise<void> {
    const value = await target.api<DirectoryPage>(browsePath, { action: 'page', browseId: id, page: number }, signal)
    if (!current(token)) return
    page = value; homePath = value.homePath
    if (inputRevision === input) pathInput = value.path
    attemptedPath = value.path
    env.positions.set(target.connection.instanceId, value.path)
  }
  async function navigate(path?: string): Promise<void> {
    if (closed || blocked || submitting || mode !== 'browse') return
    const { controller, token } = startRead()
    release(browseId); browseId = undefined
    attemptedPath = path
    pathInput = path ?? ''; const input = ++inputRevision
    loading = true; error = undefined; retry = undefined; notify()
    try {
      const reservation = await target.api<{ browseId: string; homePath: string }>(browsePath, { action: 'open', ...(path === undefined ? {} : { path }), query, showHidden }, controller.signal)
      if (!current(token)) { release(reservation.browseId); return }
      browseId = reservation.browseId; homePath = reservation.homePath
      await readPage(reservation.browseId, 0, token, controller.signal, input)
    } catch (failure) { if (current(token)) fail(failure, () => navigate(path)) }
    finally { if (current(token)) { loading = false; notify() } }
  }
  async function loadPage(number: number): Promise<void> {
    if (closed || blocked || loading || submitting || !browseId) return
    const id = browseId, { controller, token } = startRead(), input = inputRevision
    loading = true; error = undefined; retry = undefined; notify()
    try { await readPage(id, number, token, controller.signal, input) }
    // A disconnected page can already have retired its remote cursor. Start a fresh
    // bounded listing at the same location instead of repeatedly using a dead cursor.
    catch (failure) { if (current(token)) fail(failure, () => navigate(attemptedPath)) }
    finally { if (current(token)) { loading = false; notify() } }
  }
  async function initialize(): Promise<void> {
    if (closed || blocked || submitting) return
    const { controller, token } = startRead()
    loading = true; error = undefined; retry = undefined; notify()
    try {
      // A failed optional shortcut must not turn a healthy remote into an unavailable picker.
      const [info, native] = await Promise.all([
        target.api<{ instanceId: string; apiVersion: number; capabilities: readonly string[] }>('/instance', undefined, controller.signal),
        target.nativeAvailable(controller.signal).catch(() => false),
      ])
      if (!current(token)) return
      nativeAvailable = native
      if (info.instanceId !== target.connection.instanceId) throw Object.assign(new Error('instance-mismatch'), { code: 'instance-mismatch' })
      if (info.apiVersion !== 1) throw Object.assign(new Error('version-incompatible'), { code: 'version-incompatible' })
      mode = info.capabilities.includes('projects.browse') ? 'browse' : 'manual'
      loading = false
      if (mode === 'browse') await navigate(attemptedPath)
      else notify()
    } catch (failure) { if (current(token)) { fail(failure, initialize); loading = false; notify() } }
  }
  async function pickNative(): Promise<void> {
    if (!nativeAvailable || closed || blocked || submitting || loading) return
    const { controller, token } = startRead()
    loading = true; error = undefined; notify()
    try {
      const path = await target.pickNative(controller.signal)
      if (!current(token)) return
      loading = false
      if (path !== null) {
        if (mode === 'browse') { await navigate(path); return }
        pathInput = path; inputRevision++
      }
    } catch (failure) { if (current(token)) fail(failure, pickNative) }
    finally { if (current(token)) { loading = false; notify() } }
  }
  async function submit(): Promise<void> {
    if (!canSelect()) return
    const { controller, token } = startRead(), path = mode === 'browse' ? page!.path : pathInput
    submitting = true; notify()
    try {
      const project = await target.register(path, controller.signal)
      if (!current(token)) return
      env.positions.set(target.connection.instanceId, project.path)
      env.selected(project)
    } catch (failure) {
      if (current(token)) fail(failure, async () => {
        if (mode === 'browse') await navigate(path)
        else { error = undefined; await submit() }
      })
    } finally { if (current(token)) { submitting = false; notify() } }
  }
  return {
    snapshot: (): DirectorySnapshot => ({ mode, loading, submitting, nativeAvailable, pathInput, query, showHidden, homePath, page, error, blocked, closed, canSelect: canSelect() }),
    initialize, navigate, submit, pickNative,
    setPath(value: string) { if (closed || submitting) return; pathInput = value; inputRevision++; if (mode === 'manual' && !blocked) error = undefined; notify() },
    filter(value: string, hidden: boolean) {
      if (closed || blocked || submitting) return
      query = value; showHidden = hidden
      const draft = pathInput, preserveDraft = !!page && pathInput !== page.path
      void navigate(attemptedPath)
      if (preserveDraft) { pathInput = draft; inputRevision++; notify() }
    },
    next() { if (page?.nextPage !== null && page?.nextPage !== undefined) return loadPage(page.nextPage); return Promise.resolve() },
    restart() { return navigate(attemptedPath) },
    retry() { return !closed && !blocked && !loading && !submitting ? retry?.() ?? Promise.resolve() : Promise.resolve() },
    close() { if (closed) return; closed = true; cancelRead(); release(browseId); browseId = undefined },
  }
}
