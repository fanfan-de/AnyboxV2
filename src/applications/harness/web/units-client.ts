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
  attach(input: { readonly harnessUrl: string; readonly code: string; readonly projects: readonly string[]; readonly tools: readonly string[] }): Promise<LocalAttachmentView>
  revoke(attachmentId: string): Promise<void>
  readonly snapshot: () => { readonly attachments: readonly LocalAttachmentView[]; readonly notice: string }
  dispose(): Promise<void>
}
/** "Attach this device to a remote harness server": consumes an attach code through the device's own harness server over loopback. */
export function setupLocalAttachments(source: Api, messageFor: (error: unknown) => string, section: HTMLElement, deviceName: string): LocalAttachmentsView {
  const requests = createPageRequests(source), api = requests.api
  let attachments: readonly LocalAttachmentView[] = [], notice = '', disposed = false, busy = false
  let disposal: Promise<void> | undefined
  section.replaceChildren()
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag)
    if (text !== undefined) node.textContent = text
    if (className) node.className = className
    return node
  }
  const title = el('h3', `${deviceName} · 附着到远端 harness server`), hint = el('p', '把这台设备的本机执行器附着到另一台 harness server，让它在设定的目录与工具上限内使用本机执行工具。附着码由对方在“单元附着”设置中生成。', 'settings-hint')
  const list = el('div', undefined, 'units-list'), status = el('p', undefined, 'notice'); status.hidden = true
  const form = el('form', undefined, 'settings-card')
  const urlLabel = el('label', '远端 harness server 地址（HTTPS）'), urlInput = el('input'); urlInput.type = 'url'; urlInput.required = true; urlLabel.append(urlInput)
  const codeLabel = el('label', '附着码'), codeInput = el('input'); codeInput.type = 'password'; codeInput.required = true; codeLabel.append(codeInput)
  const projectsLabel = el('label', '允许对方使用的项目目录（每行一个绝对路径，留空表示不限）'), projectsInput = el('textarea'); projectsInput.rows = 3; projectsLabel.append(projectsInput)
  const toolsLabel = el('label', '允许对方使用的工具契约 ID（逗号分隔，留空表示不限）'), toolsInput = el('input'); toolsInput.type = 'text'; toolsLabel.append(toolsInput)
  const attachButton = el('button', '附着', 'primary-button'); attachButton.type = 'submit'
  form.append(urlLabel, codeLabel, projectsLabel, toolsLabel, attachButton)
  section.append(title, hint, status, list, form)
  const setNotice = (message: string) => { notice = message; status.textContent = message; status.hidden = !message }
  const render = () => {
    if (disposed) return
    list.replaceChildren(...attachments.map(attachment => {
      const row = el('section', undefined, 'settings-card unit-row'); row.dataset.attachmentId = attachment.attachmentId
      row.append(el('strong', attachment.attachmentId), el('p', describeLocalAttachment(attachment)))
      if (attachment.state === 'approved') {
        const revoke = el('button', '撤销附着'); revoke.type = 'button'
        revoke.addEventListener('click', () => { void view.revoke(attachment.attachmentId).catch(() => {}) })
        row.append(revoke)
      }
      return row
    }))
    if (!attachments.length) list.append(el('p', '这台设备尚未附着到其他 harness server。'))
  }
  const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
    if (busy) throw Object.assign(new Error('busy'), { status: 409, code: 'product-busy' })
    busy = true; attachButton.disabled = true
    try { return await work() } catch (error) { setNotice(messageFor(error)); throw error }
    finally { busy = false; attachButton.disabled = false }
  }
  const view: LocalAttachmentsView = {
    async refresh() {
      try { attachments = await api<readonly LocalAttachmentView[]>('/units/local-computer/attachments'); setNotice('') }
      catch (error) { if (!disposed) setNotice(messageFor(error)) }
      render()
    },
    attach: input => guarded(async () => {
      const attached = await api<LocalAttachmentView>('/units/local-computer/attachments', { harnessUrl: input.harnessUrl, code: input.code, ceiling: computerScope(input.projects, input.tools) })
      codeInput.value = ''
      await view.refresh()
      return attached
    }),
    revoke: attachmentId => guarded(async () => { await api(`/units/local-computer/attachments/${encodeURIComponent(attachmentId)}/revoke`, {}); await view.refresh() }),
    snapshot: () => ({ attachments, notice }),
    dispose() {
      if (disposal) return disposal
      disposed = true; codeInput.value = ''; section.replaceChildren()
      return disposal = requests.dispose()
    },
  }
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
  let disposal: Promise<void> | undefined
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
  void view.refresh()
  return view
}
