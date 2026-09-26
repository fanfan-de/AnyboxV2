import type { Api, ProjectView, SessionView, SessionPosition } from './client-types.js'
import { createPendingStore, createSessionController } from './session-client.js'
import type { BrowserStorage, SessionController } from './session-client.js'
import { createSessionPanel } from './session-view.js'
import type { SessionPanel } from './session-view.js'
import { closePane, emptyWorkspace, fitRatios, fits, openSession, panes, parseRoute, ratioBounds,
  resizeSplit, restoreWorkspace, sessionHash, splitSession, separatorSize } from './workspace-layout.js'
import type { Edge, LayoutNode, Pane, SessionRef, Size, Split, Workspace } from './workspace-layout.js'

export const workspaceKey = 'anybox.web.workspace.v1'
const storage: BrowserStorage = {
  getItem: key => sessionStorage.getItem(key), setItem: (key, value) => sessionStorage.setItem(key, value),
}

export function setupWorkspace(api: Api, messageFor: (error: unknown) => string, selectedAgent: () => string) {
  const get = <T extends HTMLElement>(id: string) => document.getElementById(id)! as T
  const host = get<HTMLElement>('pane-host'), tabs = get<HTMLElement>('pane-tabs'), notice = get<HTMLElement>('workspace-notice')
  const projectList = get<HTMLElement>('project-list'), sessionList = get<HTMLElement>('session-list')
  const addProject = get<HTMLButtonElement>('add-project'), newSession = get<HTMLButtonElement>('new-session')
  const pickerStatus = get<HTMLElement>('project-picker-status')
  const pending = createPendingStore(storage)
  const positions = new Map<string, SessionPosition>()
  try {
    const saved = JSON.parse(storage.getItem('anybox.web.positions.v1') ?? '{}')
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const [id, raw] of Object.entries(saved)) {
        if (!raw || typeof raw !== 'object' || !('viewNodeId' in raw) ||
            (raw.viewNodeId !== null && typeof raw.viewNodeId !== 'string')) continue
        const position: SessionPosition = { viewNodeId: raw.viewNodeId,
          ...('focusedRunId' in raw && typeof raw.focusedRunId === 'string' ? { focusedRunId: raw.focusedRunId } : {}) }
        // Restoring a view never resumes an implicit follow; the user can choose the result explicitly.
        positions.set(id, position)
      }
    }
  } catch { /* Layout and server data can still be recovered independently. */ }
  let state: Workspace = emptyWorkspace, projects: readonly ProjectView[] = [], sessions: readonly SessionView[] = []
  let ready = false, compact = false, creating = false, picking = false, pickerSupported = false
  let navigationVersion = 0, navigationRead: AbortController | undefined, disposed = false
  let dropTarget: { id: string; edge: Edge } | undefined
  let resizeCleanup: (() => void) | undefined
  let dragCleanup: (() => void) | undefined, suppressClick = false
  const bundles = new Map<string, { controller: SessionController; view?: SessionPanel; scroll: number }>()
  const splitElements = new Map<string, { node: Split; element: HTMLElement; separator: HTMLElement }>()
  const listeners = new AbortController(), options = { signal: listeners.signal }
  const showNotice = (message = '') => { notice.textContent = message; notice.hidden = !message }
  try { state = restoreWorkspace(JSON.parse(storage.getItem(workspaceKey) ?? 'null')) }
  catch { showNotice('无法读取工作区布局，将打开当前链接中的会话。') }
  const persist = () => {
    try { storage.setItem(workspaceKey, JSON.stringify(state)) }
    catch { showNotice('浏览器无法保存布局，本次仍可使用分屏；刷新后可能无法恢复。') }
  }
  const size = (): Size => ({ width: host.clientWidth, height: host.clientHeight })
  const activePane = () => panes(state.root).find(pane => pane.id === state.activePaneId)
  const project = () => projects.find(item => item.id === state.sidebarProjectId)
  const updateURL = (push = false) => {
    const pane = activePane()
    const hash = pane ? sessionHash(pane) : state.sidebarProjectId ? `#/projects/${encodeURIComponent(state.sidebarProjectId)}` : '#'
    if (location.hash !== hash) history[push ? 'pushState' : 'replaceState'](null, '', hash)
  }

  const candidate = (ref: SessionRef, target: string, edge: Edge): Workspace | undefined => {
    if (compact || !ready) return undefined
    const next = splitSession(state, ref, target, edge, 'drop-preview')
    return next !== state && fits(next.root, size()) ? next : undefined
  }

  function refreshControls(): void {
    newSession.disabled = creating || !project()?.available || !selectedAgent()
    addProject.disabled = !pickerSupported || picking
    const active = activePane()
    const snapshot = active ? bundles.get(active.sessionId)?.controller.snapshot() : undefined
    get('current-agent').textContent = snapshot?.session?.agentId ?? '尚未选择'
    get('session-id').textContent = active?.sessionId ?? '选择或拖入会话'
    for (const pane of panes(state.root)) bundles.get(pane.sessionId)?.view?.element.classList.toggle('active-pane', pane.id === state.activePaneId)
    for (const button of sessionList.querySelectorAll<HTMLButtonElement>('.session-open')) {
      button.classList.toggle('selected', button.dataset.sessionId === active?.sessionId)
      button.classList.toggle('opened', panes(state.root).some(item => item.sessionId === button.dataset.sessionId))
    }
    for (const button of sessionList.querySelectorAll<HTMLButtonElement>('button[data-split-edge]')) {
      button.disabled = !active || !candidate({ projectId: button.dataset.projectId!, sessionId: button.dataset.sessionId! }, active.id, button.dataset.splitEdge as Edge)
    }
    for (const button of tabs.querySelectorAll<HTMLButtonElement>('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.paneId === state.activePaneId))
    }
  }

  function focusPane(id: string): void {
    if (state.activePaneId === id || !panes(state.root).some(item => item.id === id)) return
    state = { ...state, activePaneId: id }
    if (compact) renderLayout()
    else refreshControls()
    persist()
    updateURL()
  }

  function setWorkspace(next: Workspace, push = false): void {
    state = next
    renderLayout()
    persist()
    updateURL(push)
  }

  function open(ref: SessionRef, push = true): void {
    const existing = panes(state.root).find(item => item.sessionId === ref.sessionId)
    if (existing) { focusPane(existing.id); return }
    setWorkspace(openSession(state, ref), push)
  }
  function close(id: string): void {
    setWorkspace(closePane(state, id))
    const pane = activePane()
    if (pane) bundles.get(pane.sessionId)?.view?.element.querySelector<HTMLTextAreaElement>('textarea')?.focus()
  }

  function getView(pane: Pane): SessionPanel {
    let bundle = bundles.get(pane.sessionId)
    if (!bundle) {
      const controller = createSessionController(pane, {
        api, pending, messageFor, newId: () => crypto.randomUUID(), hidden: () => document.hidden,
        position: positions.get(pane.sessionId),
        savePosition(position) {
          positions.set(pane.sessionId, position)
          try { storage.setItem('anybox.web.positions.v1', JSON.stringify(Object.fromEntries(positions))) }
          catch { showNotice('浏览器无法保存查看位置，刷新后需要重新选择分支。') }
        },
        schedule: (callback, ms) => window.setTimeout(callback, ms), clear: timer => window.clearTimeout(timer as number),
        missing(ref) {
          const item = panes(state.root).find(value => value.sessionId === ref.sessionId)
          if (item) { showNotice('会话不存在或不属于该项目，已从工作区移除。'); setWorkspace(closePane(state, item.id)) }
        },
      })
      bundle = { controller, scroll: 0 }
      bundles.set(pane.sessionId, bundle)
    }
    if (!bundle.view) {
      bundle.view = createSessionPanel(pane, projects.find(item => item.id === pane.projectId)?.name ?? pane.projectId,
        bundle.controller, () => focusPane(pane.id), () => close(pane.id), bundle.scroll)
    }
    return bundle.view
  }

  function updateRatios(node: LayoutNode): void {
    if (node.kind === 'pane') return
    const entry = splitElements.get(node.id)
    if (entry) {
      entry.node = node
      const tracks = `minmax(0, ${node.ratio}fr) ${separatorSize}px minmax(0, ${1 - node.ratio}fr)`
      if (node.axis === 'horizontal') entry.element.style.gridTemplateColumns = tracks
      else entry.element.style.gridTemplateRows = tracks
      entry.separator.setAttribute('aria-valuenow', String(Math.round(node.ratio * 100)))
      const [min, max] = ratioBounds(node, entry.element.getBoundingClientRect())
      entry.separator.setAttribute('aria-valuemin', String(Math.ceil(min * 100)))
      entry.separator.setAttribute('aria-valuemax', String(Math.floor(max * 100)))
    }
    updateRatios(node.first)
    updateRatios(node.second)
  }

  function adjustRatio(id: string, ratio: number): void {
    const entry = splitElements.get(id)
    if (!state.root || !entry) return
    state = { ...state, root: resizeSplit(state.root, id, ratio, entry.element.getBoundingClientRect()) }
    state = { ...state, root: fitRatios(state.root!, size()) }
    updateRatios(state.root!)
  }

  function build(node: LayoutNode): HTMLElement {
    if (node.kind === 'pane') return getView(node).element
    const element = document.createElement('div')
    element.className = `workspace-split ${node.axis}`
    element.dataset.splitId = node.id
    const separator = document.createElement('div')
    separator.className = 'pane-separator'
    separator.tabIndex = 0
    separator.setAttribute('role', 'separator')
    separator.setAttribute('aria-label', node.axis === 'horizontal' ? '调整左右面板宽度' : '调整上下面板高度')
    separator.setAttribute('aria-orientation', node.axis === 'horizontal' ? 'vertical' : 'horizontal')
    separator.dataset.resizeSplit = node.id
    splitElements.set(node.id, { node, element, separator })
    element.append(build(node.first), separator, build(node.second))
    return element
  }

  function renderLayout(): void {
    if (!ready) { host.textContent = '正在加载工作区…'; return }
    resizeCleanup?.()
    clearDrop()
    const all = panes(state.root), openIds = new Set(all.map(pane => pane.sessionId))
    for (const [id, bundle] of bundles) {
      if (bundle.view && !openIds.has(id)) {
        bundle.controller.detach()
        bundle.scroll = bundle.view.dispose()
        bundle.view = undefined
      }
    }
    const focused = document.activeElement instanceof HTMLElement && host.contains(document.activeElement) ? document.activeElement : undefined
    const scrolls = new Map([...bundles].filter(([, bundle]) => bundle.view).map(([id, bundle]) =>
      [id, bundle.view!.captureScroll()]))
    compact = window.innerWidth <= 760 || !fits(state.root, size())
    tabs.hidden = !compact || all.length < 2
    tabs.replaceChildren(...all.map(pane => {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.paneId = pane.id
      button.textContent = `${projects.find(item => item.id === pane.projectId)?.name ?? '项目'} · ${pane.sessionId.slice(0, 8)}`
      return button
    }))
    splitElements.clear()
    host.replaceChildren()
    host.classList.toggle('compact-workspace', compact)
    if (!state.root) {
      const empty = document.createElement('div')
      empty.className = 'workspace-empty empty-state'
      empty.innerHTML = '<span class="empty-icon" aria-hidden="true">✳</span><h2>打开一个会话</h2><p>从侧栏选择或拖入会话。拖到面板边缘可分屏。</p>'
      host.append(empty)
    } else if (compact) {
      // Keep inactive views mounted so resize and focus changes retain selection and scroll state.
      for (const pane of all) {
        const element = getView(pane).element
        element.hidden = pane.id !== state.activePaneId
        host.append(element)
      }
    } else {
      for (const pane of all) getView(pane).element.hidden = false
      const displayed = fitRatios(state.root, size())
      host.append(build(displayed))
      updateRatios(displayed)
    }
    for (const pane of all) {
      const bundle = bundles.get(pane.sessionId)!
      if (!bundle.view!.element.dataset.attached) {
        bundle.view!.element.dataset.attached = 'true'
        bundle.controller.attach(() => { bundle.view?.render(); refreshControls() })
      }
      const top = scrolls.get(pane.sessionId)
      if (top !== undefined) bundle.view!.restoreScroll(top)
    }
    if (focused?.isConnected) focused.focus({ preventScroll: true })
    refreshControls()
  }

  function renderNavigation(): void {
    projectList.replaceChildren(...projects.map(item => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = item.id === state.sidebarProjectId ? 'selected' : ''
      button.dataset.projectId = item.id
      button.textContent = item.name
      button.title = item.path
      const detail = document.createElement('small')
      detail.textContent = item.available ? item.path : `${item.path} · 不可访问`
      button.append(detail)
      return button
    }))
    sessionList.replaceChildren(...sessions.map(item => {
      const row = document.createElement('div')
      row.className = 'session-row'
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'session-open'
      button.dataset.sessionId = item.id
      button.dataset.dragSession = item.id
      button.dataset.projectId = item.projectId
      button.draggable = false
      button.textContent = `会话 · ${item.id.slice(0, 8)}`
      const menu = document.createElement('details')
      menu.className = 'session-menu'
      const summary = document.createElement('summary')
      summary.textContent = '⋯'
      summary.setAttribute('aria-label', `会话 ${item.id.slice(0, 8)} 的操作`)
      menu.append(summary)
      for (const [edge, text] of [['right', '在活动面板右侧打开'], ['bottom', '在活动面板下方打开']] as const) {
        const action = document.createElement('button')
        action.type = 'button'
        action.textContent = text
        action.dataset.splitEdge = edge
        action.dataset.projectId = item.projectId
        action.dataset.sessionId = item.id
        menu.append(action)
      }
      row.append(button, menu)
      return row
    }))
    refreshControls()
  }

  async function selectProject(id: string, write = true): Promise<void> {
    if (!projects.some(item => item.id === id)) return
    state = { ...state, sidebarProjectId: id }
    const version = ++navigationVersion
    navigationRead?.abort()
    navigationRead = new AbortController()
    sessions = []
    renderNavigation()
    if (write) { persist(); if (!state.root) updateURL() }
    try {
      const loaded = await api<readonly SessionView[]>(`/projects/${encodeURIComponent(id)}/sessions`, undefined, navigationRead.signal)
      if (version !== navigationVersion || disposed) return
      sessions = loaded
      renderNavigation()
    } catch (error) { if (version === navigationVersion && !disposed) showNotice(messageFor(error)) }
  }

  function route(): void {
    if (!ready) return
    const parsed = parseRoute(location.hash)
    if (!parsed) return
    if (!projects.some(item => item.id === parsed.projectId)) { showNotice('项目不存在。'); updateURL(); return }
    if (parsed.sessionId) open({ projectId: parsed.projectId, sessionId: parsed.sessionId }, false)
    else void selectProject(parsed.projectId)
  }

  function clearDrop(): void {
    dropTarget = undefined
    host.querySelectorAll('[data-drop-edge]').forEach(element => element.removeAttribute('data-drop-edge'))
    host.classList.remove('drop-empty')
  }
  function performSplit(ref: SessionRef, targetId: string, edge: Edge): void {
    if (!candidate(ref, targetId, edge)) return
    setWorkspace(splitSession(state, ref, targetId, edge, `split-${crypto.randomUUID()}`), true)
  }

  projectList.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-project-id]')
    if (button?.dataset.projectId) void selectProject(button.dataset.projectId)
  }, options)
  sessionList.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-session-id]')
    if (!button || button.disabled) return
    const ref = { projectId: button.dataset.projectId!, sessionId: button.dataset.sessionId! }
    if (button.dataset.splitEdge && state.activePaneId) performSplit(ref, state.activePaneId, button.dataset.splitEdge as Edge)
    else open(ref)
  }, options)
  tabs.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-pane-id]')
    if (button?.dataset.paneId) focusPane(button.dataset.paneId)
  }, options)
  document.addEventListener('click', event => {
    if (suppressClick) { event.preventDefault(); event.stopPropagation(); suppressClick = false }
  }, { ...options, capture: true })
  document.addEventListener('pointerdown', event => {
    const source = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-drag-session]') : null
    if (!source || event.button !== 0 || (event.target as HTMLElement).closest('.pane-close') || compact) return
    const ref = { projectId: source.dataset.projectId!, sessionId: source.dataset.dragSession! }
    const startX = event.clientX, startY = event.clientY, abort = new AbortController()
    let dragging = false, emptyTarget = false
    const cleanup = () => {
      abort.abort()
      clearDrop()
      source.classList.remove('dragging-session')
      if (source.hasPointerCapture(event.pointerId)) source.releasePointerCapture(event.pointerId)
      dragCleanup = undefined
    }
    dragCleanup?.()
    dragCleanup = cleanup
    document.addEventListener('pointermove', move => {
      if (move.pointerId !== event.pointerId) return
      if (!dragging && Math.hypot(move.clientX - startX, move.clientY - startY) < 6) return
      if (!dragging) { dragging = true; source.setPointerCapture(event.pointerId); source.classList.add('dragging-session') }
      move.preventDefault()
      clearDrop()
      emptyTarget = false
      const hit = document.elementFromPoint(move.clientX, move.clientY)
      if (!hit || !host.contains(hit)) return
      if (!state.root) { emptyTarget = true; host.classList.add('drop-empty'); return }
      const target = hit.closest<HTMLElement>('[data-pane-id]')
      if (!target) return
      const rect = target.getBoundingClientRect(), x = (move.clientX - rect.left) / rect.width, y = (move.clientY - rect.top) / rect.height
      const distances: readonly [Edge, number][] = [['left', x], ['right', 1 - x], ['top', y], ['bottom', 1 - y]]
      const [edge, distance] = [...distances].sort((a, b) => a[1] - b[1])[0]
      if (distance > 0.25 || !candidate(ref, target.dataset.paneId!, edge)) return
      dropTarget = { id: target.dataset.paneId!, edge }
      target.dataset.dropEdge = edge
    }, { signal: abort.signal, passive: false })
    document.addEventListener('pointerup', up => {
      if (up.pointerId !== event.pointerId) return
      const target = dropTarget, empty = emptyTarget
      cleanup()
      if (!dragging) return
      up.preventDefault()
      suppressClick = true
      window.setTimeout(() => { suppressClick = false }, 0)
      if (empty) open(ref)
      else if (target) performSplit(ref, target.id, target.edge)
    }, { signal: abort.signal })
    document.addEventListener('pointercancel', cleanup, { signal: abort.signal })
    document.addEventListener('keydown', key => { if (key.key === 'Escape') cleanup() }, { signal: abort.signal })
  }, options)
  host.addEventListener('pointerdown', event => {
    const separator = (event.target as HTMLElement).closest<HTMLElement>('[data-resize-split]')
    const entry = separator && splitElements.get(separator.dataset.resizeSplit!)
    if (!separator || !entry || event.button !== 0) return
    event.preventDefault()
    separator.focus()
    separator.setPointerCapture(event.pointerId)
    const abort = new AbortController()
    const rect = entry.element.getBoundingClientRect()
    const cleanup = () => { abort.abort(); if (separator.hasPointerCapture(event.pointerId)) separator.releasePointerCapture(event.pointerId); resizeCleanup = undefined; persist() }
    resizeCleanup = cleanup
    separator.addEventListener('pointermove', move => {
      const horizontal = entry.node.axis === 'horizontal'
      const ratio = ((horizontal ? move.clientX - rect.left : move.clientY - rect.top) - separatorSize / 2) /
        ((horizontal ? rect.width : rect.height) - separatorSize)
      adjustRatio(entry.node.id, ratio)
    }, { signal: abort.signal })
    separator.addEventListener('pointerup', cleanup, { signal: abort.signal })
    separator.addEventListener('lostpointercapture', cleanup, { signal: abort.signal })
    separator.addEventListener('pointercancel', cleanup, { signal: abort.signal })
  }, options)
  host.addEventListener('keydown', event => {
    const separator = (event.target as HTMLElement).closest<HTMLElement>('[data-resize-split]')
    const entry = separator && splitElements.get(separator.dataset.resizeSplit!)
    if (!entry) return
    const keys = entry.node.axis === 'horizontal' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
    if (!keys.includes(event.key)) return
    event.preventDefault()
    adjustRatio(entry.node.id, entry.node.ratio + (event.key === keys[0] ? -0.05 : 0.05))
    persist()
  }, options)
  newSession.addEventListener('click', () => {
    const chosen = project(), agentId = selectedAgent()
    if (!chosen?.available || creating || !agentId) return
    creating = true
    refreshControls()
    void api<SessionView>('/sessions', { projectId: chosen.id, agentId }).then(created => {
      if (disposed) return
      open({ projectId: created.projectId, sessionId: created.id })
      if (state.sidebarProjectId === created.projectId) void selectProject(created.projectId)
    }).catch(error => showNotice(messageFor(error))).finally(() => { creating = false; refreshControls() })
  }, options)
  addProject.addEventListener('click', () => {
    if (!pickerSupported || picking) return
    picking = true
    refreshControls()
    pickerStatus.hidden = false
    pickerStatus.textContent = '请在系统窗口中选择项目目录…'
    void api<ProjectView | null>('/projects/pick', {}).then(async opened => {
      if (!opened || disposed) return
      projects = await api<readonly ProjectView[]>('/projects')
      await selectProject(opened.id)
    }).catch(error => showNotice(messageFor(error))).finally(() => { picking = false; pickerStatus.hidden = pickerSupported; refreshControls() })
  }, options)
  window.addEventListener('hashchange', route, options)
  window.addEventListener('popstate', route, options)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { dragCleanup?.(); resizeCleanup?.() }
    for (const bundle of bundles.values()) if (bundle.view) void bundle.controller.refresh()
  }, options)
  let observedSize = ''
  const observer = new ResizeObserver(() => {
    const value = `${host.clientWidth}:${host.clientHeight}:${window.innerWidth <= 760}`
    if (value === observedSize) return
    observedSize = value
    const shouldCompact = window.innerWidth <= 760 || !fits(state.root, size())
    if (shouldCompact !== compact) renderLayout()
    else if (!compact && state.root) updateRatios(fitRatios(state.root, size()))
    refreshControls()
  })
  observer.observe(host)
  window.addEventListener('resize', () => {
    if ((window.innerWidth <= 760 || !fits(state.root, size())) !== compact) renderLayout()
  }, options)
  renderLayout()
  void api<{ supported: boolean }>('/projects/picker').then(value => {
    pickerSupported = value.supported
    pickerStatus.hidden = value.supported
    pickerStatus.textContent = value.supported ? '' : '当前系统暂不支持原生目录选择。'
    refreshControls()
  }).catch(() => { pickerStatus.hidden = false; pickerStatus.textContent = '无法检查目录选择器，请刷新页面。' })
  void api<readonly ProjectView[]>('/projects').then(async value => {
    if (disposed) return
    projects = value
    for (const pane of panes(state.root)) if (!projects.some(item => item.id === pane.projectId)) state = closePane(state, pane.id)
    ready = true
    const parsed = parseRoute(location.hash)
    const selected = (parsed && !parsed.sessionId ? parsed.projectId : undefined) ??
      projects.find(item => item.id === state.sidebarProjectId)?.id ?? parsed?.projectId ?? projects[0]?.id
    // Views are first mounted after projects load, so their titles use the project names.
    renderLayout()
    route()
    if (selected) await selectProject(selected)
    else renderNavigation()
    persist()
    updateURL()
  }).catch(error => showNotice(messageFor(error)))
  return {
    refreshControls,
    dispose() {
      disposed = true
      listeners.abort()
      navigationRead?.abort()
      observer.disconnect()
      resizeCleanup?.()
      dragCleanup?.()
      for (const bundle of bundles.values()) { bundle.controller.detach(); bundle.view?.dispose() }
    },
  }
}
