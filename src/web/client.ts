/** A replaceable browser client of the public /api/v1 contract. No Harness or Nya imports. */
interface AgentView { readonly id: string }
interface TurnView { readonly input: string; readonly output: string }
interface SessionView {
  readonly id: string
  readonly projectId: string
  readonly agentId: string
  readonly createdAt: string
  readonly turns: readonly TurnView[]
}
type RunStatus = 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed' | 'interrupted'
interface ProjectView {
  readonly id: string
  readonly path: string
  readonly name: string
  readonly available: boolean
}
interface RunView {
  readonly id: string
  readonly sessionId: string
  readonly input: string
  readonly status: RunStatus
  readonly createdAt: string
  readonly output?: string
  readonly error?: string
  readonly errorCategory?: string
}
interface PendingSubmission {
  readonly sessionId: string
  readonly input: string
  readonly idempotencyKey: string
  readonly runId?: string
}
interface ApiError extends Error { readonly status: number; readonly code: string }
interface CredentialView {
  readonly id: string
  readonly label: string
  readonly category: string
  readonly configured: boolean
}

function required<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (!found) throw new Error(`missing element ${id}`)
  return found as T
}

const agentSelect = required<HTMLSelectElement>('agent-select')
const projectForm = required<HTMLFormElement>('project-form')
const projectPath = required<HTMLInputElement>('project-path')
const projectList = required<HTMLElement>('project-list')
const sessionList = required<HTMLElement>('session-list')
const newSessionButton = required<HTMLButtonElement>('new-session')
const currentAgent = required<HTMLElement>('current-agent')
const sessionIdLabel = required<HTMLElement>('session-id')
const runStatus = required<HTMLElement>('run-status')
const notice = required<HTMLElement>('notice')
const transcript = required<HTMLElement>('transcript')
const emptyState = required<HTMLElement>('empty-state')
const composeForm = required<HTMLFormElement>('compose-form')
const messageInput = required<HTMLTextAreaElement>('message-input')
const sendButton = required<HTMLButtonElement>('send-message')
const cancelButton = required<HTMLButtonElement>('cancel-run')
const keyForm = required<HTMLFormElement>('key-form')
const keySelect = required<HTMLSelectElement>('key-select')
const keyInput = required<HTMLInputElement>('key-input')
const keyStatus = required<HTMLElement>('key-status')
const keyNotice = required<HTMLElement>('key-notice')
const saveKeyButton = required<HTMLButtonElement>('save-key')
const deleteKeyButton = required<HTMLButtonElement>('delete-key')

const pendingKey = 'anybox.web.v2.pending'
let projects: readonly ProjectView[] = []
let project: ProjectView | undefined
let sessions: readonly SessionView[] = []
let runs: readonly RunView[] = []
let session: SessionView | undefined
let run: RunView | undefined
let pending: PendingSubmission | undefined
let pendingBySession: Record<string, PendingSubmission> = {}
let busy = false
let agentsAvailable = false
let pollTimer: number | undefined
let routeVersion = 0
let credentials: readonly CredentialView[] = []
let keyBusy = false
let credentialLoadError: string | undefined

function apiError(error: unknown): error is ApiError {
  return error instanceof Error && 'status' in error && 'code' in error
}

async function api<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
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
    'not-found': '未找到项目、会话或运行。',
    conflict: '此会话已有运行，或同一请求编号对应了不同内容。',
    'project-unavailable': '项目目录不可访问。历史仍可查看，请检查目录路径。',
    'service-unavailable': '服务暂时不可用，请稍后重试。',
    'credential-unavailable': '无法访问系统凭据库，请稍后重试。',
  }[error.code] ?? '请求未能完成，请重试。'
}

function showNotice(message?: string): void {
  notice.hidden = !message
  notice.textContent = message ?? ''
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

function readPending(): Record<string, PendingSubmission> {
  try {
    const raw = sessionStorage.getItem(pendingKey)
    const value: unknown = raw ? JSON.parse(raw) : {}
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const found: Record<string, PendingSubmission> = {}
    for (const [id, entry] of Object.entries(value)) {
      if (!entry || typeof entry !== 'object' || !('sessionId' in entry) ||
        !('input' in entry) || !('idempotencyKey' in entry) ||
        entry.sessionId !== id || typeof entry.input !== 'string' ||
        typeof entry.idempotencyKey !== 'string' ||
        ('runId' in entry && entry.runId !== undefined && typeof entry.runId !== 'string')) continue
      found[id] = entry as PendingSubmission
    }
    return found
  } catch { return {} }
}

function savePending(value: PendingSubmission | undefined): boolean {
  if (!session) return false
  const next = { ...pendingBySession }
  if (value) next[session.id] = value
  else delete next[session.id]
  try {
    sessionStorage.setItem(pendingKey, JSON.stringify(next))
    pendingBySession = next
    pending = value
    return true
  } catch {
    showNotice('浏览器无法保存待提交信息，请启用此页面的会话存储后重试。')
    return false
  }
}

function active(value: RunView | undefined): boolean {
  return value?.status === 'running' || value?.status === 'cancelling'
}

function addMessage(role: 'user' | 'assistant', content: string, isPending = false): void {
  const item = document.createElement('div')
  item.className = `message ${role}${isPending ? ' pending' : ''}`
  const label = document.createElement('span')
  label.className = 'message-label'
  label.textContent = role === 'user' ? '你' : 'Agent'
  const text = document.createElement('span')
  text.textContent = content
  item.append(label, text)
  transcript.append(item)
}

function renderNavigation(): void {
  projectList.replaceChildren(...projects.map(item => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = item.id === project?.id ? 'selected' : ''
    button.dataset.projectId = item.id
    button.textContent = item.name
    button.title = item.path
    const detail = document.createElement('small')
    detail.textContent = item.available ? item.path : `${item.path} · 不可访问`
    button.append(detail)
    return button
  }))
  sessionList.replaceChildren(...sessions.map(item => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = item.id === session?.id ? 'selected' : ''
    button.dataset.sessionId = item.id
    button.textContent = `会话 · ${item.id.slice(0, 8)}`
    return button
  }))
}

function render(): void {
  renderNavigation()
  currentAgent.textContent = session?.agentId ?? '尚未创建'
  sessionIdLabel.textContent = session?.id ?? (project ? '选择或创建会话' : '先添加项目')
  runStatus.textContent = run ? {
    running: '运行中', cancelling: '正在取消', completed: '已完成',
    cancelled: '已取消', failed: '运行失败', interrupted: '意外中断',
  }[run.status] : pending ? busy ? '正在提交' : '等待重试' : session ? '准备就绪' : '待开始'
  transcript.replaceChildren()
  for (const item of runs) {
    addMessage('user', item.input)
    if (item.status === 'completed') addMessage('assistant', item.output ?? '')
    else if (item.status === 'failed') addMessage('assistant', `运行失败：${item.error ?? '未知错误'}`)
    else if (item.status === 'cancelled') addMessage('assistant', '运行已取消')
    else if (item.status === 'interrupted') addMessage('assistant', '应用异常退出，运行已中断')
  }
  if (pending && !runs.some(item => item.id === pending?.runId)) addMessage('user', pending.input, true)
  emptyState.hidden = Boolean(runs.length || pending)
  messageInput.disabled = !session || Boolean(pending) || busy
  sendButton.disabled = !session || busy || active(run)
  sendButton.textContent = pending ? '重试提交 ↗' : '发送消息 ↗'
  cancelButton.hidden = !active(run)
  cancelButton.disabled = busy || run?.status === 'cancelling'
  newSessionButton.disabled = !project?.available || !agentsAvailable || busy
  transcript.scrollTop = transcript.scrollHeight
}

function clearPoll(): void {
  if (pollTimer !== undefined) window.clearTimeout(pollTimer)
  pollTimer = undefined
}

function schedulePoll(): void {
  clearPoll()
  if (active(run)) pollTimer = window.setTimeout(() => { void refreshRun() }, document.hidden ? 5000 : 1200)
}

function replaceRun(value: RunView): void {
  runs = Object.freeze([...runs.filter(item => item.id !== value.id), value]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)))
  run = value
  render()
}

async function acceptRun(value: RunView): Promise<void> {
  replaceRun(value)
  if (pending) savePending({ ...pending, runId: value.id })
  if (active(value)) { schedulePoll(); return }
  clearPoll()
  savePending(undefined)
  if (value.status === 'completed') messageInput.value = ''
  else {
    messageInput.value = value.input
    if (value.errorCategory === 'credential-missing') {
      showNotice('尚未配置 API Key。请在左侧“API Key 管理”中保存后重试。')
    }
  }
  render()
}

async function refreshRun(): Promise<void> {
  if (!run || !active(run)) return
  const id = run.id
  try {
    const latest = await api<RunView>(`/runs/${encodeURIComponent(id)}`)
    if (run?.id !== id) return
    await acceptRun(latest)
  } catch (error) {
    showNotice(messageFor(error))
    schedulePoll()
  }
}

async function submitPending(): Promise<void> {
  if (!pending || busy) return
  const submission = pending
  busy = true
  showNotice()
  render()
  try {
    const accepted = await api<RunView>(`/sessions/${encodeURIComponent(submission.sessionId)}/runs`, {
      input: submission.input, idempotencyKey: submission.idempotencyKey,
    })
    if (session?.id === submission.sessionId) await acceptRun(accepted)
  } catch (error) {
    if (session?.id !== submission.sessionId) return
    showNotice(messageFor(error))
    if (apiError(error) && error.status < 500 && error.code !== 'project-unavailable') {
      messageInput.value = submission.input
      savePending(undefined)
    }
  } finally { busy = false; render() }
}

async function refreshProjects(): Promise<void> {
  projects = await api<readonly ProjectView[]>('/projects')
  if (project) project = projects.find(item => item.id === project?.id)
  render()
}

async function loadRoute(): Promise<void> {
  const version = ++routeVersion
  showNotice()
  clearPoll()
  run = undefined
  session = undefined
  pending = undefined
  runs = []
  sessions = []
  const match = /^#\/projects\/([^/]+)(?:\/sessions\/([^/]+))?$/.exec(location.hash)
  if (!match) { project = undefined; render(); return }
  try {
    const projectId = decodeURIComponent(match[1])
    const sessionId = match[2] ? decodeURIComponent(match[2]) : undefined
    project = projects.find(item => item.id === projectId)
    if (!project) { showNotice('项目不存在。'); render(); return }
    sessions = await api<readonly SessionView[]>(`/projects/${encodeURIComponent(projectId)}/sessions`)
    if (version !== routeVersion) return
    if (sessionId) {
      const loaded = await api<SessionView>(`/sessions/${encodeURIComponent(sessionId)}`)
      if (version !== routeVersion) return
      if (loaded.projectId !== projectId) throw new Error('session belongs to another project')
      session = loaded
      runs = await api<readonly RunView[]>(`/sessions/${encodeURIComponent(sessionId)}/runs`)
      if (version !== routeVersion) return
      run = [...runs].reverse().find(active) ?? runs.at(-1)
      pending = pendingBySession[sessionId]
      if (pending?.runId) {
        let existing = runs.find(item => item.id === pending?.runId)
        if (!existing) {
          try { existing = await api<RunView>(`/runs/${encodeURIComponent(pending.runId)}`) }
          catch (error) { if (!apiError(error) || error.status !== 404) throw error }
        }
        if (version !== routeVersion) return
        if (existing?.sessionId === sessionId) await acceptRun(existing)
        else await submitPending()
      } else if (pending) await submitPending()
      schedulePoll()
    }
    render()
  } catch (error) {
    if (version !== routeVersion) return
    showNotice(messageFor(error))
    render()
  }
}

projectForm.addEventListener('submit', event => {
  event.preventDefault()
  const path = projectPath.value.trim()
  if (!path) return
  void api<ProjectView>('/projects', { path }).then(async opened => {
    projectPath.value = ''
    await refreshProjects()
    location.hash = `#/projects/${encodeURIComponent(opened.id)}`
  }).catch(error => showNotice(messageFor(error)))
})

projectList.addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-project-id]')
  if (button?.dataset.projectId) location.hash = `#/projects/${encodeURIComponent(button.dataset.projectId)}`
})

sessionList.addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-session-id]')
  if (project && button?.dataset.sessionId) {
    location.hash = `#/projects/${encodeURIComponent(project.id)}/sessions/${encodeURIComponent(button.dataset.sessionId)}`
  }
})

composeForm.addEventListener('submit', event => {
  event.preventDefault()
  if (!session || busy || active(run)) return
  if (!pending) {
    const input = messageInput.value.trim()
    if (!input) { showNotice('请输入消息。'); return }
    if (!savePending({ sessionId: session.id, input, idempotencyKey: crypto.randomUUID() })) return
    run = undefined
  }
  void submitPending()
})

messageInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    composeForm.requestSubmit()
  }
})

newSessionButton.addEventListener('click', () => {
  if (busy || !project?.available || !agentSelect.value) return
  busy = true
  render()
  void api<SessionView>('/sessions', { projectId: project.id, agentId: agentSelect.value }).then(created => {
    location.hash = `#/projects/${encodeURIComponent(created.projectId)}/sessions/${encodeURIComponent(created.id)}`
  }).catch(error => showNotice(messageFor(error))).finally(() => { busy = false; render() })
})

cancelButton.addEventListener('click', () => {
  if (!run || !active(run) || busy) return
  const id = run.id
  busy = true
  render()
  void api<RunView>(`/runs/${encodeURIComponent(id)}/cancel`, {}).then(value => acceptRun(value))
    .catch(error => showNotice(messageFor(error))).finally(() => { busy = false; render() })
})

window.addEventListener('hashchange', () => { void loadRoute() })
document.addEventListener('visibilitychange', () => {
  if (active(run)) {
    if (document.hidden) schedulePoll()
    else { clearPoll(); void refreshRun() }
  }
})

pendingBySession = readPending()
void Promise.all([
  api<readonly AgentView[]>('/agents'),
  api<readonly ProjectView[]>('/projects'),
]).then(([agents, loadedProjects]) => {
  agentSelect.replaceChildren(...agents.map(agent => {
    const option = document.createElement('option')
    option.value = agent.id
    option.textContent = agent.id
    return option
  }))
  agentsAvailable = agents.length > 0
  projects = loadedProjects
  render()
  return loadRoute()
}).catch(error => showNotice(messageFor(error)))
void refreshCredentialSettings()
