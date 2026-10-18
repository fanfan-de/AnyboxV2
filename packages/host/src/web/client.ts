import { requestJSON } from '@anybox/application-api/web'
import type { ApplicationCapabilityStatus, ProductView } from '@anybox/application-api'
import type { ApplicationActivation, ApplicationWebContext, ApplicationWebModule, MountedApplication } from '@anybox/application-api/web'
import { setupPackageManagement } from './package-management.js'
import { setupPackagePageLifecycle } from './page-lifecycle.js'
import type { ApplicationInterfaceLease } from './application-lifecycle.js'
import { createApplicationInterfaceLifecycle } from './application-lifecycle.js'
import { applicationHash, closeApplicationView, completedRemovedApplicationIds, parseApplicationHash, readApplicationWorkspace, removeApplicationViews, workspaceStorageKey } from './application-workspace.js'

interface ApplicationPanel {
  id: string; route: string; panel: HTMLElement
  mounted?: MountedApplication; controller: AbortController; listeners: Set<() => void>
  loading?: Promise<void>; revision: number; openRequested: boolean; module?: ApplicationWebModule
  styles: HTMLLinkElement[]; error?: boolean; focus?: HTMLElement; control?: boolean; disposing?: boolean; disposal?: Promise<void>; cleanupFailed?: boolean
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
const unconfirmedStops = new Map<string, string>()
const lifetime = new AbortController(), views = new Map<string, ApplicationPanel>(), modules = new Map<string, Promise<ApplicationWebModule>>()
let applications: readonly ProductView[] = [], activeId: string | null = null, closed = false, requestRevision = 0, refreshTask: Promise<boolean> | undefined
let catalogAvailable = false, workspaceInitialized = false
let lifecycleFrozen = true, interfaceFrozen = false, pageRegistrationBlocked = true, reloading = false
let sharedInterfaceLease: ApplicationInterfaceLease | undefined
function updateLifecycleFence() { lifecycleFrozen = interfaceFrozen || pageRegistrationBlocked; panels.inert = lifecycleFrozen; renderList(); renderWorkspace(); if (!lifecycleFrozen && !closed) void refresh(true) }
function reloadForActivation(removedAppIds: readonly string[] = []) {
  if (reloading) return
  reloading = true
  const remaining = removeApplicationViews(snapshot(), removedAppIds)
  for (const id of removedAppIds) { const view = views.get(id); view?.panel.remove(); for (const style of view?.styles ?? []) style.remove(); views.delete(id) }
  activeId = remaining.activeId
  if (removedAppIds.length) address(true)
  save()
  void pageLifecycle.dispose({ interfacesExited: true }).then(() => location.reload(), () => show('页面退出尚未确认，请重启宿主后刷新页面。'))
}
async function prepareInterfaces(): Promise<ApplicationInterfaceLease> {
  if (sharedInterfaceLease) return sharedInterfaceLease
  const lease = await interfaceLifecycle.prepare()
  const shared = { check: () => lease.check(), disposeForRestart: () => lease.disposeForRestart(), release() { lease.release(); if (!interfaceLifecycle.frozen && sharedInterfaceLease === shared) sharedInterfaceLease = undefined } }
  sharedInterfaceLease = shared; return shared
}
const shellWork = new Set<Promise<unknown>>()
function trackShellWork<T>(task: Promise<T>): Promise<T> { shellWork.add(task); void task.then(() => shellWork.delete(task), () => shellWork.delete(task)); return task }
const interfaceLifecycle = createApplicationInterfaceLifecycle({
  interfaces: () => [...views.values()].filter(tab => tab.mounted || tab.cleanupFailed).map(tab => ({ canClose: () => canClosePanel(tab), dispose: () => disposeMounted(tab) })),
  async settle() { await Promise.allSettled([...shellWork, ...[...views.values()].flatMap(tab => [tab.loading, tab.disposal].filter((task): task is Promise<void> => !!task)), ...(refreshTask ? [refreshTask] : [])]) },
  freeze(frozen) { interfaceFrozen = frozen; updateLifecycleFence() }, save,
})
let listRevision = ''
const capabilityDetailsOpen = new Map<string, boolean>()
let managerInteractionRevision = 0
let packageManagement: ReturnType<typeof setupPackageManagement> | undefined
const showManager = () => { if (!closed && !manager.matches(':popover-open')) manager.showPopover() }
const hideManager = () => { if (manager.matches(':popover-open')) manager.hidePopover() }
const show = (message = '') => { notice.textContent = message; notice.hidden = !message; if (message) showManager() }
const states: Record<ProductView['state'], string> = { disabled: '尚未打开', applying: '正在处理', running: '运行中', blocked: '依赖未就绪', failed: '启动或关闭失败' }
const hostUnavailableMessage = '无法连接应用宿主，请确认客户端仍在运行。'
const stateLabel = (app: ProductView) => catalogAvailable ? app.definition.runtime === false && app.state === 'running' ? '可打开' : states[app.state] : '暂时无法确认状态'
const capabilityLabels: Record<ApplicationCapabilityStatus['status'], string> = {
  ready: '已就绪', missing: '未提供', unsupported: '当前平台不支持', incompatible: '版本不兼容', conflict: '与正在使用的提供方冲突', failed: '初始化或清理失败',
}
const capabilityNames: Readonly<Record<string, string>> = { 'system.directory-picker': '系统目录选择', 'storage.sqlite': '本地存储' }
function capabilityIssue(capability: ApplicationCapabilityStatus) {
  const issue = document.createElement('p'); issue.className = 'application-capability'
  const name = document.createElement('span'); name.textContent = `${capabilityNames[capability.id] ?? capability.id}：${capabilityLabels[capability.status]}`
  const detail = document.createElement('small'); detail.textContent = `${capability.id}${capability.version ? ` · ${capability.version}` : ''}`
  issue.append(name, detail); return issue
}
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
  const revision = JSON.stringify([catalogAvailable, lifecycleFrozen, applications.map(app => {
    const view = views.get(app.definition.id)
    return [app, !!view?.control, !!view?.disposing, !!view?.loading, !!view?.error, !!view?.cleanupFailed]
  })])
  if (revision === listRevision) { renderNavigation(); return }
  listRevision = revision
  for (const card of list.querySelectorAll<HTMLElement>('.application-card')) {
    const details = card.querySelector<HTMLDetailsElement>('.application-capabilities')
    if (details && card.dataset.appId) capabilityDetailsOpen.set(card.dataset.appId, details.open)
  }
  list.replaceChildren()
  if (!applications.length) { const empty = document.createElement('p'); empty.className = 'application-empty'; empty.textContent = catalogAvailable ? '还没有应用，从下方安装一个开始使用。' : '暂时无法读取应用目录。'; list.append(empty) }
  for (const app of applications) {
    const view = views.get(app.definition.id)
    const card = document.createElement('article'); card.className = 'application-card'; card.dataset.appId = app.definition.id
    const header = document.createElement('header'); header.className = 'application-card-header'
    const icon = document.createElement('span'); icon.className = 'application-icon'; icon.textContent = app.definition.name.slice(0, 1); icon.setAttribute('aria-hidden', 'true')
    const title = document.createElement('h3'); title.textContent = app.definition.name; title.id = `application-title-${app.definition.id}`
    card.setAttribute('aria-labelledby', title.id)
    const state = document.createElement('span'); state.className = 'application-state'; state.textContent = view?.control ? '正在处理应用操作…' : stateLabel(app)
    state.dataset.state = !catalogAvailable ? 'unknown' : view?.control ? 'applying' : app.state
    header.append(icon, title, state); card.append(header)
    if (app.definition.description) { const description = document.createElement('p'); description.className = 'application-description'; description.textContent = app.definition.description; description.title = app.definition.description; card.append(description) }
    const controls = document.createElement('div'); controls.className = 'application-card-actions'
    const open = button(view?.mounted ? '进入应用' : '打开应用', () => { void enterApplication(app.definition.id) }); open.className = 'application-open'; open.setAttribute('aria-label', `打开 ${app.definition.name}`)
    open.disabled = lifecycleFrozen || !catalogAvailable || !app.definition.web || app.state === 'applying' || !!view?.control || !!view?.disposing || !!view?.cleanupFailed
    const unavailable = (app.capabilities ?? []).filter(capability => capability.status !== 'ready')
    const required = unavailable.filter(capability => capability.required), optional = unavailable.filter(capability => !capability.required)
    if (required.length) {
      const issues = document.createElement('div'); issues.className = 'application-required-capabilities'; issues.setAttribute('role', 'note')
      const label = document.createElement('p'); label.textContent = '应用所需功能尚未就绪'; issues.append(label, ...required.map(capabilityIssue)); card.append(issues)
    }
    if (optional.length) {
      const details = document.createElement('details'); details.className = 'application-capabilities'; details.open = capabilityDetailsOpen.get(app.definition.id) ?? false
      const summary = document.createElement('summary'); summary.textContent = optional.length === 1 && capabilityNames[optional[0]!.id] ? `${capabilityNames[optional[0]!.id]}暂不可用` : `${optional.length} 项可选功能暂不可用`
      details.append(summary, ...optional.map(capabilityIssue)); details.addEventListener('toggle', () => { capabilityDetailsOpen.set(app.definition.id, details.open) }); card.append(details)
    }
    if (view?.loading) { const loading = document.createElement('p'); loading.className = 'application-loading'; loading.setAttribute('role', 'status'); loading.textContent = '正在加载应用界面…'; card.append(loading) }
    if (view?.error) { const reload = button('重新加载界面', () => {
      if (lifecycleFrozen) return
      view.error = false; show(); hideManager(); void ensureMounted(view, 'select')
    }); reload.disabled = lifecycleFrozen || !!view.cleanupFailed; controls.append(reload) }
    if (app.state === 'failed' || app.state === 'blocked') {
      const retry = button('重试启动', () => { void openApplication(app.definition.id, true) }); retry.disabled = lifecycleFrozen || !catalogAvailable || !!view?.control || !!view?.disposing || !!view?.cleanupFailed; controls.append(retry)
    }
    if (app.desiredEnabled) {
      const stop = button('停止应用', () => { void stopApplication(app.definition.id) }); stop.className = 'application-stop'; stop.setAttribute('aria-label', `停止 ${app.definition.name}`); stop.disabled = lifecycleFrozen || !catalogAvailable || app.state === 'applying' || !!view?.control || !!view?.disposing || !!view?.cleanupFailed; controls.append(stop)
    }
    controls.append(open); card.append(controls)
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
    shortcut.title = `${app.definition.name} · ${stateLabel(app)}`
    shortcut.setAttribute('aria-label', app.definition.name)
    shortcut.disabled = lifecycleFrozen || !catalogAvailable || !app.definition.web || app.state === 'applying'
    shortcut.dataset.state = catalogAvailable ? app.state : 'unknown'
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
    shortcut.disabled = lifecycleFrozen || !catalogAvailable || !app?.definition.web || app.state === 'applying' || !!view?.control || !!view?.disposing || !!view?.cleanupFailed
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
  closeButton.hidden = !view; closeButton.disabled = lifecycleFrozen || !!view?.control || !!view?.disposing
  closeButton.title = app ? `关闭 ${app.definition.name} 界面` : '关闭当前应用界面'
  closeButton.setAttribute('aria-label', closeButton.title)
  stopButton.hidden = !app || !app.desiredEnabled
  stopButton.disabled = lifecycleFrozen || !catalogAvailable || !!view?.control || !!view?.disposing || !!view?.cleanupFailed
  stopButton.title = app ? `停止 ${app.definition.name}` : '停止应用'
  stopButton.setAttribute('aria-label', stopButton.title)
  updateNavigation()
}
function clearUnmountedPanel(tab: ApplicationPanel) {
  if (tab.mounted || tab.cleanupFailed) return
  tab.panel.replaceChildren()
  renderList()
}
function canClosePanel(tab: ApplicationPanel) { return !tab.disposal && !tab.cleanupFailed && (tab.mounted?.canClose() ?? true) }
function disposeMounted(tab: ApplicationPanel, settleLoading = true): Promise<void> {
  if (tab.disposal) return tab.disposal
  tab.disposing = true
  tab.revision++; tab.controller.abort()
  const loading = settleLoading ? tab.loading : undefined
  const task = (async () => {
    await loading
    // A mount already in flight may return its handle after the close was accepted.
    // Retain that handle and every failed cleanup until this page really exits.
    await tab.mounted?.dispose()
    tab.mounted = undefined
    tab.listeners.clear(); for (const style of tab.styles) style.remove(); tab.styles = []
    tab.controller = new AbortController(); tab.panel.replaceChildren()
  })().then(() => { if (tab.disposal === task) tab.disposal = undefined }, error => { tab.cleanupFailed = true; throw error })
    .finally(() => { tab.disposing = false; if (!closed) { renderList(); renderWorkspace() } })
  tab.disposal = task; return task
}
async function ensureMounted(tab: ApplicationPanel, reason: ApplicationActivation) {
  if (tab.disposal) await tab.disposal
  if (closed || lifecycleFrozen || views.get(tab.id) !== tab) return
  const app = product(tab.id)
  if (closed || !catalogAvailable || app?.state !== 'running' || !app.definition.web) { clearUnmountedPanel(tab); return }
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
    const context: ApplicationWebContext = { appId: tab.id, ...(app.definition.http ? { apiBase: `/api/client/v1/apps/${encodeURIComponent(tab.id)}` } : {}), signal: tab.controller.signal,
      domId: local => `${tab.id}--${local}`, route: {
        read: () => tab.route,
        navigate(path, replace = false) {
          if (closed || lifecycleFrozen || revision !== tab.revision || tab.route === path) return
          tab.route = path
          if (activeId === tab.id) address(replace); else save()
          for (const listener of [...tab.listeners]) listener()
        },
        subscribe(listener) { tab.listeners.add(listener); return () => { tab.listeners.delete(listener) } },
      } }
    const mounted = await module.mount(tab.panel, context)
    tab.mounted = mounted
    if (closed || revision !== tab.revision) return
    const activation = tab.openRequested ? 'open' : reason; tab.openRequested = false
    await mounted.setActive(activeId === tab.id, activation)
  })().catch(async () => {
    if (closed || revision !== tab.revision) return
    tab.error = true
    // This handler is part of tab.loading, so its cleanup must not await itself.
    try { await disposeMounted(tab, false) }
    catch { if (activeId === tab.id) show('应用界面清理失败，请重新启动 Anybox 后恢复。'); return }
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
  if (lifecycleFrozen) return
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
function closeApplicationPage(id: string): Promise<void> {
  return lifecycleFrozen ? Promise.resolve() : trackShellWork(closeApplicationPageWork(id))
}
async function closeApplicationPageWork(id: string) {
  const tab = views.get(id); if (!tab || tab.control) return
  if (tab.cleanupFailed) { show('应用界面清理失败，请重新启动 Anybox 后恢复。'); return }
  if (!canClosePanel(tab)) { show('请先完成或保存当前应用中的编辑。'); return }
  tab.control = true; renderList(); renderWorkspace()
  try { await disposeMounted(tab) } catch { show('应用界面清理失败，请重新启动 Anybox 后恢复。'); tab.control = false; renderList(); renderWorkspace(); return }
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
function openApplication(id: string, retry = false): Promise<void> {
  return lifecycleFrozen ? Promise.resolve() : trackShellWork(openApplicationWork(id, retry))
}
async function openApplicationWork(id: string, retry = false) {
  if (!catalogAvailable) { show(hostUnavailableMessage); return }
  const tab = addApplication(id), app = product(id); if (!app || tab.control || tab.cleanupFailed) return
  selectApplication(id); tab.control = true; renderList(); renderWorkspace(); requestRevision++; show()
  const managerRevision = managerInteractionRevision
  try {
    const value = await requestJSON<ProductView>(`/api/client/v1/products/${encodeURIComponent(id)}/${retry ? 'retry' : 'open'}`, {})
    applications = applications.map(app => app.definition.id === id ? value : app)
    renderList(); renderWorkspace()
    if (value.state === 'running') { await ensureMounted(tab, 'open'); if (activeId === id && tab.mounted && managerRevision === managerInteractionRevision) hideManager() }
    else { clearUnmountedPanel(tab); show(value.error?.phase === 'cleanup' ? '应用清理失败，需要重启宿主。' : value.state === 'blocked' ? '应用正在等待依赖。' : '应用启动失败，可重试启动。') }
  } catch { show('应用操作未完成，正在核对当前状态。') }
  finally { tab.control = false; renderList(); renderWorkspace(); requestRevision++; void refresh(true); save() }
}
async function enterApplication(id: string) {
  if (lifecycleFrozen) return
  const view = views.get(id)
  if (view?.control || view?.disposing || view?.cleanupFailed) return
  if (views.has(id) && product(id)?.state === 'running') selectApplication(id)
  else await openApplication(id)
}
function stopApplication(id: string): Promise<void> {
  return lifecycleFrozen ? Promise.resolve() : trackShellWork(stopApplicationWork(id))
}
async function stopApplicationWork(id: string) {
  if (!catalogAvailable) { show(hostUnavailableMessage); return }
  const tab = views.get(id)
  if (tab?.cleanupFailed) { show('应用界面清理失败，请重新启动 Anybox 后恢复。'); return }
  if (tab?.control || tab && !canClosePanel(tab)) { show('请先完成或保存当前应用中的编辑。'); return }
  if (tab) tab.control = true
  renderList(); renderWorkspace()
  requestRevision++; show()
  try {
    const app = await requestJSON<ProductView>(`/api/client/v1/products/${encodeURIComponent(id)}/stop`, {})
    applications = applications.map(value => value.definition.id === id ? app : value)
    if (app.state !== 'disabled') { show(app.error?.phase === 'cleanup' ? '应用清理失败，需要重启宿主。' : '应用停止失败，请检查状态后重试。'); return }
    if (tab) { tab.control = false; await closeApplicationPageWork(id) }
    renderList(); renderWorkspace()
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    if (code === 'product-busy') show('应用仍有任务或写入进行中，请稍后停止。')
    else {
      unconfirmedStops.set(id, code === 'product-storage-failed' ? '无法保存停止状态，应用尚未停止，请稍后重试。' : '应用尚未停止，请重试；若持续失败，请检查宿主日志。')
      show('停止结果尚未确认，正在核对当前状态。')
    }
  }
  finally { if (tab) tab.control = false; renderList(); renderWorkspace(); requestRevision++; await refresh(true) }
}
function refresh(fresh = false): Promise<boolean> {
  // A control invalidates an earlier poll; reconciliation must read after it exits.
  if (refreshTask) return fresh ? refreshTask.then(() => refresh()) : refreshTask
  const revision = ++requestRevision
  const task = requestJSON<readonly ProductView[]>('/api/client/v1/products', undefined, lifetime.signal).then(async values => {
    if (closed || revision !== requestRevision) return false
    applications = values; catalogAvailable = true
    if (notice.textContent === hostUnavailableMessage) show()
    renderList(); renderWorkspace()
    for (const [id, message] of unconfirmedStops) {
      if (views.get(id)?.control) continue
      const app = product(id)
      if (app?.state === 'applying') { show('正在等待应用停止完成。'); continue }
      unconfirmedStops.delete(id)
      if (app?.state === 'disabled') { await closeApplicationPage(id); if (!views.has(id)) show() }
      else show(app?.error?.phase === 'cleanup' ? '应用清理失败，需要重启宿主。' : message)
      if (closed || revision !== requestRevision) return false
    }
    for (const tab of views.values()) {
      if (closed || revision !== requestRevision) return false
      if (lifecycleFrozen || tab.control) continue
      if (product(tab.id)?.state === 'running') { if (!tab.error && !tab.mounted) void ensureMounted(tab, 'restore') }
      else {
        const hadInterface = !!tab.mounted || !!tab.loading
        if (hadInterface) await disposeMounted(tab)
        if (closed || revision !== requestRevision || views.get(tab.id) !== tab) return false
        clearUnmountedPanel(tab)
        if (hadInterface && activeId === tab.id) showManager()
      }
    }
    return true
  }, () => {
    if (!closed && revision === requestRevision) {
      catalogAvailable = false; renderList(); renderWorkspace(); show(hostUnavailableMessage)
    }
    return false
  }).catch(() => {
    if (!closed && revision === requestRevision) show('应用界面清理失败，请重新启动 Anybox 后恢复。')
    return false
  }).finally(() => { if (refreshTask === task) refreshTask = undefined })
  refreshTask = task; return task
}
async function followAddress() {
  if (lifecycleFrozen) { if (workspaceInitialized) address(true); return }
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
manager.addEventListener('toggle', () => {
  const open = manager.matches(':popover-open')
  showApplications.setAttribute('aria-expanded', String(open))
  if (open && !closed && !packageManagement) packageManagement = setupPackageManagement(manager, { activation: { prepare: prepareInterfaces }, reload: reloadForActivation })
  else if (!open && packageManagement) { const previous = packageManagement; packageManagement = undefined; void previous.dispose() }
})
showApplications.addEventListener('click', () => { managerInteractionRevision++ })
closeButton.addEventListener('click', () => { if (activeId) void closeApplicationPage(activeId) })
stopButton.addEventListener('click', () => { if (activeId) void stopApplication(activeId) })
window.addEventListener('hashchange', () => { void followAddress().catch(() => show('无法打开该应用地址。')) }, { signal: lifetime.signal })
window.addEventListener('popstate', () => { void followAddress().catch(() => show('无法打开该应用地址。')) }, { signal: lifetime.signal })
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh() }, { signal: lifetime.signal })
const timer = setInterval(() => { if (!document.hidden) void refresh() }, 3000)
window.addEventListener('beforeunload', event => {
  if ([...views.values()].some(tab => !canClosePanel(tab))) { event.preventDefault(); event.returnValue = '' }
}, { signal: lifetime.signal })
window.addEventListener('pagehide', event => {
  if (event.persisted) return
  closed = true; clearInterval(timer); save(); lifetime.abort()
  const packageView = packageManagement; packageManagement = undefined; void packageView?.dispose()
  void Promise.allSettled([...views.values()].map(tab => disposeMounted(tab))).then(results =>
    pageLifecycle.dispose(results.every(result => result.status === 'fulfilled') ? { interfacesExited: true } : undefined)).catch(() => {})
}, { signal: lifetime.signal })
const pageLifecycle = setupPackagePageLifecycle({ prepare: prepareInterfaces, reload: reloadForActivation, connection(enabled, registered) { pageRegistrationBlocked = enabled && !registered; updateLifecycleFence() } })
async function initialize() {
  await pageLifecycle.ready
  await refresh()
  let raw: string | null = null
  try { raw = sessionStorage.getItem(workspaceStorageKey) } catch { /* Optional workspace. */ }
  let removedIds: readonly string[] = []
  try { removedIds = completedRemovedApplicationIds(await requestJSON('/api/client/v1/app-packages', undefined, lifetime.signal)) } catch { /* Unknown installation facts never discard browser positions. */ }
  const saved = removeApplicationViews(readApplicationWorkspace(raw), removedIds)
  if (removedIds.includes(parseApplicationHash(location.hash)?.id ?? '')) history.replaceState(null, '', saved.activeId ? applicationHash(saved.activeId, saved.tabs.find(tab => tab.id === saved.activeId)?.route ?? '') : '#/apps')
  for (const tab of saved.tabs) addApplication(tab.id, tab.route)
  workspaceInitialized = true
  if (lifecycleFrozen) {
    const position = parseApplicationHash(location.hash)
    if (position) { addApplication(position.id, position.route); activeId = position.id } else activeId = saved.activeId
    renderWorkspace(); save(); return
  }
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
