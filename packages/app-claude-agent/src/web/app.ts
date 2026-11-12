import { createClaudeI18n } from './i18n.js'
import { requireApplicationHttp } from '@anybox/application-api/web'
import type { ApplicationActivation, ApplicationWebContext, MountedApplication } from '@anybox/application-api/web'
import type { ProductView } from '@anybox/application-api/contracts'
import type { ApprovalView, AvailableModelsView, EnvironmentView, HistoryMessageView, RunChangedView, RunEventFrameView, RunLiveView, RunView, QueuedMessageView, ThreadMessagesView, ThreadView } from '../core/view.js'
import type { PermissionModeView } from '../core/view.js'
import { createCapabilitiesPanel } from './capabilities.js'
import { createPermissionPicker } from './permissions.js'
import { createSessionPermissionsPanel } from './session-permissions.js'
import { createWorkspacePanel } from './workspace.js'
import { createAccountPanel } from './account.js'
import { applyRunEvent, emptyRunView } from '../core/events.js'
import { createComposerExtras } from './composer-extras.js'
import { createDeviceClient, readDevices, readLocal } from './client.js'
import type { DeviceClient, DeviceTarget } from './client.js'
import { createProjectPanel } from './projects.js'
import { openConnectionManager } from './connections.js'
import { composerBlock, composerBlockLabel, deviceLabel, displayItems, filterDevices, formatRoute, formatUsage, groupThreads, messageFor, parseRoute, runStatusLabel, selectDevice } from './state.js'
import type { DeviceProbe } from './state.js'
import { renderApproval, renderThreadGroups, syncTranscript } from './view.js'

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
export async function mount(container: HTMLElement, input: ApplicationWebContext): Promise<MountedApplication> {
  const context = requireApplicationHttp(input)
  const i18n = createClaudeI18n(input.locale), { t, element: el } = i18n
  const lifetime = new AbortController(), abort = () => lifetime.abort()
  context.signal.addEventListener('abort', abort, { once: true }); if (context.signal.aborted) abort()
  const deviceSelect = el('select', { id: context.domId('device'), 'aria-label': () => t('app.device') })
  const deviceField = el('label', { class: 'ca-device', for: deviceSelect.id, hidden: true }, el('span', { text: () => t('app.device') }), deviceSelect)
  const deviceName = el('span', { class: 'ca-device-name' }), deviceState = el('span', { class: 'ca-device-state' })
  const deviceLine = el('p', { class: 'ca-device-line', hidden: true }, deviceName, deviceState)
  const deviceStatus = el('p', { class: 'ca-device-status', role: 'status' })
  const startButton = el('button', { type: 'button', class: 'ca-start', text: () => t('app.start'), hidden: true })
  const manageConnections = el('button', { type: 'button', class: 'ca-manage-connections', text: () => t('app.connections') })
  const accountButton = el('button', { type: 'button', class: 'ca-account-button', text: () => t('app.account'), 'aria-haspopup': 'dialog' })
  const panel = createProjectPanel(context.domId, {
    request: (path, signal) => { if (!client) return Promise.reject(Object.assign(new Error('product-unavailable'), { status: 503, code: 'product-unavailable' })); return track(client.request(path, undefined, signal)) },
    select: directory => startProject(directory),
    create: (directory, threadTitle) => { void createThread(directory, threadTitle) },
    pickNative: signal => client ? track(client.pickDirectory(signal)) : Promise.reject(Object.assign(new Error('picker-unavailable'), { status: 503, code: 'picker-unavailable' })),
    report: error => { if (!disposed && !lifetime.signal.aborted) show(() => messageFor(error, i18n)) },
  }, i18n)
  const threadList = el('ul', { class: 'ca-thread-list' })
  const search = el('input', { type: 'search', class: 'ca-thread-search', placeholder: () => t('app.searchPlaceholder'), 'aria-label': () => t('app.searchLabel'), autocomplete: 'off' })
  const threadCount = el('span', { class: 'ca-thread-count' })
  const menuButton = el('button', { type: 'button', class: 'ca-menu', text: () => t('app.conversations'), 'aria-label': () => t('app.openSidebar'), 'aria-expanded': 'false' })
  const title = el('strong', { class: 'ca-thread-title', text: () => t('app.newConversation') }), path = el('small', { class: 'ca-thread-path' }), status = el('span', { class: 'ca-run-status', role: 'status' })
  const noticeText = el('span'), noticeClose = el('button', { type: 'button', class: 'ca-notice-close', text: '×', 'aria-label': () => t('app.dismissNotice'), title: () => t('app.dismissNotice') })
  const notice = el('div', { class: 'ca-notice notice', role: 'alert', hidden: true }, noticeText, noticeClose)
  const environment = el('p', { class: 'ca-notice ca-environment notice', role: 'alert', hidden: true })
  const transcript = el('div', { class: 'ca-transcript', 'aria-label': () => t('app.transcript'), tabindex: '0' })
  const older=el('button',{type:'button',class:'ca-load-earlier',text:() => t('app.older'),hidden:true})
  const latest = el('button', { type: 'button', class: 'ca-latest', text: () => t('app.latest'), hidden: true })
  const transcriptHint = el('p', { class: 'ca-transcript-hint', role: 'status', hidden: true })
  const runError = el('p', { class: 'ca-run-error', role: 'alert' })
  const emptyState = el('div', { class: 'ca-empty-state', hidden: true })
  const approvalsPanel = el('section', { class: 'ca-approvals', hidden: true, 'aria-label': () => t('app.pendingRequests') })
  const prompt = el('textarea', { name: 'prompt', rows: '2', placeholder: () => t('app.promptPlaceholder'), 'aria-label': () => t('app.prompt'), id: context.domId('prompt') })
  const model = el('input', { name: 'model', placeholder: () => t('app.modelPlaceholder'), 'aria-label': () => t('app.model'), autocomplete: 'off' })
  const modelSummary = el('summary', { class: 'ca-model-summary', text: () => t('app.defaultModel'), 'aria-label': () => t('app.chooseModel') })
  const modelList = el('div', { class: 'ca-model-list', role: 'group', 'aria-label': () => t('app.availableModels') })
  const modelStatus = el('p', { class: 'ca-model-status', role: 'status' })
  const modelRefresh = el('button', { type: 'button', class: 'ca-model-refresh', text: () => t('common.refresh'), 'aria-label': () => t('app.refreshModels') })
  const modelCustom = el('details', { class: 'ca-model-custom' }, el('summary', { text: () => t('app.customModel') }),
    el('label', {}, el('span', { text: () => t('app.modelAlias') }), model), el('p', { text: () => t('app.modelHelp') }))
  const modelPicker = el('details', { class: 'ca-model-picker' }, modelSummary,
    el('div', { class: 'ca-model-popover' }, el('header', { class: 'ca-model-heading' }, el('strong', { text: () => t('app.chooseModel') }), modelRefresh), modelList, modelStatus, modelCustom))
  const effort = el('select', { name: 'effort', 'aria-label': () => t('app.effort'), title: () => t('app.effort') }, el('option', { value: '', text: () => t('app.defaultEffort') }), ...efforts.map(value => el('option', { value, text: () => t(`effort.${value}`) })))
  const send = el('button', { type: 'submit', class: 'primary-button', text: () => t('app.send') })
  const cancel = el('button', { type: 'button', class: 'ca-cancel', text: () => t('app.stop'), 'aria-label': () => t('app.stopTask'), hidden: true })
  const composerHint = el('p', { class: 'ca-composer-hint', id: context.domId('composer-hint') })
  prompt.setAttribute('aria-describedby', composerHint.id)
  const composerProject = el('button', { type: 'button', class: 'ca-composer-project', text: () => t('app.chooseProject'), title: () => t('app.newProjectHelp') })
  const capabilitiesButton = el('button', { type: 'button', class: 'ca-capabilities-button', text: () => t('app.capabilities'), 'aria-haspopup': 'dialog' })
  const skillButton = el('button', { type: 'button', class: 'ca-skill-button', text: '＋', 'aria-label': () => t('app.addSkill'), title: () => t('app.addSkill'), 'aria-haspopup': 'dialog' })
  const taskButton = el('button', { type: 'button', class: 'ca-task-button', hidden: true, 'aria-haspopup': 'dialog' })
  const workspaceButton = el('button', { type: 'button', class: 'ca-workspace-button', text: () => t('app.details'), 'aria-haspopup': 'dialog', title: () => t('app.detailsHelp') })
  const mcpInteractionButton = el('button', { type: 'button', class: 'ca-mcp-interaction-button', text: () => t('app.mcpConfirm'), hidden: true })
  const archivedButton = el('button', { type: 'button', class: 'ca-archive-filter', text: () => t('app.archived'), 'aria-pressed': 'false' })
  let showArchived = false
  const permissionPicker = createPermissionPicker(async mode => {
    const device = client, runId = activeStatus(current) ? current?.id : undefined, key = composerKey
    if (!device || !currentDevice(device)) return
    if (runId) {
      const answer = await guard(() => device.request<{ ok: boolean }>(`${app}/runs/${encodeURIComponent(runId)}/control`, { action: 'permission-mode', mode }), () => currentDevice(device) && current?.id === runId)
      if (!answer || !currentDevice(device) || current?.id !== runId || composerKey !== key) { render(); return }
      if (current) current = { ...current, permissionMode: mode }
      if (thread) thread = { ...thread, permissionMode: mode }
    }
    if (composerKey === key) { selectedPermission = mode; saveComposer(); render() }
  }, () => sessionPermissions.open(permissionPicker.summary), i18n)
  const capabilities = createCapabilitiesPanel(context.domId, {
    target: () => !client || !productRunning || !target() ? undefined : ({ key: `${client.connection.instanceId}:${thread?.id ?? target()}`, path: thread ? `${app}/threads/${encodeURIComponent(thread.id)}/capabilities` : `${app}/capabilities?cwd=${encodeURIComponent(target()!)}`, runId: activeStatus(current) ? current?.id : undefined, live }),
    request: (path, body, signal) => client ? track(client.request(path, body, signal)) : Promise.reject(new Error('product-unavailable')),
    insert: text => { prompt.value = text + prompt.value; resizePrompt(); saveComposer(); render(); prompt.focus() },
    report: message => { if (!disposed) show(message) },
  })
  const sessionPermissions = createSessionPermissionsPanel(context.domId, {
    target: () => client && thread ? { key: `${client.connection.instanceId}:${thread.id}`, threadId: thread.id } : undefined,
    request: (path, body, signal) => client ? track(client.request(path, body, signal)) : Promise.reject(new Error('product-unavailable')),
    report: message => { if (!disposed) show(message) },
  })
  const workspace = createWorkspacePanel(context.domId, {
    target: () => client && thread ? { key: `${client.connection.instanceId}:${thread.id}`, thread, run: current, live } : undefined,
    request: (path, body, signal) => client ? track(client.request(path, body, signal)) : Promise.reject(new Error('product-unavailable')),
    changed: value => { if(value.deleted){threads=threads.filter(t=>t.id!==value.id);if(thread?.id===value.id){stopSubscription();thread=undefined;current=undefined;live=undefined;history=[];navigate({hostId:client?.connection.instanceId});render()}renderThreads();return} threads = [value, ...threads.filter(item => item.id !== value.id)]; if (thread?.id === value.id) { thread = value; renderThreads(); render() } else { showArchived = !!value.archived; void openThread(value.id) } },
    report: message => { if (!disposed) show(message) },
    interactions: count => { mcpInteractionButton.hidden = count === 0; i18n.bind(mcpInteractionButton, 'text', () => t('app.mcpConfirm') + ` · ${count}`) },
  })
  const extras=createComposerExtras({i18n,key:()=>composerKey,busy:()=>submitting,changed:()=>{draft=undefined;render()},report:message=>show(message),cancel:async id=>{if(!client||!current)return;try{await track(client.request(`${app}/runs/${encodeURIComponent(current.id)}/messages/${encodeURIComponent(id)}/cancel`,{}))}catch(error){show(() => messageFor(error, i18n));throw error}}})
  const composer = el('form', { class: 'ca-composer' }, extras.progress,extras.input,extras.files,prompt, el('div', { class: 'ca-composer-row' }, extras.add,skillButton, composerProject, permissionPicker.element, modelPicker, effort, el('span', { class: 'ca-composer-spacer' }), send, cancel))
  transcript.addEventListener('claude-preview-file',event=>{const path=(event as CustomEvent<{path:string}>).detail?.path;if(typeof path==='string')workspace.openFile(path)})
  extras.bind(composer)
  const usageSummary = el('summary', { text: () => t('app.usage') }), usageDetail = el('p')
  const usage = el('details', { class: 'ca-usage', hidden: true }, usageSummary, usageDetail)
  const draftsButton = el('button', { type: 'button', class: 'ca-drafts-button', text: () => t('app.drafts'), hidden: true, 'aria-haspopup': 'dialog' })
  const draftsList = el('div', { class: 'ca-drafts-list' })
  const draftsClose = el('button', { type: 'button', text: () => t('common.close'), 'aria-label': () => t('app.closeDrafts') })
  const account = createAccountPanel(context.domId, {
    target: () => !client || !productRunning ? undefined : ({ key: `${client.connection.instanceId}:${thread?.id ?? target() ?? 'home'}:${activeStatus(current) ? current?.id : ''}`, path: `${app}/account${thread ? `?threadId=${encodeURIComponent(thread.id)}` : target() ? `?cwd=${encodeURIComponent(target()!)}` : ''}`, label: `${client.connection.name} · 当前 Claude 账号` }),
    request: (path, signal) => { if (!client) return Promise.reject(new Error('product-unavailable')); return track(client.request(path, undefined, signal)) },
  })
  const draftsDialog = el('dialog', { class: 'ca-drafts-dialog', 'aria-labelledby': context.domId('drafts-title') },
    el('header', {}, el('h2', { id: context.domId('drafts-title'), text: () => t('app.drafts') }), draftsClose),
    el('p', { text: () => t('app.draftHelp') }), draftsList)
  const backdrop = el('div', { class: 'ca-backdrop', hidden: true })
  const root = el('section', { class: 'claude-agent-app' },
    el('aside', { class: 'ca-sidebar' },
      el('header', { class: 'ca-sidebar-head' }, el('h1', { text: 'Claude Agent' }), el('span', { class: 'ca-sidebar-caption', text: () => t('app.tagline') })),
      panel.element, el('div', { class: 'ca-search-wrap' }, search), el('div', { class: 'ca-list-heading' }, el('span', { text: () => t('app.projectsAndThreads') }), threadCount, archivedButton), el('nav', { class: 'ca-threads', 'aria-label': () => t('app.threads') }, threadList),
      el('footer', { class: 'ca-sidebar-foot' }, draftsButton, deviceField, deviceLine, deviceStatus, startButton, accountButton, manageConnections, el('span', { class: 'ca-powered', text: 'Powered by Claude' }))),
    backdrop,
    el('main', { class: 'ca-main' }, el('header', { class: 'ca-thread-head' }, menuButton, el('div', { class: 'ca-thread-heading' }, path, title), status, taskButton, mcpInteractionButton, capabilitiesButton, workspaceButton), environment, notice,
      el('div', { class: 'ca-content-area' }, older,transcript, transcriptHint, runError, emptyState, latest), approvalsPanel,
      el('div', { class: 'ca-compose-dock' }, composer, el('div', { class: 'ca-composer-meta' }, composerHint, usage))), draftsDialog, capabilities.element, sessionPermissions.element, workspace.element, account.element)
  for (const legacy of [capabilities.element, sessionPermissions.element, workspace.element, account.element]) legacy.lang = 'zh-CN'
  i18n.bind(root, 'lang', () => i18n.locale)
  container.replaceChildren(root)

  let devices: readonly DeviceTarget[] = [], hidden = { unreachable: 0, unsupported: 0 }, localInstanceId: string | null = null, localPicker = false, localUnavailable = false, client: DeviceClient | undefined
  let productRunning = false, productState: ProductView['state'] | undefined
  let threads: readonly ThreadView[] = [], thread: ThreadView | undefined, project: string | undefined, loadingThread: string | undefined
  let inputHistory:readonly QueuedMessageView[]=[]
  let previousOffset:number|null=null
  let history: readonly HistoryMessageView[] = [], runs: readonly RunView[] = [], current: RunView | undefined, live: RunLiveView | undefined
  let pending: readonly ApprovalView[] = [], subscription: { close(): void } | undefined, threadTimer: ReturnType<typeof setTimeout> | undefined
  let submitting = false, disposed = false, viewRefresh: { runId: string; version: number; work: Promise<void> } | undefined, draft: { prompt: string; key: string } | undefined
  let threadReads = new AbortController(), threadReadVersion = 0
  let deviceLifetime = new AbortController(), deviceDiscovery = new AbortController(), discoveryVersion = 0, visible = true, disposal: Promise<void> | undefined
  const tasks = new Set<Promise<unknown>>()
  let connectionManager: ReturnType<typeof openConnectionManager> | undefined
  let followLatest = true, composerKey: string | undefined, composerLabel = t('app.newConversation')
  let selectedPermission: PermissionModeView = 'default'
  type ComposerDraft = { label: string; prompt: string; model: string; effort: string; permissionMode: PermissionModeView; retry: typeof draft }
  const drafts = new Map<string, ComposerDraft>()
  const saveComposer = () => {
    if (!composerKey) return
    if (prompt.value.trim()) drafts.set(composerKey, { label: composerLabel, prompt: prompt.value, model: model.value, effort: effort.value, permissionMode: selectedPermission, retry: draft })
    else drafts.delete(composerKey)
    draftsButton.hidden = drafts.size === 0&&!extras.hasDrafts()
    i18n.bind(draftsButton, 'text', () => t('app.draftCount', { count: drafts.size }) + (extras.hasDrafts() ? t('app.withAttachments') : ''))
  }
  const resizePrompt = () => { if (prompt.style) { prompt.style.height = 'auto'; prompt.style.height = `${Math.min(220, Math.max(64, prompt.scrollHeight))}px` } }
  const updateModelSummary = () => { const selected = model.value.trim(), isDefault = !selected || selected === 'default'; i18n.bind(modelSummary, 'text', () => isDefault ? t('app.defaultModel') : models.find(entry => entry.value === selected)?.displayName || selected); i18n.bind(modelSummary, 'title', () => isDefault ? models.find(entry => entry.value === 'default')?.description || t('app.defaultModelHelp') : selected) }
  const switchComposer = (key: string, label: string, mode = thread?.permissionMode ?? 'default') => {
    if (key === composerKey) { composerLabel = label; return }
    saveComposer(); composerKey = key; composerLabel = label
    const saved = drafts.get(key)
    prompt.value = saved?.prompt ?? ''; model.value = saved?.model ?? ''; effort.value = saved?.effort ?? ''; draft = saved?.retry
    selectedPermission = saved?.permissionMode ?? mode
    capabilities.close(); sessionPermissions.close(); permissionPicker.close()
    updateModelSummary(); resizePrompt(); modelPicker.open = false; modelCustom.open = false
  }
  const renderDrafts = () => {
    draftsList.replaceChildren(...[...drafts].map(([key, saved]) => {
      const discard = el('button', { type: 'button', class: 'ca-draft-discard', text: () => t('app.discardDraft'), 'aria-label': () => t('app.discardDraftLabel', { name: saved.label }) })
      discard.addEventListener('click', () => {
        drafts.delete(key)
        if (composerKey === key) { prompt.value = ''; draft = undefined; resizePrompt() }
        saveComposer(); renderDrafts(); renderThreads(); render()
        if (drafts.size === 0) draftsClose.focus()
      })
      return el('section', { class: 'ca-draft-entry' }, el('div', {}, el('strong', { text: saved.label }), el('p', { text: saved.prompt.slice(0, 140) })), discard)
    }))
    if(extras.hasDrafts()){const discardFiles=el('button',{type:'button',text:() => t('app.discardAttachments')});discardFiles.addEventListener('click',()=>{extras.discardAll();renderDrafts();render()});draftsList.append(el('section',{class:'ca-draft-entry'},el('p',{text:() => t('app.attachmentDraftHelp')}),discardFiles))}
    if (drafts.size === 0&&!extras.hasDrafts()) draftsList.append(el('p', { text: () => t('app.noDrafts') }))
  }
  const targetKey = (device: DeviceClient, kind: 'thread' | 'project', id: string) => JSON.stringify([device.connection.instanceId, kind, id])
  const track = <T>(work: Promise<T>): Promise<T> => {
    const task = work.finally(() => tasks.delete(task))
    tasks.add(task); return task
  }
  const currentDevice = (device: DeviceClient | undefined) => !!device && !disposed && !lifetime.signal.aborted && client === device
  const sameConnection = (left: DeviceTarget, right: DeviceTarget) => left.id === right.id && left.instanceId === right.instanceId && left.revision === right.revision && ('endpoint' in left ? left.endpoint : undefined) === ('endpoint' in right ? right.endpoint : undefined)
  type AvailableModel = AvailableModelsView['models'][number]
  let models: readonly AvailableModel[] = [], modelLoad: 'idle' | 'loading' | 'ready' | 'failed' = 'idle', modelFailure: unknown
  let modelReads = new AbortController(), modelReadVersion = 0
  const collapsed = storedSet(collapsedKey)
  const show = (message: string | (() => string)) => { i18n.bind(noticeText, 'text', typeof message === 'function' ? message : () => message); notice.hidden = false }
  const clearNotice = () => { i18n.bind(noticeText, 'text', () => ''); notice.hidden = true }
  const remember = (id: string) => { try { sessionStorage.setItem(selectedKey, id) } catch { /* optional */ } }
  const remembered = () => { try { return sessionStorage.getItem(selectedKey) } catch { return null } }
  const saveCollapsed = () => { try { sessionStorage.setItem(collapsedKey, JSON.stringify([...collapsed])) } catch { /* optional */ } }
  const route = () => parseRoute(context.route.read())
  const navigate = (next: { hostId?: string; threadId?: string }, replace = false) => { const value = formatRoute(next); if (context.route.read() !== value) context.route.navigate(value, replace) }
  /** A failed request shows a transient error; the next successful one clears it. Environment and Run errors have their own places. */
  const guard = <T>(work: () => Promise<T>, relevant = () => !disposed): Promise<T | undefined> => track(work().then(value => { if (relevant()) clearNotice(); return value }, error => { if (relevant() && !lifetime.signal.aborted) show(() => messageFor(error, i18n)); return undefined }))
  const target = () => thread?.projectPath ?? project
  const setDrawer = (open: boolean) => { root.dataset.drawer = open ? 'open' : ''; backdrop.hidden = !open; menuButton.setAttribute('aria-expanded', String(open)) }
  const closeDrawer = () => { if (root.dataset.drawer === 'open') setDrawer(false) }

  const renderEmptyState = () => {
    emptyState.hidden = !!thread || !client || loadingThread !== undefined
    transcript.hidden = !emptyState.hidden
    if (emptyState.hidden) return
    const choose = el('button', { type: 'button', class: 'ca-empty-choose', text: () => project ? t('app.changeProject') : t('app.chooseProject') })
    choose.addEventListener('click', () => panel.open())
    emptyState.replaceChildren(el('span', { class: 'ca-empty-eyebrow', text: project ? lastSegment(project) : 'CLAUDE AGENT' }),
      el('h2', { text: () => t('app.welcome') }), el('p', { text: () => project ? t('app.projectWelcome') : t('app.chooseWelcome') }), choose)
    if (project) {
      const suggestions = el('div', { class: 'ca-suggestions', 'aria-label': () => t('app.suggestions') })
      for (const [label, text] of [[() => t('app.suggestExplore'), '请先阅读这个项目，介绍它的结构、主要功能和开发方式。'], [() => t('app.suggestReview'), '请审查这个项目的代码，找出值得优先修复的问题，先给我建议。'], [() => t('app.suggestBuild'), '我想在这个项目中实现一个功能：']] as const) {
        const button = el('button', { type: 'button', text: label })
        button.addEventListener('click', () => { prompt.value = text; resizePrompt(); saveComposer(); render(); prompt.focus() })
        suggestions.append(button)
      }
      emptyState.append(suggestions)
    }
  }
  const render = () => {
    if (disposed) return
    extras.update(activeStatus(current)?live:undefined,inputHistory);workspace.update(); workspaceButton.disabled = !client || !productRunning || !target()
    draftsButton.hidden = drafts.size === 0&&!extras.hasDrafts()
    i18n.bind(draftsButton, 'text', () => t('app.draftCount', { count: drafts.size }) + (extras.hasDrafts() ? t('app.withAttachments') : ''))
    i18n.bind(title, 'text', () => thread ? thread.title : t('app.newConversation'))
    path.textContent = target() ? lastSegment(target()!) : 'Claude Agent'
    path.title = target() ?? ''
    i18n.bind(status, 'text', () => pending.length ? t('app.waiting', { count: pending.length }) : current ? runStatusLabel(current.status, i18n) : target() ? t('app.ready') : '')
    status.dataset.status = pending.length ? 'approval' : current?.status ?? ''
    const active = activeStatus(current)
    permissionPicker.update(active ? live?.init?.permissionMode ?? current?.permissionMode ?? selectedPermission : selectedPermission, active, !!client && productRunning && !!target() && !submitting, !!thread)
    sessionPermissions.update()
    capabilitiesButton.disabled = skillButton.disabled = !client || !productRunning || !target()
    accountButton.disabled = !client || !productRunning
    account.update()
    const agentTasks = live?.tasks ?? [], runningTasks = agentTasks.filter(task => ['running', 'pending', 'paused'].includes(task.status ?? ''))
    taskButton.hidden = agentTasks.length === 0
    i18n.bind(taskButton, 'text', () => runningTasks.length ? t('app.activeTasks', { count: runningTasks.length }) : t('app.tasks', { count: agentTasks.length }))
    capabilities.update()
    syncTranscript(transcript, displayItems(history, active ? live : undefined, active ? current?.prompt : undefined,active?current?.attachments:undefined), i18n)
    if (followLatest) transcript.scrollTop = transcript.scrollHeight
    latest.hidden = followLatest || !thread
    runError.textContent = thread && current?.error && !active ? current.error.message : ''
    renderEmptyState()
    approvalsPanel.hidden = pending.length === 0
    // Rebuild the forms only when the pending set changes, so streaming events never wipe a half-entered answer.
    const approvalKey = pending.map(approval => approval.id).join('\n')
    if (approvalsPanel.dataset.approvals !== approvalKey) {
      approvalsPanel.dataset.approvals = approvalKey
      approvalsPanel.replaceChildren(...pending.map(approval => renderApproval(approval, { decide: (view, decision, answers) => void decide(view, decision, answers) }, context.domId, i18n)))
      const focus = approvalsPanel.querySelector<HTMLElement>('[data-default-to-no="true"] button:last-of-type')
      if (focus && document.activeElement === document.body) focus.focus()
    }
    cancel.hidden = !active
    const block = composerBlock({ hasDevice: !!client, productRunning, hasTarget: !!target(), runActive: active, submitting })
    send.disabled = (block !== null && block !== 'running') || submitting || (!prompt.value.trim()&&!extras.count()) || thread?.archived === true || current?.status==='cancelling'
    send.hidden = false;i18n.bind(send, 'text', () => active?t('app.queue'):t('app.send'));extras.add.disabled=submitting||!client||!productRunning||!target()
    cancel.disabled = current?.status === 'cancelling'
    i18n.bind(cancel, 'text', () => current?.status === 'cancelling' ? t('app.stopping') : t('app.stop'))
    prompt.disabled = block === 'no-device' || block === 'not-running' || block === 'no-target'
    i18n.bind(composerHint, 'text', () => thread?.archived ? t('app.archivedHelp') : (block === 'running' ? t('app.queueHelp') : block ? composerBlockLabel(block, i18n) : t('app.sendHelp')) + (!active && thread?.options?.maxBudgetUsd ? t('app.budget', { cost: i18n.money(thread.options.maxBudgetUsd) }) : ''))
    i18n.bind(composerProject, 'text', () => target() ? lastSegment(target()!) : t('app.chooseProject'))
    i18n.bind(composerProject, 'title', () => target() ?? t('app.newProjectHelp'))
    composerProject.disabled = !client || !productRunning
    composerProject.hidden = !!thread
    const finished = current && !active && current.result ? current : [...runs].reverse().find(run => run.result)
    usage.hidden = !finished?.result
    i18n.bind(usageDetail, 'text', () => finished?.result ? `${finished.resolvedModel ? t('app.actualModel', { model: finished.resolvedModel }) : ''}${formatUsage(finished.result, i18n)}` : '')
    i18n.bind(usageSummary, 'text', () => finished?.result ? t('app.costSummary', { cost: i18n.money(finished.result.totalCostUsd, 2) }) : t('app.usage'))
    for (const node of threadList.querySelectorAll<HTMLButtonElement>('button[data-thread-id]')) node.setAttribute('aria-current', node.dataset.threadId === thread?.id ? 'true' : 'false')
    i18n.retain(root)
  }
  const renderThreads = () => {
    const query = search.value.trim().toLocaleLowerCase()
    const filtered = threads.filter(item => !!item.archived === showArchived && (!query || `${item.title} ${item.projectPath} ${item.tag ?? ''}`.toLocaleLowerCase().includes(query)))
    archivedButton.setAttribute('aria-pressed', String(showArchived)); i18n.bind(archivedButton, 'text', () => showArchived ? t('app.returnThreads') : t('app.archived'))
    threadCount.textContent = String(filtered.length)
    threadList.replaceChildren(...renderThreadGroups(groupThreads(filtered), { currentThreadId: thread?.id, selectedPath: project, collapsed: query ? new Set() : collapsed, now: Date.now() }, {
      open: id => { void openThread(id) },
      create: directory => startProject(directory),
      toggle: directory => { if (collapsed.has(directory)) collapsed.delete(directory); else collapsed.add(directory); saveCollapsed(); renderThreads() },
    }, i18n))
    if (!filtered.length) threadList.append(el('li', { class: 'ca-empty', text: () => query ? t('app.noMatches') : client && productRunning ? t('app.noThreads') : '' }))
    for (const node of threadList.querySelectorAll<HTMLButtonElement>('button[data-thread-id]')) {
      const hasDraft = client && drafts.has(targetKey(client, 'thread', node.dataset.threadId!))
      if (hasDraft) { node.dataset.draft = 'true'; node.append(el('span', { class: 'ca-draft-label', text: () => t('app.draft') })) }
    }
    scheduleThreadPoll()
    i18n.retain(root)
  }
  const renderDevices = () => {
    const single = devices.length <= 1, device = devices.find(entry => entry.id === client?.connection.id) ?? devices[0]
    deviceField.hidden = single; deviceLine.hidden = !single
    deviceSelect.replaceChildren(...devices.map(entry => el('option', { value: entry.id, text: () => deviceLabel(entry, localInstanceId, i18n) })))
    deviceSelect.disabled = !devices.length
    if (client) deviceSelect.value = client.connection.id
    i18n.bind(deviceSelect, 'title', () => { const selected = devices.find(entry => entry.id === deviceSelect.value); return t('app.deviceTitle', { name: selected ? deviceLabel(selected, localInstanceId, i18n) : t('app.noneSelected') }) })
    const stateText = () => !device ? '' : productRunning ? t('app.running') : productState === 'failed' || productState === 'blocked' ? t('app.startFailed') : productState ? t('app.notStarted') : ''
    i18n.bind(deviceName, 'text', () => device ? (device.instanceId === localInstanceId ? t('app.local') : device.name) : t('app.noDevices'))
    i18n.bind(deviceLine, 'title', () => device ? t('app.deviceTitle', { name: deviceLabel(device, localInstanceId, i18n) }) : '')
    i18n.bind(deviceState, 'text', () => stateText() ? `· ${stateText()}` : '')
    deviceLine.dataset.state = productRunning ? 'running' : ''
    const parts = () => [hidden.unreachable ? t('app.unreachable', { count: hidden.unreachable }) : '', hidden.unsupported ? t('app.unsupported', { count: hidden.unsupported }) : ''].filter(Boolean).join(i18n.locale === 'en' ? ', ' : '，')
    i18n.bind(deviceStatus, 'text', () => !devices.length
      ? (localUnavailable ? t('app.localUnavailable') : parts() ? t('app.devicesUnavailable', { details: parts() }) : t('app.noConfiguredDevices'))
      : [single ? '' : stateText() && !productRunning ? t('app.selectedDeviceState', { state: stateText() }) : '', parts() ? t('app.hiddenDevices', { details: parts() }) : ''].filter(Boolean).join(' '))
    startButton.hidden = device ? productRunning : !localUnavailable
    i18n.bind(startButton, 'text', () => !device && localUnavailable ? t('app.retryLocal') : t('app.start'))
  }
  const stopModelRead = () => { modelReads.abort(); modelReads = new AbortController(); modelReadVersion++; if (modelLoad === 'loading') modelLoad = 'idle' }
  const resetModels = () => { stopModelRead(); models = []; modelLoad = 'idle'; modelFailure = undefined; renderModels() }
  const chooseModel = (value: string) => {
    model.value = value; saveComposer(); renderModels(); modelPicker.open = false; modelCustom.open = false; stopModelRead(); modelSummary.focus()
  }
  const renderModels = () => {
    const selected = model.value.trim(), advertisedDefault = models.find(entry => entry.value === 'default')
    const option = (value: string, label: string | (() => string), description: string | (() => string)) => {
      const checked = value === selected || value === '' && selected === 'default'
      const button = el('button', { type: 'button', class: 'ca-model-option', 'data-model-value': value, 'aria-pressed': String(checked) },
        el('span', { class: 'ca-model-option-copy' }, el('strong', { text: label }), el('span', { class: 'ca-model-description', text: description })),
        el('span', { class: 'ca-model-check', 'aria-hidden': 'true', text: checked ? '✓' : '' }))
      button.addEventListener('click', () => chooseModel(value))
      return button
    }
    modelList.replaceChildren(option('', () => t('app.defaultModel'), () => advertisedDefault?.description || t('app.environmentSettings')), ...models.filter(entry => entry.value !== 'default').map(entry => option(entry.value, entry.displayName, entry.description)))
    modelList.setAttribute('aria-busy', String(modelLoad === 'loading'))
    i18n.bind(modelStatus, 'text', () => !client || !productRunning ? t('app.modelsNotStarted') : modelLoad === 'loading' ? t('app.modelsLoading') : modelLoad === 'failed' ? t('app.modelsFailed', { details: messageFor(modelFailure, i18n) }) : modelLoad === 'ready' && models.length === 0 ? t('app.modelsEmpty') : '')
    modelStatus.hidden = !modelStatus.textContent
    modelRefresh.disabled = !client || !productRunning || modelLoad === 'loading'
    i18n.bind(modelRefresh, 'text', () => modelLoad === 'failed' ? t('common.retry') : t('common.refresh'))
    updateModelSummary()
  }
  const stopThreadPoll = () => { if (threadTimer !== undefined) { clearTimeout(threadTimer); threadTimer = undefined } }
  const scheduleThreadPoll = () => {
    stopThreadPoll()
    if (disposed || !visible || !client || !threads.some(activeThread)) return
    threadTimer = setTimeout(() => { threadTimer = undefined; void loadThreads() }, threadPollMs)
  }
  const stopSubscription = () => {
    subscription?.close(); subscription = undefined
    threadReads.abort(); threadReads = new AbortController(); viewRefresh = undefined
  }
  const subscribe = (threadId: string) => {
    stopSubscription()
    if (!client) return
    const device = client, signal = threadReads.signal
    const relevant = () => !disposed && !signal.aborted && client === device && thread?.id === threadId
    subscription = device.events(threadId, {
      ready() { if (relevant()) void refreshThread() },
      change: change => { if (relevant()) void onChange(change) },
      event: frame => { if (relevant()) onEvent(frame) },
      error() { /* reconnecting; the next ready triggers a reconcile through queries */ },
    })
  }
  const refreshView = (runId: string): Promise<void> => {
    if (viewRefresh?.runId === runId && viewRefresh.version === threadReadVersion) return viewRefresh.work
    const device = client, signal = threadReads.signal, version = threadReadVersion
    const relevant = () => !disposed && !signal.aborted && client === device && current?.id === runId && version === threadReadVersion
    const work: Promise<void> = guard(async () => {
      const view = await device!.request<RunLiveView>(`${app}/runs/${encodeURIComponent(runId)}/view`, undefined, signal)
      if (relevant() && (!live || live.runId !== runId || view.seq >= live.seq)) {
        live = view; pending = view.approvals.filter(approval => approval.decision === null)
      }
    }, relevant).then(() => { if (viewRefresh?.work === work) viewRefresh = undefined; if (relevant()) render() })
    viewRefresh = { runId, version, work }
    return work
  }
  const updateListEntry = (id: string, patch: Partial<ThreadView>) => { threads = threads.map(item => item.id === id ? { ...item, ...patch } : item); renderThreads() }
  /** The device may retitle a thread when a Run starts (first prompt) or ends (session title); re-read it so the header and list follow. */
  const reloadThread = async (id: string) => {
    const device = client
    if (!device) return
    const latest = await guard(() => device.request<ThreadView>(`${app}/threads/${encodeURIComponent(id)}`), () => currentDevice(device))
    if (!latest || !currentDevice(device)) return
    if (thread?.id === id) thread = latest
    updateListEntry(id, latest); render()
  }
  const onEvent = (frame: RunEventFrameView) => {
    if (!current || frame.runId !== current.id) return
    if (live && frame.seq === live.seq + 1) {
      live = applyRunEvent(live, frame.event)
      if (frame.event.type === 'permission-mode') selectedPermission = frame.event.mode as PermissionModeView
      if (frame.event.type === 'approval-requested' || frame.event.type === 'approval-resolved') { pending = live.approvals.filter(approval => approval.decision === null); if (thread) updateListEntry(thread.id, { pendingApprovals: pending.length }) }
      render()
    } else void refreshView(frame.runId)
  }
  const onChange = async (change: RunChangedView) => {
    if (!client || !thread || change.threadId !== thread.id) return
    const device = client, signal = threadReads.signal, version = ++threadReadVersion
    const relevant = () => !disposed && !signal.aborted && client === device && thread?.id === change.threadId && version === threadReadVersion
    if (!current || current.id !== change.runId) {
      const latest = await guard(() => device.request<RunView>(`${app}/runs/${encodeURIComponent(change.runId)}`, undefined, signal), relevant)
      if (!relevant()) return
      current = latest
      live = current ? emptyRunView(current.id, current.threadId) : undefined
    } else current = { ...current, status: change.status }
    if (!activeStatus(current)) await refreshThread()
    else { if (thread) updateListEntry(thread.id, { lastRun: { id: change.runId, status: change.status } }); if (current) void refreshView(current.id); render() }
  }
  older.addEventListener('click',()=>{if(!client||!thread||previousOffset===null)return;const device=client,id=thread.id,offset=previousOffset;older.disabled=true;void track(device.request<ThreadMessagesView>(`${app}/threads/${encodeURIComponent(id)}/messages?offset=${offset}`,undefined,threadReads.signal)).then(page=>{if(!currentDevice(device)||thread?.id!==id)return;history=[...page.messages.filter(m=>!history.some(existing=>existing.id===m.id)),...history];previousOffset=page.previousOffset??null;older.hidden=previousOffset===null;followLatest=false;render()}).catch(error=>show(() => messageFor(error, i18n))).finally(()=>{older.disabled=false})})
  const refreshThread = async () => {
    if (!client || !thread) return
    const id = thread.id, device = client, signal = threadReads.signal, version = ++threadReadVersion
    const relevant = () => !disposed && !signal.aborted && client === device && thread?.id === id && version === threadReadVersion
    const [messages, list, approvals] = await Promise.all([
      guard(() => device.request<ThreadMessagesView>(`${app}/threads/${encodeURIComponent(id)}/messages`, undefined, signal), relevant),
      guard(() => device.request<readonly RunView[]>(`${app}/threads/${encodeURIComponent(id)}/runs`, undefined, signal), relevant),
      guard(() => device.request<readonly ApprovalView[]>(`${app}/threads/${encodeURIComponent(id)}/approvals`, undefined, signal), relevant),
    ])
    if (!relevant()) return
    if (messages) {history = messages.messages;previousOffset=messages.previousOffset??null;older.hidden=previousOffset===null}
    if (list) { runs = list; current = list.find(activeStatus) ?? list.at(-1); if (live?.runId !== current?.id) live = undefined }
    if(current){const queued=await guard(()=>device.request<readonly QueuedMessageView[]>(`${app}/runs/${encodeURIComponent(current!.id)}/messages`,undefined,signal),relevant);if(relevant()&&queued)inputHistory=queued}
    if (approvals) pending = approvals
    if (activeStatus(current)) await refreshView(current!.id)
    if (!relevant()) return
    const latest = await guard(() => device.request<ThreadView>(`${app}/threads/${encodeURIComponent(id)}`, undefined, signal), relevant)
    if (!relevant()) return
    if (latest) { thread = latest; updateListEntry(id, latest) }
    render()
  }
  const openThread = (id: string | undefined, replace = false): Promise<void> => track((async () => {
    if (id !== thread?.id && !workspace.canClose()) { if (client) navigate({ hostId: client.connection.instanceId, threadId: thread?.id }, true); return }
    const device = client
    if (!device || !currentDevice(device)) return
    followLatest = true
    thread = threads.find(item => item.id === id)
    switchComposer(targetKey(device, 'thread', thread?.id ?? ''), thread?.title ?? t('app.newConversation'))
    resetModels()
    if (thread) { project = undefined; panel.setPath(thread.projectPath); closeDrawer() }
    inputHistory=[];older.hidden=true;previousOffset=null;history = []; runs = []; current = undefined; live = undefined; pending = []; clearNotice()
    navigate({ hostId: device.connection.instanceId, threadId: thread?.id }, replace)
    if (!thread) { loadingThread = undefined; transcriptHint.hidden = true; stopSubscription(); renderThreads(); render(); return }
    loadingThread = thread.id
    const cancelHint = delayed(() => { if (currentDevice(device) && loadingThread === id) { i18n.bind(transcriptHint, 'text', () => t('app.transcriptLoading')); transcriptHint.hidden = false } })
    renderThreads(); render()
    subscribe(thread.id)
    const signal = threadReads.signal
    await refreshThread()
    cancelHint()
    if (currentDevice(device) && !signal.aborted && loadingThread === id) { loadingThread = undefined; transcriptHint.hidden = true; render() }
  })())
  /** A project without a thread yet: the first prompt sent creates the thread and starts its Run. */
  const startProject = (directory: string) => {
    if (!workspace.canClose()) return
    if (!client) return
    followLatest = true
    switchComposer(targetKey(client, 'project', directory), lastSegment(directory), 'default')
    stopSubscription()
    project = directory; thread = undefined; loadingThread = undefined; transcriptHint.hidden = true
    resetModels()
    inputHistory=[];older.hidden=true;previousOffset=null;history = []; runs = []; current = undefined; live = undefined; pending = []; clearNotice()
    panel.setPath(directory)
    navigate({ hostId: client.connection.instanceId })
    renderThreads(); render()
    closeDrawer()
    prompt.focus()
  }
  const createThread = async (directory: string, threadTitle: string | undefined) => {
    const device = client
    if (!device) return
    const sourceKey = composerKey
    const created = await guard(() => device.request<ThreadView>(`${app}/threads`, { projectPath: directory, ...(threadTitle ? { title: threadTitle } : {}) }), () => currentDevice(device))
    if (!created || !currentDevice(device)) return
    threads = [created, ...threads]
    if (composerKey === sourceKey) await openThread(created.id)
    else renderThreads()
    if (currentDevice(device)) { void panel.refreshRecent(); prompt.focus() }
  }
  const loadThreads = async (device = client, signal?: AbortSignal) => {
    if (!device) return
    const relevant = () => currentDevice(device) && !signal?.aborted
    const cancelPlaceholder = threads.length ? () => {} : delayed(() => { if (relevant()) threadList.replaceChildren(el('li', { class: 'ca-empty', text: () => t('app.threadsLoading') })) })
    const list = await guard(() => device.request<readonly ThreadView[]>(`${app}/threads`, undefined, signal), relevant)
    cancelPlaceholder()
    if (!relevant()) return
    if (list) { threads = list; if (thread) thread = list.find(item => item.id === thread!.id) ?? thread }
    renderThreads()
  }
  const loadModels = (): Promise<void> => track((async () => {
    stopModelRead()
    const device = client, directory = target(), signal = modelReads.signal, version = modelReadVersion
    if (!device || !productRunning || !visible || !modelPicker.open) { renderModels(); return }
    const relevant = () => currentDevice(device) && !signal.aborted && version === modelReadVersion && directory === target() && visible && modelPicker.open
    models = []; modelLoad = 'loading'; modelFailure = undefined; renderModels()
    try {
      const view = await device.request<AvailableModelsView>(`${app}/models${directory ? `?cwd=${encodeURIComponent(directory)}` : ''}`, undefined, signal)
      if (!relevant()) return
      models = view.models; modelLoad = 'ready'
    } catch (error) {
      if (!relevant()) return
      modelLoad = 'failed'; modelFailure = error
    }
    if (relevant()) renderModels()
  })())
  const enablePanel = async () => { panel.setEnabled(true); await panel.refreshRecent() }
  const loadEnvironment = async (device: DeviceClient, signal?: AbortSignal) => {
    const relevant = () => currentDevice(device) && !signal?.aborted
    const view = await guard(() => device.request<EnvironmentView>(`${app}/environment`, undefined, signal), relevant)
    if (!relevant()) return
    environment.textContent = view?.executable.error?.message ?? ''
    environment.hidden = !environment.textContent
  }
  /** Only an explicit activation may start the execution device's application; selecting a device never does. */
  const ensureProduct = async (activate: boolean, device = client, signal?: AbortSignal): Promise<boolean> => {
    if (!device || !currentDevice(device) || signal?.aborted) return false
    const relevant = () => currentDevice(device) && !signal?.aborted
    let state = await guard(() => device.request<ProductView>('/products/claude-agent', undefined, signal), relevant)
    if (!relevant()) return false
    if (!state) { renderDevices(); i18n.bind(deviceStatus, 'text', () => t('app.deviceStatusFailed')); return false }
    if (activate && state.state !== 'running') state = await guard(() => device.request<ProductView>(state!.state === 'failed' || state!.state === 'blocked' ? '/products/claude-agent/retry' : '/products/claude-agent/open', {}, signal), relevant) ?? state
    if (!relevant()) return false
    productRunning = state.state === 'running'; productState = state.state
    if (!productRunning) panel.setEnabled(false)
    renderDevices(); render()
    return productRunning
  }
  const afterProduct = async (device: DeviceClient, signal?: AbortSignal) => {
    if (!currentDevice(device) || signal?.aborted) return
    await loadEnvironment(device, signal)
    if (!currentDevice(device) || signal?.aborted) return
    await Promise.all([loadThreads(device, signal), enablePanel()])
  }
  const selectClient = (device: DeviceTarget | undefined, activate: boolean, signal?: AbortSignal): Promise<void> => track((async () => {
    if (disposed || signal?.aborted) return
    if (!workspace.canClose()) return
    deviceLifetime.abort(); deviceLifetime = new AbortController()
    stopSubscription(); stopThreadPoll(); panel.setEnabled(false)
    thread = undefined; project = undefined; loadingThread = undefined; transcriptHint.hidden = true; threads = []; history = []; runs = []; current = undefined; live = undefined; pending = []; resetModels(); modelPicker.open = false
    productRunning = false; productState = undefined; environment.hidden = true
    client = device ? createDeviceClient(context.apiBase, device, AbortSignal.any([lifetime.signal, deviceLifetime.signal])) : undefined
    panel.setNativePicker(!!device && localPicker && device.instanceId === localInstanceId)
    renderDevices(); renderThreads(); renderModels(); render(); clearNotice()
    const selected = client
    if (!device || !selected) return
    remember(device.id)
    const requested = route()
    navigate({ hostId: device.instanceId, threadId: requested.hostId === device.instanceId ? requested.threadId : undefined }, true)
    if (!(await ensureProduct(activate, selected, signal))) return
    await afterProduct(selected, signal)
    if (!currentDevice(selected) || signal?.aborted) return
    const threadId = route().threadId
    if (threadId && threads.some(item => item.id === threadId)) await openThread(threadId, true)
    else if (threadId) navigate({ hostId: device.instanceId }, true)
  })())
  /** Each saved connection is asked for its instance capabilities through the gateway; only Claude Agent devices are offered. */
  const probeDevices = async (list: readonly DeviceTarget[], signal: AbortSignal): Promise<Map<string, DeviceProbe | undefined>> => new Map(await Promise.all(list.map(async device => {
    try {
      const info = await createDeviceClient(context.apiBase, device, signal).request<{ capabilities?: unknown }>('/instance', undefined, AbortSignal.timeout(probeTimeoutMs))
      return [device.id, { capabilities: Array.isArray(info?.capabilities) ? info.capabilities.filter((entry): entry is string => typeof entry === 'string') : [] }] as const
    } catch { return [device.id, undefined] as const }
  })))
  /** Refresh the saved directory on activation without resetting a still-valid device's view or observation. */
  const loadDevices = (activate: boolean): Promise<void> => track((async () => {
    deviceDiscovery.abort(); deviceDiscovery = new AbortController()
    const signal = AbortSignal.any([lifetime.signal, deviceDiscovery.signal]), version = ++discoveryVersion
    const relevant = () => !disposed && !signal.aborted && version === discoveryVersion
    const [directory, local] = await Promise.all([guard(() => readDevices(context.apiBase, signal), relevant), readLocal(context.apiBase, signal).catch(() => undefined)])
    if (!directory || !relevant()) return
    const targets: readonly DeviceTarget[] = local?.device ? [local.device, ...directory.connections.filter(item => item.instanceId !== local.device!.instanceId)] : directory.connections
    if (!client) i18n.bind(deviceStatus, 'text', () => targets.length ? t('app.devicesChecking') : '')
    const partition = filterDevices(targets, await probeDevices(targets, signal))
    if (!relevant()) return
    localInstanceId = local?.device ? local.instanceId : directory.localInstanceId
    localPicker = local?.picker === true && local.instanceId === localInstanceId
    localUnavailable = local?.managed === true && !local.device
    i18n.bind(manageConnections, 'text', () => local?.managed ? t('app.remoteConnections') : t('app.connections'))
    // A failed probe is not a removed connection. Keep observing the current instance until its saved identity changes.
    const unchanged = client && targets.find(entry => sameConnection(entry, client!.connection))
    const retained = unchanged && !partition.unsupported.some(entry => entry.id === unchanged.id) ? unchanged : undefined
    devices = retained && !partition.qualified.some(entry => entry.id === retained.id) ? [...partition.qualified, retained] : partition.qualified
    hidden = { unreachable: partition.unreachable.filter(entry => entry.id !== retained?.id).length, unsupported: partition.unsupported.filter(entry => entry.id !== retained?.id).length }
    const requested = route(), selected = devices.find(entry => entry.instanceId === requested.hostId) ?? retained ?? selectDevice(devices, requested, remembered(), localInstanceId)
    if (!client || !selected || !sameConnection(client.connection, selected)) { await selectClient(selected, activate, signal); return }
    const device = client
    panel.setNativePicker(localPicker && device.connection.instanceId === localInstanceId)
    renderDevices()
    if (await ensureProduct(activate, device, signal)) {
      await afterProduct(device, signal)
      if (relevant() && currentDevice(device) && route().threadId && !thread) await openThread(route().threadId, true)
    }
    if (relevant()) scheduleThreadPoll()
  })())
  const decide = async (approval: ApprovalView, decision: 'allow' | 'allow-session' | 'deny', answers?: Record<string, string>) => {
    const device = client
    if (!device) return
    const resolved = await guard(() => device.request<ApprovalView>(`${app}/approvals/${encodeURIComponent(approval.id)}`, { decision, ...(answers ? { answers } : {}) }), () => currentDevice(device))
    if (resolved && currentDevice(device)) { pending = pending.filter(item => item.id !== approval.id); if (thread) updateListEntry(thread.id, { pendingApprovals: pending.length }); render() }
  }
  const submit = (): Promise<void> => track((async () => {
    const device = client
    if (!device || !currentDevice(device) || composerBlock({ hasDevice: true, productRunning, hasTarget: !!target(), runActive: false, submitting })) return
    const text = prompt.value.trim()
    if (!text&&!extras.count()) return
    const selectedModel = model.value.trim(), selectedEffort = effort.value, permissionMode = selectedPermission
    let submittedThread = thread, submittedKey = composerKey!
    const submittedProject = project
    let attachmentKey=submittedKey
    if(activeStatus(current)&&current){
      const run=current,key=composerKey!,content=text
      if(!draft||draft.prompt!==content)draft={prompt:content,key:crypto.randomUUID()};const requestKey=draft.key
      submitting=true;render()
      try{const prepared=await extras.prepare((path,body)=>track(device.request(path,body)),key);await device.request(`${app}/runs/${encodeURIComponent(run.id)}/messages`,{prompt:content,attachmentIds:prepared.ids,idempotencyKey:requestKey});prepared.clear();if(composerKey===key&&prompt.value.trim()===content){prompt.value='';draft=undefined;saveComposer();renderThreads()} }
      catch(error){if(currentDevice(device))show(() => t('app.queueUnconfirmed', { details: messageFor(error, i18n) }))}finally{submitting=false;render()}return
    }
    if (!draft || draft.prompt !== text) draft = { prompt: text, key: crypto.randomUUID() }
    const retry = draft
    saveComposer()
    submitting = true; render()
    try {
      // The same unsent text keeps its key, so a retry after a lost response cannot start a second run.
      if (!submittedThread) {
        // First message in a project: create the thread, then its Run; a failure keeps the prompt as a draft.
        const created = await device.request<ThreadView>(`${app}/threads`, { projectPath: submittedProject })
        if (!currentDevice(device)) return
        threads = [created, ...threads]; submittedThread = created
        const nextKey = targetKey(device, 'thread', created.id)
        extras.move(attachmentKey,nextKey);attachmentKey=nextKey
        const saved = drafts.get(submittedKey)
        if (saved) { drafts.delete(submittedKey); drafts.set(nextKey, saved) }
        if (composerKey === submittedKey) {
          composerKey = nextKey; composerLabel = created.title; thread = created; project = undefined
          navigate({ hostId: device.connection.instanceId, threadId: created.id })
          subscribe(created.id)
        }
        submittedKey = nextKey
        renderThreads(); void panel.refreshRecent()
      }
      const prepared=await extras.prepare((path,body)=>track(device.request(path,body)),attachmentKey)
      const body = { attachmentIds:prepared.ids,prompt: text, idempotencyKey: retry.key, permissionMode, ...(selectedModel ? { model: selectedModel } : {}), ...(selectedEffort ? { effort: selectedEffort } : {}) }
      const run = await device.request<RunView>(`${app}/threads/${encodeURIComponent(submittedThread.id)}/runs`, body)
      if (!currentDevice(device)) return
      prepared.clear()
      const savedDraft = drafts.get(submittedKey)
      if (savedDraft?.retry?.key === retry.key && savedDraft.prompt.trim() === text) drafts.delete(submittedKey)
      if (composerKey === submittedKey) {
        draft = undefined
        if (prompt.value.trim() === text) prompt.value = ''
        resizePrompt(); saveComposer(); followLatest = true
        current = run; live = emptyRunView(run.id, run.threadId); runs = [...runs.filter(item => item.id !== run.id), run]; clearNotice()
      }
      updateListEntry(submittedThread.id, { lastRun: { id: run.id, status: run.status } })
      void reloadThread(submittedThread.id)
    } catch (error) { if (currentDevice(device) && composerKey === submittedKey) show(() => messageFor(error, i18n)) }
    finally { submitting = false; render() }
  })())
  composer.addEventListener('submit', event => { event.preventDefault(); void submit() })
  capabilitiesButton.addEventListener('click', () => capabilities.open('skills', capabilitiesButton))
  skillButton.addEventListener('click', () => capabilities.open('skills', skillButton))
  taskButton.addEventListener('click', () => capabilities.open('agents', taskButton))
  workspaceButton.addEventListener('click', () => { void (async () => { if (!thread && target()) await createThread(target()!, undefined); workspace.open('usage', workspaceButton) })() })
  mcpInteractionButton.addEventListener('click', () => workspace.open('mcp', mcpInteractionButton))
  archivedButton.addEventListener('click', () => { showArchived = !showArchived; renderThreads() })
  prompt.addEventListener('input', () => { resizePrompt(); saveComposer(); render(); renderThreads() })
  model.addEventListener('input', () => { saveComposer(); renderModels() })
  model.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); chooseModel(model.value.trim()) } })
  modelPicker.addEventListener('toggle', () => { if (modelPicker.open) void loadModels(); else stopModelRead() })
  modelPicker.addEventListener('keydown', event => { if (event.key === 'Escape' && modelPicker.open) { event.preventDefault(); event.stopPropagation(); modelPicker.open = false; stopModelRead(); modelSummary.focus() } })
  modelRefresh.addEventListener('click', () => { void loadModels() })
  effort.addEventListener('change', saveComposer)
  prompt.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void submit() } })
  search.addEventListener('input', renderThreads)
  draftsButton.addEventListener('click', () => { saveComposer(); renderDrafts(); draftsDialog.showModal() })
  draftsClose.addEventListener('click', () => draftsDialog.close())
  composerProject.addEventListener('click', () => panel.open())
  transcript.addEventListener('scroll', () => { followLatest = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80; latest.hidden = followLatest })
  latest.addEventListener('click', () => { followLatest = true; transcript.scrollTop = transcript.scrollHeight; latest.hidden = true })
  cancel.addEventListener('click', () => {
    const device = client, runId = current?.id
    if (device && runId) void guard(() => device.request<RunView>(`${app}/runs/${encodeURIComponent(runId)}/cancel`, {}), () => currentDevice(device) && current?.id === runId).then(run => { if (run && currentDevice(device) && current?.id === runId) { current = run; render() } })
  })
  noticeClose.addEventListener('click', clearNotice)
  menuButton.addEventListener('click', () => setDrawer(root.dataset.drawer !== 'open'))
  backdrop.addEventListener('click', closeDrawer)
  root.addEventListener('keydown', event => { if (event.key === 'Escape' && root.dataset.drawer === 'open' && !container.querySelector('dialog[open]')) { closeDrawer(); menuButton.focus() } })
  startButton.addEventListener('click', () => { void track((async () => { const device = client; if (!device && localUnavailable) { await loadDevices(false); return }; if (device && await ensureProduct(true, device)) await afterProduct(device) })()) })
  manageConnections.addEventListener('click', () => {
    if (connectionManager) void track(connectionManager.close())
    connectionManager = openConnectionManager(root, context.apiBase, context.domId, () => disposed || !visible ? Promise.resolve() : loadDevices(false))
    root.querySelector('.ca-connections-dialog')?.setAttribute('lang', 'zh-CN')
  })
  accountButton.addEventListener('click', () => account.open(accountButton))
  deviceSelect.addEventListener('change', () => {
    const device = devices.find(item => item.id === deviceSelect.value)
    if (device && device.id !== client?.connection.id) { deviceDiscovery.abort(); void selectClient(device, false) }
  })
  const unsubscribeRoute = context.route.subscribe(() => {
    const requested = route()
    if (requested.hostId && requested.hostId !== client?.connection.instanceId) { const device = devices.find(item => item.instanceId === requested.hostId); if (device) { deviceDiscovery.abort(); void selectClient(device, false) }; return }
    if (client && requested.threadId !== thread?.id && threads.length) void openThread(requested.threadId, true)
  })
  try { await loadDevices(false) } catch (error) { i18n.dispose(); throw error }
  return {
    async setActive(active: boolean, reason: ApplicationActivation) {
      if (disposed) return
      visible = active
      // Deactivation cancels only discovery/open intent; an already selected thread keeps observing its Run.
      if (!active) { account.close(); workspace.hide(); deviceDiscovery.abort(); panel.close(); capabilities.close(); sessionPermissions.close(); permissionPicker.close(); if (connectionManager) void track(connectionManager.close()); for (const dialog of container.querySelectorAll<HTMLDialogElement>('dialog[open]')) dialog.close(); modelPicker.open = false; stopModelRead(); closeDrawer(); stopThreadPoll(); return }
      await loadDevices(reason === 'open')
    },
    canClose: () => { saveComposer(); return !submitting && !prompt.value.trim() && drafts.size === 0 && !extras.hasDrafts() && workspace.canClose() },
    dispose() {
      if (disposal) return disposal
      disposed = true; i18n.dispose(); account.dispose(); workspace.dispose(); extras.dispose(); capabilities.dispose(); sessionPermissions.dispose(); permissionPicker.close(); if (connectionManager) void track(connectionManager.close()); unsubscribeRoute(); stopSubscription(); stopThreadPoll(); panel.dispose(); deviceDiscovery.abort(); deviceLifetime.abort(); stopModelRead(); lifetime.abort(); context.signal.removeEventListener('abort', abort); container.replaceChildren()
      disposal = Promise.allSettled([...tasks]).then(() => {})
      return disposal
    },
  }
}
