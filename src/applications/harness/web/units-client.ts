import type { Api } from './client-types.js'
import type { UnitAttachment, UnitScope } from '../core/unit/domain.js'
import { createPageRequests } from './page-lifecycle.js'

/** Owner-side unit attachments of one fixed device: list, issue one-time attach codes, revoke. */
export interface UnitsSettingsView {
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
  refresh(): Promise<void>
  start(): Promise<void>
  attach(input: { readonly harnessUrl: string; readonly code: string; readonly projects: readonly string[]; readonly tools: readonly string[] }): Promise<LocalAttachmentView>
  permissions(attachmentId: string, input: { readonly projects: 'all' | readonly string[]; readonly tools: 'all' | readonly string[] }): Promise<void>
  revoke(attachmentId: string): Promise<void>
  readonly snapshot: () => { readonly attachments: readonly LocalAttachmentView[]; readonly notice: string }
  dispose(): Promise<void>
}
/** Local client management, independent of every saved harness server connection. */
export function setupLocalAttachments(source: Api, messageFor: (error: unknown) => string, section: HTMLElement, deviceName: string): LocalAttachmentsView {
  const requests = createPageRequests(source), api = requests.api
  let attachments: readonly LocalAttachmentView[] = [], notice = '', disposed = false, busy = false, running = false, supported = true, unavailable = false
  section.replaceChildren()
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag)
    if (text !== undefined) node.textContent = text
    if (className) node.className = className
    return node
  }
  const title = el('h3', `${deviceName} · Computer worker`), hint = el('p', '允许远端 Agent 使用本机执行工具。附着码由对方在“单元附着”设置中生成。此入口管理客户端服务所在设备，无须启动本机 harness server。', 'settings-hint')
  const workerStatus = el('p', '正在读取状态…'), startButton = el('button', '启动 Computer worker'), refreshButton = el('button', '刷新状态')
  workerStatus.setAttribute('role', 'status'); startButton.type = refreshButton.type = 'button'; startButton.disabled = true
  const list = el('div', undefined, 'units-list'), status = el('p', undefined, 'notice'); status.hidden = true
  const form = el('form', undefined, 'settings-card')
  const urlLabel = el('label', '远端 harness server 地址（HTTPS）'), urlInput = el('input'); urlInput.type = 'url'; urlInput.required = true; urlLabel.append(urlInput)
  const codeLabel = el('label', '附着码'), codeInput = el('input'); codeInput.type = 'password'; codeInput.required = true; codeLabel.append(codeInput)
  const projectsLabel = el('label', '允许对方使用的项目目录（每行一个绝对路径，留空表示不限）'), projectsInput = el('textarea'); projectsInput.rows = 3; projectsLabel.append(projectsInput)
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
          const editor = el('form'), projectLabel = el('label', '项目目录（每行一个，留空表示不允许）'), projects = el('textarea')
          projects.rows = 3; projects.value = attachment.ceiling.projects === 'all' ? '' : attachment.ceiling.projects.join('\n'); projectLabel.append(projects)
          const allProjectsLabel = el('label', '不限项目目录', 'computer-grant-toggle'), allProjects = el('input'); allProjects.type = 'checkbox'; allProjects.checked = attachment.ceiling.projects === 'all'; allProjectsLabel.append(allProjects)
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
    if (!attachments.length && running) list.append(el('p', '这台设备尚未附着到其他 harness server。'))
  }
  const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
    if (busy) throw Object.assign(new Error('busy'), { status: 409, code: 'product-busy' })
    if (disposed) throw new Error('view-disposed')
    busy = true; attachButton.disabled = startButton.disabled = refreshButton.disabled = true
    try { return await work() } catch (error) { setNotice(messageFor(error)); throw error }
    finally { busy = false; attachButton.disabled = !running; startButton.disabled = running || !supported || unavailable; refreshButton.disabled = false }
  }
  const view: LocalAttachmentsView = {
    async refresh() {
      try {
        const value = await api<{ state: 'stopped' | 'running' | 'unavailable'; supported: boolean; workerId?: string; attachments: readonly LocalAttachmentView[] }>('/computer/status')
        if (disposed) return
        running = value.state === 'running'; supported = value.supported; unavailable = value.state === 'unavailable'; attachments = value.attachments
        workerStatus.textContent = !supported ? '当前平台尚不支持 Computer worker。' : running ? `运行中 · ${value.workerId}` : value.state === 'stopped' ? '尚未启动。启动后可查看和管理附着。' : '无法连接本机 worker，请检查进程状态后刷新。'
        startButton.hidden = running; startButton.disabled = busy || !supported || value.state === 'unavailable'
        form.hidden = !running; attachButton.disabled = !running || busy; setNotice('')
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
    async dispose() { disposed = true; await requests.dispose(); section.replaceChildren() },
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
  let attachments: readonly UnitAttachment[] = [], notice = '', code = '', disposed = false, busy = false
  panel.replaceChildren()
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag)
    if (text !== undefined) node.textContent = text
    if (className) node.className = className
    return node
  }
  const heading = el('header', undefined, 'settings-panel-heading'), title = el('h3', '单元附着'); title.id = 'agent--units-title'
  heading.append(title, el('p', '本设备的 harness server 与可部署单元（本机与远端 Computer）之间的附着。附着码只显示一次，由远端设备在其“管理连接”里消费。'))
  const list = el('div', undefined, 'units-list'), status = el('p', undefined, 'notice'); status.hidden = true
  const form = el('form', undefined, 'settings-card'), formTitle = el('h3', '生成 Computer 附着码')
  const projectsLabel = el('label', '允许的项目目录（每行一个绝对路径，留空表示不限）'), projectsInput = el('textarea'); projectsInput.rows = 3; projectsLabel.append(projectsInput)
  const toolsLabel = el('label', '允许的工具契约 ID（逗号分隔，留空表示不限）'), toolsInput = el('input'); toolsInput.type = 'text'; toolsLabel.append(toolsInput)
  const issueButton = el('button', '生成附着码', 'primary-button'); issueButton.type = 'submit'
  const once = el('p', undefined, 'token-once'); once.hidden = true
  form.append(formTitle, projectsLabel, toolsLabel, issueButton, once)
  panel.append(heading, status, list, form)
  const setNotice = (message: string) => { notice = message; status.textContent = message; status.hidden = !message }
  const render = () => {
    if (disposed) return
    list.replaceChildren(...attachments.map(attachment => {
      const row = el('section', undefined, 'settings-card unit-row'), label = el('p', describeAttachment(attachment))
      row.dataset.attachmentId = attachment.attachmentId
      row.append(el('strong', attachment.attachmentId), label)
      if (attachment.origin === 'remote' && attachment.state !== 'revoked') {
        const revoke = el('button', '撤销附着'); revoke.type = 'button'
        revoke.addEventListener('click', () => { void view.revoke(attachment.attachmentId).catch(() => {}) })
        row.append(revoke)
      }
      return row
    }))
    if (!attachments.length) list.append(el('p', '尚无附着记录。'))
  }
  const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
    if (busy) throw Object.assign(new Error('busy'), { status: 409, code: 'product-busy' })
    busy = true; issueButton.disabled = true
    try { return await work() } catch (error) { setNotice(messageFor(error)); throw error }
    finally { busy = false; issueButton.disabled = false }
  }
  const view: UnitsSettingsView = {
    async refresh() {
      try { attachments = await api<readonly UnitAttachment[]>('/units/attachments'); setNotice('') }
      catch (error) { if (!disposed) setNotice(messageFor(error)) }
      render()
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
    async dispose() { disposed = true; await requests.dispose(); panel.replaceChildren() },
  }
  form.addEventListener('submit', event => {
    event.preventDefault()
    void view.issue({ projects: parseGrantList(projectsInput.value), tools: parseGrantList(toolsInput.value) }).catch(() => {})
  })
  void view.refresh()
  return view
}
