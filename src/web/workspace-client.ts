import type { ModelsCatalog } from './models-client.js'
import type { Api, ProjectView, SessionView, SessionPosition } from './client-types.js'
import { createPendingStore, createSessionController } from './session-client.js'
import type { BrowserStorage, SessionController } from './session-client.js'
import { createRunChangeClient } from './run-change-client.js'
import { createSessionPanel } from './session-view.js'
import type { SessionPanel } from './session-view.js'
import { closePane, emptyWorkspace, fitRatios, fits, openSession, panes, parseRoute, ratioBounds,
  resizeSplit, restoreWorkspace, sessionHash, splitSession, separatorSize } from './workspace-layout.js'
import type { Edge, LayoutNode, Pane, SessionRef, Size, Split, Workspace } from './workspace-layout.js'

export const workspaceKey = 'anybox.web.workspace.v1'
const storage: BrowserStorage = {
  getItem: key => sessionStorage.getItem(key), setItem: (key, value) => sessionStorage.setItem(key, value),
}

export function setupWorkspace(api: Api, messageFor: (error: unknown) => string, selectedAgent: () => string, models?: ModelsCatalog, configureModels?: () => void) {
  const get = <T extends HTMLElement>(id: string) => document.getElementById(id)! as T
  const host = get<HTMLElement>('pane-host'), tabs = get<HTMLElement>('pane-tabs'), notice = get<HTMLElement>('workspace-notice')
  const projectList = get<HTMLElement>('project-list')
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
  let state: Workspace = emptyWorkspace, projects: readonly ProjectView[] = []
  let ready = false, compact = false, creating = false, picking = false, pickerSupported = false
  let disposed = false
  const collapsedProjects = new Set<string>()
  const projectGroups = new Map<string, HTMLElement>()
  const sessionIndex = createProjectSessionIndex(api, id => renderProjectSessions(id))
  let dropTarget: { id: string; edge: Edge } | undefined
  let resizeCleanup: (() => void) | undefined
  let dragCleanup: (() => void) | undefined, suppressClick = false
  const bundles = new Map<string, { controller: SessionController; view?: SessionPanel; scroll: number }>()
  const sessionLabels = new Map<string, string>()
  const changes = createRunChangeClient({
    open(url, handlers) {
      const source = new EventSource(url)
      source.addEventListener('ready', () => handlers.ready())
      source.addEventListener('run-changed', event => handlers.change((event as MessageEvent<string>).data))
      source.addEventListener('model-progress', event => handlers.progress((event as MessageEvent<string>).data))
      source.addEventListener('error', () => handlers.error())
      return { close: () => source.close() }
    },
    refresh(id) { bundles.get(id)?.controller.notifyChange() },
    progress(id, runId, event) { bundles.get(id)?.controller.modelProgress(runId, event) },
    connected(value) { for (const bundle of bundles.values()) bundle.controller.setLive(value) },
  })
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
    newSession.title = project() ? `在 ${project()!.name} 中新建会话` : '先选择一个项目'
    for (const button of projectList.querySelectorAll<HTMLButtonElement>('.project-button')) {
      const selected = button.dataset.projectId === state.sidebarProjectId
      button.classList.toggle('selected', selected)
      button.setAttribute('aria-pressed', String(selected))
    }
    for (const button of projectList.querySelectorAll<HTMLButtonElement>('[data-create-project-session]')) {
      button.disabled = creating || !selectedAgent() || !projects.find(item => item.id === button.dataset.createProjectSession)?.available
    }
    const active = activePane()
    const snapshot = active ? bundles.get(active.sessionId)?.controller.snapshot() : undefined
    const activeProject = projects.find(item => item.id === active?.projectId)
    get('current-agent').textContent = snapshot?.session?.agentId ?? 'Anybox Agent'
    get('session-id').textContent = activeProject?.name ?? project()?.name ?? '选择一个项目开始'
    get('session-id').title = active?.sessionId ?? ''
    get('workspace-title').textContent = activeProject?.name ?? project()?.name ?? 'Anybox'
    get('project-count').textContent = String(projects.length)
    for (const button of host.querySelectorAll<HTMLButtonElement>('[data-create-session]')) button.disabled = newSession.disabled
    for (const button of host.querySelectorAll<HTMLButtonElement>('[data-add-project]')) button.disabled = addProject.disabled
    for (const pane of panes(state.root)) bundles.get(pane.sessionId)?.view?.element.classList.toggle('active-pane', pane.id === state.activePaneId)
    for (const button of projectList.querySelectorAll<HTMLButtonElement>('.session-open')) {
      button.classList.toggle('selected', button.dataset.sessionId === active?.sessionId)
      button.classList.toggle('opened', panes(state.root).some(item => item.sessionId === button.dataset.sessionId))
      const known = bundles.get(button.dataset.sessionId!)?.controller.snapshot()
      const firstInput = known?.path[0]?.input ?? known?.children[0]?.input ?? known?.runs.at(-1)?.input
      if (!known?.loading && firstInput && !sessionLabels.has(button.dataset.sessionId!)) sessionLabels.set(button.dataset.sessionId!, firstInput)
      const label = sessionLabels.get(button.dataset.sessionId!)
      if (label) {
        button.querySelector<HTMLElement>('.session-name')!.textContent = label
        button.title = label
      }
    }
    for (const button of projectList.querySelectorAll<HTMLButtonElement>('button[data-split-edge]')) {
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
        api, pending, messageFor, ...(models ? { models: () => models.snapshot().models } : {}), newId: () => crypto.randomUUID(), hidden: () => document.hidden,
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
        bundle.controller, () => focusPane(pane.id), () => close(pane.id), bundle.scroll, models, configureModels)
    }
    return bundle.view
  }

  function updateRatios(node: LayoutNode): void {
    if (node.kind === 'pane') { bundles.get(node.sessionId)?.view?.resizeInput(); return }
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
      empty.innerHTML = `<svg class="empty-logo" aria-hidden="true" viewBox="0 0 128 128"><use href="#anybox-mark"/></svg>
        <h2>让想法，从这里开始</h2><p>选择一个本地项目，和 Anybox 一起完成工作。</p>
        <div class="empty-actions"><button class="primary-button" type="button" data-create-session>新建会话</button><button type="button" data-add-project>添加项目</button></div>`
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
      bundle.view!.resizeInput()
    }
    if (focused?.isConnected) focused.focus({ preventScroll: true })
    changes.update(all.map(pane => pane.sessionId))
    refreshControls()
  }

  function renderProjectSessions(id: string): void {
    const group = projectGroups.get(id)
    if (!group) return
    const list = group.querySelector<HTMLElement>('.project-sessions')!
    const entry = sessionIndex.get(id)
    const focused = list.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined
    const focusedData = focused ? JSON.stringify(focused.dataset) : undefined
    list.setAttribute('aria-busy', String(entry?.loading ?? true))
    list.replaceChildren(...(entry?.sessions ?? []).map(item => {
      const row = document.createElement('div')
      row.className = 'session-row'
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'session-open'
      button.dataset.sessionId = item.id
      button.dataset.dragSession = item.id
      button.dataset.projectId = item.projectId
      button.draggable = false
      const name = document.createElement('span'), time = document.createElement('time')
      name.className = 'session-name'
      name.textContent = `会话 · ${item.id.slice(0, 8)}`
      time.className = 'session-time'
      time.dateTime = item.createdAt
      const date = new Date(item.createdAt)
      if (!Number.isNaN(date.getTime())) {
        time.textContent = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date)
        time.title = date.toLocaleString('zh-CN')
      }
      button.append(name, time)
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
    if (!entry || entry.loading || entry.error || !entry.sessions.length) {
      const hint = document.createElement('p')
      hint.className = 'navigation-empty'
      hint.textContent = entry?.error ? messageFor(entry.error) : !entry || entry.loading ? '正在读取会话…' : '还没有会话'
      list.append(hint)
      if (entry?.error) {
        const retry = document.createElement('button')
        retry.type = 'button'
        retry.dataset.retryProject = id
        retry.textContent = '重新读取会话'
        list.append(retry)
      }
    }
    if (focusedData) [...list.querySelectorAll<HTMLElement>('button, summary')]
      .find(button => JSON.stringify(button.dataset) === focusedData)?.focus({ preventScroll: true })
    refreshControls()
  }

  function renderNavigation(): void {
    for (const [id, group] of projectGroups) {
      if (!projects.some(item => item.id === id)) { group.remove(); projectGroups.delete(id) }
    }
    projectList.querySelector(':scope > .navigation-empty')?.remove()
    for (const item of projects) {
      let group = projectGroups.get(item.id)
      if (!group) {
        group = document.createElement('section')
        group.className = 'project-group'
        group.dataset.projectId = item.id
        group.setAttribute('aria-label', item.name)
        group.innerHTML = `<div class="project-row">
          <button class="project-toggle" type="button"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 9 7 7 7-7"/></svg></button>
          <button class="project-button" type="button"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-folder"/></svg><span class="project-copy"><span class="project-name"></span><small></small></span></button>
          <button class="project-create icon-button" type="button"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-plus"/></svg></button>
        </div><div class="project-sessions navigation-list"></div>`
        const toggle = group.querySelector<HTMLButtonElement>('.project-toggle')!
        toggle.dataset.toggleProject = item.id
        toggle.setAttribute('aria-label', `展开或收起 ${item.name} 的会话`)
        toggle.setAttribute('aria-controls', `project-sessions-${item.id}`)
        const create = group.querySelector<HTMLButtonElement>('.project-create')!
        create.dataset.createProjectSession = item.id
        create.setAttribute('aria-label', `在 ${item.name} 中新建会话`)
        create.title = `在 ${item.name} 中新建会话`
        const list = group.querySelector<HTMLElement>('.project-sessions')!
        list.id = `project-sessions-${item.id}`
        list.setAttribute('aria-label', `${item.name} 的会话`)
        projectGroups.set(item.id, group)
        projectList.append(group)
        renderProjectSessions(item.id)
      }
      const button = group.querySelector<HTMLButtonElement>('.project-button')!
      button.dataset.projectId = item.id
      button.title = item.path
      button.classList.toggle('unavailable', !item.available)
      button.querySelector('.project-name')!.textContent = item.name
      button.querySelector('small')!.textContent = item.available ? item.path : '目录不可访问'
      updateProjectExpansion(item.id)
    }
    if (!projects.length) {
      const hint = document.createElement('p')
      hint.className = 'navigation-empty'
      hint.textContent = '添加一个本地项目，开始工作。'
      projectList.append(hint)
    }
    refreshControls()
  }

  function updateProjectExpansion(id: string): void {
    const group = projectGroups.get(id)
    if (!group) return
    const expanded = !collapsedProjects.has(id)
    group.querySelector('.project-toggle')!.setAttribute('aria-expanded', String(expanded))
    group.querySelector<HTMLElement>('.project-sessions')!.hidden = !expanded
  }

  function selectProject(id: string, write = true): void {
    if (!projects.some(item => item.id === id)) return
    state = { ...state, sidebarProjectId: id }
    collapsedProjects.delete(id)
    updateProjectExpansion(id)
    refreshControls()
    if (write) { persist(); if (!state.root) updateURL() }
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
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null
    if (!button || button.disabled) return
    const data = button.dataset
    if (data.toggleProject) {
      if (collapsedProjects.has(data.toggleProject)) collapsedProjects.delete(data.toggleProject)
      else collapsedProjects.add(data.toggleProject)
      updateProjectExpansion(data.toggleProject)
    } else if (data.createProjectSession) {
      createSession(data.createProjectSession)
    } else if (data.retryProject) {
      void sessionIndex.load(data.retryProject)
    } else if (data.sessionId && data.projectId) {
      const ref = { projectId: data.projectId, sessionId: data.sessionId }
      selectProject(ref.projectId)
      if (data.splitEdge && state.activePaneId) performSplit(ref, state.activePaneId, data.splitEdge as Edge)
      else open(ref)
    } else if (data.projectId) selectProject(data.projectId)
  }, options)
  tabs.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-pane-id]')
    if (button?.dataset.paneId) focusPane(button.dataset.paneId)
  }, options)
  host.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-create-session], [data-add-project]') : null
    if (!button || button.disabled) return
    if (button.hasAttribute('data-create-session')) newSession.click()
    else addProject.click()
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
  function createSession(projectId: string): void {
    const chosen = projects.find(item => item.id === projectId), agentId = selectedAgent()
    if (!chosen?.available || creating || !agentId) return
    selectProject(chosen.id)
    creating = true
    refreshControls()
    void api<SessionView>('/sessions', { projectId: chosen.id, agentId }).then(created => {
      if (disposed) return
      open({ projectId: created.projectId, sessionId: created.id })
      void sessionIndex.load(created.projectId)
    }).catch(error => { if (!disposed) showNotice(messageFor(error)) }).finally(() => { creating = false; if (!disposed) refreshControls() })
  }
  newSession.addEventListener('click', () => { if (state.sidebarProjectId) createSession(state.sidebarProjectId) }, options)
  addProject.addEventListener('click', () => {
    if (!pickerSupported || picking) return
    picking = true
    refreshControls()
    pickerStatus.hidden = false
    pickerStatus.textContent = '请在系统窗口中选择项目目录…'
    void api<ProjectView | null>('/projects/pick', {}).then(async opened => {
      if (!opened || disposed) return
      projects = await api<readonly ProjectView[]>('/projects')
      if (disposed) return
      renderNavigation()
      selectProject(opened.id)
      for (const item of projects) if (!sessionIndex.get(item.id)) void sessionIndex.load(item.id)
    }).catch(error => showNotice(messageFor(error))).finally(() => { picking = false; pickerStatus.hidden = pickerSupported; refreshControls() })
  }, options)
  window.addEventListener('hashchange', route, options)
  window.addEventListener('popstate', route, options)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { dragCleanup?.(); resizeCleanup?.() }
    for (const bundle of bundles.values()) if (bundle.view) void bundle.controller.refresh()
  }, options)
  const unsubscribeModels = models?.subscribe(() => { for (const bundle of bundles.values()) bundle.view?.render() })
  let observedSize = ''
  const observer = new ResizeObserver(() => {
    const value = `${host.clientWidth}:${host.clientHeight}:${window.innerWidth <= 760}`
    if (value === observedSize) return
    observedSize = value
    const shouldCompact = window.innerWidth <= 760 || !fits(state.root, size())
    if (shouldCompact !== compact) renderLayout()
    else if (!compact && state.root) updateRatios(fitRatios(state.root, size()))
    else for (const bundle of bundles.values()) bundle.view?.resizeInput()
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
    renderNavigation()
    if (selected) selectProject(selected)
    for (const item of projects) void sessionIndex.load(item.id)
    persist()
    updateURL()
  }).catch(error => showNotice(messageFor(error)))
  return {
    refreshControls,
    dispose() {
      disposed = true
      changes.dispose()
      unsubscribeModels?.()
      listeners.abort()
      sessionIndex.dispose()
      observer.disconnect()
      resizeCleanup?.()
      dragCleanup?.()
      for (const bundle of bundles.values()) { bundle.controller.detach(); bundle.view?.dispose() }
    },
  }
}


interface ProjectSessionEntry {
  readonly sessions: readonly SessionView[]
  readonly loading: boolean
  readonly error?: unknown
}

/** Each project's read is independent, including refresh after creating a session. */
export function createProjectSessionIndex(api: Api, changed: (projectId: string) => void) {
  const entries = new Map<string, ProjectSessionEntry>()
  const reads = new Map<string, AbortController>()
  let disposed = false
  return {
    get: (id: string) => entries.get(id),
    async load(id: string): Promise<void> {
      if (disposed) return
      reads.get(id)?.abort()
      const read = new AbortController()
      reads.set(id, read)
      entries.set(id, { sessions: entries.get(id)?.sessions ?? [], loading: true })
      changed(id)
      try {
        const sessions = await api<readonly SessionView[]>(`/projects/${encodeURIComponent(id)}/sessions`, undefined, read.signal)
        if (disposed || reads.get(id) !== read) return
        entries.set(id, { sessions, loading: false })
      } catch (error) {
        if (disposed || reads.get(id) !== read) return
        entries.set(id, { sessions: entries.get(id)?.sessions ?? [], loading: false, error })
      }
      if (reads.get(id) === read) reads.delete(id)
      changed(id)
    },
    dispose() {
      disposed = true
      for (const read of reads.values()) read.abort()
      reads.clear()
    },
  }
}
