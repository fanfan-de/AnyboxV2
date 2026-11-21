import { splitScopedId } from './harness-client.js'
import type { HarnessClient } from './harness-client.js'
import { setupArchivePanel } from './archive-client.js'
import { createFileLeaseKeeper } from './file-client.js'
import type { ModelsCatalog } from './models-client.js'
import type { AgentView, SessionView, SessionPosition } from './client-types.js'
import { createPendingStore, createSessionController } from './session-client.js'
import type { BrowserStorage, SessionController } from './session-client.js'
import { createImageLeaseKeeper } from './image-client.js'
import { createDraftStore, continuousDraftKey, filesForWorkspaceChange } from './draft-client.js'
import { createSessionPanel } from './session-view.js'
import type { SessionPanel, SessionScrollPosition } from './session-view.js'
import { parseRoute, restoreLegacyProject, sessionHash } from './workspace-layout.js'
import type { Pane, SessionRef } from './workspace-layout.js'
import { createSidebarStateStore } from './sidebar-layout.js'
import { setupSidebarLayout } from './sidebar-client.js'
import { createFileSidebar, restoreFileSidebarSessionState } from './file-sidebar.js'
import type { FilePreviewRequest } from './file-sidebar.js'

export const workspaceKey = 'anybox.personal-agent.web.workspace.v2'
const storage: BrowserStorage = {
  getItem: key => sessionStorage.getItem(key), setItem: (key, value) => sessionStorage.setItem(key, value),
}

const fileStateKey = (ref: SessionRef) => ref.continuous ? JSON.stringify([ref.sessionId, ref.projectId]) : ref.sessionId

interface Bundle { controller: SessionController; view?: SessionPanel; scroll: SessionScrollPosition }
interface CurrentPane { ref: SessionRef; agentId?: string; bundle: Bundle }

export function setupWorkspace(api: HarnessClient, messageFor: (error: unknown) => string, selectedAgent: () => string,
  models: ModelsCatalog | undefined, environment: { root: HTMLElement; storageKey?: string; isActive(): boolean; agentsSettled(): boolean;
    agentFor?(id: string): AgentView | undefined; conversationPreview?(id: string, text: string): void; route: {
    read(): string; write(hash: string, push: boolean): void; subscribe(listener: () => void): () => void
  } }) {
  const root = environment.root
  const get = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!
  const host = get('personal-agent--pane-host'), notice = get('personal-agent--workspace-notice')
  const workspaceControls = get('personal-agent--workspace-controls'), center = get('personal-agent--session-workspace')
  const layoutKey = environment.storageKey ?? workspaceKey
  const positionsKey = environment.storageKey ? `${environment.storageKey}.positions` : 'anybox.personal-agent.web.positions.v2'
  const pending = createPendingStore(storage), drafts = createDraftStore(storage)
  const positions = new Map<string, SessionPosition>()
  const bundles = new Map<string, Bundle>()
  const listeners = new AbortController(), options = { signal: listeners.signal }
  const showNotice = (message = '') => { notice.textContent = message; notice.hidden = !message }
  let disposed = false, applicationActive = environment.isActive()
  let legacyProjectId: string | null = null
  let history: SessionRef | undefined, current: CurrentPane | undefined
  let opening: { agentId: string; abort: AbortController } | undefined
  let failed: { agentId: string; message: string } | undefined
  try {
    legacyProjectId = restoreLegacyProject(JSON.parse(storage.getItem(layoutKey) ?? 'null'))
  } catch { /* The previous selection is optional. */ }
  try {
    const saved = JSON.parse(storage.getItem(positionsKey) ?? '{}')
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const [id, raw] of Object.entries(saved)) {
        if (!raw || typeof raw !== 'object' || !('viewNodeId' in raw) ||
            (raw.viewNodeId !== null && typeof raw.viewNodeId !== 'string')) continue
        positions.set(id, { viewNodeId: raw.viewNodeId, viewMode: 'viewMode' in raw && raw.viewMode === 'runs' ? 'runs' : 'dialogue',
          ...('focusedRunId' in raw && typeof raw.focusedRunId === 'string' ? { focusedRunId: raw.focusedRunId } : {}) })
      }
    }
  } catch { /* Dialogue information can still be recovered from the device. */ }

  const sidebarState = createSidebarStateStore(`${layoutKey}.sidebars.v1`, { storage,
    onStorageError: () => showNotice('浏览器无法保存边栏与文件视图位置。'),
  })
  const fileSidebar = createFileSidebar(get('personal-agent--file-sidebar-content'), {
    api, messageFor,
    changed(ref, value) {
      if (!disposed) sidebarState.update(state => ({ ...state, perSession: { ...state.perSession, [fileStateKey(ref)]: value } }))
    },
  })
  const sidebarLayout = setupSidebarLayout(root, {
    storageKey: `${layoutKey}.sidebars.v1`, stateStore: sidebarState, isActive: () => applicationActive,
  })
  const unsubscribeSidebar = sidebarLayout.subscribe(visible => fileSidebar.setVisible(visible && !document.hidden))
  const fileSidebarSync = () => {
    const ref = current?.ref
    fileSidebar.setSession(ref, current?.bundle.controller,
      ref ? restoreFileSidebarSessionState(sidebarState.read().perSession[fileStateKey(ref)]) : undefined)
  }
  const openFile = (request: FilePreviewRequest) => {
    if (!current || current.ref.sessionId !== request.ref.sessionId || current.ref.projectId !== request.ref.projectId) return
    fileSidebarSync()
    sidebarLayout.openRight()
    fileSidebar.open(request)
  }
  const changes = api.changes({
    refresh(id) { if (current?.ref.sessionId === id) current.bundle.controller.notifyChange() },
    view(snapshot) { if (current?.ref.sessionId === snapshot.sessionId) current.bundle.controller.protocolView(snapshot) },
    incompatibleView(sessionId, runId) { if (current?.ref.sessionId === sessionId) current.bundle.controller.incompatibleView(runId) },
    connected(ids, value) { if (current && ids.includes(current.ref.sessionId)) current.bundle.controller.setLive(value) },
  })
  const schedule = (callback: () => void, ms: number) => window.setTimeout(callback, ms)
  const clear = (timer: unknown) => window.clearTimeout(timer as number)
  const leaseOptions = { api, drafts, pending, schedule, clear,
    changed: () => current?.bundle.controller.imagesChanged(), error: (error: unknown) => showNotice(messageFor(error)),
  }
  const imageLeases = createImageLeaseKeeper(leaseOptions)
  const fileLeases = createFileLeaseKeeper(leaseOptions)
  const archivePanel = setupArchivePanel(api, messageFor, {
    root,
    view(session) {
      history = { projectId: session.projectId, sessionId: session.id }
      environment.route.write(sessionHash(history), true)
      reconcile()
      current?.bundle.view?.element.focus({ preventScroll: true })
    },
  })

  function unmount(): void {
    if (!current) return
    const bundle = current.bundle
    bundle.controller.detach()
    if (bundle.view) {
      bundle.scroll = bundle.view.dispose()
      bundle.view.element.remove()
      bundle.view = undefined
    }
    current = undefined
    center.insertBefore(workspaceControls, notice)
    changes.update([])
    fileSidebarSync()
  }

  function mount(ref: SessionRef, agentId?: string): void {
    if (current?.ref.sessionId === ref.sessionId && current.ref.projectId === ref.projectId && current.ref.continuous === ref.continuous) {
      current.bundle.view?.setAgent(agentId ? environment.agentFor?.(agentId) : undefined)
      return
    }
    unmount()
    const instance = splitScopedId(ref.sessionId)?.instanceId
    const visibleModels = () => models?.snapshot().models.filter(model => !instance || splitScopedId(model.id)?.instanceId === instance) ?? []
    const key = JSON.stringify([ref.sessionId, Boolean(ref.continuous)])
    let bundle = bundles.get(key)
    if (!bundle) {
      if (ref.continuous && legacyProjectId && legacyProjectId !== ref.projectId) {
        const previousKey = continuousDraftKey(legacyProjectId), nextKey = continuousDraftKey(ref.projectId)
        const previous = drafts.get(ref.sessionId, previousKey), next = drafts.get(ref.sessionId, nextKey)
        if ((previous.text || previous.images.length || previous.files.length) && !next.text && !next.images.length && !next.files.length) {
          try {
            drafts.set(ref.sessionId, nextKey, { ...previous, files: filesForWorkspaceChange(previous.files) })
            drafts.set(ref.sessionId, previousKey, { text: '', images: [], files: [] })
          } catch { showNotice('浏览器无法保存迁入的草稿。') }
        }
      }
      const controller = createSessionController(ref, {
        api, pending, drafts, uploadImage: api.upload, messageFor, newId: () => crypto.randomUUID(),
        schedule, clear, hidden: () => document.hidden || !applicationActive,
        continuous: ref.continuous, historyOnly: !ref.continuous,
        ...(models ? { models: visibleModels } : {}),
        position: positions.get(ref.sessionId),
        savePosition(position) {
          positions.set(ref.sessionId, position)
          try { storage.setItem(positionsKey, JSON.stringify(Object.fromEntries(positions))) }
          catch { showNotice('浏览器无法保存查看位置。') }
        },
        missing() {
          if (current?.ref.sessionId !== ref.sessionId) return
          unmount()
          if (agentId) failed = { agentId, message: '对话暂不可用。' }
          else {
            history = undefined
            environment.route.write('#', false)
            showNotice('历史对话暂不可用。')
          }
          reconcile()
        },
      })
      bundle = { controller, scroll: { dialogue: 0 } }
      bundles.set(key, bundle)
    }
    const pane: Pane = { ...ref, id: ref.sessionId }
    bundle.view = createSessionPanel(pane, bundle.controller,
      () => {
        history = undefined
        environment.route.write('#', false)
        reconcile()
      }, bundle.scroll, models ? { ...models, snapshot: () => ({ ...models.snapshot(), models: visibleModels() }) } : undefined,
      openFile)
    bundle.view.setAgent(agentId ? environment.agentFor?.(agentId) : undefined)
    bundle.view.element.classList.add('active-pane')
    const heading = bundle.view.element.querySelector('.pane-heading')!
    heading.insertBefore(workspaceControls, heading.querySelector('.pane-close'))
    host.replaceChildren(bundle.view.element)
    current = { ref, agentId, bundle }
    fileSidebarSync()
    bundle.controller.attach(() => {
      bundle.view?.render(); fileSidebar.refresh()
      if (agentId && ref.continuous) {
        const state = bundle.controller.snapshot(), latest = state.path.at(-1)
        const latestRun = state.runs.reduce<typeof state.run>((newest, run) => !newest || run.createdAt >= newest.createdAt ? run : newest, undefined)
        const text = state.pending?.input || latestRun?.output || latestRun?.input || latest?.output || latest?.input
        if (text) environment.conversationPreview?.(agentId, text)
      }
    })
    changes.update([ref.sessionId])
  }

  function renderEmpty(title: string, hint: string, retry = false): void {
    unmount()
    const previous = host.firstElementChild as HTMLElement | null
    const state = JSON.stringify([title, hint, retry])
    if (previous?.dataset.state === state) return
    const empty = document.createElement('div')
    empty.className = 'workspace-empty empty-state'
    empty.dataset.state = state
    const heading = document.createElement('h2'), description = document.createElement('p')
    heading.textContent = title; description.textContent = hint
    empty.append(heading, description)
    if (retry) {
      const buttons = document.createElement('div'), button = document.createElement('button')
      buttons.className = 'empty-actions'
      button.type = 'button'; button.textContent = '重新打开'; button.dataset.workspaceAction = 'retry'
      buttons.append(button); empty.append(buttons)
    }
    host.replaceChildren(empty)
  }

  function cancelOpening(): void { opening?.abort.abort(); opening = undefined }
  function reconcile(): void {
    if (disposed || !applicationActive) return
    if (history) {
      cancelOpening()
      mount(history)
      return
    }
    const agentId = selectedAgent()
    if (!agentId) {
      cancelOpening()
      if (!environment.agentsSettled()) renderEmpty('正在读取 Agent…', '')
      else renderEmpty('没有可用的 Agent', '请在设置中检查执行设备或创建 Agent。')
      return
    }
    if (current?.ref.continuous && current.agentId === agentId) {
      current.bundle.view?.setAgent(environment.agentFor?.(agentId))
      return
    }
    if (opening?.agentId === agentId) return
    cancelOpening()
    if (failed?.agentId === agentId) { renderEmpty('暂时无法打开对话', failed.message, true); return }
    const request = { agentId, abort: new AbortController() }
    opening = request
    renderEmpty('正在打开对话…', environment.agentFor?.(agentId)?.name ?? '')
    void api<SessionView>(`/agents/${encodeURIComponent(agentId)}/session`, {}, request.abort.signal).then(session => {
      if (disposed || opening !== request) return
      const instance = splitScopedId(agentId)?.instanceId
      if (!session.continuous || session.agentId !== agentId || !instance ||
          splitScopedId(session.id)?.instanceId !== instance || splitScopedId(session.projectId)?.instanceId !== instance) {
        throw new Error('Agent 对话返回信息无效。')
      }
      mount({ projectId: session.projectId, sessionId: session.id, continuous: true }, agentId)
      opening = undefined; failed = undefined
    }).catch(error => {
      if (disposed || opening !== request) return
      opening = undefined; failed = { agentId, message: messageFor(error) }; reconcile()
    })
  }

  function selectAgent(): void {
    failed = undefined
    if (history) {
      history = undefined
      environment.route.write('#', true)
    }
    reconcile()
  }

  let observedHash: string | undefined
  function route(): void {
    const hash = environment.route.read()
    if (hash === observedHash) return
    observedHash = hash
    const parsed = parseRoute(hash)
    history = parsed?.sessionId ? { projectId: parsed.projectId, sessionId: parsed.sessionId } : undefined
    if (parsed && !parsed.sessionId) {
      legacyProjectId = parsed.projectId
      environment.route.write('#', false)
    }
    reconcile()
  }

  host.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-workspace-action]') : null
    if (button?.dataset.workspaceAction === 'retry') { failed = undefined; reconcile() }
  }, options)
  document.addEventListener('visibilitychange', () => {
    fileSidebar.setVisible(!document.hidden && applicationActive && sidebarLayout.rightVisible())
    if (document.hidden) { current?.bundle.view?.closeContextUsage(); return }
    if (applicationActive) {
      void imageLeases.refresh(); void fileLeases.refresh(); archivePanel.refresh()
      void current?.bundle.controller.refresh()
    }
  }, options)
  const unsubscribeModels = models?.subscribe(() => current?.bundle.view?.render())
  const observer = new ResizeObserver(() => { if (applicationActive) current?.bundle.view?.resizeInput() })
  observer.observe(host)
  const unsubscribeRoute = environment.route.subscribe(route)
  route()
  return {
    closeSidebar: () => sidebarLayout.closeDrawers(),
    refreshArchive: () => archivePanel.activate(),
    refreshSession: () => current?.bundle.controller.notifyChange(),
    setActive(active: boolean) {
      applicationActive = active
      sidebarLayout.setActive(active)
      fileSidebar.setVisible(active && !document.hidden && sidebarLayout.rightVisible())
      if (!active) { cancelOpening(); current?.bundle.view?.closeContextUsage(); return }
      route()
      reconcile()
      void current?.bundle.controller.refresh()
    },
    selectAgent,
    refreshControls: reconcile,
    dispose() {
      disposed = true
      cancelOpening()
      unsubscribeRoute(); unsubscribeSidebar(); unsubscribeModels?.()
      sidebarLayout.dispose(); changes.dispose(); imageLeases.dispose(); fileLeases.dispose(); archivePanel.dispose()
      listeners.abort(); observer.disconnect()
      for (const bundle of bundles.values()) { bundle.controller.dispose(); bundle.view?.dispose() }
      return fileSidebar.dispose()
    },
  }
}
