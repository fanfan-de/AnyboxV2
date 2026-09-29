/** Browser bootstrap: global settings plus independently owned conversation panels. */
import { setupPromptSettings } from './prompt-client.js'
import { setupWorkspace } from './workspace-client.js'
import type { AgentView, ApiError } from './client-types.js'
import { createModelsCatalog, setupModelsSettings } from './models-client.js'

function required<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (!found) throw new Error(`missing element ${id}`)
  return found as T
}
const agentSelect = required<HTMLSelectElement>('agent-select')
const settingsDialog = required<HTMLDialogElement>('settings-dialog')
const openSettingsButton = required<HTMLButtonElement>('open-settings')
const closeSettingsButton = required<HTMLButtonElement>('close-settings')
const sidebar = required<HTMLElement>('workspace-sidebar')
const sidebarToggle = required<HTMLButtonElement>('toggle-sidebar')
const sidebarToggleLabel = required<HTMLElement>('sidebar-toggle-label')
const sidebarClose = required<HTMLButtonElement>('close-sidebar')
const sidebarBackdrop = required<HTMLButtonElement>('sidebar-backdrop')
const sessionWorkspace = required<HTMLElement>('session-workspace')
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
required('show-workspace').addEventListener('click', () => {
  if (narrowWindow.matches) sidebarOpen = true
  else sidebarCollapsed = false
  renderSidebar()
  focusSidebar()
})
const helpDialog = required<HTMLDialogElement>('help-dialog')
required('open-help').addEventListener('click', () => { closeSidebar(); helpDialog.showModal() })
sidebar.addEventListener('click', event => {
  const action = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.session-open, #new-session, [data-create-project-session]') : null
  // The accepted new-session click disables its button synchronously; inspect it before its handler runs.
  if (action && !action.disabled) queueMicrotask(closeSidebar)
}, { capture: true })
document.addEventListener('keydown', event => {
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
document.addEventListener('focusin', event => {
  if (narrowWindow.matches && sidebarOpen && event.target instanceof Node && !sidebar.contains(event.target)) focusSidebar()
})
narrowWindow.addEventListener('change', () => {
  const focused = document.activeElement
  const hadSidebarFocus = sidebarOpen || sidebar.contains(focused)
  sidebarOpen = false
  renderSidebar()
  if (hadSidebarFocus && (sidebar.inert || focused === document.body ||
      !(focused instanceof HTMLElement) || !focused.getClientRects().length)) sidebarToggle.focus()
})
renderSidebar()


function apiError(error: unknown): error is ApiError {
  return error instanceof Error && 'status' in error && 'code' in error
}

async function api<T>(path: string, body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store', signal,
  })
  const data: unknown = await response.json()
  if (!response.ok) {
    const code = typeof data === 'object' && data !== null && 'error' in data &&
      typeof data.error === 'object' && data.error !== null && 'code' in data.error &&
      typeof data.error.code === 'string' ? data.error.code : 'internal-error'
    const fileIndex = data && typeof data === 'object' && 'error' in data && data.error && typeof data.error === 'object' && 'fileIndex' in data.error && Number.isSafeInteger(data.error.fileIndex) ? Number(data.error.fileIndex) : undefined
    throw Object.assign(new Error(code), { status: response.status, code, ...(fileIndex === undefined ? {} : { fileIndex }) }) as ApiError
  }
  return data as T
}

function messageFor(error: unknown): string {
  if (!apiError(error)) return '无法连接本机服务。请检查服务是否仍在运行，然后重试。'
  return {
    'invalid-input': '输入无效，请检查内容后重试。',
    'file-invalid': '文件路径或引用无效，请重新选择项目内的普通文件。',
    'file-missing': '文件或快照不存在，或不属于此会话。',
    'file-unavailable': '文件暂时无法读取，请检查权限后重试。',
    'file-unsupported': '只支持普通 UTF-8 文本文件。',
    'file-too-large': '源文件最多 10 MiB；每个引用最多 64 KiB，每轮合计 256 KiB。请选择较小的行范围。',
    'file-range-invalid': '行范围无效或超出文件行数，请重新选择。',
    'file-changed': '读取期间文件发生变化，请重试。',
    'file-expired': '文件快照已过期，请更新为当前文件后重新发送。',
    'file-corrupt': '文件快照损坏，无法使用该历史内容。',
    'file-preparation-conflict': '同一快照准备编号对应了不同内容，请重新发送。',
    'file-cancelled': '文件读取已取消。',
    'file-cleanup-failed': '文件资源清理失败，请重新启动服务。',
    'image-required': '请上传 PNG、JPEG 或 WebP 图片。',
    'asset-invalid': '图片信息无效，请重新添加。',
    'asset-too-large': '每张图片最多 10 MiB，每条消息最多 8 张、合计 20 MiB，图片宽高不能超过 4096 像素。',
    'asset-unsupported': '只支持静态 PNG、JPEG 和 WebP 图片。',
    'asset-expired': '草稿图片已过期，请重新添加。',
    'asset-missing': '图片不存在或不属于此会话，请重新添加。',
    'asset-corrupt': '图片无法读取，请重新添加有效图片。',
    'asset-unavailable': '本地图片存储暂不可用，请稍后重试。',
    'asset-cancelled': '图片上传已取消。',
    'asset-cleanup-failed': '图片资源未能正常清理，请重新启动服务。',
    'invalid-config': '模型配置无效，请检查地址、参数范围与能力声明。',
    'capability-unsupported': '所选模型的能力或推理档位不满足请求，请检查能力声明与参数。',
    'model-required': '请先选择一个可用模型。',
    'model-unavailable': '所选模型不可用，请检查提供方、密钥与模型配置。',
    'protocol-unavailable': '该协议当前不可用，请检查提供方配置。',
    'session-archived': '会话已归档，请先恢复后再继续。',
    'session-has-active-runs': '会话仍有运行未结束，请等待完成，或取消并等待清理后再归档。',
    'legacy-session-readonly': '旧版文本会话仅供查看，请新建原生会话。',
    'protocol-mismatch': '此会话已固定协议，请新建会话使用其他协议。',
    'history-incompatible': '所选模型、连接或参数无法完整恢复此分支的原生历史，请使用原配置或新建会话。',
    'native-history-unavailable': '原生历史目前无法恢复；已有记录仍可查看。',
    'invalid-history': '此分支的原生历史未通过完整性校验，无法继续。',
    'view-unavailable': '此运行的协议展示暂不可用。',
    'credential-missing': '此提供方尚未配置 API Key。',
    'unavailable': '此模型或提供方已停用，请选择其他模型。',
    'provider-failure': '提供方请求失败，请检查地址、Key 和提供方状态。',
    'authentication': '提供方认证失败，请检查 API Key。',
    'timeout': '远端请求超时，请稍后重试。',
    busy: '已有请求正在进行，请等待完成后重试。',
    'invalid-response': '远端数据未通过校验，请稍后重试。',
    'storage-unavailable': '本地数据暂时无法保存，请检查存储位置。',
    cancelled: '请求已取消。',
    'cleanup-failure': '请求资源未能正常退出，请重新装配服务后重试。',
    'invalid-json': '请求格式无效，请重试。',
    'not-found': '未找到请求的项目、会话、运行或 Prompt。',
    conflict: '配置已被修改，或同一请求编号对应了不同内容。请先保留你的修改，再重新读取。',
    'node-not-found': '对话节点不存在，请重新选择位置。',
    'project-unavailable': '项目目录不可访问。历史仍可查看，请检查目录路径。',
    'service-unavailable': '服务暂时不可用，请稍后重试。',
    'credential-unavailable': '无法访问系统凭据库，请稍后重试。',
    'picker-busy': '目录选择窗口已打开，请先完成当前选择。',
    'picker-unsupported': '当前系统暂不支持原生目录选择。',
    'picker-unavailable': '无法打开目录选择窗口，请稍后重试。',
    'prompt-conflict': '草稿已被其他页面修改。请先复制保留你的内容，再点击“放弃修改 / 重新读取”。',
    'prompt-publication-conflict': '草稿已发布或在发布期间发生变化，请重新读取后再操作。',
    'prompt-forbidden': '当前本机用户无权管理这个 Prompt 或 Agent。',
    'request-too-large': '内容过长，请缩短后重试。',
  }[error.code] ?? '请求未能完成，请重试。'
}

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
  required('settings-content').scrollTop = 0
}
for (const button of settingsNavigation) button.addEventListener('click', () => {
  selectSettingsSection(button.dataset.settingsSection as SettingsSection)
})
openSettingsButton.addEventListener('click', () => { closeSidebar(); settingsDialog.showModal() })
closeSettingsButton.addEventListener('click', () => { settingsDialog.close() })
settingsDialog.addEventListener('close', () => {
  if (!document.querySelector('dialog[open]') && !openSettingsButton.getClientRects().length) sidebarToggle.focus()
})

const models = createModelsCatalog(api, messageFor)
setupModelsSettings(api, messageFor, models)
const workspace = setupWorkspace(api, messageFor, () => agentSelect.value, models)
void api<readonly AgentView[]>('/agents').then(agents => {
  agentSelect.replaceChildren(...agents.map(agent => {
    const option = document.createElement('option')
    option.value = agent.id
    option.textContent = agent.id
    return option
  }))
  agentSelect.disabled = agents.length === 0
  workspace.refreshControls()
}).catch(error => {
  const notice = required<HTMLElement>('workspace-notice')
  notice.textContent = messageFor(error)
  notice.hidden = false
})
agentSelect.addEventListener('change', workspace.refreshControls)
setupPromptSettings(api, messageFor)
window.addEventListener('pagehide', event => { if (!event.persisted) workspace.dispose() })
