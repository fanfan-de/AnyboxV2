import type { ApplicationActivation, ApplicationWebContext, MountedApplication } from '../../../host/web/application-contracts.js'
import type { ProductView } from '../../../host/applications/contracts.js'
import type { ApprovalView, EnvironmentView, HistoryMessageView, RecentModelsView, RunChangedView, RunEventFrameView, RunLiveView, RunView, ThreadMessagesView, ThreadView } from '../core/view.js'
import { applyRunEvent, emptyRunView } from '../core/events.js'
import { createDeviceClient, readDevices } from './client.js'
import type { DeviceClient, DeviceConnection } from './client.js'
import { createProjectPanel } from './projects.js'
import { composerBlock, composerBlockLabels, deviceLabel, displayItems, filterDevices, formatRoute, formatUsage, groupThreads, messageFor, parseRoute, runStatusLabels, selectDevice } from './state.js'
import type { DeviceProbe } from './state.js'
import { el, renderApproval, renderThreadGroups, syncTranscript } from './view.js'

const selectedKey = 'anybox.claude-agent.selected', collapsedKey = 'anybox.claude-agent.collapsed'
const efforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const app = '/apps/claude-agent'
// Other threads' Runs are not subscribed; the list is re-read on this cadence only while one of them is active.
const threadPollMs = 10_000, probeTimeoutMs = 6_000, placeholderDelayMs = 200
const activeStatus = (run: RunView | undefined) => run?.status === 'running' || run?.status === 'cancelling'
const activeThread = (thread: ThreadView) => thread.lastRun?.status === 'running' || thread.lastRun?.status === 'cancelling'
const lastSegment = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
const storedSet = (key: string): Set<string> => { try { const value = JSON.parse(sessionStorage.getItem(key) ?? '[]'); return new Set(Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []) } catch { return new Set() } }
/** Shows placeholder text only when a read takes noticeably long, so quick answers never flash it. Returns the cancel. */
const delayed = (apply: () => void) => { const timer = setTimeout(apply, placeholderDelayMs); return () => clearTimeout(timer) }

/** One device, one thread at a time. The browser is a view over the execution device; it never owns runs or transcripts. */
export async function mount(container: HTMLElement, context: ApplicationWebContext): Promise<MountedApplication> {
  const lifetime = new AbortController(), abort = () => lifetime.abort()
  context.signal.addEventListener('abort', abort, { once: true }); if (context.signal.aborted) abort()
  const deviceSelect = el('select', { id: context.domId('device'), 'aria-label': '执行设备' })
  const deviceField = el('label', { class: 'ca-device', for: deviceSelect.id, hidden: true }, el('span', { text: '执行设备' }), deviceSelect)
  const deviceName = el('span', { class: 'ca-device-name' }), deviceState = el('span', { class: 'ca-device-state' })
  const deviceLine = el('p', { class: 'ca-device-line', hidden: true }, deviceName, deviceState)
  const deviceStatus = el('p', { class: 'ca-device-status', role: 'status' })
  const startButton = el('button', { type: 'button', class: 'ca-start', text: '启动 Claude Agent', hidden: true })
  const panel = createProjectPanel(context.domId, {
    request: (path, signal) => { if (!client) return Promise.reject(Object.assign(new Error('product-unavailable'), { status: 503, code: 'product-unavailable' })); return client.request(path, undefined, signal) },
    select: directory => startProject(directory),
    create: (directory, threadTitle) => { void createThread(directory, threadTitle) },
    report: error => { if (!disposed && !lifetime.signal.aborted) show(messageFor(error)) },
  })
  const threadList = el('ul', { class: 'ca-thread-list' })
  const menuButton = el('button', { type: 'button', class: 'ca-menu', text: '☰', 'aria-label': '打开侧栏', 'aria-expanded': 'false' })
  const title = el('strong', { class: 'ca-thread-title', text: '选择或新建一个线程' }), path = el('small', { class: 'ca-thread-path' }), status = el('span', { class: 'ca-run-status' })
  const noticeText = el('span'), noticeClose = el('button', { type: 'button', class: 'ca-notice-close', text: '×', 'aria-label': '关闭提示' })
  const notice = el('div', { class: 'ca-notice notice', role: 'alert', hidden: true }, noticeText, noticeClose)
  const environment = el('p', { class: 'ca-notice ca-environment notice', role: 'alert', hidden: true })
  const transcript = el('div', { class: 'ca-transcript', 'aria-live': 'polite' })
  const transcriptHint = el('p', { class: 'ca-transcript-hint', role: 'status', hidden: true })
  const runError = el('p', { class: 'ca-run-error', role: 'alert' })
  const emptyState = el('div', { class: 'ca-empty-state', hidden: true })
  const approvalsPanel = el('section', { class: 'ca-approvals', hidden: true, 'aria-label': '待处理请求' })
  const prompt = el('textarea', { name: 'prompt', rows: '3', placeholder: '输入提示词。Enter 发送，Shift+Enter 换行', 'aria-label': '提示词', id: context.domId('prompt') })
  const modelList = el('datalist', { id: context.domId('models') })
  const model = el('input', { name: 'model', placeholder: '模型（可选）', 'aria-label': '模型', autocomplete: 'off', list: modelList.id })
  const effort = el('select', { name: 'effort', 'aria-label': '思考强度' }, el('option', { value: '', text: '默认强度' }), ...efforts.map(value => el('option', { value, text: value })))
  const send = el('button', { type: 'submit', class: 'primary-button', text: '发送' })
  const cancel = el('button', { type: 'button', class: 'ca-cancel', text: '取消', hidden: true })
  const composerHint = el('p', { class: 'ca-composer-hint', id: context.domId('composer-hint') })
  prompt.setAttribute('aria-describedby', composerHint.id)
  const composer = el('form', { class: 'ca-composer' }, prompt, el('div', { class: 'ca-composer-row' }, model, modelList, effort, send, cancel), composerHint)
  const usage = el('footer', { class: 'ca-usage' })
  const backdrop = el('div', { class: 'ca-backdrop', hidden: true })
  const root = el('section', { class: 'claude-agent-app' },
    el('aside', { class: 'ca-sidebar' },
      el('header', { class: 'ca-sidebar-head' }, el('h1', { text: 'Claude Agent' }), deviceField, deviceLine, deviceStatus, startButton),
      panel.element, el('nav', { class: 'ca-threads', 'aria-label': '线程' }, threadList), el('footer', { class: 'ca-powered', text: 'Powered by Claude' })),
    backdrop,
    el('main', { class: 'ca-main' }, el('header', { class: 'ca-thread-head' }, menuButton, title, path, status), environment, notice, transcript, transcriptHint, runError, emptyState, approvalsPanel, composer, usage))
  container.replaceChildren(root)

  let devices: readonly DeviceConnection[] = [], hidden = { unreachable: 0, unsupported: 0 }, localInstanceId: string | null = null, client: DeviceClient | undefined
  let productRunning = false, productState: ProductView['state'] | undefined
  let threads: readonly ThreadView[] = [], thread: ThreadView | undefined, project: string | undefined, loadingThread: string | undefined
  let history: readonly HistoryMessageView[] = [], runs: readonly RunView[] = [], current: RunView | undefined, live: RunLiveView | undefined
  let pending: readonly ApprovalView[] = [], subscription: { close(): void } | undefined, threadTimer: ReturnType<typeof setTimeout> | undefined
  let submitting = false, disposed = false, viewRefresh: Promise<void> | undefined, draft: { prompt: string; key: string } | undefined
  let models: string[] = []
  const collapsed = storedSet(collapsedKey)
  const show = (message: string) => { noticeText.textContent = message; notice.hidden = false }
  const clearNotice = () => { noticeText.textContent = ''; notice.hidden = true }
  const remember = (id: string) => { try { sessionStorage.setItem(selectedKey, id) } catch { /* optional */ } }
  const remembered = () => { try { return sessionStorage.getItem(selectedKey) } catch { return null } }
  const saveCollapsed = () => { try { sessionStorage.setItem(collapsedKey, JSON.stringify([...collapsed])) } catch { /* optional */ } }
  const route = () => parseRoute(context.route.read())
  const navigate = (next: { hostId?: string; threadId?: string }, replace = false) => { const value = formatRoute(next); if (context.route.read() !== value) context.route.navigate(value, replace) }
  /** A failed request shows a transient error; the next successful one clears it. Environment and Run errors have their own places. */
  const guard = <T>(work: () => Promise<T>): Promise<T | undefined> => work().then(value => { if (!disposed) clearNotice(); return value }, error => { if (!disposed && !lifetime.signal.aborted) show(messageFor(error)); return undefined })
  const target = () => thread?.projectPath ?? project
  const setDrawer = (open: boolean) => { root.dataset.drawer = open ? 'open' : ''; backdrop.hidden = !open; menuButton.setAttribute('aria-expanded', String(open)) }
  const closeDrawer = () => { if (root.dataset.drawer === 'open') setDrawer(false) }

  const renderEmptyState = () => {
    emptyState.hidden = !!thread || !client || loadingThread !== undefined
    transcript.hidden = !emptyState.hidden
    if (emptyState.hidden) return
    const step = (heading: string, text: string) => el('li', {}, el('strong', { text: heading }), el('span', { text }))
    emptyState.replaceChildren(el('h2', { text: project ? `在 ${lastSegment(project)} 开始新线程` : '开始使用 Claude Agent' }), el('ol', {},
      step(project ? '项目已选择' : '选择项目', project ? `${project}。要换项目，用左栏的最近项目、浏览或路径输入。` : '在左栏点一个最近项目、浏览执行设备上的目录，或输入项目目录的绝对路径。线程按项目分组显示。'),
      step('输入提示词并发送', '第一条消息会自动创建线程并开始执行。Enter 发送，Shift+Enter 换行；模型与强度在输入框下方，留空使用 Claude 的默认值。'),
      step('审批与取消', 'Claude 请求使用工具或向你提问时，审批面板出现在输入框上方；执行期间输入框旁有“取消”按钮。')))
  }
  const render = () => {
    if (disposed) return
    title.textContent = thread ? thread.title : project ? `新线程 · ${lastSegment(project)}` : '选择或新建一个线程'
    path.textContent = target() ?? ''
    path.title = target() ?? ''
    status.textContent = current ? runStatusLabels[current.status] ?? current.status : ''
    status.dataset.status = current?.status ?? ''
    const active = activeStatus(current)
    syncTranscript(transcript, displayItems(history, active ? live : undefined, active ? current?.prompt : undefined))
    if (active || !thread) transcript.scrollTop = transcript.scrollHeight
    runError.textContent = thread && current?.error && !active ? current.error.message : ''
    renderEmptyState()
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
    const block = composerBlock({ hasDevice: !!client, productRunning, hasTarget: !!target(), runActive: active, submitting })
    send.disabled = block !== null
    prompt.disabled = block === 'no-device' || block === 'not-running' || block === 'no-target'
    composerHint.textContent = block ? composerBlockLabels[block] : ''
    const finished = current && !active && current.result ? current : [...runs].reverse().find(run => run.result)
    usage.textContent = finished?.result ? formatUsage(finished.result) : ''
    for (const node of threadList.querySelectorAll<HTMLButtonElement>('button[data-thread-id]')) node.setAttribute('aria-current', node.dataset.threadId === thread?.id ? 'true' : 'false')
  }
  const renderThreads = () => {
    threadList.replaceChildren(...renderThreadGroups(groupThreads(threads), { currentThreadId: thread?.id, selectedPath: project, collapsed, now: Date.now() }, {
      open: id => { void openThread(id) },
      create: directory => startProject(directory),
      toggle: directory => { if (collapsed.has(directory)) collapsed.delete(directory); else collapsed.add(directory); saveCollapsed(); renderThreads() },
    }))
    if (!threads.length) threadList.append(el('li', { class: 'ca-empty', text: client && productRunning ? '还没有线程。先在上方选择项目。' : '' }))
    scheduleThreadPoll()
  }
  const renderDevices = () => {
    const single = devices.length <= 1, device = client?.connection ?? devices[0]
    deviceField.hidden = single; deviceLine.hidden = !single
    deviceSelect.replaceChildren(...devices.map(entry => el('option', { value: entry.id, text: deviceLabel(entry, localInstanceId) })))
    deviceSelect.disabled = !devices.length
    if (client) deviceSelect.value = client.connection.id
    deviceSelect.title = `执行设备：${deviceSelect.selectedOptions[0]?.textContent ?? '未选择'}`
    const stateText = !device ? '' : productRunning ? '运行中' : productState === 'failed' || productState === 'blocked' ? '启动失败' : productState ? '尚未启动' : ''
    deviceName.textContent = device ? (device.instanceId === localInstanceId ? '本机' : device.name) : '没有可用的执行设备'
    deviceLine.title = device ? `执行设备：${deviceLabel(device, localInstanceId)}` : ''
    deviceState.textContent = stateText ? `· ${stateText}` : ''
    deviceLine.dataset.state = productRunning ? 'running' : ''
    const parts = [hidden.unreachable ? `${hidden.unreachable} 台无法连接` : '', hidden.unsupported ? `${hidden.unsupported} 台未安装 Claude Agent` : ''].filter(Boolean).join('，')
    deviceStatus.textContent = !devices.length
      ? (parts ? `已配置的设备都不可用：${parts}。请在 Anybox Harness 的“管理连接”中检查。` : '尚未配置执行设备。请先在 Anybox Harness 的“管理连接”中添加已安装 Claude 的设备。')
      : [single ? '' : stateText && !productRunning ? `所选设备上的 Claude Agent ${stateText}。` : '', parts ? `另有 ${parts}，未显示。` : ''].filter(Boolean).join(' ')
    startButton.hidden = !device || productRunning
  }
  const renderModels = () => { modelList.replaceChildren(...models.map(value => el('option', { value }))) }
  const addModel = (value: string | null | undefined) => { if (value && !models.includes(value)) { models = [value, ...models]; renderModels() } }
  const stopThreadPoll = () => { if (threadTimer !== undefined) { clearTimeout(threadTimer); threadTimer = undefined } }
  const scheduleThreadPoll = () => {
    stopThreadPoll()
    if (disposed || !client || !threads.some(activeThread)) return
    threadTimer = setTimeout(() => { threadTimer = undefined; void loadThreads() }, threadPollMs)
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
    if (current?.id === runId) { live = view; addModel(view.init?.model) }
  }).then(() => { viewRefresh = undefined; render() })
  const updateListEntry = (id: string, patch: Partial<ThreadView>) => { threads = threads.map(item => item.id === id ? { ...item, ...patch } : item); renderThreads() }
  /** The device may retitle a thread when a Run starts (first prompt) or ends (session title); re-read it so the header and list follow. */
  const reloadThread = async (id: string) => {
    const latest = await guard(() => client!.request<ThreadView>(`${app}/threads/${encodeURIComponent(id)}`))
    if (!latest || disposed) return
    if (thread?.id === id) thread = latest
    updateListEntry(id, latest); render()
  }
  const onEvent = (frame: RunEventFrameView) => {
    if (!current || frame.runId !== current.id) return
    if (live && frame.seq === live.seq + 1) {
      live = applyRunEvent(live, frame.event)
      if (frame.event.type === 'init') addModel(frame.event.init.model)
      if (frame.event.type === 'approval-requested' || frame.event.type === 'approval-resolved') { pending = live.approvals.filter(approval => approval.decision === null); if (thread) updateListEntry(thread.id, { pendingApprovals: pending.length }) }
      render()
    } else void refreshView(frame.runId)
  }
  const onChange = async (change: RunChangedView) => {
    if (!client || !thread || change.threadId !== thread.id) return
    if (!current || current.id !== change.runId) {
      current = await guard(() => client!.request<RunView>(`${app}/runs/${encodeURIComponent(change.runId)}`))
      live = current ? emptyRunView(current.id, current.threadId) : undefined
      if (current) void refreshView(current.id)
    } else current = { ...current, status: change.status }
    if (!activeStatus(current)) { await refreshThread(); void loadModels() }
    else { if (thread) updateListEntry(thread.id, { lastRun: { id: change.runId, status: change.status } }); render() }
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
    if (list) { runs = list; current = list.find(activeStatus) ?? list.at(-1); if (!activeStatus(current)) live = undefined; for (const run of list) { addModel(run.model); addModel(run.resolvedModel) } }
    pending = approvals ?? []
    if (activeStatus(current)) await refreshView(current!.id)
    const latest = await guard(() => client!.request<ThreadView>(`${app}/threads/${encodeURIComponent(id)}`))
    if (latest && thread?.id === id) { thread = latest; updateListEntry(id, latest) }
    render()
  }
  const openThread = async (id: string | undefined, replace = false) => {
    if (!client) return
    thread = threads.find(item => item.id === id)
    if (thread) { project = undefined; closeDrawer() }
    history = []; runs = []; current = undefined; live = undefined; pending = []; clearNotice()
    navigate({ hostId: client.connection.instanceId, threadId: thread?.id }, replace)
    if (!thread) { loadingThread = undefined; transcriptHint.hidden = true; stopSubscription(); renderThreads(); render(); return }
    loadingThread = thread.id
    const cancelHint = delayed(() => { if (loadingThread === id) { transcriptHint.textContent = '正在读取转录…'; transcriptHint.hidden = false } })
    renderThreads(); render()
    subscribe(thread.id)
    await refreshThread()
    cancelHint()
    if (loadingThread === id) { loadingThread = undefined; transcriptHint.hidden = true; render() }
  }
  /** A project without a thread yet: the first prompt sent creates the thread and starts its Run. */
  const startProject = (directory: string) => {
    if (!client) return
    stopSubscription()
    project = directory; thread = undefined; loadingThread = undefined; transcriptHint.hidden = true
    history = []; runs = []; current = undefined; live = undefined; pending = []; clearNotice()
    panel.setPath(directory)
    navigate({ hostId: client.connection.instanceId })
    renderThreads(); render()
    closeDrawer()
    prompt.focus()
  }
  const createThread = async (directory: string, threadTitle: string | undefined) => {
    if (!client) return
    const created = await guard(() => client!.request<ThreadView>(`${app}/threads`, { projectPath: directory, ...(threadTitle ? { title: threadTitle } : {}) }))
    if (!created) return
    threads = [created, ...threads]
    await openThread(created.id)
    void panel.refreshRecent()
  }
  const loadThreads = async () => {
    if (!client) return
    const cancelPlaceholder = threads.length ? () => {} : delayed(() => { threadList.replaceChildren(el('li', { class: 'ca-empty', text: '正在读取线程…' })) })
    const list = await guard(() => client!.request<readonly ThreadView[]>(`${app}/threads`))
    cancelPlaceholder()
    if (disposed) return
    if (list) { threads = list; if (thread) thread = list.find(item => item.id === thread!.id) ?? thread }
    renderThreads()
  }
  const loadModels = async () => {
    if (!client) return
    const recent = await guard(() => client!.request<RecentModelsView>(`${app}/models/recent`))
    if (recent) { models = [...new Set([...recent.models, ...models])]; renderModels() }
  }
  const enablePanel = async () => { panel.setEnabled(true); await panel.refreshRecent() }
  const loadEnvironment = async () => {
    if (!client) return
    const view = await guard(() => client!.request<EnvironmentView>(`${app}/environment`))
    environment.textContent = view?.executable.error?.message ?? ''
    environment.hidden = !environment.textContent
  }
  /** Only an explicit activation may start the execution device's application; selecting a device never does. */
  const ensureProduct = async (activate: boolean): Promise<boolean> => {
    if (!client) return false
    let state = await guard(() => client!.request<ProductView>('/products/claude-agent'))
    if (!state) { productRunning = false; productState = undefined; renderDevices(); deviceStatus.textContent = '无法读取所选设备的状态。'; return false }
    if (activate && state.state !== 'running') state = await guard(() => client!.request<ProductView>(state!.state === 'failed' || state!.state === 'blocked' ? '/products/claude-agent/retry' : '/products/claude-agent/open', {})) ?? state
    productRunning = state.state === 'running'; productState = state.state
    if (!productRunning) panel.setEnabled(false)
    renderDevices(); render()
    return productRunning
  }
  const afterProduct = async () => { await loadEnvironment(); await Promise.all([loadThreads(), enablePanel(), loadModels()]) }
  const selectClient = async (device: DeviceConnection | undefined, activate: boolean) => {
    stopSubscription(); stopThreadPoll(); panel.setEnabled(false)
    thread = undefined; project = undefined; loadingThread = undefined; transcriptHint.hidden = true; threads = []; history = []; runs = []; current = undefined; live = undefined; pending = []; models = []
    productRunning = false; productState = undefined; environment.hidden = true
    client = device ? createDeviceClient(context.apiBase, device, lifetime.signal) : undefined
    renderDevices(); renderThreads(); renderModels(); render(); clearNotice()
    if (!device) return
    remember(device.id)
    const requested = route()
    navigate({ hostId: device.instanceId, threadId: requested.hostId === device.instanceId ? requested.threadId : undefined }, true)
    if (!(await ensureProduct(activate))) return
    await afterProduct()
    const threadId = route().threadId
    if (threadId && threads.some(item => item.id === threadId)) await openThread(threadId, true)
    else if (threadId) navigate({ hostId: device.instanceId }, true)
  }
  /** Each saved connection is asked for its instance capabilities through the gateway; only Claude Agent devices are offered. */
  const probeDevices = async (list: readonly DeviceConnection[]): Promise<Map<string, DeviceProbe | undefined>> => new Map(await Promise.all(list.map(async device => {
    try {
      const info = await createDeviceClient(context.apiBase, device, lifetime.signal).request<{ capabilities?: unknown }>('/instance', undefined, AbortSignal.timeout(probeTimeoutMs))
      return [device.id, { capabilities: Array.isArray(info?.capabilities) ? info.capabilities.filter((entry): entry is string => typeof entry === 'string') : [] }] as const
    } catch { return [device.id, undefined] as const }
  })))
  const loadDevices = async (activate: boolean) => {
    const directory = await guard(() => readDevices(context.apiBase, lifetime.signal))
    if (!directory || disposed) return
    localInstanceId = directory.localInstanceId
    deviceStatus.textContent = directory.connections.length ? '正在检查执行设备…' : ''
    const partition = filterDevices(directory.connections, await probeDevices(directory.connections))
    if (disposed) return
    devices = partition.qualified; hidden = { unreachable: partition.unreachable.length, unsupported: partition.unsupported.length }
    await selectClient(selectDevice(devices, route(), remembered(), localInstanceId), activate)
  }
  const decide = async (approval: ApprovalView, decision: 'allow' | 'allow-session' | 'deny', answers?: Record<string, string>) => {
    if (!client) return
    const resolved = await guard(() => client!.request<ApprovalView>(`${app}/approvals/${encodeURIComponent(approval.id)}`, { decision, ...(answers ? { answers } : {}) }))
    if (resolved) { pending = pending.filter(item => item.id !== approval.id); if (thread) updateListEntry(thread.id, { pendingApprovals: pending.length }); render() }
  }
  const submit = async () => {
    if (!client || !target() || submitting) return
    const text = prompt.value.trim()
    if (!text) return
    submitting = true; render()
    try {
      // The same unsent text keeps its key, so a retry after a lost response cannot start a second run.
      if (!draft || draft.prompt !== text) draft = { prompt: text, key: crypto.randomUUID() }
      if (!thread) {
        // First message in a project: create the thread, then its Run; a failure keeps the prompt as a draft.
        const created = await client.request<ThreadView>(`${app}/threads`, { projectPath: project })
        threads = [created, ...threads]; thread = created; project = undefined
        navigate({ hostId: client.connection.instanceId, threadId: created.id })
        subscribe(created.id); renderThreads(); void panel.refreshRecent()
      }
      const body = { prompt: text, idempotencyKey: draft.key, ...(model.value.trim() ? { model: model.value.trim() } : {}), ...(effort.value ? { effort: effort.value } : {}) }
      const run = await client.request<RunView>(`${app}/threads/${encodeURIComponent(thread.id)}/runs`, body)
      draft = undefined; prompt.value = ''
      current = run; live = emptyRunView(run.id, run.threadId); runs = [...runs.filter(item => item.id !== run.id), run]; clearNotice()
      addModel(run.model)
      updateListEntry(thread.id, { lastRun: { id: run.id, status: run.status } })
      void reloadThread(thread.id)
    } catch (error) { show(messageFor(error)) }
    finally { submitting = false; render() }
  }
  composer.addEventListener('submit', event => { event.preventDefault(); void submit() })
  prompt.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void submit() } })
  cancel.addEventListener('click', () => { if (client && current) void guard(() => client!.request<RunView>(`${app}/runs/${encodeURIComponent(current!.id)}/cancel`, {})).then(run => { if (run) { current = run; render() } }) })
  noticeClose.addEventListener('click', clearNotice)
  menuButton.addEventListener('click', () => setDrawer(root.dataset.drawer !== 'open'))
  backdrop.addEventListener('click', closeDrawer)
  root.addEventListener('keydown', event => { if (event.key === 'Escape' && root.dataset.drawer === 'open') { closeDrawer(); menuButton.focus() } })
  startButton.addEventListener('click', () => { void (async () => { if (await ensureProduct(true)) await afterProduct() })() })
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
      if (!active) { for (const dialog of container.querySelectorAll<HTMLDialogElement>('dialog[open]')) dialog.close(); closeDrawer(); stopThreadPoll(); return }
      scheduleThreadPoll()
      if (reason === 'open' && client) { if (await ensureProduct(true)) { await afterProduct(); if (route().threadId && !thread) await openThread(route().threadId, true) } }
    },
    canClose: () => !submitting,
    async dispose() { disposed = true; unsubscribeRoute(); stopSubscription(); stopThreadPoll(); panel.dispose(); lifetime.abort(); container.replaceChildren() },
  }
}
