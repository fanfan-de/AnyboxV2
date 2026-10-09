import { splitScopedId } from './harness-client.js'
import type { HarnessClient } from './harness-client.js'
import { setupArchivePanel } from './archive-client.js'
import { setupProjectDirectoryPicker } from './project-directory-view.js'
import { createFileLeaseKeeper } from './file-client.js'
import type { ModelsCatalog } from './models-client.js'
import type { Api, ProjectView, SessionView, SessionPosition } from './client-types.js'
import { createPendingStore, createSessionController } from './session-client.js'
import type { BrowserStorage, SessionController } from './session-client.js'
import { createImageLeaseKeeper } from './image-client.js'
import { createDraftStore } from './draft-client.js'
import type { ImageRef } from './client-types.js'
import { createRunChangeClient } from './run-change-client.js'
import { createSessionPanel } from './session-view.js'
import type { SessionPanel, SessionScrollPosition } from './session-view.js'
import { closePane, emptyWorkspace, fitRatios, fits, openSession, panes, parseRoute, ratioBounds,
  resizeSplit, restoreWorkspace, sessionHash, splitSession, separatorSize, waitForProjectSnapshot } from './workspace-layout.js'
import type { Edge, LayoutNode, Pane, SessionRef, Size, Split, Workspace } from './workspace-layout.js'
import { createSidebarStateStore } from './sidebar-layout.js'
import { setupSidebarLayout } from './sidebar-client.js'
import { createFileSidebar, restoreFileSidebarSessionState } from './file-sidebar.js'
import type { FilePreviewRequest } from './file-sidebar.js'
import { createSessionMenu } from './session-menu.js'

export const workspaceKey = 'anybox.web.workspace.v2'
const storage: BrowserStorage = {
  getItem: key => sessionStorage.getItem(key), setItem: (key, value) => sessionStorage.setItem(key, value),
}

/** Sidebar selection follows the device while the full project snapshot remains available to panes. */
export function projectSidebar(projects: readonly ProjectView[], instanceId: string | undefined, preferredId: string | null | undefined, settled: boolean) {
  const visible = projects.filter(project => instanceId === undefined || (project.instanceId ?? splitScopedId(project.id)?.instanceId) === instanceId)
  const preferred = visible.find(project => project.id === preferredId)
  const pending = preferredId && (instanceId === undefined || splitScopedId(preferredId)?.instanceId === instanceId) && waitForProjectSnapshot(preferredId, projects, settled)
  return { projects: visible, selectedProjectId: preferred?.id ?? (pending && preferredId ? preferredId : visible[0]?.id ?? null) }
}

export function setupWorkspace(api: Api, messageFor: (error: unknown) => string, selectedAgent: (projectId?: string) => string, models: ModelsCatalog | undefined, environment: { root: HTMLElement; storageKey?: string; selectedInstanceId?: string; isActive(): boolean; route: { read(): string; write(hash: string, push: boolean): void; subscribe(listener: () => void): () => void } }) {
  const root = environment.root
  let applicationActive = environment.isActive?.() ?? true
  const layoutKey = environment.storageKey ?? workspaceKey
  const positionsKey = environment.storageKey ? `${environment.storageKey}.positions` : 'anybox.web.positions.v2'
  const routeHash = () => environment.route.read()
  const get = <T extends HTMLElement>(id: string) => root.querySelector(`#${id}`)! as T
  const host = get<HTMLElement>('agent--pane-host'), tabs = get<HTMLElement>('agent--pane-tabs'), notice = get<HTMLElement>('agent--workspace-notice')
  const workspaceControls = get<HTMLElement>('agent--workspace-controls')
  const projectList = get<HTMLElement>('agent--project-list')
  const addProject = get<HTMLButtonElement>('agent--add-project')
  const pickerStatus = get<HTMLElement>('agent--project-picker-status')
  const pending = createPendingStore(storage)
  const drafts = createDraftStore(storage)
  const positions = new Map<string, SessionPosition>()
  try {
    const saved = JSON.parse(storage.getItem(positionsKey) ?? '{}')
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const [id, raw] of Object.entries(saved)) {
        if (!raw || typeof raw !== 'object' || !('viewNodeId' in raw) ||
            (raw.viewNodeId !== null && typeof raw.viewNodeId !== 'string')) continue
        const position: SessionPosition = { viewNodeId: raw.viewNodeId,
          viewMode: 'viewMode' in raw && raw.viewMode === 'runs' ? 'runs' : 'dialogue',
          ...('focusedRunId' in raw && typeof raw.focusedRunId === 'string' ? { focusedRunId: raw.focusedRunId } : {}) }
        // Restoring a view never resumes an implicit follow; the user can choose the result explicitly.
        positions.set(id, position)
      }
    }
  } catch { /* Layout and server data can still be recovered independently. */ }
  let state: Workspace = emptyWorkspace, projects: readonly ProjectView[] = []
  let initialProjectsSettled = false, receivedProjects: readonly ProjectView[] = []
  let ready = false, compact = false, creating = false, pickerSupported = false
  let disposed = false
  const projectGroups = new Map<string, HTMLElement>()
  const sessionIndex = createProjectSessionIndex(api, id => renderProjectSessions(id))
  let dropTarget: { id: string; edge: Edge } | undefined
  let resizeCleanup: (() => void) | undefined
  let dragCleanup: (() => void) | undefined, suppressClick = false
  const bundles = new Map<string, { controller: SessionController; view?: SessionPanel; scroll: SessionScrollPosition }>()
  const multi = api as Partial<HarnessClient>
  const changes = multi.changes ? multi.changes({
    refresh(id) { bundles.get(id)?.controller.notifyChange() },
    view(snapshot) { bundles.get(snapshot.sessionId)?.controller.protocolView(snapshot) },
    incompatibleView(sessionId, runId) { bundles.get(sessionId)?.controller.incompatibleView(runId) },
    connected(ids, value) { for (const id of ids) bundles.get(id)?.controller.setLive(value) },
  }) : createRunChangeClient({
    open(url, handlers) {
      const source = new EventSource(url)
      source.addEventListener('ready', () => handlers.ready())
      source.addEventListener('run-changed', event => handlers.change((event as MessageEvent<string>).data))
      source.addEventListener('protocol-view', event => handlers.view((event as MessageEvent<string>).data))
      source.addEventListener('error', () => handlers.error())
      return { close: () => source.close() }
    },
    refresh(id) { bundles.get(id)?.controller.notifyChange() },
    view(snapshot) { bundles.get(snapshot.sessionId)?.controller.protocolView(snapshot) },
    incompatibleView(sessionId, runId) { bundles.get(sessionId)?.controller.incompatibleView(runId) },
    connected(value) { for (const bundle of bundles.values()) bundle.controller.setLive(value) },
  })
  const splitElements = new Map<string, { node: Split; element: HTMLElement; separator: HTMLElement }>()
  const listeners = new AbortController(), options = { signal: listeners.signal }
  const showNotice = (message = '') => { notice.textContent = message; notice.hidden = !message }
  const imageLeases = createImageLeaseKeeper({ api, drafts, pending,
    schedule: (callback, ms) => window.setTimeout(callback, ms), clear: timer => window.clearTimeout(timer as number),
    changed: () => { for (const bundle of bundles.values()) bundle.controller.imagesChanged() },
    error: error => showNotice(messageFor(error)),
  })
  const fileLeases = createFileLeaseKeeper({ api, drafts, pending,
    schedule: (callback, ms) => window.setTimeout(callback, ms), clear: timer => window.clearTimeout(timer as number),
    changed: () => { for (const bundle of bundles.values()) bundle.controller.imagesChanged() },
    error: error => showNotice(messageFor(error)),
  })
  const archiveWrites = new Set<string>()
  const archivePanel = setupArchivePanel(api, messageFor, {
    root,
    projects: () => projects,
    view: session => {
      selectProject(session.projectId); open({ projectId: session.projectId, sessionId: session.id })
      if (applicationActive) bundles.get(session.id)?.view?.element.focus({ preventScroll: true })
    },
    restore: session => changeArchive(session.id, session.projectId, false),
  })
  async function changeArchive(id: string, projectId: string, archive: boolean): Promise<void> {
    if (archiveWrites.has(id)) return
    archiveWrites.add(id); refreshControls()
    try {
      await api<SessionView>(`/sessions/${encodeURIComponent(id)}/${archive ? 'archive' : 'restore'}`, {})
      if (disposed) return
      if (archive) {
        const pane = panes(state.root).find(item => item.sessionId === id)
        if (pane) close(pane.id)
        showNotice('会话已归档，可从“设置 → 已归档会话”查看或恢复。')
      } else {
        await bundles.get(id)?.controller.refresh()
        showNotice('会话已恢复。')
      }
      await sessionIndex.load(projectId)
      archivePanel.refresh()
    } finally { archiveWrites.delete(id); if (!disposed) refreshControls() }
  }
  const uploadImage = async (sessionId: string, file: File, signal: AbortSignal): Promise<ImageRef> => {
    if (multi.upload) return multi.upload(sessionId, file, signal)
    const response = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/images`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, signal, cache: 'no-store',
    })
    const value = await response.json()
    if (!response.ok) throw new Error(messageFor(Object.assign(new Error('image upload failed'), { status: response.status, code: value?.error?.code ?? 'internal-error' })))
    return value as ImageRef
  }
  try { state = restoreWorkspace(JSON.parse(storage.getItem(layoutKey) ?? 'null')) }
  catch { showNotice('无法读取工作区布局，将打开当前链接中的会话。') }
  const persist = () => {
    try { storage.setItem(layoutKey, JSON.stringify(state)) }
    catch { showNotice('浏览器无法保存布局，本次仍可使用分屏；刷新后可能无法恢复。') }
  }
  const size = (): Size => ({ width: host.clientWidth, height: host.clientHeight })
  const activePane = () => panes(state.root).find(pane => pane.id === state.activePaneId)
  const titleFor = (ref: SessionRef) => bundles.get(ref.sessionId)?.controller.snapshot().session?.title ||
    sessionIndex.get(ref.projectId)?.sessions.find(session => session.id === ref.sessionId)?.title
  const sidebarState = createSidebarStateStore(`${layoutKey}.sidebars.v1`, { storage,
    onStorageError: () => showNotice('浏览器无法保存边栏与文件视图位置，当前工作区仍可使用。'),
  })
  const fileSidebar = createFileSidebar(get('agent--file-sidebar-content'), {
    api, messageFor,
    projectLabel: ref => { const project = projects.find(item => item.id === ref.projectId); return project && [project.harnessName, project.name].filter(Boolean).join(' · ') },
    changed(sessionId, value) {
      if (disposed) return
      try { sidebarState.update(current => ({ ...current, perSession: { ...current.perSession, [sessionId]: value } })) }
      catch { showNotice('浏览器无法保存文件视图位置，当前工作区仍可使用。') }
    },
  })
  const sidebarLayout = setupSidebarLayout(root, {
    storageKey: `${layoutKey}.sidebars.v1`, stateStore: sidebarState, isActive: () => applicationActive,
  })
  const unsubscribeSidebar = sidebarLayout.subscribe(visible => fileSidebar.setVisible(visible && !document.hidden))
  const syncFileSidebar = () => {
    const pane = activePane(), bundle = pane && bundles.get(pane.sessionId)
    fileSidebar.setSession(pane && bundle?.view ? pane : undefined, bundle?.view ? bundle.controller : undefined,
      pane ? restoreFileSidebarSessionState(sidebarState.read().perSession[pane.sessionId]) : undefined)
  }
  const openFile = (request: FilePreviewRequest) => {
    const pane = panes(state.root).find(item => item.sessionId === request.ref.sessionId && item.projectId === request.ref.projectId)
    if (!pane) return
    focusPane(pane.id)
    syncFileSidebar()
    sidebarLayout.openRight()
    fileSidebar.open(request)
  }
  const sidebar = () => projectSidebar(projects, environment.selectedInstanceId, state.sidebarProjectId, initialProjectsSettled)
  const project = () => sidebar().projects.find(item => item.id === state.sidebarProjectId)
  const projectLabel = (value: ProjectView | undefined) => value ? [value.harnessName, value.name].filter(Boolean).join(' · ') : undefined
  const updateURL = (push = false) => {
    const pane = activePane()
    const hash = pane ? sessionHash(pane) : state.sidebarProjectId ? `#/projects/${encodeURIComponent(state.sidebarProjectId)}` : '#'
    environment.route.write(hash, push)
  }

  const candidate = (ref: SessionRef, target: string, edge: Edge): Workspace | undefined => {
    if (compact || !ready) return undefined
    const next = splitSession(state, ref, target, edge, 'drop-preview')
    return next !== state && fits(next.root, size()) ? next : undefined
  }
  const sessionMenu = createSessionMenu(get('agent--workspace-sidebar'), {
    available(ref, action) {
      if (action === 'archive') return !archiveWrites.has(ref.sessionId)
      const active = activePane()
      return !!active && !!candidate(ref, active.id, action)
    },
    select(ref, action) {
      if (action === 'archive') {
        void changeArchive(ref.sessionId, ref.projectId, true).catch(error => { if (!disposed) showNotice(messageFor(error)) })
      } else if (state.activePaneId) {
        selectProject(ref.projectId)
        performSplit(ref, state.activePaneId, action)
      }
    },
  })

  function refreshControls(): void {
    const navigation = sidebar()
    state = { ...state, sidebarProjectId: navigation.selectedProjectId }
    const canCreateSession = !creating && !!project()?.available && !!selectedAgent(state.sidebarProjectId ?? undefined)
    addProject.disabled = !pickerSupported
    for (const button of projectList.querySelectorAll<HTMLButtonElement>('.project-button')) {
      const selected = button.dataset.projectId === state.sidebarProjectId
      button.classList.toggle('selected', selected)
      button.setAttribute('aria-pressed', String(selected))
    }
    for (const button of projectList.querySelectorAll<HTMLButtonElement>('[data-create-project-session]')) {
      button.disabled = creating || !selectedAgent(state.sidebarProjectId ?? undefined) || !projects.find(item => item.id === button.dataset.createProjectSession)?.available
    }
    const active = activePane()
    const heading = active && bundles.get(active.sessionId)?.view?.element.querySelector<HTMLElement>('.pane-heading')
    if (heading) {
      if (workspaceControls.parentElement !== heading) heading.insertBefore(workspaceControls, heading.querySelector('.pane-close'))
    } else {
      const center = get<HTMLElement>('agent--session-workspace')
      if (workspaceControls.parentElement !== center) center.insertBefore(workspaceControls, notice)
    }
    for (const button of host.querySelectorAll<HTMLButtonElement>('[data-create-session]')) button.disabled = !canCreateSession
    for (const button of host.querySelectorAll<HTMLButtonElement>('[data-add-project]')) button.disabled = addProject.disabled
    for (const pane of panes(state.root)) bundles.get(pane.sessionId)?.view?.element.classList.toggle('active-pane', pane.id === state.activePaneId)
    for (const button of projectList.querySelectorAll<HTMLButtonElement>('.session-open')) {
      button.classList.toggle('selected', button.dataset.sessionId === active?.sessionId)
      button.classList.toggle('opened', panes(state.root).some(item => item.sessionId === button.dataset.sessionId))
      const known = bundles.get(button.dataset.sessionId!)?.controller.snapshot()
      const label = known?.session?.title
      if (label) {
        button.querySelector<HTMLElement>('.session-name')!.textContent = label
        button.title = label
      }
    }
    sessionMenu.refresh()
    for (const button of tabs.querySelectorAll<HTMLButtonElement>('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.paneId === state.activePaneId))
      const pane = panes(state.root).find(item => item.id === button.dataset.paneId)
      if (pane) {
        button.textContent = `${projects.find(item => item.id === pane.projectId)?.name ?? '项目'} · ${titleFor(pane) || (splitScopedId(pane.sessionId)?.id ?? pane.sessionId).slice(0, 8)}`
        button.title = button.textContent
      }
    }
    syncFileSidebar()
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
    const element = pane ? bundles.get(pane.sessionId)?.view?.element : undefined
    const input = element?.querySelector<HTMLTextAreaElement>('.composer:not([hidden]) textarea:not(:disabled)')
    if (applicationActive) (input ?? element ?? get('agent--toggle-sidebar')).focus({ preventScroll: true })
  }

  function getView(pane: Pane): SessionPanel {
    let bundle = bundles.get(pane.sessionId)
    if (!bundle) {
      const controller = createSessionController(pane, {
        api, pending, drafts, uploadImage, messageFor, ...(models ? { models: () => models.snapshot().models.filter(model => !splitScopedId(pane.sessionId) || splitScopedId(model.id)?.instanceId === splitScopedId(pane.sessionId)?.instanceId) } : {}), newId: () => crypto.randomUUID(), hidden: () => document.hidden || !applicationActive,
        position: positions.get(pane.sessionId),
        savePosition(position) {
          positions.set(pane.sessionId, position)
          try { storage.setItem(positionsKey, JSON.stringify(Object.fromEntries(positions))) }
          catch { showNotice('浏览器无法保存查看位置，刷新后需要重新选择分支。') }
        },
        schedule: (callback, ms) => window.setTimeout(callback, ms), clear: timer => window.clearTimeout(timer as number),
        archived(ref) {
          const pane = panes(state.root).find(item => item.sessionId === ref.sessionId)
          if (pane) close(pane.id)
          showNotice('会话已在其他页面归档，已关闭对应面板。')
          void sessionIndex.load(ref.projectId)
          archivePanel.refresh()
        },
        missing(ref) {
          const item = panes(state.root).find(value => value.sessionId === ref.sessionId)
          if (item) { showNotice('会话不存在或不属于该项目，已从工作区移除。'); setWorkspace(closePane(state, item.id)) }
        },
      })
      bundle = { controller, scroll: { dialogue: 0 } }
      bundles.set(pane.sessionId, bundle)
    }
    if (!bundle.view) {
      bundle.view = createSessionPanel(pane, projectLabel(projects.find(item => item.id === pane.projectId)) ?? pane.projectId,
        bundle.controller, () => focusPane(pane.id), () => close(pane.id), bundle.scroll, models && splitScopedId(pane.sessionId) ? {
          ...models,
          snapshot: () => ({ ...models.snapshot(), models: models.snapshot().models.filter(model => splitScopedId(model.id)?.instanceId === splitScopedId(pane.sessionId)?.instanceId) }),
        } : models, async () => {
          try {
            await changeArchive(pane.sessionId, pane.projectId, false)
            const element = bundles.get(pane.sessionId)?.view?.element
            if (applicationActive) (element?.querySelector<HTMLElement>('.composer:not([hidden]) textarea:not(:disabled)') ?? element)?.focus({ preventScroll: true })
          }
          catch (error) { if (!disposed) showNotice(messageFor(error)) }
        }, openFile)
    }
    bundle.view.setProjectName(projectLabel(projects.find(item => item.id === pane.projectId)) ?? pane.projectId)
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
    if (!applicationActive || host.clientWidth === 0 || host.clientHeight === 0) return
    if (!ready) { host.textContent = '正在加载工作区…'; return }
    resizeCleanup?.()
    clearDrop()
    const focused = document.activeElement instanceof HTMLElement &&
      (host.contains(document.activeElement) || workspaceControls.contains(document.activeElement)) ? document.activeElement : undefined
    // Preserve the shared controls and their listeners while rebuilding or disposing pane views.
    if (host.contains(workspaceControls)) workspaceControls.remove()
    const all = panes(state.root), openIds = new Set(all.map(pane => pane.sessionId))
    for (const [id, bundle] of bundles) {
      if (bundle.view && !openIds.has(id)) {
        bundle.controller.detach()
        bundle.scroll = bundle.view.dispose()
        bundle.view = undefined
      }
    }
    const scrolls = new Map([...bundles].filter(([, bundle]) => bundle.view).map(([id, bundle]) =>
      [id, bundle.view!.captureScroll()]))
    compact = root.clientWidth <= 760 || !fits(state.root, size())
    tabs.hidden = !compact || all.length < 2
    tabs.replaceChildren(...all.map(pane => {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.paneId = pane.id
      button.textContent = `${projects.find(item => item.id === pane.projectId)?.name ?? '项目'} · ${titleFor(pane) || (splitScopedId(pane.sessionId)?.id ?? pane.sessionId).slice(0, 8)}`
      button.title = button.textContent
      return button
    }))
    splitElements.clear()
    host.replaceChildren()
    host.classList.toggle('compact-workspace', compact)
    if (!state.root) {
      const empty = document.createElement('div')
      empty.className = 'workspace-empty empty-state'
      empty.innerHTML = `<svg class="empty-logo" aria-hidden="true" viewBox="0 0 128 128"><use href="#agent--anybox-mark"/></svg>
        <h2>让想法，从这里开始</h2><p>选择一个执行设备上的项目，和 Anybox Harness 一起完成工作。</p>
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
    changes.update(all.map(pane => pane.sessionId))
    refreshControls()
    if (focused?.isConnected) focused.focus({ preventScroll: true })
  }

  function renderProjectSessions(id: string): void {
    const group = projectGroups.get(id)
    if (!group) return
    if (sessionMenu.reference()?.projectId === id) sessionMenu.close(true)
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
      name.textContent = item.title || `会话 · ${(splitScopedId(item.id)?.id ?? item.id).slice(0, 8)}`
      button.title = name.textContent
      time.className = 'session-time'
      time.dateTime = item.createdAt
      const date = new Date(item.createdAt)
      if (!Number.isNaN(date.getTime())) {
        time.textContent = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date)
        time.title = date.toLocaleString('zh-CN')
      }
      button.append(name, time)
      const trigger = document.createElement('button')
      trigger.type = 'button'; trigger.className = 'session-menu-trigger icon-button'; trigger.textContent = '⋯'
      trigger.dataset.sessionMenu = item.id; trigger.dataset.projectId = item.projectId
      trigger.setAttribute('aria-label', `会话 ${(splitScopedId(item.id)?.id ?? item.id).slice(0, 8)} 的操作`)
      trigger.title = '会话操作'; trigger.setAttribute('aria-haspopup', 'menu')
      trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', sessionMenu.id)
      row.append(button, trigger)
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
    if (focusedData) [...list.querySelectorAll<HTMLElement>('button')]
      .find(button => JSON.stringify(button.dataset) === focusedData)?.focus({ preventScroll: true })
    refreshControls()
  }

  function renderNavigation(): void {
    const visible = sidebar().projects
    for (const [id, group] of projectGroups) {
      if (!visible.some(item => item.id === id)) {
        if (sessionMenu.reference()?.projectId === id) sessionMenu.close()
        group.remove(); projectGroups.delete(id)
      }
    }
    projectList.querySelector(':scope > .navigation-empty')?.remove()
    for (const item of visible) {
      let group = projectGroups.get(item.id)
      if (!group) {
        group = document.createElement('section')
        group.className = 'project-group'
        group.dataset.projectId = item.id
        group.setAttribute('aria-label', item.name)
        group.innerHTML = `<div class="project-row">
          <button class="project-button" type="button"><span class="project-copy"><span class="project-name"></span><small></small></span></button>
          <button class="project-create icon-button" type="button"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#agent--icon-plus"/></svg></button>
        </div><div class="project-sessions navigation-list"></div>`
        group.querySelector('.project-button')!.setAttribute('aria-controls', `agent--project-sessions-${item.id}`)
        const create = group.querySelector<HTMLButtonElement>('.project-create')!
        create.dataset.createProjectSession = item.id
        create.setAttribute('aria-label', `在 ${item.name} 中新建会话`)
        create.title = `在 ${item.name} 中新建会话`
        const list = group.querySelector<HTMLElement>('.project-sessions')!
        list.id = `agent--project-sessions-${item.id}`
        list.setAttribute('aria-label', `${item.name} 的会话`)
        projectGroups.set(item.id, group)
        projectList.append(group)
        renderProjectSessions(item.id)
      }
      projectList.append(group)
      const button = group.querySelector<HTMLButtonElement>('.project-button')!
      group.setAttribute('aria-label', item.name)
      group.querySelector('.project-create')!.setAttribute('aria-label', `在 ${item.name} 中新建会话`)
      group.querySelector<HTMLButtonElement>('.project-create')!.title = `在 ${item.name} 中新建会话`
      group.querySelector('.project-sessions')!.setAttribute('aria-label', `${item.name} 的会话`)
      button.dataset.projectId = item.id
      button.title = item.path
      button.classList.toggle('unavailable', !item.available)
      button.querySelector('.project-name')!.textContent = item.name
      button.querySelector('small')!.textContent = item.available ? item.path : '目录不可访问'
      updateProjectExpansion(item.id)
    }
    if (!visible.length) {
      const hint = document.createElement('p')
      hint.className = 'navigation-empty'
      hint.textContent = '为当前执行设备添加项目，开始工作。'
      projectList.append(hint)
    }
    refreshControls()
  }

  function updateProjectExpansion(id: string): void {
    const group = projectGroups.get(id)
    if (!group) return
    const expanded = !sidebarState.read().collapsedProjects.includes(id)
    if (!expanded && sessionMenu.reference()?.projectId === id) sessionMenu.close()
    group.querySelector('.project-button')!.setAttribute('aria-expanded', String(expanded))
    group.querySelector<HTMLElement>('.project-sessions')!.hidden = !expanded
  }

  function setProjectExpanded(id: string, expanded: boolean): void {
    if (sidebarState.read().collapsedProjects.includes(id) === !expanded) return
    sidebarState.update(current => ({ ...current, collapsedProjects: expanded
      ? current.collapsedProjects.filter(projectId => projectId !== id) : [...current.collapsedProjects, id] }))
    updateProjectExpansion(id)
  }

  function selectProject(id: string, { write = true, expand = true }: { write?: boolean; expand?: boolean } = {}): void {
    if (!sidebar().projects.some(item => item.id === id)) return
    state = { ...state, sidebarProjectId: id }
    if (expand) setProjectExpanded(id, true)
    refreshControls()
    if (write) { persist(); if (!state.root) updateURL() }
  }

  function route(): void {
    if (!ready) return
    const parsed = parseRoute(routeHash())
    if (!parsed) return
    if (waitForProjectSnapshot(parsed.projectId, receivedProjects, initialProjectsSettled)) return
    if (!projects.some(item => item.id === parsed.projectId)) { showNotice('项目不存在。'); updateURL(); return }
    if (parsed.sessionId) open({ projectId: parsed.projectId, sessionId: parsed.sessionId }, false)
    else selectProject(parsed.projectId, { expand: false })
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
    if (data.sessionMenu && data.projectId) {
      sessionMenu.toggle(button, { projectId: data.projectId, sessionId: data.sessionMenu })
    } else if (data.createProjectSession) {
      createSession(data.createProjectSession)
    } else if (data.retryProject) {
      void sessionIndex.load(data.retryProject)
    } else if (data.sessionId && data.projectId) {
      const ref = { projectId: data.projectId, sessionId: data.sessionId }
      selectProject(ref.projectId)
      open(ref)
    } else if (data.projectId) {
      setProjectExpanded(data.projectId, sidebarState.read().collapsedProjects.includes(data.projectId))
      selectProject(data.projectId, { expand: false })
    }
  }, options)
  projectList.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const trigger = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-session-menu]') : null
    if (!trigger?.dataset.projectId || !trigger.dataset.sessionMenu) return
    event.preventDefault(); event.stopPropagation()
    sessionMenu.toggle(trigger, { projectId: trigger.dataset.projectId, sessionId: trigger.dataset.sessionMenu }, event.key === 'ArrowUp')
  }, options)
  tabs.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-pane-id]')
    if (button?.dataset.paneId) focusPane(button.dataset.paneId)
  }, options)
  host.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-create-session], [data-add-project]') : null
    if (!button || button.disabled) return
    if (button.hasAttribute('data-create-session') && state.sidebarProjectId) createSession(state.sidebarProjectId)
    else addProject.click()
  }, options)
  document.addEventListener('click', event => {
    if (!applicationActive || !(event.target instanceof Node) || !root.contains(event.target)) return
    if (suppressClick) { event.preventDefault(); event.stopPropagation(); suppressClick = false }
  }, { ...options, capture: true })
  document.addEventListener('pointerdown', event => {
    if (!applicationActive || !(event.target instanceof Node) || !root.contains(event.target)) return
    const source = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-drag-session]') : null
    if (!source || event.button !== 0 || (event.target as HTMLElement).closest('.pane-close, .workspace-controls') || compact) return
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
    const chosen = projects.find(item => item.id === projectId), agentId = selectedAgent(projectId)
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
  const projectPicker = setupProjectDirectoryPicker(messageFor, opened => {
    if (disposed) return
    // Show the confirmed target immediately; an unrelated offline device must not delay it.
    projects = [...projects.filter(project => project.id !== opened.id), opened]
    renderNavigation(); selectProject(opened.id)
    void sessionIndex.load(opened.id)
    void api<readonly ProjectView[]>('/projects').then(value => {
      if (disposed) return
      projects = value; renderNavigation(); refreshControls()
      for (const item of projects) if (!sessionIndex.get(item.id)) void sessionIndex.load(item.id)
    }).catch(error => { if (!disposed) showNotice(messageFor(error)) })
  }, root)
  addProject.addEventListener('click', () => {
    const target = multi.directoryTarget?.()
    if (target) projectPicker.open(target, addProject)
  }, options)
  const unsubscribeRoute = environment.route.subscribe(route)
  document.addEventListener('visibilitychange', () => {
    fileSidebar.setVisible(!document.hidden && applicationActive && sidebarLayout.rightVisible())
    if (!document.hidden && applicationActive) {
      void imageLeases.refresh(); void fileLeases.refresh(); archivePanel.refresh()
      for (const project of projects) void sessionIndex.load(project.id)
    }
    if (document.hidden) { dragCleanup?.(); resizeCleanup?.() }
    for (const bundle of bundles.values()) if (bundle.view) void bundle.controller.refresh()
  }, options)
  const unsubscribeModels = models?.subscribe(() => { for (const bundle of bundles.values()) bundle.view?.render() })
  let observedSize = ''
  const observer = new ResizeObserver(() => {
    if (!applicationActive || host.clientWidth === 0 || host.clientHeight === 0) return
    const value = `${host.clientWidth}:${host.clientHeight}:${root.clientWidth <= 760}`
    if (value === observedSize) return
    sessionMenu.close()
    observedSize = value
    const shouldCompact = root.clientWidth <= 760 || !fits(state.root, size())
    if (shouldCompact !== compact) renderLayout()
    else if (!compact && state.root) updateRatios(fitRatios(state.root, size()))
    else for (const bundle of bundles.values()) bundle.view?.resizeInput()
    refreshControls()
  })
  observer.observe(host)
  window.addEventListener('resize', () => {
    if (!applicationActive || host.clientWidth === 0 || host.clientHeight === 0) return
    if ((root.clientWidth <= 760 || !fits(state.root, size())) !== compact) renderLayout()
  }, options)
  renderLayout()
  pickerSupported = !!multi.directoryTarget?.()
  pickerStatus.hidden = pickerSupported
  pickerStatus.textContent = pickerSupported ? '' : '请先添加 harness server 连接，再选择项目目录。'
  refreshControls()
  const receiveProjects = (value: readonly ProjectView[]) => {
    if (disposed) return
    receivedProjects = value
    projects = [...value]
    // Keep a saved pane for an offline or removed connection. It must never fall back to another target.
    for (const pane of panes(state.root)) {
      const ref = splitScopedId(pane.projectId)
      if (ref && !projects.some(item => item.id === pane.projectId)) {
        const connection = multi.connections?.find(item => item.instanceId === ref.instanceId)
        projects = [...projects, { id: pane.projectId, name: '暂不可用的项目', path: '', available: false, instanceId: ref.instanceId, harnessName: connection?.name ?? '未连接的设备' }]
      }
    }
    for (const pane of panes(state.root)) if (!projects.some(item => item.id === pane.projectId)) state = closePane(state, pane.id)
    ready = true
    const parsed = parseRoute(routeHash())
    const waiting = waitForProjectSnapshot(parsed?.projectId ?? state.sidebarProjectId, value, initialProjectsSettled)
    const ownRoute = parsed && !parsed.sessionId && (environment.selectedInstanceId === undefined || splitScopedId(parsed.projectId)?.instanceId === environment.selectedInstanceId)
    const navigation = projectSidebar(projects, environment.selectedInstanceId, ownRoute ? parsed.projectId : state.sidebarProjectId, initialProjectsSettled)
    state = { ...state, sidebarProjectId: navigation.selectedProjectId }
    // Views are first mounted after projects load, so their titles use the project names.
    renderLayout()
    if (!waiting) route()
    renderNavigation()
    if (navigation.selectedProjectId) selectProject(navigation.selectedProjectId, { write: false, expand: false })
    for (const item of projects) void sessionIndex.load(item.id)
    if (!waiting) { persist(); updateURL() }
  }
  const unsubscribeProjects = multi.subscribeList?.('/projects', values => receiveProjects(values as readonly ProjectView[]))
  void api<readonly ProjectView[]>('/projects').then(values => { initialProjectsSettled = true; receiveProjects(values) }).catch(error => showNotice(messageFor(error)))
  return {
    openSidebar: () => sidebarLayout.openLeft(),
    closeSidebar: () => { sessionMenu.close(); sidebarLayout.closeDrawers() },
    refreshArchive: () => archivePanel.activate(),
    setActive(active: boolean) {
      applicationActive = active
      sidebarLayout.setActive(active)
      fileSidebar.setVisible(active && !document.hidden && sidebarLayout.rightVisible())
      if (!active) { sessionMenu.close(); void projectPicker.close(); dragCleanup?.(); resizeCleanup?.(); return }
      if (disposed) return
      renderLayout()
      for (const bundle of bundles.values()) void bundle.controller.refresh()
    },
    refreshControls,
    dispose() {
      unsubscribeRoute?.()
      disposed = true
      sessionMenu.dispose()
      unsubscribeSidebar()
      sidebarLayout.dispose()
      changes.dispose()
      imageLeases.dispose()
      fileLeases.dispose()
      unsubscribeModels?.()
      unsubscribeProjects?.()
      listeners.abort()
      sessionIndex.dispose()
      archivePanel.dispose()
      const pickerExit = projectPicker.dispose()
      observer.disconnect()
      resizeCleanup?.()
      dragCleanup?.()
      for (const bundle of bundles.values()) { bundle.controller.dispose(); bundle.view?.dispose() }
      return Promise.all([pickerExit, fileSidebar.dispose()]).then(() => {})
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
