import type { DirectoryPage, ProjectView } from './client-types.js'
import type { ProjectDirectoryTarget } from './harness-client.js'
import type { ComputerEnvironment, ComputerEnvironments } from '../core/computer/environments.js'

export interface DirectoryPositions { get(instanceId: string, environmentId?: string): string | undefined; set(instanceId: string, path: string, environmentId?: string): void }
export const environmentLabel = (environment: ComputerEnvironment): string => environment.origin === 'local' ? '本机（默认）'
  : `远端环境 · ${environment.platform ?? '平台待确认'}${environment.architecture ? `/${environment.architecture}` : ''} · ${environment.environmentId.slice(0, 8)}`
export const environmentStateLabel = (environment: ComputerEnvironment): string => ({ 'on-demand': '按需启动', connected: '已连接', offline: '离线', pending: '等待附着', revoked: '已撤销' })[environment.connectionState]

/** The environment list and selection belong to one captured harness connection. */
export function createProjectEnvironmentController(target: ProjectDirectoryTarget, env: { changed(): void }) {
  let environments: readonly ComputerEnvironment[] = [], selectedEnvironmentId: string | undefined, loading = false, error: unknown, closed = false
  let controller: AbortController | undefined, generation = 0
  const pending = new Set<Promise<void>>()
  const notify = () => { if (!closed) env.changed() }
  const failure = () => Object.assign(new Error('computer-environments-unavailable'), { code: 'computer-environments-unavailable' })
  return {
    initialize(): Promise<void> {
      if (closed) return Promise.resolve()
      controller?.abort(); const signal = (controller = new AbortController()).signal, token = ++generation
      loading = true; error = undefined; selectedEnvironmentId = undefined; notify()
      const task = Promise.resolve().then(() => target.environments(signal)).then((value: ComputerEnvironments) => {
        if (closed || token !== generation) return
        if (value.defaultEnvironmentId !== 'local:computer' || !Array.isArray(value.environments) ||
          !value.environments.some(item => item.environmentId === value.defaultEnvironmentId && item.origin === 'local' && item.state === 'approved')) throw failure()
        environments = Object.freeze(value.environments.map(item => Object.freeze({ ...item })))
        selectedEnvironmentId = value.defaultEnvironmentId
      }).catch(failure => { if (!closed && token === generation) { environments = []; error = failure } })
        .finally(() => { pending.delete(task); if (!closed && token === generation) { loading = false; notify() } })
      pending.add(task); return task
    },
    select(id: string): boolean {
      if (closed || loading || error || !environments.some(item => item.environmentId === id && item.state === 'approved')) return false
      selectedEnvironmentId = id; notify(); return true
    },
    target(): ProjectDirectoryTarget | undefined {
      if (closed || loading || error) return undefined
      const selected = environments.find(item => item.environmentId === selectedEnvironmentId && item.state === 'approved')
      return selected ? target.forEnvironment(selected) : undefined
    },
    snapshot: () => ({ environments, selectedEnvironmentId, loading, error, closed }),
    async close() { closed = true; generation++; controller?.abort(); await Promise.allSettled([...pending]) },
  }
}
/** Native confirmation registers on the captured device; other targets use the browser. */
export function createProjectDirectoryLauncher() {
  let disposed = false, active: { controller: AbortController; done: Promise<void> } | undefined
  const close = () => { active?.controller.abort(); return active?.done ?? Promise.resolve() }
  return {
    open(target: ProjectDirectoryTarget, env: { browse(): void; selected(project: ProjectView): void; failed(error: unknown): void }): Promise<void> | undefined {
      if (disposed || active) return undefined
      const controller = new AbortController(), signal = controller.signal
      const done = Promise.resolve().then(async () => {
        signal.throwIfAborted()
        let native = false
        if (target.environment?.origin === 'remote') { env.browse(); return }
        try { native = await target.nativeAvailable(signal) }
        catch { signal.throwIfAborted() }
        signal.throwIfAborted()
        if (!native) { env.browse(); return }
        const path = await target.pickNative(signal)
        signal.throwIfAborted()
        if (path === null) return
        const project = await target.register(path, signal)
        signal.throwIfAborted()
        env.selected(project)
      }).catch(error => { if (!signal.aborted) env.failed(error) }).finally(() => {
        if (active?.done === done) active = undefined
      })
      active = { controller, done }
      return done
    },
    close,
    dispose() { disposed = true; return close() },
  }
}

export function createDirectoryPositions(storage?: { getItem(key: string): string | null; setItem(key: string, value: string): void }): DirectoryPositions {
  const memory = new Map<string, string>(), prefix = 'anybox.project-directory.v1.'
  const key = (id: string, environmentId = 'local:computer') => environmentId === 'local:computer' ? id : `${id}:${encodeURIComponent(environmentId)}`
  return {
    get(instanceId, environmentId) {
      const id = key(instanceId, environmentId)
      if (memory.has(id)) return memory.get(id)
      try { const value = storage?.getItem(prefix + id); if (value) { memory.set(id, value); return value } } catch { /* Private browsing may deny storage. */ }
      return undefined
    },
    set(instanceId, path, environmentId) { const id = key(instanceId, environmentId); memory.set(id, path); try { storage?.setItem(prefix + id, path) } catch { /* Browsing still works in memory. */ } },
  }
}
export interface DirectorySnapshot {
  readonly mode: 'unknown' | 'browse' | 'manual'
  readonly loading: boolean
  readonly submitting: boolean
  readonly creating: boolean
  readonly creationSupported?: boolean
  readonly createFormOpen: boolean
  readonly directoryName: string
  readonly createPath?: string
  readonly createError?: unknown
  readonly createNeedsRead: boolean
  readonly pathInput: string
  readonly query: string
  readonly showHidden: boolean
  readonly homePath?: string
  readonly page?: DirectoryPage
  readonly error?: unknown
  readonly blocked: boolean
  readonly canSelect: boolean
  readonly canStartCreate: boolean
  readonly canCreate: boolean
  readonly hasRetry: boolean
  readonly closed: boolean
}
const browsePath = '/projects/directories/browse'
function errorCode(error: unknown): string { return error instanceof Error && 'code' in error ? String(error.code) : '' }
const bindingFailure = (error: unknown) => ['connection-changed', 'instance-mismatch', 'instance-unavailable', 'version-incompatible', 'client-disposed'].includes(errorCode(error))

/** Browser independent state; every response belongs to one dialog and one captured instance. */
export function createProjectDirectoryController(inputTarget: ProjectDirectoryTarget, env: {
  positions: DirectoryPositions
  changed(): void
  selected(project: ProjectView): void
}) {
  const pending = new Set<Promise<unknown>>()
  const track = <T>(promise: Promise<T>): Promise<T> => { const task = promise.finally(() => pending.delete(task)); pending.add(task); return task }
  const target: ProjectDirectoryTarget = { ...inputTarget, api: (path, body, signal) => track(inputTarget.api(path, body, signal)), register: (path, signal) => track(inputTarget.register(path, signal)) }
  let mode: DirectorySnapshot['mode'] = 'unknown', loading = false, submitting = false, creating = false
  let creationSupported: boolean | undefined, createFormOpen = false, directoryName = '', createPath: string | undefined, createError: unknown, createNeedsRead = false
  let pathInput = env.positions.get(target.connection.instanceId, target.environment?.environmentId) ?? '', query = '', showHidden = false
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
  const clearCreateForm = () => { createFormOpen = false; directoryName = ''; createPath = undefined; createError = undefined; createNeedsRead = false }
  const canSelect = () => !closed && !loading && !submitting && !creating && !blocked && !error && !createError &&
    (mode === 'manual' ? !!pathInput.trim() : mode === 'browse' && !!page && pathInput === page.path)
  const canStartCreate = () => creationSupported === true && mode === 'browse' && !!browseId && canSelect() && !createError && !createNeedsRead
  const canCreate = () => createFormOpen && canStartCreate() && createPath === page?.path && !!directoryName.trim() && !createError
  async function readPage(id: string, number: number, token: number, signal: AbortSignal, input: number): Promise<void> {
    const value = await target.api<DirectoryPage>(browsePath, { action: 'page', browseId: id, page: number }, signal)
    if (!current(token)) return
    page = value; homePath = value.homePath
    if (inputRevision === input) pathInput = value.path
    attemptedPath = value.path
    env.positions.set(target.connection.instanceId, value.path, target.environment?.environmentId)
  }
  async function navigate(path?: string): Promise<void> {
    if (closed || blocked || submitting || creating || mode !== 'browse') return
    clearCreateForm()
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
    if (closed || blocked || loading || submitting || creating || !browseId) return
    clearCreateForm()
    const id = browseId, { controller, token } = startRead(), input = inputRevision
    loading = true; error = undefined; retry = undefined; notify()
    try { await readPage(id, number, token, controller.signal, input) }
    // A disconnected page can already have retired its remote cursor. Start a fresh
    // bounded listing at the same location instead of repeatedly using a dead cursor.
    catch (failure) { if (current(token)) fail(failure, () => navigate(attemptedPath)) }
    finally { if (current(token)) { loading = false; notify() } }
  }
  async function initialize(): Promise<void> {
    if (closed || blocked || submitting || creating) return
    if (target.environment?.origin === 'remote') { mode = 'manual'; creationSupported = false; loading = false; notify(); return }
    const { controller, token } = startRead()
    loading = true; error = undefined; retry = undefined; notify()
    try {
      const info = await target.api<{ instanceId: string; apiVersion: number; capabilities: readonly string[] }>('/instance', undefined, controller.signal)
      if (!current(token)) return
      if (info.instanceId !== target.connection.instanceId) throw Object.assign(new Error('instance-mismatch'), { code: 'instance-mismatch' })
      if (info.apiVersion !== 1) throw Object.assign(new Error('version-incompatible'), { code: 'version-incompatible' })
      mode = info.capabilities.includes('projects.browse') ? 'browse' : 'manual'
      creationSupported = info.capabilities.includes('projects.create-directory')
      loading = false
      if (mode === 'browse') await navigate(attemptedPath)
      else notify()
    } catch (failure) { if (current(token)) { fail(failure, initialize); loading = false; notify() } }
  }
  async function submit(): Promise<void> {
    if (!canSelect()) return
    const { controller, token } = startRead(), path = mode === 'browse' ? page!.path : pathInput
    submitting = true; notify()
    try {
      const project = await target.register(path, controller.signal)
      if (!current(token)) return
      env.positions.set(target.connection.instanceId, project.path, target.environment?.environmentId)
      env.selected(project)
    } catch (failure) {
      if (current(token)) fail(failure, async () => {
        if (mode === 'browse') await navigate(path)
        else { error = undefined; await submit() }
      })
    } finally { if (current(token)) { submitting = false; notify() } }
  }
  async function createDirectory(): Promise<void> {
    if (!canCreate()) return
    // The remote reservation owns the parent; a draft path never enters this write.
    const id = browseId!, name = directoryName, { controller, token } = startRead()
    creating = true; createError = undefined; retry = undefined; notify()
    let createdPath: string | undefined
    try {
      const result = await target.api<{ path: string }>('/projects/directories/create', { browseId: id, name }, controller.signal)
      if (!current(token)) return
      createdPath = result.path
    } catch (failure) {
      if (current(token)) {
        createError = failure; blocked ||= bindingFailure(failure)
        createNeedsRead = !['directory-exists', 'directory-name-invalid'].includes(errorCode(failure))
      }
    } finally { if (current(token)) { creating = false; notify() } }
    // A subsequent listing failure may retry the read, never the completed mutation.
    if (createdPath !== undefined && current(token)) await navigate(createdPath)
  }
  return {
    snapshot: (): DirectorySnapshot => ({ mode, loading, submitting, creating, creationSupported, createFormOpen, directoryName, createPath, createError, createNeedsRead, pathInput, query, showHidden, homePath, page, error, blocked, closed, canSelect: canSelect(), canStartCreate: canStartCreate(), canCreate: canCreate(), hasRetry: !!retry }),
    initialize, navigate, submit, createDirectory,
    beginCreate() { if (!canStartCreate() || createFormOpen) return; createFormOpen = true; createPath = page!.path; directoryName = ''; createError = undefined; notify() },
    cancelCreate() { if (closed || creating) return; const needsRead = createNeedsRead; clearCreateForm(); createNeedsRead = needsRead; notify() },
    setDirectoryName(value: string) { if (closed || creating || blocked || !createFormOpen) return; directoryName = value; if (!createNeedsRead) createError = undefined; notify() },
    setPath(value: string) { if (closed || submitting || creating) return; pathInput = value; inputRevision++; if (mode === 'manual' && !blocked) error = undefined; notify() },
    filter(value: string, hidden: boolean) {
      if (closed || blocked || submitting || creating) return
      query = value; showHidden = hidden
      const draft = pathInput, preserveDraft = !!page && pathInput !== page.path
      void navigate(attemptedPath)
      if (preserveDraft) { pathInput = draft; inputRevision++; notify() }
    },
    next() { if (page?.nextPage !== null && page?.nextPage !== undefined) return loadPage(page.nextPage); return Promise.resolve() },
    restart() { return navigate(attemptedPath) },
    retry() { return !closed && !blocked && !loading && !submitting && !creating ? retry?.() ?? Promise.resolve() : Promise.resolve() },
    async close() { if (!closed) { closed = true; cancelRead(); release(browseId); browseId = undefined }; while (pending.size) await Promise.allSettled([...pending]) },
  }
}
