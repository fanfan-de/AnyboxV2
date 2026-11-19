import { splitScopedId } from './harness-client.js'
import type { Api, ProjectView, SessionView } from './client-types.js'

/** Latest read wins, including a refresh after a restore or a settings reopening. */
export function createArchiveIndex(api: Api, changed: () => void) {
  let sessions: readonly SessionView[] = [], archived: readonly SessionView[] = [], loading = false, error: unknown
  let read: AbortController | undefined, disposed = false
  return {
    snapshot: () => ({ sessions: [...new Map([...sessions, ...archived].filter(session => !session.continuous).map(session => [session.id, session])).values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)), loading, error }),
    async load(): Promise<void> {
      if (disposed) return
      read?.abort()
      const current = new AbortController(); read = current
      loading = true; error = undefined; changed()
      try {
        const [value, legacy] = await Promise.allSettled([
          api<readonly SessionView[]>('/sessions/archived', undefined, current.signal),
          api<readonly ProjectView[]>('/projects', undefined, current.signal).then(projects => Promise.allSettled(projects.map(project =>
            api<readonly SessionView[]>(`/projects/${encodeURIComponent(project.id)}/sessions`, undefined, current.signal)))),
        ])
        if (disposed || read !== current) return
        if (value.status === 'fulfilled') archived = value.value
        if (legacy.status === 'fulfilled') sessions = legacy.value.flatMap(result => result.status === 'fulfilled' ? result.value : [])
        const failed = [value, legacy, ...(legacy.status === 'fulfilled' ? legacy.value : [])].find(result => result.status === 'rejected')
        if (failed?.status === 'rejected') error = failed.reason
      } catch (failure) {
        if (disposed || read !== current) return
        error = failure
      } finally {
        if (!disposed && read === current) { loading = false; changed() }
      }
    },
    dispose() { disposed = true; read?.abort() },
  }
}

export function setupArchivePanel(api: Api, messageFor: (error: unknown) => string, env: {
  root: ParentNode
  view(session: SessionView): void
}) {
  const dialog = env.root.querySelector<HTMLDialogElement>('#personal-agent--settings-dialog')!
  const panel = env.root.querySelector<HTMLElement>('#personal-agent--archive-settings')!
  const list = panel.querySelector<HTMLElement>('.archive-list')!
  const status = panel.querySelector<HTMLElement>('[data-archive-status]')!
  const retry = panel.querySelector<HTMLButtonElement>('[data-archive-refresh]')!
  const listeners = new AbortController(), options = { signal: listeners.signal }
  let disposed = false
  const index = createArchiveIndex(api, render)
  const visible = () => dialog.open && !panel.hidden
  function render(): void {
    if (disposed) return
    const state = index.snapshot()
    const focused = list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset : undefined
    list.setAttribute('aria-busy', String(state.loading))
    status.textContent = state.error ? messageFor(state.error)
      : state.loading ? '正在读取历史对话…' : state.sessions.length ? '' : '没有旧版对话记录'
    list.replaceChildren(...state.sessions.map(session => {
      const row = document.createElement('div'); row.className = 'archive-row'
      const copy = document.createElement('div'); copy.className = 'archive-copy'
      const title = document.createElement('strong')
      title.textContent = session.title || `会话 ${(splitScopedId(session.id)?.id ?? session.id).slice(0, 8)}`
      const time = document.createElement('time'); time.dateTime = session.archivedAt ?? session.createdAt
      time.textContent = `${session.archivedAt ? '归档于 ' : ''}${new Date(time.dateTime).toLocaleString('zh-CN')}`
      copy.append(title, time)
      const view = document.createElement('button'); view.type = 'button'; view.textContent = '查看'
      view.className = 'secondary-button'; view.dataset.archiveView = session.id
      view.addEventListener('click', () => { dialog.close(); env.view(session) }, options)
      row.append(copy, view)
      return row
    }))
    if (focused) [...list.querySelectorAll<HTMLButtonElement>('button')].find(button => button.dataset.archiveView === focused.archiveView)?.focus({ preventScroll: true })
  }
  retry.addEventListener('click', () => { void index.load() }, options)
  return {
    activate() { if (!disposed && visible()) void index.load() },
    refresh() { if (!disposed && visible()) void index.load() },
    dispose() { disposed = true; listeners.abort(); index.dispose() },
  }
}
