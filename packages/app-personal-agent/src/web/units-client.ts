import type { EnvironmentInventoryTarget } from '@anybox/execution-environments/management'
import type { Api } from './client-types.js'
import type { UnitAttachment, UnitScope } from '../core/unit/domain.js'
import type { ComputerEnvironment, ComputerEnvironments } from '../core/computer/environments.js'
import { createPageRequests } from './page-lifecycle.js'
import type { LocalComputerWorkerStatus } from '../core/computer/worker-port.js'

const environmentLabel = (environment: ComputerEnvironment): string => environment.origin === 'local' ? '本机（默认）'
  : `远端环境 · ${environment.platform ?? '平台待确认'}${environment.architecture ? `/${environment.architecture}` : ''} · ${environment.environmentId.slice(0, 8)}`
const environmentStateLabel = (environment: ComputerEnvironment): string => ({
  'on-demand': '按需启动', connected: '已连接', offline: '离线', pending: '等待附着', revoked: '已撤销',
})[environment.connectionState]

/** Owner-side unit attachments of one fixed device: list, issue one-time attach codes, revoke. */
export interface UnitsSettingsView {
  canLeave(): boolean
  refresh(): Promise<void>
  issue(input: { readonly projects: readonly string[]; readonly tools: readonly string[] }): Promise<string>
  revoke(attachmentId: string): Promise<void>
  readonly snapshot: () => { readonly attachments: readonly UnitAttachment[]; readonly notice: string; readonly code: string }
  dispose(): Promise<void>
}
/** Newline- or comma-separated absolute paths; empty means every project. */
export function parseGrantList(value: string): readonly string[] {
  return Object.freeze([...new Set(value.split(/[\n,]/).map(item => item.trim()).filter(Boolean))])
}
export function computerScope(projects: readonly string[], tools: readonly string[]): UnitScope {
  return { kind: 'computer', projects: projects.length ? projects : 'all', tools: tools.length ? tools : 'all' }
}
const stateLabels: Record<UnitAttachment['state'], string> = { pending: '等待单元消费附着码', approved: '已批准', revoked: '已撤销' }
export function describeAttachment(attachment: UnitAttachment): string {
  const scope = attachment.scope ?? attachment.requestedScope
  const grants = scope.kind === 'computer' ? `目录 ${scope.projects === 'all' ? '不限' : scope.projects.join('、')} · 工具 ${scope.tools === 'all' ? '不限' : scope.tools.join('、')}`
    : `${scope.access === 'manage' ? '管理' : '执行'} · 模型配置 ${scope.configurations === 'all' ? '不限' : scope.configurations.join('、')}`
  return `${attachment.unitKind === 'computer' ? 'Computer' : 'Models'} · ${attachment.origin === 'local' ? '本机' : attachment.unitId ?? '未知单元'} · ${stateLabels[attachment.state]} · epoch ${attachment.epoch} · ${grants}`
}

/** A worker attachment as the device's own worker reports it, with the dial-out connection state. */
export interface LocalAttachmentView {
  readonly attachmentId: string; readonly harnessUrl: string; readonly instanceId: string; readonly state: 'approved' | 'revoked'
  readonly ceiling: Extract<UnitScope, { kind: 'computer' }>; readonly connection: 'connected' | 'connecting' | 'offline' | 'instance-mismatch' | 'revoked'; readonly lastError: string | null
}
const connectionLabels: Record<LocalAttachmentView['connection'], string> = { connected: '已连接', connecting: '正在连接', offline: '离线', 'instance-mismatch': '对方实例已改变', revoked: '已撤销' }
export function describeLocalAttachment(attachment: LocalAttachmentView): string {
  return `${attachment.harnessUrl} · ${connectionLabels[attachment.connection]}${attachment.lastError ? `（${attachment.lastError}）` : ''} · 目录 ${attachment.ceiling.projects === 'all' ? '不限' : attachment.ceiling.projects.join('、')} · 工具 ${attachment.ceiling.tools === 'all' ? '不限' : attachment.ceiling.tools.join('、')}`
}
export interface LocalAttachmentsView {
  canLeave(): boolean
  refresh(): Promise<void>
  start(): Promise<void>
  attach(input: { readonly harnessUrl: string; readonly code: string; readonly projects: readonly string[]; readonly tools: readonly string[] }): Promise<LocalAttachmentView>
  permissions(attachmentId: string, input: { readonly projects: 'all' | readonly string[]; readonly tools: 'all' | readonly string[] }): Promise<void>
  revoke(attachmentId: string): Promise<void>
  readonly snapshot: () => { readonly attachments: readonly LocalAttachmentView[]; readonly notice: string }
  dispose(): Promise<void>
}
/** Local client management, independent of every saved Personal Agent 执行服务 connection. */
export function setupLocalAttachments(source: Api, messageFor: (error: unknown) => string, section: HTMLElement, deviceName: string): LocalAttachmentsView {
  const requests = createPageRequests(source), api = requests.api
  let attachments: readonly LocalAttachmentView[] = [], notice = '', disposed = false, busy = false, running = false, supported = true, unavailable = false, restartRequired = false
  let disposal: Promise<void> | undefined
  section.replaceChildren()
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag)
    if (text !== undefined) node.textContent = text
    if (className) node.className = className
    return node
  }
  const title = el('h3', `${deviceName} · Computer worker`), hint = el('p', '允许远端 Agent 使用本机执行工具。附着码由对方在“执行环境”设置中生成。此入口管理客户端服务所在设备，无须启动本机 Personal Agent 执行服务。', 'settings-hint')
  const workerStatus = el('p', '正在读取状态…'), startButton = el('button', '启动 Computer worker'), refreshButton = el('button', '刷新状态')
  workerStatus.setAttribute('role', 'status'); startButton.type = refreshButton.type = 'button'; startButton.disabled = true
  const list = el('div', undefined, 'units-list'), status = el('p', undefined, 'notice'); status.hidden = true
  const form = el('form', undefined, 'settings-card')
  const urlLabel = el('label', '远端 Personal Agent 执行服务 地址（HTTPS）'), urlInput = el('input'); urlInput.type = 'url'; urlInput.required = true; urlLabel.append(urlInput)
  const codeLabel = el('label', '附着码'), codeInput = el('input'); codeInput.type = 'password'; codeInput.required = true; codeLabel.append(codeInput)
  const projectsLabel = el('label', '允许对方访问的目录（每行一个绝对路径，留空表示不限）'), projectsInput = el('textarea'); projectsInput.rows = 3; projectsLabel.append(projectsInput)
  const toolsLabel = el('label', '允许对方使用的工具契约 ID（逗号分隔，留空表示不限）'), toolsInput = el('input'); toolsInput.type = 'text'; toolsLabel.append(toolsInput)
  const attachButton = el('button', '附着', 'primary-button'); attachButton.type = 'submit'
  form.append(urlLabel, codeLabel, projectsLabel, toolsLabel, attachButton)
  const controls = el('div', undefined, 'settings-actions'); controls.append(startButton, refreshButton)
  section.append(title, hint, workerStatus, controls, status, list, form)
  const setNotice = (message: string) => { notice = message; status.textContent = message; status.hidden = !message }
  const render = () => {
    if (disposed) return
    list.replaceChildren(...attachments.map(attachment => {
      const row = el('section', undefined, 'settings-card unit-row'); row.dataset.attachmentId = attachment.attachmentId
      row.append(el('strong', attachment.attachmentId), el('p', describeLocalAttachment(attachment)))
      if (attachment.state === 'approved') {
        const edit = el('button', '配置权限'); edit.type = 'button'
        edit.addEventListener('click', () => {
          if (busy) return
          const editor = el('form'), projectLabel = el('label', '允许访问的目录（每行一个，留空表示不允许）'), projects = el('textarea')
          projects.rows = 3; projects.value = attachment.ceiling.projects === 'all' ? '' : attachment.ceiling.projects.join('\n'); projectLabel.append(projects)
          const allProjectsLabel = el('label', '不限目录', 'computer-grant-toggle'), allProjects = el('input'); allProjects.type = 'checkbox'; allProjects.checked = attachment.ceiling.projects === 'all'; allProjectsLabel.append(allProjects)
          const toolLabel = el('label', '工具契约 ID（逗号分隔，留空表示不允许）'), tools = el('input')
          tools.value = attachment.ceiling.tools === 'all' ? '' : attachment.ceiling.tools.join(', '); toolLabel.append(tools)
          const allToolsLabel = el('label', '不限工具', 'computer-grant-toggle'), allTools = el('input'); allTools.type = 'checkbox'; allTools.checked = attachment.ceiling.tools === 'all'; allToolsLabel.append(allTools)
          projects.disabled = allProjects.checked; tools.disabled = allTools.checked
          allProjects.addEventListener('change', () => { projects.disabled = allProjects.checked }); allTools.addEventListener('change', () => { tools.disabled = allTools.checked })
          const save = el('button', '保存权限并停止当前执行'); save.type = 'submit'
          const cancel = el('button', '取消'); cancel.type = 'button'
          cancel.addEventListener('click', () => render())
          editor.append(allProjectsLabel, projectLabel, allToolsLabel, toolLabel, el('p', '保存后会取消并等待该附着的当前工具执行退出。新请求使用新的权限上限。', 'settings-hint'), save, cancel)
          editor.addEventListener('submit', event => { event.preventDefault(); void view.permissions(attachment.attachmentId, { projects: allProjects.checked ? 'all' : parseGrantList(projects.value), tools: allTools.checked ? 'all' : parseGrantList(tools.value) }).catch(() => {}) })
          row.replaceChildren(el('strong', attachment.harnessUrl), editor)
        })
        const revoke = el('button', '撤销附着'); revoke.type = 'button'
        revoke.addEventListener('click', () => { void view.revoke(attachment.attachmentId).catch(() => {}) })
        row.append(edit, revoke)
      }
      return row
    }))
    if (!attachments.length && running) list.append(el('p', '这台设备尚未附着到其他 Personal Agent 执行服务。'))
  }
  const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
    if (busy) throw Object.assign(new Error('busy'), { status: 409, code: 'product-busy' })
    if (disposed) throw new Error('view-disposed')
    busy = true; attachButton.disabled = startButton.disabled = refreshButton.disabled = true
    try { return await work() } catch (error) { setNotice(messageFor(error)); throw error }
    finally { busy = false; attachButton.disabled = !running || restartRequired; startButton.disabled = running || !supported || unavailable; refreshButton.disabled = false }
  }
  const view: LocalAttachmentsView = {
    canLeave: () => !busy && !requests.writing,
    async refresh() {
      try {
        const value = await api<Omit<LocalComputerWorkerStatus, 'attachments'> & { attachments: readonly LocalAttachmentView[] }>('/computer/status')
        if (disposed) return
        restartRequired = value.state === 'restart-required'
        running = value.state === 'running' || restartRequired; supported = value.supported; unavailable = value.state === 'unavailable'; attachments = value.attachments
        workerStatus.textContent = restartRequired ? 'Computer worker 的版本或运行条件已变化，已暂停新工具调用。请在任务退出后停止并重新启动 worker。'
          : !supported ? '当前平台尚不支持 Computer worker。' : running ? `运行中 · ${value.workerId}` : value.state === 'stopped' ? '尚未启动。启动后可查看和管理附着。' : '无法连接本机 worker，请检查进程状态后刷新。'
        startButton.hidden = running; startButton.disabled = busy || !supported || value.state === 'unavailable'
        form.hidden = !running || restartRequired; attachButton.disabled = !running || restartRequired || busy; setNotice('')
      }
      catch (error) { if (!disposed) setNotice(messageFor(error)) }
      render()
    },
    start: () => guarded(async () => { await api('/computer/start', {}); await view.refresh() }),
    attach: input => guarded(async () => {
      codeInput.value = ''
      const attached = await api<LocalAttachmentView>('/computer/attachments', { harnessUrl: input.harnessUrl, code: input.code, ceiling: computerScope(input.projects, input.tools) })
      await view.refresh()
      return attached
    }),
    permissions: (attachmentId, input) => guarded(async () => { await api(`/computer/attachments/${encodeURIComponent(attachmentId)}/permissions`, { ceiling: { kind: 'computer', ...input } }); await view.refresh() }),
    revoke: attachmentId => guarded(async () => { await api(`/computer/attachments/${encodeURIComponent(attachmentId)}/revoke`, {}); await view.refresh() }),
    snapshot: () => ({ attachments, notice }),
    dispose() {
      if (disposal) return disposal
      disposed = true; codeInput.value = ''; section.replaceChildren()
      return disposal = requests.dispose()
    },
  }
  form.hidden = true
  startButton.addEventListener('click', () => { void view.start().catch(() => {}) })
  refreshButton.addEventListener('click', () => { if (!busy) void view.refresh() })
  form.addEventListener('submit', event => {
    event.preventDefault()
    const code = codeInput.value
    void view.attach({ harnessUrl: urlInput.value.trim(), code: code.trim(), projects: parseGrantList(projectsInput.value), tools: parseGrantList(toolsInput.value) }).catch(() => {})
  })
  void view.refresh()
  return view
}

export function setupUnitsSettings(source: Api, messageFor: (error: unknown) => string, panel: HTMLElement): UnitsSettingsView {
  const requests = createPageRequests(source), api = requests.api
  let attachments: readonly UnitAttachment[] = [], environments: readonly ComputerEnvironment[] = [], notice = '', code = '', disposed = false, busy = false
  let targets: readonly EnvironmentInventoryTarget[] = [], catalogNotice = '', refreshEpoch = 0
  let disposal: Promise<void> | undefined
  panel.replaceChildren()
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag)
    if (text !== undefined) node.textContent = text
    if (className) node.className = className
    return node
  }
  const heading = el('header', undefined, 'settings-panel-heading'), title = el('h3', '执行环境'); title.id = 'personal-agent--units-title'
  heading.append(title, el('p', 'Agent 在执行服务所在的机器上使用自己的工作目录。这里也可管理已附着的远端环境。附着码只显示一次，请在远端设备的“管理连接”中输入。'))
  const refreshButton = el('button', '刷新执行环境'); refreshButton.type = 'button'; heading.append(refreshButton)
  const list = el('div', undefined, 'units-list'), status = el('p', undefined, 'notice'); status.hidden = true
  const form = el('form', undefined, 'settings-card'), formTitle = el('h3', '生成 Computer 附着码')
  const projectsLabel = el('label', '允许访问的目录（每行一个绝对路径，留空表示不限）'), projectsInput = el('textarea'); projectsInput.rows = 3; projectsLabel.append(projectsInput)
  const toolsLabel = el('label', '允许的工具契约 ID（逗号分隔，留空表示不限）'), toolsInput = el('input'); toolsInput.type = 'text'; toolsLabel.append(toolsInput)
  const issueButton = el('button', '生成附着码', 'primary-button'); issueButton.type = 'submit'
  const once = el('p', undefined, 'token-once'); once.hidden = true
  form.append(formTitle, projectsLabel, toolsLabel, issueButton, once)
  const catalog = el('div', undefined, 'units-list')
  panel.append(heading, status, list, catalog, form)
  const setNotice = (message: string) => { notice = message; status.textContent = message; status.hidden = !message }
  const render = () => {
    if (disposed) return
    list.replaceChildren(...environments.map(environment => {
      const attachment = attachments.find(value => value.attachmentId === environment.environmentId)
      const row = el('section', undefined, 'settings-card unit-row')
      row.dataset.attachmentId = environment.environmentId
      const label = el('strong', environmentLabel(environment)); label.title = `${environment.environmentId}${environment.unitId ? ` · ${environment.unitId}` : ''}`
      const details = el('details'); details.append(el('summary', '身份与权限'), el('p', environment.environmentId))
      if (attachment) details.append(el('p', describeAttachment(attachment)))
      const support = environment.toolSupport
      details.append(el('p', support?.state === 'reported'
        ? 'Worker 最近报告的工具：' + (support.manifest.tools.map(tool => tool.toolId).join('、') || '无')
        : '尚未收到可用的 Worker 工具报告。'))
      details.append(el('p', '命令以执行设备的系统账户运行。项目目录限制用于工具准入，不提供操作系统级文件隔离。'))
      row.append(label, el('p', environmentStateLabel(environment)), details)
      if (environment.origin === 'remote' && environment.state !== 'revoked') {
        const revoke = el('button', '撤销附着'); revoke.type = 'button'
        revoke.addEventListener('click', () => { void view.revoke(environment.environmentId).catch(() => {}) })
        row.append(revoke)
      }
      return row
    }))
    if (!environments.length) list.append(el('p', notice ? '无法读取执行环境，请重试。' : '尚无执行环境。'))
    catalog.replaceChildren(el('h4', '可授予 Agent 的工具'))
    if (catalogNotice) catalog.append(el('p', catalogNotice))
    else if (!targets.length) catalog.append(el('p', '尚无可授权的工具目标。'))
    for (const target of targets) {
      const details = el('details', undefined, 'settings-card')
      details.append(el('summary', target.name + ' · ' + target.environmentId), el('p', target.targetId),
        el('p', target.tools.map(tool => tool.toolId).join('、')))
      if (target.agents.length) for (const agent of target.agents) {
        details.append(el('p', (agent.name || agent.id) + ' 已获授权：' + agent.toolIds.join('、')))
      }
      else details.append(el('p', '尚无 Agent 获得此目标的工具授权。'))
      catalog.append(details)
    }
  }
  const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
    if (busy) throw Object.assign(new Error('busy'), { status: 409, code: 'product-busy' })
    busy = true; issueButton.disabled = true
    try { return await work() } catch (error) { setNotice(messageFor(error)); throw error }
    finally { busy = false; issueButton.disabled = false }
  }
  const view: UnitsSettingsView = {
    canLeave: () => !busy && !requests.writing,
    async refresh() {
      const epoch = ++refreshEpoch
      try {
        const [values, projection] = await Promise.all([
          Promise.all([api<readonly UnitAttachment[]>('/units/attachments'), api<ComputerEnvironments>('/computer-environments')]),
          api<readonly EnvironmentInventoryTarget[]>('/tool-environments').then(
            entries => ({ entries, notice: '' }), error => ({ entries: [], notice: messageFor(error) })),
        ])
        if (disposed || epoch !== refreshEpoch) return
        targets = projection.entries
        catalogNotice = projection.notice
        if (!Array.isArray(values[1]?.environments)) throw Object.assign(new Error('computer-environments-unavailable'), { code: 'computer-environments-unavailable' })
        attachments = values[0].filter(value => value.unitKind === 'computer'); environments = values[1].environments; setNotice('')
      }
      catch (error) { if (!disposed && epoch === refreshEpoch) setNotice(messageFor(error)) }
      if (epoch === refreshEpoch) render()
    },
    issue: input => guarded(async () => {
      const issued = await api<{ attachment: UnitAttachment; code: string }>('/units/attach-codes', { unitKind: 'computer', scope: computerScope(input.projects, input.tools) })
      code = issued.code
      once.textContent = `仅本次显示，请在远端设备的“管理连接”中填入：${issued.code}`; once.hidden = false
      await view.refresh()
      return issued.code
    }),
    revoke: attachmentId => guarded(async () => { await api(`/units/attachments/${encodeURIComponent(attachmentId)}/revoke`, {}); await view.refresh() }),
    snapshot: () => ({ attachments, notice, code }),
    dispose() {
      if (disposal) return disposal
      disposed = true; code = ''; once.textContent = ''; panel.replaceChildren()
      return disposal = requests.dispose()
    },
  }
  form.addEventListener('submit', event => {
    event.preventDefault()
    void view.issue({ projects: parseGrantList(projectsInput.value), tools: parseGrantList(toolsInput.value) }).catch(() => {})
  })
  refreshButton.addEventListener('click', () => { if (!busy) void view.refresh() })
  void view.refresh()
  return view
}
