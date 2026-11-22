import type { EnvironmentInventoryTarget } from '@anybox/execution-environments/management'
import type { Api } from './client-types.js'
import type { UnitAttachment, UnitScope } from '../core/unit/domain.js'
import type { ComputerEnvironment, ComputerEnvironments } from '../core/computer/environments.js'
import { environmentLabel, environmentStateLabel } from './project-directory-client.js'
import { createPageRequests } from './page-lifecycle.js'
import type { LocalComputerWorkerStatus } from '../core/computer/worker-port.js'

/** Owner-side unit attachments of one fixed device: list, issue one-time attach codes, revoke. */
export interface UnitsSettingsView {
  canLeave(): boolean
  refresh(): Promise<void>
  issue(input: { readonly projects: readonly string[]; readonly tools: readonly string[] }): Promise<string>
  revoke(attachmentId: string): Promise<void>
  readonly snapshot: () => { readonly attachments: readonly UnitAttachment[]; readonly notice: string; readonly code: string }
  close(): Promise<void>
  closeLocalComputer(): Promise<void>
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
/** Local client management, independent of every saved harness server connection. */
export function setupLocalAttachments(source: Api, messageFor: (error: unknown) => string, section: HTMLElement, deviceName: string, close?: () => void): LocalAttachmentsView {
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
  const title = el('h5', `${deviceName} · Computer worker`)
  const workerStatus = el('span', '正在读取状态…', 'execution-environment-status')
  const startButton = el('button', '启动 Computer worker', 'secondary-button'), refreshButton = el('button', '刷新状态', 'secondary-button')
  workerStatus.setAttribute('role', 'status'); startButton.type = refreshButton.type = 'button'; startButton.disabled = true
  const header = el('div', undefined, 'execution-environment-toolbar')
  const workerHeading = el('div', undefined, 'execution-environment-row-heading'); workerHeading.append(title, workerStatus)
  const list = el('div', undefined, 'units-list'), status = el('p', undefined, 'notice'); status.hidden = true
  const connection = el('details', undefined, 'execution-environment-disclosure'); connection.hidden = true
  const form = el('form', undefined, 'execution-environment-form')
  const urlLabel = el('label', '目标执行设备地址（HTTPS）'), urlInput = el('input'); urlInput.type = 'url'; urlInput.required = true; urlLabel.append(urlInput)
  const codeLabel = el('label', '附着码'), codeInput = el('input'); codeInput.type = 'password'; codeInput.required = true; codeInput.autocomplete = 'off'; codeLabel.append(codeInput)
  const projectsLabel = el('label', '允许对方使用的项目目录（每行一个绝对路径，留空表示不限）'), projectsInput = el('textarea'); projectsInput.rows = 3; projectsLabel.append(projectsInput)
  const toolsLabel = el('label', '允许对方使用的工具契约 ID（逗号分隔，留空表示不限）'), toolsInput = el('input'); toolsInput.type = 'text'; toolsLabel.append(toolsInput)
  const attachButton = el('button', '附着', 'primary-button'); attachButton.type = 'submit'
  form.append(el('p', '在对方执行设备的「执行环境」中生成附着码，再填写地址和附着码。', 'settings-hint'), urlLabel, codeLabel, projectsLabel, toolsLabel, attachButton)
  connection.append(el('summary', '连接到其他执行设备'), form)
  const controls = el('div', undefined, 'settings-actions'); controls.append(startButton, refreshButton)
  const closeButton = close && el('button', '收起', 'secondary-button')
  if (close && closeButton) {
    closeButton.type = 'button'
    closeButton.addEventListener('click', close)
    controls.append(closeButton)
  }
  header.append(workerHeading, controls)
  section.append(header, status, connection, list)
  closeButton?.focus()
  const setNotice = (message: string) => { notice = message; status.textContent = message; status.hidden = !message }
  const render = () => {
    if (disposed) return
    list.hidden = !running && !attachments.length
    list.replaceChildren(...attachments.map(attachment => {
      const row = el('section', undefined, 'settings-card unit-row'); row.dataset.attachmentId = attachment.attachmentId
      const heading = el('div', undefined, 'execution-environment-row-heading')
      const badge = el('span', connectionLabels[attachment.connection], 'execution-environment-status'); badge.dataset.state = attachment.connection
      heading.append(el('strong', attachment.harnessUrl), badge)
      const details = el('details', undefined, 'execution-environment-disclosure')
      details.append(el('summary', '身份与权限'), el('p', attachment.attachmentId), el('p', describeLocalAttachment(attachment)))
      row.append(heading, details)
      if (attachment.state === 'approved') {
        const edit = el('button', '配置权限', 'secondary-button'); edit.type = 'button'
        edit.addEventListener('click', () => {
          if (busy) return
          const editor = el('form', undefined, 'execution-environment-form'), projectLabel = el('label', '项目目录（每行一个，留空表示不允许）'), projects = el('textarea')
          projects.rows = 3; projects.value = attachment.ceiling.projects === 'all' ? '' : attachment.ceiling.projects.join('\n'); projectLabel.append(projects)
          const allProjectsLabel = el('label', '不限项目目录', 'computer-grant-toggle'), allProjects = el('input'); allProjects.type = 'checkbox'; allProjects.checked = attachment.ceiling.projects === 'all'; allProjectsLabel.append(allProjects)
          const toolLabel = el('label', '工具契约 ID（逗号分隔，留空表示不允许）'), tools = el('input')
          tools.value = attachment.ceiling.tools === 'all' ? '' : attachment.ceiling.tools.join(', '); toolLabel.append(tools)
          const allToolsLabel = el('label', '不限工具', 'computer-grant-toggle'), allTools = el('input'); allTools.type = 'checkbox'; allTools.checked = attachment.ceiling.tools === 'all'; allToolsLabel.append(allTools)
          projects.disabled = allProjects.checked; tools.disabled = allTools.checked
          allProjects.addEventListener('change', () => { projects.disabled = allProjects.checked }); allTools.addEventListener('change', () => { tools.disabled = allTools.checked })
          const save = el('button', '保存权限并停止当前执行', 'primary-button'); save.type = 'submit'
          const cancel = el('button', '取消', 'secondary-button'); cancel.type = 'button'
          cancel.addEventListener('click', () => render())
          editor.append(allProjectsLabel, projectLabel, allToolsLabel, toolLabel, el('p', '保存后会取消并等待该附着的当前工具执行退出。新请求使用新的权限上限。', 'settings-hint'), save, cancel)
          editor.addEventListener('submit', event => { event.preventDefault(); void view.permissions(attachment.attachmentId, { projects: allProjects.checked ? 'all' : parseGrantList(projects.value), tools: allTools.checked ? 'all' : parseGrantList(tools.value) }).catch(() => {}) })
          row.replaceChildren(el('strong', attachment.harnessUrl), editor)
        })
        const revoke = el('button', '撤销附着', 'secondary-button'); revoke.type = 'button'
        revoke.addEventListener('click', () => { void view.revoke(attachment.attachmentId).catch(() => {}) })
        const actions = el('div', undefined, 'settings-actions'); actions.append(edit, revoke); row.append(actions)
      }
      return row
    }))
    if (running && !attachments.length) list.append(el('p', '尚未连接到其他执行设备。', 'settings-hint'))
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
        workerStatus.textContent = restartRequired ? '需要重启' : !supported ? '当前平台不支持' : running ? '运行中' : unavailable ? '无法连接' : '尚未启动'
        workerStatus.dataset.state = value.state
        workerStatus.title = value.workerId ?? ''
        startButton.hidden = running; startButton.disabled = busy || !supported || value.state === 'unavailable'
        connection.hidden = !running || restartRequired
        if (connection.hidden) { connection.open = false; codeInput.value = '' }
        attachButton.disabled = connection.hidden || busy
        setNotice(restartRequired ? 'Computer worker 的版本或运行条件已变化，已暂停新工具调用。请在任务退出后停止并重新启动 worker。'
          : unavailable ? '无法连接本机 worker，请检查进程状态后刷新。' : '')
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
  startButton.addEventListener('click', () => { void view.start().catch(() => {}) })
  refreshButton.addEventListener('click', () => { if (!busy) void view.refresh() })
  connection.addEventListener('toggle', () => { if (!connection.open) codeInput.value = '' })
  form.addEventListener('submit', event => {
    event.preventDefault()
    const code = codeInput.value.trim()
    codeInput.value = ''
    void view.attach({ harnessUrl: urlInput.value.trim(), code, projects: parseGrantList(projectsInput.value), tools: parseGrantList(toolsInput.value) }).catch(() => {})
  })
  void view.refresh()
  return view
}

/** The local worker panel opens on demand and its submitted writes survive closing the settings dialog. */
export function setupLocalComputerSettings(source: Api, messageFor: (error: unknown) => string, section: HTMLElement) {
  const open = document.createElement('button'), panel = document.createElement('section')
  open.type = 'button'; open.textContent = '管理本机 Computer worker'; open.className = 'secondary-button'; open.dataset.computer = ''
  panel.className = 'computer-management'; panel.dataset.attachments = ''; panel.hidden = true
  section.append(open, panel)
  let view: LocalAttachmentsView | undefined, exit: Promise<void> | undefined
  let joiningWrite = false, disposed = false
  const close = (restoreFocus = false) => {
    if (!view) return exit ?? Promise.resolve()
    const previous = view; view = undefined
    joiningWrite = !previous.canLeave()
    panel.hidden = true; open.hidden = false; open.disabled = true
    return exit = previous.dispose().finally(() => {
      exit = undefined; joiningWrite = false; open.disabled = disposed
      if (restoreFocus && !disposed) open.focus()
    })
  }
  open.addEventListener('click', () => {
    if (disposed || view || exit) return
    panel.hidden = false; open.hidden = true
    view = setupLocalAttachments(source, messageFor, panel, '本机', () => { void close(true) })
  })
  return {
    canLeave: () => !joiningWrite && (view?.canLeave() ?? true), close,
    dispose() { disposed = true; return close() },
  }
}

export function setupUnitsSettings(source: Api | undefined, messageFor: (error: unknown) => string, panel: HTMLElement, localSource?: Api): UnitsSettingsView {
  const requests = source ? createPageRequests(source) : undefined, api = requests?.api
  let attachments: readonly UnitAttachment[] = [], environments: readonly ComputerEnvironment[] = [], notice = '', code = '', disposed = false, busy = false
  let targets: readonly EnvironmentInventoryTarget[] = [], catalogNotice = '', refreshEpoch = 0, issueEpoch = 0
  let disposal: Promise<void> | undefined
  panel.replaceChildren()
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag)
    if (text !== undefined) node.textContent = text
    if (className) node.className = className
    return node
  }
  const heading = el('header', undefined, 'settings-panel-heading'), title = el('h3', '执行环境'); title.id = 'agent--units-title'
  const titleRow = el('div', undefined, 'settings-title-row'); titleRow.append(title)
  heading.append(titleRow, el('p', '执行环境决定 Agent 的工具在哪里运行。'))
  panel.append(heading)

  const computerSection = el('section', undefined, 'execution-environment-section')
  const computerHeading = el('div', undefined, 'execution-environment-toolbar')
  const refreshButton = el('button', '刷新', 'secondary-button'); refreshButton.type = 'button'
  refreshButton.setAttribute('aria-label', '刷新执行环境')
  computerHeading.append(el('h4', '文件与命令在哪台电脑上运行'))
  if (api) computerHeading.append(refreshButton)
  computerSection.append(computerHeading)
  const list = el('div', undefined, 'units-list'), status = el('p', undefined, 'notice'); status.hidden = true
  const issueDetails = el('details', undefined, 'execution-environment-disclosure')
  const form = el('form', undefined, 'execution-environment-form')
  const projectsLabel = el('label', '允许的项目目录（每行一个绝对路径，留空表示不限）'), projectsInput = el('textarea'); projectsInput.rows = 3; projectsLabel.append(projectsInput)
  const toolsLabel = el('label', '允许的工具契约 ID（逗号分隔，留空表示不限）'), toolsInput = el('input'); toolsInput.type = 'text'; toolsLabel.append(toolsInput)
  const issueButton = el('button', '生成附着码', 'primary-button'); issueButton.type = 'submit'
  const once = el('p', undefined, 'token-once'); once.hidden = true
  form.append(el('p', '在另一台电脑上打开「管理本机 Computer worker」，填入此执行设备的地址和生成的附着码。', 'settings-hint'), projectsLabel, toolsLabel, issueButton, once)
  issueDetails.append(el('summary', '接入另一台电脑'), form)
  const catalog = el('div', undefined, 'units-list')
  panel.append(computerSection)
  if (api) {
    computerSection.append(el('p', '「本机」指所选执行设备所在的电脑。每个项目在创建时选择一台电脑。', 'settings-hint'), status, list, issueDetails)
    const catalogSection = el('section', undefined, 'execution-environment-section')
    catalogSection.append(el('h4', '由哪些环境提供工具'), el('p', '在「Agent 工具」中管理每个 Agent 的授权和偏好。', 'settings-hint'), catalog)
    panel.append(catalogSection)
  } else {
    computerSection.append(el('p', '尚无可用的执行设备。可在「管理连接」中检查连接并启动 Agent。', 'settings-hint'))
  }
  const localSection = localSource && el('section', undefined, 'execution-environment-section')
  if (localSection) {
    localSection.append(el('h4', '客户端电脑'), el('p', '检查客户端电脑的工具服务，或将这台电脑提供给其他执行设备。', 'settings-hint'))
    panel.append(localSection)
  }
  const localComputer = localSource && localSection ? setupLocalComputerSettings(localSource, messageFor, localSection) : undefined
  const closeLocalComputer = () => localComputer?.close() ?? Promise.resolve()
  const clearIssuedCode = () => { issueEpoch++; code = ''; once.textContent = ''; once.hidden = true }
  const setNotice = (message: string) => { notice = message; status.textContent = message; status.hidden = !message }
  const render = () => {
    if (disposed) return
    list.replaceChildren(...environments.map(environment => {
      const attachment = attachments.find(value => value.attachmentId === environment.environmentId)
      const row = el('section', undefined, 'settings-card unit-row')
      row.dataset.attachmentId = environment.environmentId
      const label = el('strong', environmentLabel(environment)); label.title = `${environment.environmentId}${environment.unitId ? ` · ${environment.unitId}` : ''}`
      const badge = el('span', environmentStateLabel(environment), 'execution-environment-status'); badge.dataset.state = environment.connectionState
      const rowHeading = el('div', undefined, 'execution-environment-row-heading'); rowHeading.append(label, badge)
      const details = el('details', undefined, 'execution-environment-disclosure'); details.append(el('summary', '身份与权限'), el('p', environment.environmentId))
      if (attachment) details.append(el('p', describeAttachment(attachment)))
      const support = environment.toolSupport
      details.append(el('p', support?.state === 'reported'
        ? 'Worker 最近报告的工具：' + (support.manifest.tools.map(tool => tool.toolId).join('、') || '无')
        : '尚未收到可用的 Worker 工具报告。'))
      details.append(el('p', '命令以执行设备的系统账户运行。项目目录限制用于工具准入，不提供操作系统级文件隔离。'))
      row.append(rowHeading, details)
      if (environment.origin === 'remote' && environment.state !== 'revoked') {
        const revoke = el('button', '撤销附着', 'secondary-button'); revoke.type = 'button'
        revoke.addEventListener('click', () => { void view.revoke(environment.environmentId).catch(() => {}) })
        details.append(revoke)
      }
      return row
    }))
    if (!environments.length) list.append(el('p', notice ? '无法读取执行环境，请重试。' : '尚无执行环境。'))
    catalog.replaceChildren()
    if (catalogNotice) catalog.append(el('p', catalogNotice))
    else if (!targets.length) catalog.append(el('p', '尚无可授权的工具目标。'))
    for (const target of targets) {
      const details = el('details', undefined, 'settings-card execution-environment-disclosure')
      const name = target.environmentId === 'mcp' ? `MCP · ${target.name}` : target.name
      details.append(el('summary', name), el('p', `${target.environmentId} · ${target.targetId}`),
        el('p', target.tools.map(tool => tool.toolId).join('、')))
      if (target.agents.length) for (const agent of target.agents) {
        details.append(el('p', (agent.name || agent.id) + ' 已获授权：' + agent.toolIds.join('、')))
      }
      else details.append(el('p', '尚无 Agent 获得此目标的工具授权。'))
      catalog.append(details)
    }
  }
  const guarded = async <T>(work: (targetApi: Api) => Promise<T>): Promise<T> => {
    if (!api) throw Object.assign(new Error('instance-unavailable'), { code: 'instance-unavailable' })
    if (disposed) throw new Error('view-disposed')
    if (busy) throw Object.assign(new Error('busy'), { status: 409, code: 'product-busy' })
    busy = true; issueButton.disabled = true
    try { return await work(api) } catch (error) { setNotice(messageFor(error)); throw error }
    finally { busy = false; issueButton.disabled = false }
  }
  const view: UnitsSettingsView = {
    canLeave: () => !busy && !requests?.writing && (localComputer?.canLeave() ?? true),
    async refresh() {
      if (!api) return
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
    issue: input => guarded(async targetApi => {
      clearIssuedCode()
      const epoch = issueEpoch
      issueDetails.open = true
      const issued = await targetApi<{ attachment: UnitAttachment; code: string }>('/units/attach-codes', { unitKind: 'computer', scope: computerScope(input.projects, input.tools) })
      if (!disposed && epoch === issueEpoch && issueDetails.open) {
        code = issued.code
        once.textContent = `附着码 ${issued.code}，仅显示一次。`; once.hidden = false
      }
      await view.refresh()
      return issued.code
    }),
    revoke: attachmentId => guarded(async targetApi => { await targetApi(`/units/attachments/${encodeURIComponent(attachmentId)}/revoke`, {}); await view.refresh() }),
    snapshot: () => ({ attachments, notice, code }),
    close() { issueDetails.open = false; clearIssuedCode(); return closeLocalComputer() },
    closeLocalComputer,
    dispose() {
      if (disposal) return disposal
      disposed = true; clearIssuedCode(); panel.replaceChildren()
      return disposal = Promise.all([localComputer?.dispose(), requests?.dispose()]).then(() => {})
    },
  }
  issueDetails.addEventListener('toggle', () => { if (!issueDetails.open) clearIssuedCode() })
  form.addEventListener('submit', event => {
    event.preventDefault()
    void view.issue({ projects: parseGrantList(projectsInput.value), tools: parseGrantList(toolsInput.value) }).catch(() => {})
  })
  refreshButton.addEventListener('click', () => { if (!busy) void view.refresh() })
  void view.refresh()
  return view
}
