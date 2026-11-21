import { splitScopedId } from './harness-client.js'
import type { HarnessClient } from './harness-client.js'
import { setupWorkspace } from './workspace-client.js'
import { createModelsCatalog, setupModelsSettings } from './models-client.js'
import { setupPromptSettings } from './prompt-client.js'
import { setupSessionDefaults } from './session-defaults-client.js'
import { setupAgentDirectory } from './agent-directory-client.js'
import { createAgentLogo } from './agent-logo.js'
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
  selectedId?: string; selectedName?: string; layoutKey?: string; isActive(): boolean;
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
const mainAgentSlot = required<HTMLElement>('personal-agent--main-agent')
const otherAgentList = required<HTMLElement>('personal-agent--other-agents')
const searchToggle = required<HTMLButtonElement>('personal-agent--search-agents')
const searchField = required<HTMLElement>('personal-agent--agent-search-field')
const searchInput = required<HTMLInputElement>('personal-agent--agent-search')
const searchEmpty = required<HTMLElement>('personal-agent--agent-search-empty')
const createAgentButton = required<HTMLButtonElement>('personal-agent--create-agent')
const settingsDialog = required<HTMLDialogElement>('personal-agent--settings-dialog')
const openSettingsButton = required<HTMLButtonElement>('personal-agent--open-settings')
const closeSettingsButton = required<HTMLButtonElement>('personal-agent--close-settings')
const sidebarToggle = required<HTMLButtonElement>('personal-agent--toggle-sidebar')
function closeSidebar(): void { workspace.closeSidebar() }

const selected = options.selectedId === undefined ? api.connections[0] : api.connections.find(item => item.id === options.selectedId)
const selectedAgentKey = selected && `anybox.personal-agent.client.agent.${selected.instanceId}`
let preferredAgentId = ''
try { if (selectedAgentKey) preferredAgentId = sessionStorage.getItem(selectedAgentKey) ?? '' } catch { /* Optional selection. */ }
openSettingsButton.addEventListener('click', () => { closeSidebar(); settings.open() })
closeSettingsButton.addEventListener('click', () => { settingsDialog.close() })
settingsDialog.addEventListener('close', () => {
  const focus = document.activeElement
  const needsFallback = focus === document.body || focus === openSettingsButton || settingsDialog.contains(focus)
  if (!closed && needsFallback && options.isActive?.() !== false && !root.querySelector('dialog[open]') && !openSettingsButton.getClientRects().length) sidebarToggle.focus()
})

const models = createModelsCatalog(api, messageFor)
void models.refresh()
settingsDialog.addEventListener('close', () => { void models.refresh(); workspace.refreshSession() }, { signal: lifetime.signal })
const hostApi = selected ? api.forConnection(selected.id) : undefined
const hostModels = hostApi ? createModelsCatalog(hostApi, messageFor) : undefined
const sessionDefaults = hostApi && hostModels ? setupSessionDefaults(hostApi, messageFor, hostModels, required('personal-agent--session-defaults')) : undefined
const toolsSettings = hostApi && selected ? setupToolsSettings(hostApi, messageFor, required('personal-agent--tools-settings'),
  JSON.stringify(['personal-agent', selected.instanceId]), agentId => {
    const sessionId = workspace.continuousSessionId(agentId)
    const ref = sessionId ? splitScopedId(sessionId) : undefined
    return ref?.instanceId === selected.instanceId ? ref.id : undefined
  }) : undefined
const unitsSettings = hostApi ? setupUnitsSettings(hostApi, messageFor, required('personal-agent--units-settings')) : undefined
const modelsSettings = hostApi && hostModels && selected ? setupModelsSettings(hostApi, messageFor, hostModels, required('personal-agent--models-settings')) : undefined
const promptSettings = hostApi && selected ? setupPromptSettings(hostApi, messageFor, required('personal-agent--prompt-settings'), JSON.stringify([selected.instanceId, 'prompts'])) : undefined
const agentDirectory = hostApi && hostModels && selected ? setupAgentDirectory(hostApi, messageFor, hostModels,
  required('personal-agent--agent-directory'), selected.instanceId, agent => {
    api.rememberAgent(selected.id, agent)
    sessionDefaults?.refreshAgent(agent.id)
    promptSettings?.receiveAgent(agent)
    refreshAgentList()
  }) : undefined
settingsDialog.addEventListener('close', () => agentDirectory?.pauseLogo(), { signal: lifetime.signal })
document.addEventListener('visibilitychange', () => {
  if (document.hidden) agentDirectory?.pauseLogo()
}, { signal: lifetime.signal })
if (!selected) {
  required('personal-agent--default-model-hint').textContent = '请先在管理连接中启动所选设备上的 Agent，再设置默认模型。'
  for (const [id, titleId, title, text] of [
    ['personal-agent--agent-directory', 'personal-agent--agent-directory-title', 'Agent 管理', 'Agent'],
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
  if (agentDirectory && !agentDirectory.canLeave()) { revealSettings('agents'); return false }
  if (sessionDefaults && !sessionDefaults.canLeave()) { revealSettings('general'); return false }
  if (toolsSettings && !toolsSettings.canLeave()) { revealSettings('tools'); return false }
  if (modelsSettings && !modelsSettings.canLeave()) { revealSettings('models'); return false }
  if (promptSettings && !promptSettings.canLeave()) { revealSettings('prompts'); return false }
  if (unitsSettings && !unitsSettings.canLeave()) { revealSettings('units'); return false }
  return true
}
let knownAgents: readonly AgentView[] = []
let activeAgentId = '', agentsSettled = !selected
const recentMessages = new Map<string, string>()
const agentButtons = new Map<string, { button: HTMLButtonElement; logo: ReturnType<typeof createAgentLogo>; name: HTMLElement; preview: HTMLElement; main: boolean }>()
const agentFor = (id: string) => knownAgents.find(agent => agent.id === id)
const workspace = setupWorkspace(api, messageFor, () => activeAgentId, models, {
  root, storageKey: options.layoutKey, route: options.route, isActive: options.isActive, agentFor, agentsSettled: () => agentsSettled,
  conversationPreview(id, text) {
    if (!text) return
    const preview = text.replace(/^\s{0,3}#{1,6}\s+/u, '').replace(/\s+/gu, ' ').trim().slice(0, 160)
    if (!preview) return
    recentMessages.set(id, preview)
    const entry = agentButtons.get(id)
    if (entry) entry.preview.textContent = preview
  },
})
const settings = setupSettingsNavigation(root, {
  devices: options.devices, selectedId: options.selectedId, selectedName: options.selectedName,
  initialState: options.settingsState, isActive: options.isActive, selectDevice: options.selectDevice,
  refreshArchive: () => workspace.refreshArchive(),
  resetModelsView: () => modelsSettings?.resetView(),
  refreshTools: () => toolsSettings?.refresh(),
  refreshAgents: () => { agentDirectory?.refresh(); refreshAgentList() },
  leaveAgents: () => agentDirectory?.pauseLogo(),
})
function updateActiveAgent(id: string): void {
  activeAgentId = id
  for (const [key, { button }] of agentButtons) button.setAttribute('aria-pressed', String(key === id))
  sessionDefaults?.selectAgent(id)
  toolsSettings?.selectAgent(id, agentFor(id)?.name)
}
function activateAgent(id: string): void {
  if (id !== activeAgentId && !canLeave()) return
  preferredAgentId = id
  try { if (selectedAgentKey) sessionStorage.setItem(selectedAgentKey, id) } catch { /* Optional selection. */ }
  updateActiveAgent(id)
  closeSidebar()
  workspace.selectAgent()
}
function filterAgents(): void {
  const query = searchInput.value.trim().toLocaleLowerCase()
  let mainVisible = false, otherVisible = false
  for (const [id, entry] of agentButtons) {
    const agent = agentFor(id)
    const matches = !query || `${agent?.name ?? ''} ${agent?.description ?? ''}`.toLocaleLowerCase().includes(query)
    entry.button.hidden = !matches
    if (matches) { if (entry.main) mainVisible = true; else otherVisible = true }
  }
  mainAgentSlot.hidden = !mainVisible
  otherAgentList.hidden = !otherVisible
  searchEmpty.hidden = !query || mainVisible || otherVisible
}
function showAgentSearch(show: boolean): void {
  searchField.hidden = !show
  searchToggle.setAttribute('aria-expanded', String(show))
  if (show) searchInput.focus()
  else { searchInput.value = ''; filterAgents() }
}
searchToggle.addEventListener('click', () => showAgentSearch(searchField.hidden), { signal: lifetime.signal })
searchInput.addEventListener('input', filterAgents, { signal: lifetime.signal })
searchInput.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); showAgentSearch(false); searchToggle.focus() }
}, { signal: lifetime.signal })
createAgentButton.disabled = !agentDirectory
createAgentButton.addEventListener('click', () => {
  if (!canLeave()) return
  const creating = agentDirectory?.create()
  revealSettings('agents')
  if (creating) root.querySelector<HTMLInputElement>('[data-agent-name]')?.focus()
}, { signal: lifetime.signal })
function renderAgentButtons(agents: readonly AgentView[]): void {
  const ids = new Set(agents.map(agent => agent.id))
  for (const [id, entry] of agentButtons) {
    if (ids.has(id)) continue
    entry.logo.dispose()
    entry.button.remove()
    agentButtons.delete(id)
    recentMessages.delete(id)
  }
  let nextOther = otherAgentList.firstElementChild
  agents.forEach((agent, index) => {
    const main = index === 0
    let entry = agentButtons.get(agent.id)
    if (entry?.main !== main) {
      entry?.logo.dispose()
      const button = entry?.button ?? document.createElement('button')
      button.replaceChildren()
      button.className = 'agent-nav-button'
      button.type = 'button'
      if (!entry) button.addEventListener('click', () => activateAgent(agent.id), { signal: lifetime.signal })
      const logo = createAgentLogo(button, { size: main ? 76 : 44 })
      const copy = document.createElement('span'), name = document.createElement('span'), preview = document.createElement('span')
      copy.className = 'agent-nav-copy'; name.className = 'agent-nav-name'; preview.className = 'agent-nav-preview'
      copy.append(name, preview); button.append(copy)
      entry = { button, logo, name, preview, main }
      agentButtons.set(agent.id, entry)
    }
    const { button, logo } = entry
    const name = agent.name || splitScopedId(agent.id)?.id || agent.id
    const label = main ? `主 Agent · ${name}` : name
    button.title = label
    button.setAttribute('aria-label', label)
    entry.name.textContent = name
    entry.preview.textContent = recentMessages.get(agent.id) || agent.description || '点击开始对话'
    logo.set({ name, logoShader: agent.logoShader })
    if (main) {
      if (mainAgentSlot.firstElementChild !== button) mainAgentSlot.append(button)
      if (nextOther === button) nextOther = otherAgentList.firstElementChild
    } else {
      if (nextOther !== button) otherAgentList.insertBefore(button, nextOther)
      nextOther = button.nextElementSibling
    }
  })
  filterAgents()
}
function receiveAgents(agents: readonly AgentView[]) {
  if (closed) return
  knownAgents = agents
  const own = agents.filter(agent => splitScopedId(agent.id)?.instanceId === selected?.instanceId)
  renderAgentButtons(own)
  updateActiveAgent(own.find(agent => agent.id === preferredAgentId)?.id ?? own[0]?.id ?? '')
  agentDirectory?.receiveAgents(own.map(agent => ({ ...agent, id: splitScopedId(agent.id)!.id })))
  workspace.refreshControls()
}
const unsubscribeAgents = api.subscribeList('/agents', values => receiveAgents(values as readonly AgentView[]))
function refreshAgentList() {
  if (!selected) return
  void api<readonly AgentView[]>('/agents').then(agents => {
    agentsSettled = true
    receiveAgents(agents)
  }).catch(error => {
    if (closed) return
    agentsSettled = true
    workspace.refreshControls()
    const notice = required<HTMLElement>('personal-agent--workspace-notice')
    notice.textContent = messageFor(error)
    notice.hidden = false
  })
}
refreshAgentList()
return {
  settingsState: () => settings.snapshot(), restoreSettings: () => settings.restore(), showSettingsBlocked: () => settings.showBlocked(),
  setActive(active) {
    if (!active) { agentDirectory?.pauseLogo(); settingsDialog.close() }
    workspace.setActive(active)
  },
  canLeave,
  async dispose() {
    closed = true; lifetime.abort(); settings.dispose(); settingsDialog.close(); unsubscribeAgents()
    for (const { logo } of agentButtons.values()) logo.dispose()
    agentButtons.clear()
    const workspaceExit = workspace.dispose(); models.dispose(); hostModels?.dispose()
    await Promise.all([workspaceExit, agentDirectory?.dispose(), modelsSettings?.dispose(), promptSettings?.dispose(), sessionDefaults?.dispose(), toolsSettings?.dispose(), unitsSettings?.dispose()])
    await api.dispose()
  },
}
}
