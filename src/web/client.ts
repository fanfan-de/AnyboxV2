/** Browser bootstrap: global settings plus independently owned conversation panels. */
import { setupPromptSettings } from './prompt-client.js'
import { setupWorkspace } from './workspace-client.js'
import type { AgentView, ApiError, CredentialView } from './client-types.js'

function required<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (!found) throw new Error(`missing element ${id}`)
  return found as T
}
const agentSelect = required<HTMLSelectElement>('agent-select')
const settingsDialog = required<HTMLDialogElement>('settings-dialog')
const openSettingsButton = required<HTMLButtonElement>('open-settings')
const closeSettingsButton = required<HTMLButtonElement>('close-settings')
const keyForm = required<HTMLFormElement>('key-form')
const keySelect = required<HTMLSelectElement>('key-select')
const keyInput = required<HTMLInputElement>('key-input')
const keyStatus = required<HTMLElement>('key-status')
const keyNotice = required<HTMLElement>('key-notice')
const saveKeyButton = required<HTMLButtonElement>('save-key')
const deleteKeyButton = required<HTMLButtonElement>('delete-key')


let credentials: readonly CredentialView[] = []
let keyBusy = false
let credentialLoadError: string | undefined
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
    throw Object.assign(new Error(code), { status: response.status, code }) as ApiError
  }
  return data as T
}

function messageFor(error: unknown): string {
  if (!apiError(error)) return '无法连接本机服务。请检查服务是否仍在运行，然后重试。'
  return {
    'invalid-input': '输入无效，请检查内容后重试。',
    'invalid-json': '请求格式无效，请重试。',
    'not-found': '未找到请求的项目、会话、运行或 Prompt。',
    conflict: '同一请求编号对应了不同内容或对话起点。',
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

function renderCredentialSettings(): void {
  const selected = credentials.find(item => item.id === keySelect.value)
  keyStatus.textContent = credentialLoadError ?? (selected ? `${selected.category} · ${selected.configured ? '已配置' : '尚未配置'}` :
    credentials.length ? '请选择服务。' : '当前没有可管理的服务。'
  )
  keySelect.disabled = keyBusy || credentials.length === 0
  keyInput.disabled = keyBusy || !selected
  saveKeyButton.disabled = keyBusy || !selected
  deleteKeyButton.disabled = keyBusy || !selected?.configured
}

async function refreshCredentialSettings(): Promise<void> {
  try {
    const selectedId = keySelect.value
    credentials = await api<readonly CredentialView[]>('/credentials')
    credentialLoadError = undefined
    keySelect.replaceChildren(...credentials.map(item => {
      const option = document.createElement('option')
      option.value = item.id
      option.textContent = `${item.category} · ${item.label}`
      return option
    }))
    if (credentials.some(item => item.id === selectedId)) keySelect.value = selectedId
    renderCredentialSettings()
  } catch (error) { credentialLoadError = messageFor(error); renderCredentialSettings() }
}

openSettingsButton.addEventListener('click', () => { settingsDialog.showModal() })
closeSettingsButton.addEventListener('click', () => { settingsDialog.close() })
settingsDialog.addEventListener('close', () => {
  keyInput.value = ''
  keyNotice.hidden = true
})

keySelect.addEventListener('change', () => {
  keyInput.value = ''
  keyNotice.hidden = true
  renderCredentialSettings()
})

keyForm.addEventListener('submit', event => {
  event.preventDefault()
  const id = keySelect.value
  const key = keyInput.value
  if (!id || !key.trim() || keyBusy) return
  keyBusy = true
  renderCredentialSettings()
  keyNotice.hidden = true
  void api<CredentialView>(`/credentials/${encodeURIComponent(id)}`, { key }).then(() => {
    keyInput.value = ''
    keyNotice.textContent = '已保存。该服务的后续调用会读取新 Key。'
    keyNotice.hidden = false
    return refreshCredentialSettings()
  }).catch(error => { keyNotice.textContent = messageFor(error); keyNotice.hidden = false })
    .finally(() => { keyBusy = false; renderCredentialSettings() })
})

deleteKeyButton.addEventListener('click', () => {
  const id = keySelect.value
  if (!id || keyBusy) return
  keyBusy = true
  renderCredentialSettings()
  keyNotice.hidden = true
  void api<CredentialView>(`/credentials/${encodeURIComponent(id)}/delete`, {}).then(() => {
    keyNotice.textContent = '已删除。该服务的后续调用需要重新配置 Key。'
    keyNotice.hidden = false
    return refreshCredentialSettings()
  }).catch(error => { keyNotice.textContent = messageFor(error); keyNotice.hidden = false })
    .finally(() => { keyBusy = false; renderCredentialSettings() })
})


const workspace = setupWorkspace(api, messageFor, () => agentSelect.value)
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
void refreshCredentialSettings()
setupPromptSettings(api, messageFor)
window.addEventListener('pagehide', event => { if (!event.persisted) workspace.dispose() })
