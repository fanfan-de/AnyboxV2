import { splitScopedId } from './harness-client.js'
import type { HarnessClient } from './harness-client.js'
import { setupWorkspace } from './workspace-client.js'
import { createModelsCatalog, setupModelsSettings } from './models-client.js'
import { setupPromptSettings } from './prompt-client.js'
import { messageFor } from './client-errors.js'
import type { AgentView } from './client-types.js'
import type { MountedPage } from './page-lifecycle.js'

export function mountAgentPage(root: HTMLElement, api: HarnessClient, options: {
  selectedId?: string; selectedName?: string; layoutKey?: string; isActive(): boolean;
  route: { read(): string; write(hash: string, push: boolean): void; subscribe(listener: () => void): () => void };
}): MountedPage {
  let closed = false
  const lifetime = new AbortController()
  function listen<T extends keyof DocumentEventMap>(target: Document, type: T, listener: (event: DocumentEventMap[T]) => void): void
  function listen(target: MediaQueryList, type: 'change', listener: (event: MediaQueryListEvent) => void): void
  function listen(target: EventTarget, type: string, listener: ((event: KeyboardEvent) => void) | ((event: FocusEvent) => void) | ((event: MediaQueryListEvent) => void)): void { target.addEventListener(type, event => { if (options.isActive?.() === false) return; (listener as EventListener)(event) }, { signal: lifetime.signal }) }
function required<T extends HTMLElement>(id: string): T {
  const found = root.querySelector<T>(`#${id}`)
  if (!found) throw new Error(`missing element ${id}`)
  return found as T
}
const agentSelect = required<HTMLSelectElement>('agent--agent-select')
const settingsDialog = required<HTMLDialogElement>('agent--settings-dialog')
const openSettingsButton = required<HTMLButtonElement>('agent--open-settings')
const closeSettingsButton = required<HTMLButtonElement>('agent--close-settings')
const sidebar = required<HTMLElement>('agent--workspace-sidebar')
const sidebarToggle = required<HTMLButtonElement>('agent--toggle-sidebar')
const sidebarToggleLabel = required<HTMLElement>('agent--sidebar-toggle-label')
const sidebarClose = required<HTMLButtonElement>('agent--close-sidebar')
const sidebarBackdrop = required<HTMLButtonElement>('agent--sidebar-backdrop')
const sessionWorkspace = required<HTMLElement>('agent--session-workspace')
const workspaceShell = sidebar.closest<HTMLElement>('.workspace')!
const narrowWindow = window.matchMedia('(max-width: 760px)')
let sidebarCollapsed = false, sidebarOpen = false

function renderSidebar(): void {
  const drawerOpen = narrowWindow.matches && sidebarOpen
  const visible = narrowWindow.matches ? sidebarOpen : !sidebarCollapsed
  workspaceShell.classList.toggle('sidebar-collapsed', !narrowWindow.matches && sidebarCollapsed)
  workspaceShell.classList.toggle('sidebar-open', drawerOpen)
  sidebar.inert = !visible
  sidebar.setAttribute('aria-hidden', String(!visible))
  if (drawerOpen) {
    sidebar.setAttribute('role', 'dialog')
    sidebar.setAttribute('aria-modal', 'true')
  } else {
    sidebar.removeAttribute('role')
    sidebar.removeAttribute('aria-modal')
  }
  sidebarBackdrop.hidden = !drawerOpen
  sessionWorkspace.inert = drawerOpen
  sidebarToggle.setAttribute('aria-expanded', String(visible))
  sidebarToggleLabel.textContent = visible ? '收起侧栏' : '展开侧栏'
  sidebarToggle.title = sidebarToggleLabel.textContent
}

function sidebarFocusTargets(): HTMLElement[] {
  return [...sidebar.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, [tabindex]')]
    .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0)
}

function focusSidebar(): void {
  const target = sidebarFocusTargets()[0] ?? sidebar
  target.focus()
}

function closeSidebar(): void {
  if (!narrowWindow.matches || !sidebarOpen) return
  sidebarOpen = false
  renderSidebar()
  sidebarToggle.focus()
}

sidebar.tabIndex = -1
sidebarToggle.addEventListener('click', () => {
  if (narrowWindow.matches) sidebarOpen = !sidebarOpen
  else sidebarCollapsed = !sidebarCollapsed
  renderSidebar()
  if (narrowWindow.matches && sidebarOpen) focusSidebar()
})
sidebarClose.addEventListener('click', closeSidebar)
sidebarBackdrop.addEventListener('click', closeSidebar)
required('agent--show-workspace').addEventListener('click', () => {
  if (narrowWindow.matches) sidebarOpen = true
  else sidebarCollapsed = false
  renderSidebar()
  focusSidebar()
})
const helpDialog = required<HTMLDialogElement>('agent--help-dialog')
required('agent--close-help').addEventListener('click', () => helpDialog.close())
required('agent--open-help').addEventListener('click', () => { closeSidebar(); helpDialog.showModal() })
sidebar.addEventListener('click', event => {
  const action = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.session-open, #agent--new-session, [data-create-project-session], #agent--add-project') : null
  // Release the narrow-screen drawer's focus trap before the selector opens its modal.
  if (action?.id === 'agent--add-project' && !action.disabled) { closeSidebar(); return }
  // The accepted new-session click disables its button synchronously; inspect it before its handler runs.
  if (action && !action.disabled) queueMicrotask(closeSidebar)
}, { capture: true })
listen(document, 'keydown', event => {
  if (!narrowWindow.matches || !sidebarOpen) return
  if (event.key === 'Escape') {
    event.preventDefault()
    closeSidebar()
  } else if (event.key === 'Tab') {
    const targets = sidebarFocusTargets(), first = targets[0], last = targets.at(-1)
    if (!first || !sidebar.contains(document.activeElement) ||
        (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
      event.preventDefault()
      const target = event.shiftKey ? last ?? sidebar : first ?? sidebar
      target.focus()
    }
  }
})
listen(document, 'focusin', event => {
  if (narrowWindow.matches && sidebarOpen && event.target instanceof Node && !sidebar.contains(event.target)) focusSidebar()
})
listen(narrowWindow, 'change', () => {
  const focused = document.activeElement
  const hadSidebarFocus = sidebarOpen || sidebar.contains(focused)
  sidebarOpen = false
  renderSidebar()
  if (hadSidebarFocus && (sidebar.inert || focused === document.body ||
      !(focused instanceof HTMLElement) || !focused.getClientRects().length)) sidebarToggle.focus()
})
renderSidebar()



const selected = options.selectedId === undefined ? api.connections[0] : api.connections.find(item => item.id === options.selectedId)
required('agent--settings-target').textContent = `执行设备：${options.selectedName ?? selected?.name ?? '未选择'}`
type SettingsSection = 'general' | 'models' | 'prompts'
const settingsNavigation = [...settingsDialog.querySelectorAll<HTMLButtonElement>('[data-settings-section]')]
const settingsPanels = [...settingsDialog.querySelectorAll<HTMLElement>('[data-settings-panel]')]
function selectSettingsSection(section: SettingsSection): void {
  for (const button of settingsNavigation) {
    if (button.dataset.settingsSection === section) button.setAttribute('aria-current', 'page')
    else button.removeAttribute('aria-current')
  }
  // Keep each form mounted so navigating between sections preserves unfinished edits.
  for (const panel of settingsPanels) panel.hidden = panel.dataset.settingsPanel !== section
  required('agent--settings-content').scrollTop = 0
}
for (const button of settingsNavigation) button.addEventListener('click', () => {
  selectSettingsSection(button.dataset.settingsSection as SettingsSection)
})
openSettingsButton.addEventListener('click', () => { closeSidebar(); settingsDialog.showModal() })
closeSettingsButton.addEventListener('click', () => { settingsDialog.close() })
settingsDialog.addEventListener('close', () => {
  if (options.isActive?.() !== false && !root.querySelector('dialog[open]') && !openSettingsButton.getClientRects().length) sidebarToggle.focus()
})

const models = createModelsCatalog(api, messageFor)
void models.refresh()
settingsDialog.addEventListener('close', () => { void models.refresh() })
const hostApi = selected ? api.forConnection(selected.id) : undefined
const hostModels = hostApi ? createModelsCatalog(hostApi, messageFor) : undefined
const modelsSettings = hostApi && hostModels && selected ? setupModelsSettings(hostApi, messageFor, hostModels, selected.instanceId, required('agent--models-settings')) : undefined
const promptSettings = hostApi && selected ? setupPromptSettings(hostApi, messageFor, required('agent--prompt-settings'), JSON.stringify(['agent', selected.instanceId, 'prompts'])) : undefined
if (!selected) {
  for (const section of ['models', 'prompts'] as const) {
    const panel = required<HTMLElement>(section === 'models' ? 'agent--models-settings' : 'agent--prompt-settings')
    panel.replaceChildren()
    const heading = document.createElement('h3'), hint = document.createElement('p')
    heading.id = section === 'models' ? 'agent--models-settings-title' : 'agent--prompt-title'
    heading.textContent = section === 'models' ? '模型管理' : 'Prompt 管理'
    hint.textContent = '请先在管理连接中启动所选设备上的 Agent，再管理模型与 Prompt。'
    panel.append(heading, hint)
  }
}
function revealSettings(section: SettingsSection): void {
  selectSettingsSection(section)
  if (options.isActive() && !settingsDialog.open) { closeSidebar(); settingsDialog.showModal() }
}
function canLeave(): boolean {
  if (modelsSettings && !modelsSettings.canLeave()) { revealSettings('models'); return false }
  if (promptSettings && !promptSettings.canLeave()) { revealSettings('prompts'); return false }
  return true
}
let knownAgents: readonly AgentView[] = []
const workspace = setupWorkspace(api, messageFor, projectId => {
  const instance = projectId && splitScopedId(projectId)?.instanceId
  const candidates = knownAgents.filter(agent => splitScopedId(agent.id)?.instanceId === instance)
  return candidates.find(agent => splitScopedId(agent.id)?.id === splitScopedId(agentSelect.value)?.id)?.id ?? candidates[0]?.id ?? ''
}, models, { root, storageKey: options.layoutKey, route: options.route, isActive: options.isActive })
const receiveAgents = (agents: readonly AgentView[]) => {
  if (closed) return
  knownAgents = agents
  const previous = agentSelect.value
  const own = agents.filter(agent => splitScopedId(agent.id)?.instanceId === selected?.instanceId)
  agentSelect.replaceChildren(...own.map(agent => {
    const option = document.createElement('option')
    option.value = agent.id
    option.textContent = `${agent.harnessName ?? ''} · ${splitScopedId(agent.id)?.id ?? agent.id}`
    return option
  }))
  if (own.some(agent => agent.id === previous)) agentSelect.value = previous
  agentSelect.disabled = own.length === 0
  workspace.refreshControls()
}
const unsubscribeAgents = api.subscribeList('/agents', values => receiveAgents(values as readonly AgentView[]))
void api<readonly AgentView[]>('/agents').then(receiveAgents).catch(error => {
  if (closed) return
  const notice = required<HTMLElement>('agent--workspace-notice')
  notice.textContent = messageFor(error)
  notice.hidden = false
})
agentSelect.addEventListener('change', workspace.refreshControls)
return {
  setActive(active) {
    if (!active) { sidebarOpen = false; renderSidebar(); settingsDialog.close(); helpDialog.close() }
    workspace.setActive(active)
  },
  canLeave,
  async dispose() {
    closed = true; lifetime.abort(); unsubscribeAgents(); workspace.dispose(); models.dispose(); hostModels?.dispose()
    await Promise.all([modelsSettings?.dispose(), promptSettings?.dispose()])
    await api.dispose()
  },
}
}
