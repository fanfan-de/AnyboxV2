import { requestJSON } from './http-client.js'
import type { ProductView } from '../applications/contracts.js'
import type { ApplicationActivation, ApplicationWebContext, ApplicationWebModule, MountedApplication } from './application-contracts.js'
import { applicationHash, closeApplicationView, parseApplicationHash, readApplicationWorkspace, workspaceStorageKey } from './application-workspace.js'

interface ApplicationPanel {
  id: string; route: string; panel: HTMLElement
  mounted?: MountedApplication; controller: AbortController; listeners: Set<() => void>
  loading?: Promise<void>; revision: number; openRequested: boolean; module?: ApplicationWebModule
  styles: HTMLLinkElement[]; error?: boolean; focus?: HTMLElement; control?: boolean; disposing?: boolean; disposal?: Promise<void>
}
const list = document.getElementById('application-list')!, panels = document.getElementById('application-panels')!
const shortcuts = document.getElementById('application-shortcuts')!
const rail = document.querySelector('.product-rail')!
const manager = document.getElementById('application-manager')!
const actions = document.getElementById('application-actions')!
const showApplications = document.getElementById('show-applications')! as HTMLButtonElement
const closeButton = document.getElementById('close-application')! as HTMLButtonElement
const notice = document.getElementById('workbench-notice')!, stopButton = document.getElementById('stop-application')! as HTMLButtonElement
const moduleAttempts = new Map<string, number>()
const lifetime = new AbortController(), views = new Map<string, ApplicationPanel>(), modules = new Map<string, Promise<ApplicationWebModule>>()
let applications: readonly ProductView[] = [], activeId: string | null = null, closed = false, requestRevision = 0, refreshTask: Promise<void> | undefined
let listRevision = ''
let managerInteractionRevision = 0
const showManager = () => { if (!closed && !manager.matches(':popover-open')) manager.showPopover() }
const hideManager = () => { if (manager.matches(':popover-open')) manager.hidePopover() }
const show = (message = '') => { notice.textContent = message; notice.hidden = !message; if (message) showManager() }
const states: Record<ProductView['state'], string> = { disabled: '尚未打开', applying: '正在处理', running: '运行中', blocked: '依赖未就绪', failed: '启动或关闭失败' }
const product = (id: string) => applications.find(app => app.definition.id === id)
// Keep the saved workspace's tabs field so existing browser positions continue to restore.
const snapshot = () => ({ tabs: [...views.values()].map(tab => ({ id: tab.id, route: tab.route })), activeId })
function save() { try { sessionStorage.setItem(workspaceStorageKey, JSON.stringify(snapshot())) } catch { /* Optional browser positions. */ } }
function address(replace = false) {
  const tab = activeId && views.get(activeId), hash = tab ? applicationHash(tab.id, tab.route) : '#/apps'
  if (location.hash !== hash) history[replace ? 'replaceState' : 'pushState'](null, '', hash)
  save()
}
function loadModule(app: ProductView): Promise<ApplicationWebModule> {
  const entry = app.definition.web?.entry
  if (!entry || !entry.startsWith('/') || entry.startsWith('//')) return Promise.reject(new Error('missing application interface'))
  let task = modules.get(entry)
  if (!task) {
    const attempt = moduleAttempts.get(entry) ?? 0; moduleAttempts.set(entry, attempt + 1)
    const url = new URL(entry, location.origin); if (attempt) url.searchParams.set('interfaceRevision', String(attempt))
    task = import(url.href).then(module => { if (typeof module.mount !== 'function') throw new Error('invalid application interface'); return module }); modules.set(entry, task); void task.catch(() => { if (modules.get(entry) === task) modules.delete(entry) })
  }
  return task
}
function button(text: string, action: () => void) {
  const element = document.createElement('button'); element.type = 'button'; element.textContent = text; element.addEventListener('click', action); return element
}
function renderList() {
  const revision = JSON.stringify(applications.map(app => {
    const view = views.get(app.definition.id)
    return [app, !!view?.control, !!view?.disposing, !!view?.loading, !!view?.error]
  }))
  if (revision === listRevision) { renderNavigation(); return }
  listRevision = revision
  list.replaceChildren()
  if (!applications.length) { const empty = document.createElement('p'); empty.textContent = '当前没有注册应用。'; list.append(empty) }
  for (const app of applications) {
    const view = views.get(app.definition.id)
    const card = document.createElement('article'); card.className = 'application-card'
    const title = document.createElement('h3'); title.textContent = app.definition.name
    const description = document.createElement('p'); description.textContent = app.definition.description ?? ''
    const state = document.createElement('p'); state.className = 'application-state'; state.textContent = view?.control ? '正在处理应用操作…' : states[app.state]
    const open = button(`打开 ${app.definition.name}`, () => { void enterApplication(app.definition.id) }); open.disabled = !app.definition.web || app.state === 'applying' || !!view?.control || !!view?.disposing
    card.append(title, description, state, open)
    if (view?.loading) { const loading = document.createElement('p'); loading.textContent = '正在加载应用界面…'; card.append(loading) }
    if (view?.error) card.append(button('重新加载界面', () => {
      view.error = false; show(); hideManager(); void ensureMounted(view, 'select')
    }))
    if (app.state === 'failed' || app.state === 'blocked') card.append(button('重试启动', () => { void openApplication(app.definition.id, true) }))
    if (app.desiredEnabled) card.append(button('停止应用', () => { void stopApplication(app.definition.id) }))
    list.append(card)
  }
  renderNavigation()
}
function renderNavigation() {
  const existing = new Map([...shortcuts.querySelectorAll<HTMLButtonElement>('button')].map(element => [element.dataset.appId, element]))
  for (const [index, app] of applications.entries()) {
    const id = app.definition.id
    let shortcut = existing.get(id)
    if (!shortcut) {
      shortcut = button(app.definition.name.slice(0, 1), () => { void enterApplication(id) })
      shortcut.className = 'application-shortcut'; shortcut.dataset.appId = id
      shortcut.id = `app-shortcut-${id}`
    }
    shortcut.textContent = app.definition.name.slice(0, 1)
    shortcut.title = `${app.definition.name} · ${states[app.state]}`
    shortcut.setAttribute('aria-label', app.definition.name)
    shortcut.disabled = !app.definition.web || app.state === 'applying'
    shortcut.dataset.state = app.state
    if (views.has(id)) shortcut.setAttribute('aria-controls', `app-panel-${id}`)
    else shortcut.removeAttribute('aria-controls')
    if (shortcuts.children[index] !== shortcut) shortcuts.insertBefore(shortcut, shortcuts.children[index] ?? null)
    existing.delete(id)
  }
  for (const shortcut of existing.values()) shortcut.remove()
  updateNavigation()
}
function updateNavigation() {
  for (const shortcut of shortcuts.querySelectorAll<HTMLButtonElement>('button')) {
    const id = shortcut.dataset.appId!, app = product(id), view = views.get(id)
    shortcut.disabled = !app?.definition.web || app.state === 'applying' || !!view?.control || !!view?.disposing
    if (shortcut.dataset.appId === activeId) shortcut.setAttribute('aria-current', 'page')
    else shortcut.removeAttribute('aria-current')
  }
}
function renderWorkspace() {
  for (const tab of views.values()) {
    const app = product(tab.id), active = activeId === tab.id
    tab.panel.setAttribute('aria-label', app?.definition.name ?? tab.id)
    tab.panel.hidden = !active; tab.panel.inert = !active
  }
  const app = activeId && product(activeId)
  const view = activeId ? views.get(activeId) : undefined
  actions.hidden = !view
  closeButton.hidden = !view; closeButton.disabled = !!view?.control || !!view?.disposing
  closeButton.title = app ? `关闭 ${app.definition.name} 界面` : '关闭当前应用界面'
  closeButton.setAttribute('aria-label', closeButton.title)
  stopButton.hidden = !app || !app.desiredEnabled
  stopButton.disabled = !!view?.control || !!view?.disposing
  stopButton.title = app ? `停止 ${app.definition.name}` : '停止应用'
  stopButton.setAttribute('aria-label', stopButton.title)
  updateNavigation()
}
function clearUnmountedPanel(tab: ApplicationPanel) {
  if (tab.mounted) return
  tab.panel.replaceChildren()
  renderList()
}
function disposeMounted(tab: ApplicationPanel): Promise<void> {
  if (tab.disposal) return tab.disposal
  tab.disposing = true
  tab.revision++; tab.controller.abort()
  const page = tab.mounted; tab.mounted = undefined
  const loading = tab.loading
  const task = (async () => {
    await page?.dispose()
    await loading
    tab.listeners.clear(); for (const style of tab.styles) style.remove(); tab.styles = []
    tab.controller = new AbortController(); tab.panel.replaceChildren()
  })().finally(() => { tab.disposing = false; if (tab.disposal === task) tab.disposal = undefined })
  tab.disposal = task; return task
}
async function ensureMounted(tab: ApplicationPanel, reason: ApplicationActivation) {
  if (tab.disposal) await tab.disposal
  if (closed || views.get(tab.id) !== tab) return
  const app = product(tab.id)
  if (closed || app?.state !== 'running' || !app.definition.web) { clearUnmountedPanel(tab); return }
  if (reason === 'open') tab.openRequested = true
  if (tab.mounted) {
    const activation = tab.openRequested ? 'open' : reason; tab.openRequested = false
    await tab.mounted.setActive(activeId === tab.id, activation); return
  }
  if (tab.loading) return tab.loading
  const revision = ++tab.revision
  clearUnmountedPanel(tab)
  const task = (async () => {
    const module = await loadModule(app)
    if (closed || revision !== tab.revision) return
    tab.module = module; tab.error = false
    const styleLoads = (app.definition.web?.styles ?? []).map(path => new Promise<void>((resolve, reject) => {
      const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = path
      const signal = tab.controller.signal
      const cancelled = () => { style.remove(); reject(new DOMException('Aborted', 'AbortError')) }
      const finish = (error?: Error) => { signal.removeEventListener('abort', cancelled); error ? reject(error) : resolve() }
      style.onload = () => finish(); style.onerror = () => finish(new Error('application styles unavailable'))
      signal.addEventListener('abort', cancelled, { once: true })
      tab.styles.push(style); document.head.append(style)
    }))
    await Promise.all(styleLoads)
    if (closed || revision !== tab.revision) return
    tab.panel.replaceChildren()
    const context: ApplicationWebContext = { appId: tab.id, apiBase: `/api/client/v1/apps/${encodeURIComponent(tab.id)}`, signal: tab.controller.signal,
      domId: local => `${tab.id}--${local}`, route: {
        read: () => tab.route,
        navigate(path, replace = false) {
          if (closed || revision !== tab.revision || tab.route === path) return
          tab.route = path
          if (activeId === tab.id) address(replace); else save()
          for (const listener of [...tab.listeners]) listener()
        },
        subscribe(listener) { tab.listeners.add(listener); return () => { tab.listeners.delete(listener) } },
      } }
    const mounted = await module.mount(tab.panel, context)
    if (closed || revision !== tab.revision) { await mounted.dispose(); return }
    tab.mounted = mounted
    const activation = tab.openRequested ? 'open' : reason; tab.openRequested = false
    await mounted.setActive(activeId === tab.id, activation)
  })().catch(async () => {
    if (closed || revision !== tab.revision) return
    tab.error = true; tab.controller.abort(); tab.listeners.clear()
    const mounted = tab.mounted; tab.mounted = undefined; await mounted?.dispose().catch(() => {})
    for (const style of tab.styles) style.remove(); tab.styles = []
    tab.controller = new AbortController()
    clearUnmountedPanel(tab)
    if (activeId === tab.id) show('应用界面暂时无法加载，请重新加载界面。')
  }).finally(() => { if (tab.loading === task) tab.loading = undefined; if (!closed) renderList() })
  tab.loading = task; renderList(); return task
}
function addApplication(id: string, route = ''): ApplicationPanel {
  const existing = views.get(id); if (existing) return existing
  const panel = document.createElement('section'); panel.className = 'application-panel product-page'; panel.dataset.appId = id
  panel.id = `app-panel-${id}`; panel.setAttribute('role', 'region'); panel.tabIndex = -1
  panels.append(panel)
  const tab: ApplicationPanel = { id, route, panel, controller: new AbortController(), listeners: new Set(), revision: 0, openRequested: false, styles: [] }
  views.set(id, tab); renderNavigation(); clearUnmountedPanel(tab); return tab
}
function selectApplication(id: string | null, reason: ApplicationActivation = 'select', changeAddress = true) {
  const previous = activeId && views.get(activeId)
  if (previous && previous.id !== id) {
    if (previous.panel.contains(document.activeElement)) previous.focus = document.activeElement as HTMLElement
    void Promise.resolve(previous.mounted?.setActive(false, 'select')).catch(() => show('应用界面暂时无法切换。'))
  }
  if (activeId !== id) show()
  activeId = id; renderWorkspace(); if (changeAddress) address(); else save()
  if (id) hideManager(); else showManager()
  const tab = id && views.get(id)
  if (tab) {
    const app = product(tab.id)
    if (!app) show('此应用暂不可用。')
    else if (app.state !== 'running' || !app.definition.web) showManager()
    void ensureMounted(tab, reason).catch(() => show('应用界面暂时无法切换。'))
    if (reason === 'select') (tab.focus?.isConnected ? tab.focus : tab.panel).focus({ preventScroll: true })
  }
}
async function closeApplicationPage(id: string) {
  const tab = views.get(id); if (!tab || tab.control) return
  if (tab.mounted && !tab.mounted.canClose()) { show('请先完成或保存当前应用中的编辑。'); return }
  tab.control = true; renderList(); renderWorkspace()
  try { await disposeMounted(tab) } catch { show('应用界面清理失败，请刷新页面。'); tab.control = false; renderList(); renderWorkspace(); return }
  // A different application may have become active while disposal was pending.
  const wasActive = activeId === id
  const next = closeApplicationView(snapshot(), id)
  views.delete(id); tab.panel.remove(); renderList()
  if (wasActive) {
    selectApplication(next.activeId)
    const focus = next.activeId ? document.getElementById(`app-shortcut-${next.activeId}`) : showApplications
    focus?.focus(); show()
  } else { renderWorkspace(); save() }
}
async function openApplication(id: string, retry = false) {
  const tab = addApplication(id), app = product(id); if (!app || tab.control) return
  selectApplication(id); tab.control = true; renderList(); renderWorkspace(); requestRevision++; show()
  const managerRevision = managerInteractionRevision
  try {
    const value = await requestJSON<ProductView>(`/api/client/v1/products/${encodeURIComponent(id)}/${retry ? 'retry' : 'open'}`, {})
    applications = applications.map(app => app.definition.id === id ? value : app)
    renderList(); renderWorkspace()
    if (value.state === 'running') { await ensureMounted(tab, 'open'); if (activeId === id && tab.mounted && managerRevision === managerInteractionRevision) hideManager() }
    else { clearUnmountedPanel(tab); show(value.error?.phase === 'cleanup' ? '应用清理失败，需要重启宿主。' : value.state === 'blocked' ? '应用正在等待依赖。' : '应用启动失败，可重试启动。') }
  } catch { show('应用操作未完成，正在核对当前状态。') }
  finally { tab.control = false; renderList(); renderWorkspace(); requestRevision++; void refresh(); save() }
}
async function enterApplication(id: string) {
  const view = views.get(id)
  if (view?.control || view?.disposing) return
  if (views.has(id) && product(id)?.state === 'running') selectApplication(id)
  else await openApplication(id)
}
async function stopApplication(id: string) {
  const tab = views.get(id)
  if (tab?.control || tab?.mounted && !tab.mounted.canClose()) { show('请先完成或保存当前应用中的编辑。'); return }
  if (tab) tab.control = true
  renderList(); renderWorkspace()
  requestRevision++; show()
  try {
    const app = await requestJSON<ProductView>(`/api/client/v1/products/${encodeURIComponent(id)}/stop`, {})
    applications = applications.map(value => value.definition.id === id ? app : value)
    if (app.state !== 'disabled') { show('应用停止失败，需要检查状态或重启宿主。'); return }
    if (tab) { tab.control = false; await closeApplicationPage(id) }
    renderList(); renderWorkspace()
  } catch (error) { show(error && typeof error === 'object' && 'code' in error && error.code === 'product-busy' ? '应用仍有任务或写入进行中，请稍后停止。' : '应用停止未完成，正在核对当前状态。') }
  finally { if (tab) tab.control = false; renderList(); renderWorkspace(); requestRevision++; void refresh() }
}
function refresh(): Promise<void> {
  if (refreshTask) return refreshTask
  const revision = ++requestRevision
  const task = requestJSON<readonly ProductView[]>('/api/client/v1/products', undefined, lifetime.signal).then(async values => {
    if (closed || revision !== requestRevision) return
    applications = values; renderList(); renderWorkspace()
    for (const tab of views.values()) {
      if (closed || revision !== requestRevision) return
      if (tab.control) continue
      if (product(tab.id)?.state === 'running') { if (!tab.error && !tab.mounted) void ensureMounted(tab, 'restore') }
      else {
        const hadInterface = !!tab.mounted || !!tab.loading
        if (hadInterface) await disposeMounted(tab)
        if (closed || revision !== requestRevision || views.get(tab.id) !== tab) return
        clearUnmountedPanel(tab)
        if (hadInterface && activeId === tab.id) showManager()
      }
    }
  }).catch(() => { if (!closed && !applications.length) show('暂时无法读取应用目录。') }).finally(() => { if (refreshTask === task) refreshTask = undefined })
  refreshTask = task; return task
}
async function followAddress() {
  const current = parseApplicationHash(location.hash)
  if (current) {
    const tab = addApplication(current.id, current.route)
    if (tab.route !== current.route) { tab.route = current.route; for (const listener of [...tab.listeners]) listener() }
    selectApplication(tab.id, 'navigate', false); return
  }
  for (const app of applications) if (app.definition.web?.legacyRoutes?.some(prefix => location.hash.startsWith(prefix))) {
    const route = (await loadModule(app)).resolveLegacyRoute?.(location.hash)
    if (route !== undefined) { const tab = addApplication(app.definition.id); tab.route = route; selectApplication(tab.id, 'navigate', false); address(true); return }
  }
  selectApplication(null, 'navigate', false)
}
rail.addEventListener('keydown', event => {
  const key = event as KeyboardEvent, values = [...rail.querySelectorAll<HTMLButtonElement>('button:not(:disabled):not([hidden])')], index = values.findIndex(element => element === key.target)
  if (index < 0) return
  const next = key.key === 'ArrowDown' ? (index + 1) % values.length : key.key === 'ArrowUp' ? (index + values.length - 1) % values.length : key.key === 'Home' ? 0 : key.key === 'End' ? values.length - 1 : -1
  if (next >= 0) { key.preventDefault(); values[next].focus() }
})
manager.addEventListener('toggle', () => { showApplications.setAttribute('aria-expanded', String(manager.matches(':popover-open'))) })
showApplications.addEventListener('click', () => { managerInteractionRevision++ })
closeButton.addEventListener('click', () => { if (activeId) void closeApplicationPage(activeId) })
stopButton.addEventListener('click', () => { if (activeId) void stopApplication(activeId) })
window.addEventListener('hashchange', () => { void followAddress().catch(() => show('无法打开该应用地址。')) }, { signal: lifetime.signal })
window.addEventListener('popstate', () => { void followAddress().catch(() => show('无法打开该应用地址。')) }, { signal: lifetime.signal })
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh() }, { signal: lifetime.signal })
const timer = setInterval(() => { if (!document.hidden) void refresh() }, 3000)
window.addEventListener('beforeunload', event => {
  if ([...views.values()].some(tab => tab.mounted && !tab.mounted.canClose())) { event.preventDefault(); event.returnValue = '' }
}, { signal: lifetime.signal })
window.addEventListener('pagehide', event => {
  if (event.persisted) return
  closed = true; clearInterval(timer); save(); lifetime.abort()
  for (const tab of views.values()) void disposeMounted(tab).catch(() => {})
}, { signal: lifetime.signal })
async function initialize() {
  await refresh()
  let raw: string | null = null
  try { raw = sessionStorage.getItem(workspaceStorageKey) } catch { /* Optional workspace. */ }
  const saved = readApplicationWorkspace(raw)
  for (const tab of saved.tabs) addApplication(tab.id, tab.route)
  if (!raw && !location.hash) for (const app of applications) if (app.definition.web?.legacyRoutes) {
    const route = (await loadModule(app)).restoreLegacyRoute?.(sessionStorage)
    if (route !== undefined) { addApplication(app.definition.id, route); activeId = app.definition.id; break }
  }
  if (location.hash && location.hash !== '#') await followAddress()
  else { selectApplication(activeId ?? saved.activeId, 'restore', false); address(true) }
  for (const tab of views.values()) void ensureMounted(tab, 'restore')
  renderWorkspace()
}
void initialize().catch(() => show('应用工作区暂时无法恢复。'))
