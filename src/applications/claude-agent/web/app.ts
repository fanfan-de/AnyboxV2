import type { ApplicationActivation, ApplicationWebContext, MountedApplication } from '../../../host/web/application-contracts.js'
import type { ProductView } from '../../../host/applications/contracts.js'
import type { ApprovalView, EnvironmentView, HistoryMessageView, RunChangedView, RunEventFrameView, RunLiveView, RunView, ThreadMessagesView, ThreadView } from '../core/view.js'
import { applyRunEvent, emptyRunView } from '../core/events.js'
import { createDeviceClient, readDevices } from './client.js'
import type { DeviceClient, DeviceConnection } from './client.js'
import { deviceLabel, displayItems, formatRoute, formatUsage, messageFor, parseRoute, runStatusLabels, selectDevice } from './state.js'
import { el, renderApproval, syncTranscript } from './view.js'

const selectedKey = 'anybox.claude-agent.selected'
const efforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const app = '/apps/claude-agent'
const activeStatus = (run: RunView | undefined) => run?.status === 'running' || run?.status === 'cancelling'

/** One device, one thread at a time. The browser is a view over the execution device; it never owns runs or transcripts. */
export async function mount(container: HTMLElement, context: ApplicationWebContext): Promise<MountedApplication> {
  const lifetime = new AbortController(), abort = () => lifetime.abort()
  context.signal.addEventListener('abort', abort, { once: true }); if (context.signal.aborted) abort()
  const deviceSelect = el('select', { id: context.domId('device'), 'aria-label': '执行设备' })
  const deviceStatus = el('p', { class: 'ca-device-status', role: 'status' })
  const startButton = el('button', { type: 'button', class: 'ca-start', text: '启动 Claude Agent', hidden: true })
  const pathInput = el('input', { name: 'projectPath', required: true, placeholder: '项目目录绝对路径', 'aria-label': '项目目录绝对路径', autocomplete: 'off', id: context.domId('project-path') })
  const titleInput = el('input', { name: 'title', placeholder: '标题（可选）', 'aria-label': '标题', autocomplete: 'off' })
  const newThread = el('form', { class: 'ca-new-thread' }, pathInput, titleInput, el('button', { type: 'submit', class: 'primary-button', text: '新建线程' }))
  const threadList = el('ul', { class: 'ca-thread-list' })
  const title = el('strong', { class: 'ca-thread-title', text: '选择或新建一个线程' }), path = el('small', { class: 'ca-thread-path' }), status = el('span', { class: 'ca-run-status' })
  const notice = el('p', { class: 'ca-notice notice', role: 'alert', hidden: true })
  const transcript = el('div', { class: 'ca-transcript', 'aria-live': 'polite' })
  const approvalsPanel = el('section', { class: 'ca-approvals', hidden: true, 'aria-label': '待处理请求' })
  const prompt = el('textarea', { name: 'prompt', rows: '3', placeholder: '输入提示词。Enter 发送，Shift+Enter 换行', 'aria-label': '提示词', id: context.domId('prompt') })
  const model = el('input', { name: 'model', placeholder: '模型（可选）', 'aria-label': '模型', autocomplete: 'off' })
  const effort = el('select', { name: 'effort', 'aria-label': '思考强度' }, el('option', { value: '', text: '默认强度' }), ...efforts.map(value => el('option', { value, text: value })))
  const send = el('button', { type: 'submit', class: 'primary-button', text: '发送' })
  const cancel = el('button', { type: 'button', class: 'ca-cancel', text: '取消', hidden: true })
  const composer = el('form', { class: 'ca-composer' }, prompt, el('div', { class: 'ca-composer-row' }, model, effort, send, cancel))
  const usage = el('footer', { class: 'ca-usage' })
  container.replaceChildren(el('section', { class: 'claude-agent-app' },
    el('aside', { class: 'ca-sidebar' },
      el('header', { class: 'ca-sidebar-head' }, el('h1', { text: 'Claude Agent' }), el('label', { class: 'ca-device', for: deviceSelect.id }, el('span', { text: '执行设备' }), deviceSelect), deviceStatus, startButton),
      newThread, el('nav', { class: 'ca-threads', 'aria-label': '线程' }, threadList), el('footer', { class: 'ca-powered', text: 'Powered by Claude' })),
    el('main', { class: 'ca-main' }, el('header', { class: 'ca-thread-head' }, title, path, status), notice, transcript, approvalsPanel, composer, usage)))

  let devices: readonly DeviceConnection[] = [], localInstanceId: string | null = null, client: DeviceClient | undefined
  let threads: readonly ThreadView[] = [], thread: ThreadView | undefined
  let history: readonly HistoryMessageView[] = [], runs: readonly RunView[] = [], current: RunView | undefined, live: RunLiveView | undefined
  let pending: readonly ApprovalView[] = [], subscription: { close(): void } | undefined
  let submitting = false, disposed = false, viewRefresh: Promise<void> | undefined, draft: { prompt: string; key: string } | undefined
  const show = (message = '') => { notice.textContent = message; notice.hidden = !message }
  const remember = (id: string) => { try { sessionStorage.setItem(selectedKey, id) } catch { /* optional */ } }
  const remembered = () => { try { return sessionStorage.getItem(selectedKey) } catch { return null } }
  const route = () => parseRoute(context.route.read())
  const navigate = (next: { hostId?: string; threadId?: string }, replace = false) => { const value = formatRoute(next); if (context.route.read() !== value) context.route.navigate(value, replace) }
  const guard = <T>(work: () => Promise<T>): Promise<T | undefined> => work().catch(error => { if (!disposed && !lifetime.signal.aborted) show(messageFor(error)); return undefined })

  const render = () => {
    if (disposed) return
    title.textContent = thread ? thread.title : '选择或新建一个线程'
    path.textContent = thread ? thread.projectPath : ''
    status.textContent = current ? runStatusLabels[current.status] ?? current.status : ''
    status.dataset.status = current?.status ?? ''
    const active = activeStatus(current)
    syncTranscript(transcript, displayItems(history, active ? live : undefined, active ? current?.prompt : undefined))
    if (active || !thread) transcript.scrollTop = transcript.scrollHeight
    approvalsPanel.hidden = pending.length === 0
    // Rebuild the forms only when the pending set changes, so streaming events never wipe a half-entered answer.
    const approvalKey = pending.map(approval => approval.id).join('\n')
    if (approvalsPanel.dataset.approvals !== approvalKey) {
      approvalsPanel.dataset.approvals = approvalKey
      approvalsPanel.replaceChildren(...pending.map(approval => renderApproval(approval, { decide: (view, decision, answers) => void decide(view, decision, answers) }, context.domId)))
      const focus = approvalsPanel.querySelector<HTMLElement>('[data-default-to-no="true"] button:last-of-type')
      if (focus && document.activeElement === document.body) focus.focus()
    }
    cancel.hidden = !active
    send.disabled = !thread || !client || active || submitting
    prompt.disabled = !thread || !client
    const finished = current && !active && current.result ? current : [...runs].reverse().find(run => run.result)
    usage.textContent = finished?.result ? formatUsage(finished.result) : ''
    if (current?.error && !active) show(current.error.message)
    for (const node of threadList.querySelectorAll<HTMLButtonElement>('button[data-thread-id]')) node.setAttribute('aria-current', node.dataset.threadId === thread?.id ? 'true' : 'false')
  }
  const renderThreads = () => {
    threadList.replaceChildren(...threads.map(item => {
      const button = el('button', { type: 'button', 'data-thread-id': item.id, 'aria-current': item.id === thread?.id ? 'true' : 'false' },
        el('span', { class: 'ca-thread-name', text: item.title }), el('small', { text: item.lastRun ? runStatusLabels[item.lastRun.status] ?? item.lastRun.status : '尚未执行' }))
      button.addEventListener('click', () => { void openThread(item.id) })
      return el('li', {}, button)
    }))
    if (!threads.length) threadList.append(el('li', { class: 'ca-empty', text: client ? '还没有线程。输入项目目录新建一个。' : '' }))
  }
  const renderDevices = () => {
    deviceSelect.replaceChildren(...devices.map(device => el('option', { value: device.id, text: deviceLabel(device, localInstanceId) })))
    deviceSelect.disabled = !devices.length
    if (client) deviceSelect.value = client.connection.id
    deviceSelect.title = `执行设备：${deviceSelect.selectedOptions[0]?.textContent ?? '未选择'}`
  }
  const stopSubscription = () => { subscription?.close(); subscription = undefined }
  const subscribe = (threadId: string) => {
    stopSubscription()
    if (!client) return
    subscription = client.events(threadId, {
      ready() {},
      change: change => void onChange(change),
      event: frame => onEvent(frame),
      error() { /* reconnecting; the next ready triggers a reconcile through queries */ },
    })
  }
  const refreshView = (runId: string) => viewRefresh ??= guard(async () => {
    const view = await client!.request<RunLiveView>(`${app}/runs/${encodeURIComponent(runId)}/view`)
    if (current?.id === runId) live = view
  }).then(() => { viewRefresh = undefined; render() })
  const onEvent = (frame: RunEventFrameView) => {
    if (!current || frame.runId !== current.id) return
    if (live && frame.seq === live.seq + 1) { live = applyRunEvent(live, frame.event); if (frame.event.type === 'approval-requested' || frame.event.type === 'approval-resolved') pending = live.approvals.filter(approval => approval.decision === null); render() }
    else void refreshView(frame.runId)
  }
  const onChange = async (change: RunChangedView) => {
    if (!client || !thread || change.threadId !== thread.id) return
    if (!current || current.id !== change.runId) {
      current = await guard(() => client!.request<RunView>(`${app}/runs/${encodeURIComponent(change.runId)}`))
      live = current ? emptyRunView(current.id, current.threadId) : undefined
      if (current) void refreshView(current.id)
    } else current = { ...current, status: change.status }
    if (!activeStatus(current)) await refreshThread()
    else render()
  }
  const refreshThread = async () => {
    if (!client || !thread) return
    const id = thread.id
    const [messages, list, approvals] = await Promise.all([
      guard(() => client!.request<ThreadMessagesView>(`${app}/threads/${encodeURIComponent(id)}/messages`)),
      guard(() => client!.request<readonly RunView[]>(`${app}/threads/${encodeURIComponent(id)}/runs`)),
      guard(() => client!.request<readonly ApprovalView[]>(`${app}/threads/${encodeURIComponent(id)}/approvals`)),
    ])
    if (disposed || thread?.id !== id) return
    if (messages) history = messages.messages
    if (list) { runs = list; current = list.find(activeStatus) ?? list.at(-1); if (!activeStatus(current)) live = undefined }
    pending = approvals ?? []
    if (activeStatus(current)) await refreshView(current!.id)
    const latest = await guard(() => client!.request<ThreadView>(`${app}/threads/${encodeURIComponent(id)}`))
    if (latest && thread?.id === id) { thread = latest; threads = threads.map(item => item.id === id ? latest : item); renderThreads() }
    render()
  }
  const openThread = async (id: string | undefined, replace = false) => {
    if (!client) return
    thread = threads.find(item => item.id === id)
    history = []; runs = []; current = undefined; live = undefined; pending = []; show()
    navigate({ hostId: client.connection.instanceId, threadId: thread?.id }, replace)
    renderThreads(); render()
    if (!thread) { stopSubscription(); return }
    subscribe(thread.id)
    await refreshThread()
  }
  const loadThreads = async () => {
    if (!client) return
    const list = await guard(() => client!.request<readonly ThreadView[]>(`${app}/threads`))
    if (list) threads = list
    renderThreads()
  }
  const loadEnvironment = async () => {
    if (!client) return
    const environment = await guard(() => client!.request<EnvironmentView>(`${app}/environment`))
    if (environment?.executable.error) show(`${environment.executable.error.message}`)
  }
  /** Only an explicit activation may start the execution device's application; selecting a device never does. */
  const ensureProduct = async (activate: boolean): Promise<boolean> => {
    if (!client) return false
    let state = await guard(() => client!.request<ProductView>('/products/claude-agent'))
    if (!state) { deviceStatus.textContent = '无法读取所选设备的状态。'; startButton.hidden = true; return false }
    if (activate && state.state !== 'running') state = await guard(() => client!.request<ProductView>(state!.state === 'failed' || state!.state === 'blocked' ? '/products/claude-agent/retry' : '/products/claude-agent/open', {})) ?? state
    const running = state.state === 'running'
    deviceStatus.textContent = running ? '' : state.state === 'failed' ? '所选设备上的 Claude Agent 未能启动。' : '所选设备上的 Claude Agent 尚未启动。'
    startButton.hidden = running
    return running
  }
  const selectClient = async (device: DeviceConnection | undefined, activate: boolean) => {
    stopSubscription()
    thread = undefined; threads = []; history = []; runs = []; current = undefined; live = undefined; pending = []
    client = device ? createDeviceClient(context.apiBase, device, lifetime.signal) : undefined
    renderDevices(); renderThreads(); render(); show()
    if (!device) { deviceStatus.textContent = devices.length ? '' : '尚未配置执行设备。请先在 Anybox Harness 的“管理连接”中添加设备。'; startButton.hidden = true; return }
    remember(device.id)
    const requested = route()
    navigate({ hostId: device.instanceId, threadId: requested.hostId === device.instanceId ? requested.threadId : undefined }, true)
    if (!(await ensureProduct(activate))) return
    await loadEnvironment()
    await loadThreads()
    const threadId = route().threadId
    if (threadId && threads.some(item => item.id === threadId)) await openThread(threadId, true)
    else if (threadId) navigate({ hostId: device.instanceId }, true)
  }
  const loadDevices = async (activate: boolean) => {
    const directory = await guard(() => readDevices(context.apiBase, lifetime.signal))
    if (!directory) return
    devices = directory.connections; localInstanceId = directory.localInstanceId
    await selectClient(selectDevice(devices, route(), remembered(), localInstanceId), activate)
  }
  const decide = async (approval: ApprovalView, decision: 'allow' | 'allow-session' | 'deny', answers?: Record<string, string>) => {
    if (!client) return
    const resolved = await guard(() => client!.request<ApprovalView>(`${app}/approvals/${encodeURIComponent(approval.id)}`, { decision, ...(answers ? { answers } : {}) }))
    if (resolved) { pending = pending.filter(item => item.id !== approval.id); render() }
  }
  const submit = async () => {
    if (!client || !thread || submitting) return
    const text = prompt.value.trim()
    if (!text) return
    submitting = true; render()
    try {
      // The same unsent text keeps its key, so a retry after a lost response cannot start a second run.
      if (!draft || draft.prompt !== text) draft = { prompt: text, key: crypto.randomUUID() }
      const body = { prompt: text, idempotencyKey: draft.key, ...(model.value.trim() ? { model: model.value.trim() } : {}), ...(effort.value ? { effort: effort.value } : {}) }
      const run = await client.request<RunView>(`${app}/threads/${encodeURIComponent(thread.id)}/runs`, body)
      draft = undefined; prompt.value = ''
      current = run; live = emptyRunView(run.id, run.threadId); runs = [...runs.filter(item => item.id !== run.id), run]; show()
    } catch (error) { show(messageFor(error)) }
    finally { submitting = false; render() }
  }
  composer.addEventListener('submit', event => { event.preventDefault(); void submit() })
  prompt.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void submit() } })
  cancel.addEventListener('click', () => { if (client && current) void guard(() => client!.request<RunView>(`${app}/runs/${encodeURIComponent(current!.id)}/cancel`, {})).then(run => { if (run) { current = run; render() } }) })
  newThread.addEventListener('submit', event => {
    event.preventDefault()
    if (!client) return
    const projectPath = pathInput.value.trim(), threadTitle = titleInput.value.trim()
    void guard(() => client!.request<ThreadView>(`${app}/threads`, { projectPath, ...(threadTitle ? { title: threadTitle } : {}) })).then(created => {
      if (!created) return
      pathInput.value = ''; titleInput.value = ''
      threads = [created, ...threads]
      void openThread(created.id)
    })
  })
  startButton.addEventListener('click', () => { void (async () => { if (await ensureProduct(true)) { await loadEnvironment(); await loadThreads() } })() })
  deviceSelect.addEventListener('change', () => { const device = devices.find(item => item.id === deviceSelect.value); if (device && device.id !== client?.connection.id) void selectClient(device, false) })
  const unsubscribeRoute = context.route.subscribe(() => {
    const requested = route()
    if (requested.hostId && requested.hostId !== client?.connection.instanceId) { const device = devices.find(item => item.instanceId === requested.hostId); if (device) void selectClient(device, false); return }
    if (client && requested.threadId !== thread?.id && threads.length) void openThread(requested.threadId, true)
  })
  await loadDevices(false)
  return {
    async setActive(active: boolean, reason: ApplicationActivation) {
      if (disposed) return
      if (!active) { for (const dialog of container.querySelectorAll<HTMLDialogElement>('dialog[open]')) dialog.close(); return }
      if (reason === 'open' && client) { if (await ensureProduct(true)) { await loadEnvironment(); await loadThreads(); if (route().threadId && !thread) await openThread(route().threadId, true) } }
    },
    canClose: () => !submitting,
    async dispose() { disposed = true; unsubscribeRoute(); stopSubscription(); lifetime.abort(); container.replaceChildren() },
  }
}
