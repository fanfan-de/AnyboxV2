import type { HarnessClient } from './harness-client.js'
import { splitScopedId } from './harness-client.js'
import type { Api, ProjectView, SessionView } from './client-types.js'

/** Latest read wins, including a refresh after a restore or a settings reopening. */
export function createArchiveIndex(api: Api, changed: () => void) {
  let sessions: readonly SessionView[] = [], loading = false, error: unknown
  let read: AbortController | undefined, disposed = false
  const unsubscribe = (api as Partial<HarnessClient>).subscribeList?.('/sessions/archived', values => { if (!disposed) { sessions = values as readonly SessionView[]; changed() } })
  return {
    snapshot: () => ({ sessions, loading, error }),
    async load(): Promise<void> {
      if (disposed) return
      read?.abort()
      const current = new AbortController(); read = current
      loading = true; error = undefined; changed()
      try {
        const value = await api<readonly SessionView[]>('/sessions/archived', undefined, current.signal)
        if (disposed || read !== current) return
        sessions = value
      } catch (failure) {
        if (disposed || read !== current) return
        error = failure
      } finally {
        if (!disposed && read === current) { loading = false; changed() }
      }
    },
    dispose() { disposed = true; read?.abort(); unsubscribe?.() },
  }
}

export function setupArchivePanel(api: Api, messageFor: (error: unknown) => string, env: {
  root: ParentNode
  projects(): readonly ProjectView[]
  view(session: SessionView): void
  restore(session: SessionView): Promise<void>
}) {
  const dialog = env.root.querySelector<HTMLDialogElement>('#agent--settings-dialog')!
  const panel = env.root.querySelector<HTMLElement>('#agent--archive-settings')!
  const list = panel.querySelector<HTMLElement>('.archive-list')!
  const status = panel.querySelector<HTMLElement>('[data-archive-status]')!
  const retry = panel.querySelector<HTMLButtonElement>('[data-archive-refresh]')!
  const listeners = new AbortController(), options = { signal: listeners.signal }
  const restoring = new Set<string>()
  let disposed = false, actionError: unknown
  const index = createArchiveIndex(api, render)
  const visible = () => dialog.open && !panel.hidden
  function render(): void {
    if (disposed) return
    const state = index.snapshot()
    const focused = list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset : undefined
    list.setAttribute('aria-busy', String(state.loading))
    status.textContent = actionError ? messageFor(actionError) : state.error ? messageFor(state.error)
      : state.loading ? '正在读取已归档会话…' : state.sessions.length ? '' : '还没有已归档会话'
    list.replaceChildren(...state.sessions.map(session => {
      const row = document.createElement('div'); row.className = 'archive-row'
      const copy = document.createElement('div'); copy.className = 'archive-copy'
      const title = document.createElement('strong')
      const project = env.projects().find(project => project.id === session.projectId)
      const label = session.title || `会话 ${(splitScopedId(session.id)?.id ?? session.id).slice(0, 8)}`
      title.textContent = `${project ? [project.harnessName, project.name].filter(Boolean).join(' · ') : session.projectId} · ${label}`
      const time = document.createElement('time'); time.dateTime = session.archivedAt!
      time.textContent = `归档于 ${new Date(session.archivedAt!).toLocaleString('zh-CN')}`
      copy.append(title, time)
      const view = document.createElement('button'); view.type = 'button'; view.textContent = '查看'
      view.className = 'secondary-button'; view.dataset.archiveView = session.id
      view.addEventListener('click', () => { dialog.close(); env.view(session) }, options)
      const restore = document.createElement('button'); restore.type = 'button'; restore.textContent = restoring.has(session.id) ? '正在恢复…' : '恢复'
      restore.dataset.archiveRestore = session.id; restore.disabled = restoring.has(session.id)
      restore.addEventListener('click', () => {
        if (restoring.has(session.id)) return
        restoring.add(session.id); actionError = undefined; render()
        void env.restore(session).then(() => index.load()).catch(error => { actionError = error }).finally(() => {
          restoring.delete(session.id); render()
          // The restored row is gone; keep keyboard focus inside visible settings.
          if (visible() && !dialog.contains(document.activeElement)) retry.focus()
        })
      }, options)
      row.append(copy, view, restore)
      return row
    }))
    if (focused) [...list.querySelectorAll<HTMLButtonElement>('button')].find(button =>
      (focused.archiveView && button.dataset.archiveView === focused.archiveView) ||
      (focused.archiveRestore && button.dataset.archiveRestore === focused.archiveRestore))?.focus({ preventScroll: true })
  }
  retry.addEventListener('click', () => { actionError = undefined; void index.load() }, options)
  return {
    activate() { if (!disposed && visible()) { actionError = undefined; void index.load() } },
    refresh() { if (!disposed && visible()) void index.load() },
    dispose() { disposed = true; listeners.abort(); index.dispose() },
  }
}
