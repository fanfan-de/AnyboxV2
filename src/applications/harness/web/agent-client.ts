import { splitScopedId } from './harness-client.js'
import type { HarnessClient } from './harness-client.js'
import { setupWorkspace } from './workspace-client.js'
import { createModelsCatalog, setupModelsSettings } from './models-client.js'
import { setupPromptSettings } from './prompt-client.js'
import { messageFor } from './client-errors.js'
import type { AgentView } from './client-types.js'
import type { MountedPage } from './page-lifecycle.js'

export function mountAgentPage(root: HTMLElement, api: HarnessClient, options: {
  selectedId?: string; selectedName?: string; selectedInstanceId?: string; layoutKey?: string; isActive(): boolean;
  route: { read(): string; write(hash: string, push: boolean): void; subscribe(listener: () => void): () => void };
}): MountedPage {
  let closed = false
  const lifetime = new AbortController()
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
function closeSidebar(): void { workspace.closeSidebar() }
const helpDialog = required<HTMLDialogElement>('agent--help-dialog')
required('agent--close-help').addEventListener('click', () => helpDialog.close())
required('agent--open-help').addEventListener('click', () => { closeSidebar(); helpDialog.showModal() })
sidebar.addEventListener('click', event => {
  const action = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.session-open, [data-create-project-session], #agent--add-project') : null
  // Release a drawer's focus trap before the project selector opens its modal.
  if (action?.id === 'agent--add-project' && !action.disabled) { closeSidebar(); return }
  // Creating a project session disables its button synchronously; inspect it before its handler runs.
  if (action && !action.disabled) queueMicrotask(closeSidebar)
}, { capture: true, signal: lifetime.signal })

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
}, models, { root, storageKey: options.layoutKey, selectedInstanceId: options.selectedInstanceId ?? selected?.instanceId, route: options.route, isActive: options.isActive })
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
    if (!active) { settingsDialog.close(); helpDialog.close() }
    workspace.setActive(active)
  },
  canLeave,
  async dispose() {
    closed = true; lifetime.abort(); unsubscribeAgents(); const workspaceExit = workspace.dispose(); models.dispose(); hostModels?.dispose()
    await Promise.all([workspaceExit, modelsSettings?.dispose(), promptSettings?.dispose()])
    await api.dispose()
  },
}
}
