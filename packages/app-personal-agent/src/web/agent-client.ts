import { splitScopedId } from './harness-client.js'
import type { HarnessClient } from './harness-client.js'
import { setupWorkspace } from './workspace-client.js'
import { createModelsCatalog, setupModelsSettings } from './models-client.js'
import { setupPromptSettings } from './prompt-client.js'
import { setupSessionDefaults } from './session-defaults-client.js'
import { setupToolsSettings } from './tools-client.js'
import { setupUnitsSettings } from './units-client.js'
import { messageFor } from './client-errors.js'
import type { AgentView } from './client-types.js'
import type { MountedPage } from './page-lifecycle.js'
import { setupSettingsNavigation } from './settings-client.js'
import type { SettingsSection, SettingsViewState } from './settings-client.js'

export interface AgentMountedPage extends MountedPage {
  settingsState(): SettingsViewState
  restoreSettings(): void
  showSettingsBlocked(): void
}
export function mountAgentPage(root: HTMLElement, api: HarnessClient, options: {
  selectedId?: string; selectedName?: string; selectedInstanceId?: string; layoutKey?: string; isActive(): boolean;
  devices: readonly { id: string; name: string }[]; settingsState?: SettingsViewState; selectDevice(id: string): boolean;
  route: { read(): string; write(hash: string, push: boolean): void; subscribe(listener: () => void): () => void };
}): AgentMountedPage {
  let closed = false
  const lifetime = new AbortController()
function required<T extends HTMLElement>(id: string): T {
  const found = root.querySelector<T>(`#${id}`)
  if (!found) throw new Error(`missing element ${id}`)
  return found as T
}
const agentSelect = required<HTMLSelectElement>('personal-agent--agent-select')
const settingsDialog = required<HTMLDialogElement>('personal-agent--settings-dialog')
const openSettingsButton = required<HTMLButtonElement>('personal-agent--open-settings')
const closeSettingsButton = required<HTMLButtonElement>('personal-agent--close-settings')
const sidebar = required<HTMLElement>('personal-agent--workspace-sidebar')
const sidebarToggle = required<HTMLButtonElement>('personal-agent--toggle-sidebar')
function closeSidebar(): void { workspace.closeSidebar() }
sidebar.addEventListener('click', event => {
  const action = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.session-open, [data-create-project-session], #personal-agent--add-project') : null
  // Release a drawer's focus trap before the project selector opens its modal.
  if (action?.id === 'personal-agent--add-project' && !action.disabled) { closeSidebar(); return }
  // Creating a project session disables its button synchronously; inspect it before its handler runs.
  if (action && !action.disabled) queueMicrotask(closeSidebar)
}, { capture: true, signal: lifetime.signal })

const selected = options.selectedId === undefined ? api.connections[0] : api.connections.find(item => item.id === options.selectedId)
openSettingsButton.addEventListener('click', () => { closeSidebar(); settings.open(); workspace.refreshArchive() })
closeSettingsButton.addEventListener('click', () => { settingsDialog.close() })
settingsDialog.addEventListener('close', () => {
  const focus = document.activeElement
  const needsFallback = focus === document.body || focus === openSettingsButton || settingsDialog.contains(focus)
  if (!closed && needsFallback && options.isActive?.() !== false && !root.querySelector('dialog[open]') && !openSettingsButton.getClientRects().length) sidebarToggle.focus()
})

const models = createModelsCatalog(api, messageFor)
void models.refresh()
settingsDialog.addEventListener('close', () => { void models.refresh() })
const hostApi = selected ? api.forConnection(selected.id) : undefined
const hostModels = hostApi ? createModelsCatalog(hostApi, messageFor) : undefined
const sessionDefaults = hostApi && hostModels ? setupSessionDefaults(hostApi, messageFor, hostModels, required('personal-agent--session-defaults'), agentSelect) : undefined
const toolsSettings = hostApi ? setupToolsSettings(hostApi, messageFor, required('personal-agent--tools-settings'), agentSelect) : undefined
const unitsSettings = hostApi ? setupUnitsSettings(hostApi, messageFor, required('personal-agent--units-settings')) : undefined
const modelsSettings = hostApi && hostModels && selected ? setupModelsSettings(hostApi, messageFor, hostModels, selected.instanceId, required('personal-agent--models-settings')) : undefined
const promptSettings = hostApi && selected ? setupPromptSettings(hostApi, messageFor, required('personal-agent--prompt-settings'), JSON.stringify([selected.instanceId, 'prompts'])) : undefined
if (!selected) {
  required('personal-agent--default-model-hint').textContent = '请先在管理连接中启动所选设备上的 Agent，再设置默认模型。'
  for (const [id, titleId, title, text] of [
    ['personal-agent--models-settings', 'personal-agent--models-settings-title', '模型管理', '模型与配置'],
    ['personal-agent--prompt-settings', 'personal-agent--prompt-title', 'Prompt 管理', 'Prompt'],
    ['personal-agent--tools-settings', 'personal-agent--tools-title', 'Agent 工具', '工具'],
    ['personal-agent--units-settings', 'personal-agent--units-title', '执行环境', '执行环境'],
  ] as const) {
    const panel = required<HTMLElement>(id)
    panel.replaceChildren()
    const header = document.createElement('header'), heading = document.createElement('h3'), hint = document.createElement('p')
    header.className = 'settings-panel-heading'; heading.id = titleId; heading.textContent = title
    hint.textContent = `所选设备尚未启动或暂时无法连接。请先在“管理连接”中检查并启动 Agent，再管理${text}。`
    header.append(heading); panel.append(header, hint)
  }
}
function revealSettings(section: SettingsSection): void {
  closeSidebar(); settings.open(section)
}
function canLeave(): boolean {
  if (sessionDefaults && !sessionDefaults.canLeave()) { revealSettings('general'); return false }
  if (toolsSettings && !toolsSettings.canLeave()) { revealSettings('tools'); return false }
  if (modelsSettings && !modelsSettings.canLeave()) { revealSettings('models'); return false }
  if (promptSettings && !promptSettings.canLeave()) { revealSettings('prompts'); return false }
  if (unitsSettings && !unitsSettings.canLeave()) { revealSettings('units'); return false }
  return true
}
let knownAgents: readonly AgentView[] = []
const workspace = setupWorkspace(api, messageFor, projectId => {
  const instance = projectId && splitScopedId(projectId)?.instanceId
  const candidates = knownAgents.filter(agent => splitScopedId(agent.id)?.instanceId === instance)
  return candidates.find(agent => splitScopedId(agent.id)?.id === splitScopedId(agentSelect.value)?.id)?.id ?? candidates[0]?.id ?? ''
}, models, { root, storageKey: options.layoutKey, selectedInstanceId: options.selectedInstanceId ?? selected?.instanceId, route: options.route, isActive: options.isActive })
const settings = setupSettingsNavigation(root, {
  devices: options.devices, selectedId: options.selectedId, selectedName: options.selectedName,
  initialState: options.settingsState, isActive: options.isActive, selectDevice: options.selectDevice,
  refreshArchive: () => workspace.refreshArchive(),
})
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
  sessionDefaults?.selectAgent(agentSelect.value)
  toolsSettings?.selectAgent(agentSelect.value)
  workspace.refreshControls()
}
const unsubscribeAgents = api.subscribeList('/agents', values => receiveAgents(values as readonly AgentView[]))
void api<readonly AgentView[]>('/agents').then(receiveAgents).catch(error => {
  if (closed) return
  const notice = required<HTMLElement>('personal-agent--workspace-notice')
  notice.textContent = messageFor(error)
  notice.hidden = false
})
agentSelect.addEventListener('change', () => { sessionDefaults?.selectAgent(agentSelect.value); toolsSettings?.selectAgent(agentSelect.value); workspace.refreshControls() }, { signal: lifetime.signal })
return {
  settingsState: () => settings.snapshot(), restoreSettings: () => settings.restore(), showSettingsBlocked: () => settings.showBlocked(),
  setActive(active) {
    if (!active) settingsDialog.close()
    workspace.setActive(active)
  },
  canLeave,
  async dispose() {
    closed = true; lifetime.abort(); settings.dispose(); settingsDialog.close(); unsubscribeAgents(); const workspaceExit = workspace.dispose(); models.dispose(); hostModels?.dispose()
    await Promise.all([workspaceExit, modelsSettings?.dispose(), promptSettings?.dispose(), sessionDefaults?.dispose(), toolsSettings?.dispose(), unitsSettings?.dispose()])
    await api.dispose()
  },
}
}
