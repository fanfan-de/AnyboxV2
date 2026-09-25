/** A replaceable browser client of the public /api/v1 contract. No Harness or Nya imports. */
interface AgentView { readonly id: string }
interface TurnView { readonly input: string; readonly output: string }
interface SessionView {
  readonly id: string
  readonly agentId: string
  readonly createdAt: string
  readonly turns: readonly TurnView[]
}
type RunStatus = 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed'
interface RunView {
  readonly id: string
  readonly sessionId: string
  readonly input: string
  readonly status: RunStatus
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

const pendingKey = 'anybox.web.v1.pending'
let session: SessionView | undefined
let run: RunView | undefined
let pending: PendingSubmission | undefined
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
    'not-found': '会话或运行已不存在，可能是本机服务重启了。',
    conflict: '此会话已有运行，或同一请求编号对应了不同内容。',
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

function readPending(): PendingSubmission | undefined {
  try {
    const raw = sessionStorage.getItem(pendingKey)
    if (!raw) return undefined
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || !('sessionId' in value) || !('input' in value) ||
      !('idempotencyKey' in value) || typeof value.sessionId !== 'string' ||
      typeof value.input !== 'string' || typeof value.idempotencyKey !== 'string' ||
      ('runId' in value && value.runId !== undefined && typeof value.runId !== 'string')) return undefined
    return value as PendingSubmission
  } catch { return undefined }
}

function savePending(value: PendingSubmission | undefined): boolean {
  try {
    if (value) sessionStorage.setItem(pendingKey, JSON.stringify(value))
    else sessionStorage.removeItem(pendingKey)
    pending = value
    return true
  } catch {
    if (!value) pending = undefined
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

function render(): void {
  currentAgent.textContent = session?.agentId ?? '尚未创建'
  sessionIdLabel.textContent = session?.id ?? '选择 Agent 后开始'
  runStatus.textContent = run ? {
    running: '运行中', cancelling: '正在取消', completed: '已完成', cancelled: '已取消', failed: '运行失败',
  }[run.status] : pending ? busy ? '正在提交' : '等待重试' : session ? '准备就绪' : '待开始'
  transcript.replaceChildren()
  for (const turn of session?.turns ?? []) {
    addMessage('user', turn.input)
    addMessage('assistant', turn.output)
  }
  if (pending) addMessage('user', pending.input, true)
  emptyState.hidden = Boolean(session?.turns.length || pending)
  messageInput.disabled = !session || Boolean(pending) || busy
  sendButton.disabled = !session || busy || active(run)
  sendButton.textContent = pending && !run ? '重试提交 ↗' : '发送消息 ↗'
  cancelButton.hidden = !active(run)
  cancelButton.disabled = busy || run?.status === 'cancelling'
  newSessionButton.disabled = !agentsAvailable || busy || Boolean(pending)
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

async function finishRun(value: RunView): Promise<void> {
  run = value
  clearPoll()
  savePending(undefined)
  if (value.status === 'completed' && session) {
    const id = session.id
    try {
      const latest = await api<SessionView>(`/sessions/${encodeURIComponent(id)}`)
      if (session?.id === id) session = latest
    }
    catch (error) { showNotice(messageFor(error)) }
    if (session?.id !== id) return
    messageInput.value = ''
  } else {
    messageInput.value = value.input
    showNotice(value.status === 'cancelled' ? '运行已取消。可以修改消息后重新发送。' :
      value.errorCategory === 'credential-missing' ? '尚未配置 API Key。请在左侧“API Key 管理”中保存后重试。' :
      `运行失败：${value.error ?? '请稍后重试。'}`)
  }
  render()
}

async function acceptRun(value: RunView): Promise<void> {
  run = value
  if (pending) savePending({ ...pending, runId: value.id })
  render()
  if (active(value)) schedulePoll()
  else await finishRun(value)
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
    if (apiError(error) && error.status === 404) {
      savePending(undefined)
      run = undefined
    } else schedulePoll()
    render()
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
    if (session?.id !== submission.sessionId) return
    await acceptRun(accepted)
  } catch (error) {
    if (session?.id !== submission.sessionId) return
    showNotice(messageFor(error))
    if (apiError(error) && error.status === 404) {
      savePending(undefined)
      session = undefined
      location.hash = ''
    } else if (apiError(error) && error.status < 500) {
      messageInput.value = submission.input
      savePending(undefined)
    }
  } finally { busy = false; render() }
}

async function loadRoute(): Promise<void> {
  const version = ++routeVersion
  clearPoll()
  run = undefined
  const match = /^#\/sessions\/([^/]+)$/.exec(location.hash)
  if (!match) { session = undefined; pending = undefined; render(); return }
  let id: string
  try { id = decodeURIComponent(match[1]) } catch { showNotice('会话地址无效。'); return }
  try {
    const loaded = await api<SessionView>(`/sessions/${encodeURIComponent(id)}`)
    if (version !== routeVersion) return
    session = loaded
    pending = readPending()
    if (pending?.sessionId !== loaded.id) pending = undefined
    render()
    if (pending?.runId) {
      try { await acceptRun(await api<RunView>(`/runs/${encodeURIComponent(pending.runId)}`)) }
      catch (error) { showNotice(messageFor(error)); await submitPending() }
    } else if (pending) await submitPending()
  } catch (error) {
    if (version !== routeVersion) return
    session = undefined
    run = undefined
    savePending(undefined)
    showNotice(messageFor(error))
    render()
  }
}

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
  if (busy || pending || !agentSelect.value) return
  busy = true
  showNotice()
  render()
  void api<SessionView>('/sessions', { agentId: agentSelect.value }).then(created => {
    session = created
    run = undefined
    savePending(undefined)
    messageInput.value = ''
    location.hash = `#/sessions/${encodeURIComponent(created.id)}`
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

void api<readonly AgentView[]>('/agents').then(agents => {
  agentSelect.replaceChildren(...agents.map(agent => {
    const option = document.createElement('option')
    option.value = agent.id
    option.textContent = agent.id
    return option
  }))
  agentsAvailable = agents.length > 0
  render()
  return loadRoute()
}).catch(error => showNotice(messageFor(error)))
void refreshCredentialSettings()
