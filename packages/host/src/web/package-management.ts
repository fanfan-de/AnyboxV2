import type { ApplicationInterfaceLease } from './application-lifecycle.js'
import { removedApplicationIds } from './application-workspace.js'
import { browserApplicationDirectory, readBrowserApplicationDirectory, type BrowserApplicationDirectory } from './package-directory.js'

/** Browser controls for package lifecycle only; application views and business stay untouched. */
export const maximumLocalApplicationArchiveSize = 256 * 1024 * 1024
const api = '/api/client/v1/app-packages'
interface Identity { readonly appId: string; readonly version: string; readonly digest: string; readonly target: { readonly os: string; readonly arch: string } }
interface InstallationFacts { readonly appId: string; readonly installed: readonly { readonly identity: Identity; readonly state: string }[]; readonly selected: Identity | null; readonly pending: Identity | null }
type ControlAction = 'cancel' | 'recover' | 'discard'
interface Operation { readonly filename?: string; readonly createdAt?: string; readonly updatedAt?: string; readonly revision?: number; readonly id: string; readonly requestId: string; readonly phase: string; readonly identity: Identity | null; readonly receipt?: unknown; readonly error?: unknown }
interface Activation { readonly kind?: 'activate' | 'remove'; readonly protected?: boolean; readonly id: string; readonly requestId: string; readonly revision: number; readonly phase: string; readonly targets?: readonly { readonly identity: Identity }[]; readonly roles?: readonly { readonly role: string; readonly ready: boolean }[]; readonly error?: unknown }
interface ActualCatalog { readonly role: string; readonly generation: string; readonly state: string; readonly entries: readonly { readonly identity: Identity; readonly entry: string }[] }
interface Status { readonly registryRevision?: number; readonly lifecycleAvailable?: boolean; readonly actual?: readonly ActualCatalog[]; readonly activations?: readonly Activation[]; readonly available: boolean; readonly trustedPublisherCount?: number; readonly installations: readonly InstallationFacts[]; readonly operations: readonly Operation[] }
interface Options {
  readonly fetch?: typeof fetch
  readonly hash?: (file: File) => Promise<string>
  readonly requestId?: () => string
  /** A zero interval is useful to consumers that already own observation scheduling. */
  readonly pollMs?: number
  readonly activation?: { prepare(): Promise<ApplicationInterfaceLease> }
  readonly reload?: (removedAppIds?: readonly string[]) => void
}
type LocalApplicationSource = { readonly sourceFormat: 'archive'; readonly file: File; readonly name: string; readonly size: number } | ({ readonly sourceFormat: 'directory' } & BrowserApplicationDirectory)
const phaseNames: Readonly<Record<string, string>> = {
  accepted: '等待上传', receiving: '正在接收应用包', verifying: '正在验证应用包', prepared: '已验证，准备安装', committing: '正在保存安装',
  installed: '安装已完成', 'awaiting-activation': '安装已完成', completed: '安装已完成', failed: '安装失败', cancelled: '已取消', 'recovery-required': '需要核对恢复',
}
const finished = (phase: string) => ['installed', 'awaiting-activation', 'completed', 'failed', 'cancelled', 'recovery-required'].includes(phase)
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function operation(value: unknown): value is Operation {
  return object(value) && typeof value.id === 'string' && typeof value.requestId === 'string' && typeof value.phase === 'string'
}
function activation(value: unknown): value is Activation { return object(value) && typeof value.id === 'string' && typeof value.requestId === 'string' && typeof value.revision === 'number' && typeof value.phase === 'string' }
function status(value: unknown): value is Status {
  return object(value) && typeof value.available === 'boolean' && Array.isArray(value.installations) && Array.isArray(value.operations) && value.operations.every(operation)
}
function code(value: unknown): string | undefined { return object(value) && typeof value.code === 'string' ? value.code : undefined }
function failureMessage(error: unknown): string {
  switch (code(error)) {
    case 'archive-size-limit': case 'archive-too-large': case 'file-too-large': return '应用包超过 256 MiB，请选择较小的应用包。'
    case 'directory-root-required': case 'directory-layout-invalid': case 'directory-metadata-required': return '请选择包含 manifest.json 和 payload/ 的单个应用文件夹。'
    case 'directory-file-limit': return '应用文件夹的文件数量或文件大小超过限制，请检查后重新选择。'
    case 'unsafe-path': case 'duplicate-path': case 'path-kind-conflict': return '应用文件夹包含不安全或冲突的文件名，请修正后重新选择。'
    case 'directory-file-changed': case 'invalid-file-index': return '应用文件夹的内容或文件清单不完整，请检查后重新选择。'
    case 'installation-local-trust-required': return '请先确认信任此本地应用，再安装所选文件夹。'
    case 'publisher-not-authorized': case 'archive-signature-invalid': case 'signature-invalid': case 'publisher-untrusted': case 'archive-untrusted': return '应用包签名或发布者未获信任，未安装。'
    case 'installation-upload-integrity-mismatch': case 'archive-digest-mismatch': case 'digest-mismatch': return '应用包内容校验失败，请重新取得完整应用包。'
    case 'installation-upload-size-mismatch': return '接收到的应用包不完整，请重新取得完整应用包后安装。'
    case 'installation-preparation-unavailable': return '当前运行环境无法完成应用包准备，请检查宿主运行环境。'
    case 'installation-work-exit-unconfirmed': return '安装准备进程的退出尚未确认，请核对并恢复后继续。'
    case 'installation-committed-retained': return '安装文件已保存，需要核对安装登记。'
    case 'request-conflict': case 'operation-conflict': case 'revision-conflict': return '应用安装状态已改变，请核对后继续。'
    case 'reclamation-root-unavailable': return '当前平台无法取得安全的应用包目录句柄，尚未卸载。操作记录和应用数据已保留，请使用支持的本机管理环境恢复。'
    case 'reclamation-root-changed': return '应用包目录的实际身份已改变，尚未卸载。请由本机管理者核对原目录后恢复，应用数据已保留。'
    case 'version-in-use': case 'use-unavailable': return '应用版本仍被其他角色或独立服务使用，尚未卸载。请先由其所属管理者关闭并确认退出，再核对恢复。'
    case 'package-reclamation-path-unsafe': case 'package-reclamation-directory-changed': case 'package-reclamation-content-unsafe': case 'package-reclamation-failed': case 'package-reclamation-interrupted': return '应用文件回收尚未完成，不能确认已卸载。操作记录和应用数据已保留，请核对并恢复卸载。'
    case 'application-interface-blocked': return '请先完成或保存所有已打开应用中的编辑，再应用更改或卸载。'
    case 'application-interface-cleanup-failed': return '应用界面清理失败，宿主尚未重启。请保留现场并核对恢复状态。'
    case 'product-busy': case 'activation-busy': case 'activation-browser-busy': return '应用仍有任务或写入进行中，待生效版本和卸载操作均未完成。完成工作后再继续。'
    case 'activation-browser-exit-unconfirmed': case 'activation-browser-unavailable': return '另一个应用页面的退出尚未确认，待生效版本和操作记录已保留。请核对所有应用页面。'
    case 'activation-manager-unavailable': case 'package-lifecycle-manager-unavailable': return '当前宿主需要外部生命周期管理者完成重启，待生效版本已保留。'
    case 'service-closing': case 'installer-unavailable': return '宿主暂时无法安装应用，请稍后核对状态。'
    default: return '安装未完成，请核对操作状态。'
  }
}
function receiptError(value: Operation): unknown {
  if (object(value.receipt) && value.receipt.error) return value.receipt.error
  return value.error
}
function sameIdentity(left: Identity | null, right: Identity): boolean { return !!left && left.appId === right.appId && left.version === right.version && left.digest === right.digest && left.target?.os === right.target?.os && left.target?.arch === right.target?.arch }
function installationLabel(identity: Identity, installations: readonly InstallationFacts[], actual: readonly ActualCatalog[], activations: readonly Activation[]): string {
  const facts = installations.find(value => value.appId === identity.appId)
  const installed = facts?.installed.find(value => sameIdentity(value.identity, identity))
  if (installed?.state === 'removed') return '现已卸载'
  if (installed?.state === 'reclaiming') return '正在回收，尚未卸载'
  if (installed?.state === 'quarantined') return '已隔离'
  if (sameIdentity(facts?.pending ?? null, identity)) return '已安装，待生效'
  if (sameIdentity(facts?.selected ?? null, identity)) {
    const activation = [...activations].reverse().find(value => value.kind !== 'remove' && value.phase !== 'cancelled' && value.targets?.some(target => sameIdentity(target.identity, identity)))
    const expected = activation?.roles
    const allRolesReady = activation?.phase === 'completed' && !!expected?.length && expected.every(role => role.ready && actual.some(value => value.role === role.role && value.state === 'ready'))
    const roles = actual.filter(value => value.entries.some(entry => entry.identity.appId === identity.appId))
    return allRolesReady && roles.length && roles.every(value => value.state === 'ready' && value.entries.some(entry => sameIdentity(entry.identity, identity))) ? '已生效' : '已选定，等待就绪'
  }
  return installed ? '已安装，备用版本' : '安装已完成'
}
function operationLabel(value: Operation, installations: readonly InstallationFacts[], actual: readonly ActualCatalog[], activations: readonly Activation[]): string {
  return ['installed', 'awaiting-activation', 'completed'].includes(value.phase) && value.identity ? installationLabel(value.identity, installations, actual, activations) : phaseNames[value.phase] ?? '正在核对状态'
}
function operationMessage(value: Operation, installations: readonly InstallationFacts[], actual: readonly ActualCatalog[], activations: readonly Activation[]): string {
  if (value.phase === 'failed' || value.phase === 'recovery-required') return failureMessage(receiptError(value))
  if (value.phase === 'cancelled') return '本次安装已取消。'
  if (['installed', 'awaiting-activation', 'completed'].includes(value.phase)) return value.identity ? `应用包${installationLabel(value.identity, installations, actual, activations)}。` : '应用包已安装，请核对下方版本状态。'
  return '应用包已交给宿主处理，可关闭此面板。'
}
export function validateLocalApplicationArchive(file: Pick<File, 'name' | 'size'>): string | undefined {
  if (!file.name || file.name.length > 255 || /[/\\\0]/.test(file.name) || !/\.anybox-app$/i.test(file.name)) return '请选择 .anybox-app 应用包文件。'
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > maximumLocalApplicationArchiveSize) return '应用包需大于 0 字节且不超过 256 MiB。'
  return undefined
}
async function archiveDigest(file: File): Promise<string> {
  const bytes = await file.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
}

/** Disposal stops observations, clears local file references immediately and joins accepted browser work. */
export function setupPackageManagement(container: HTMLElement, options: Options = {}) {
  const fetcher = options.fetch ?? fetch, hash = options.hash ?? archiveDigest, nextRequestId = options.requestId ?? (() => crypto.randomUUID())
  const root = document.createElement('section'); root.className = 'package-management'; root.setAttribute('aria-label', '本地应用包安装')
  const installPanel = document.createElement('div'); installPanel.className = 'package-install-panel'
  const heading = document.createElement('h3'); heading.textContent = '安装应用'
  const help = document.createElement('p'); help.textContent = '选择一种安装来源。安装后应用更改，即可在工作区打开应用。'
  const sectionHeading = document.createElement('div'); sectionHeading.className = 'package-section-heading'; sectionHeading.append(heading, help)
  const sources = document.createElement('div'); sources.className = 'package-source-options'
  const directoryLabel = document.createElement('div'); directoryLabel.className = 'package-source-option'
  const directoryTitle = document.createElement('span'); directoryTitle.className = 'package-source-title'; directoryTitle.textContent = '应用文件夹'
  const directoryDescription = document.createElement('span'); directoryDescription.className = 'package-source-description'; directoryDescription.textContent = '包含 manifest.json 和 payload/ 的已构建目录'
  const directoryInput = document.createElement('input'); directoryInput.type = 'file'; directoryInput.multiple = true; directoryInput.hidden = true; directoryInput.setAttribute('webkitdirectory', ''); directoryInput.setAttribute('aria-label', '选择本地应用文件夹')
  const directoryButton = makeButton('选择文件夹', () => { directoryInput.click() }); directoryButton.setAttribute('aria-label', '选择本地应用文件夹'); directoryButton.className = 'package-source-button'; directoryLabel.append(directoryTitle, directoryDescription, directoryButton, directoryInput)
  const label = document.createElement('div'); label.className = 'package-source-option'
  const archiveTitle = document.createElement('span'); archiveTitle.className = 'package-source-title'; archiveTitle.textContent = '应用包文件'
  const archiveDescription = document.createElement('span'); archiveDescription.className = 'package-source-description'; archiveDescription.textContent = '.anybox-app 文件，需来自已信任的发布者'
  const input = document.createElement('input'); input.type = 'file'; input.hidden = true; input.accept = '.anybox-app'; input.setAttribute('aria-label', '选择本地应用包')
  const archiveButton = makeButton('选择应用包', () => { input.click() }); archiveButton.setAttribute('aria-label', '选择本地应用包'); archiveButton.className = 'package-source-button'; label.append(archiveTitle, archiveDescription, archiveButton, input)
  sources.append(directoryLabel, label)
  const trustLabel = document.createElement('label'); trustLabel.className = 'package-trust'
  const trustInput = document.createElement('input'); trustInput.type = 'checkbox'; trustInput.setAttribute('aria-label', '信任此本地应用并安装')
  const trustCopy = document.createElement('span'); trustCopy.className = 'package-trust-copy'; trustCopy.textContent = '我信任此本地应用，允许安装其中的可执行内容。'
  trustLabel.append(trustInput, trustCopy)
  const chosen = document.createElement('p'); chosen.className = 'package-file'
  const clearButton = makeButton('清除选择', () => { select(null) }); clearButton.className = 'package-clear'
  const selectionMeta = document.createElement('div'); selectionMeta.className = 'package-selection-meta'; selectionMeta.append(chosen, clearButton)
  const selection = document.createElement('div'); selection.className = 'package-selection'; selection.append(selectionMeta, trustLabel)
  const controls = document.createElement('div'); controls.className = 'package-controls'
  const installButton = makeButton('安装应用包', () => { void install() }), applyButton = makeButton('应用更改', () => { void applyChanges() }), refreshButton = makeButton('核对安装状态', () => { void refresh() })
  installButton.className = 'primary'; refreshButton.className = 'package-refresh'; applyButton.className = 'primary'
  controls.append(installButton)
  installPanel.append(sectionHeading, sources, selection, controls)
  const notice = document.createElement('p'); notice.className = 'package-notice'; notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite')
  const pendingBanner = document.createElement('div'); pendingBanner.className = 'package-pending-banner'
  const pendingCopy = document.createElement('p'); pendingBanner.append(pendingCopy, applyButton)
  const factsList = document.createElement('div'); factsList.className = 'package-facts'; factsList.setAttribute('aria-label', '已安装应用包')
  const activity = document.createElement('div'); activity.className = 'package-activity'
  const activationList = document.createElement('div'); activationList.setAttribute('aria-label', '版本生效状态')
  const operationsList = document.createElement('div'); operationsList.setAttribute('aria-label', '安装操作'); activity.append(activationList, operationsList)
  const history = document.createElement('details'); history.className = 'package-history'
  const historySummary = document.createElement('summary'); historySummary.textContent = '操作记录与运行详情'
  const historyContent = document.createElement('div'); historyContent.className = 'package-history-content'; history.append(historySummary, historyContent)
  root.append(installPanel, notice, pendingBanner, factsList, activity, refreshButton, history); container.append(root)
  let closed = false, selected: LocalApplicationSource | null = null, trustedDirectory = false, busy = false, available: boolean | undefined, trustedPublisherCount: number | undefined, message = '', revision = 0
  let registryRevision: number | undefined, lifecycleAvailable = false, actual: readonly ActualCatalog[] = [], activations: readonly Activation[] = [], preparingActivation = false
  let activationAttempt: { requestId: string; lease: ApplicationInterfaceLease; id?: string; commitSent: boolean; driving: boolean; recovery?: boolean; recoveryRequested?: boolean; aborted?: boolean } | undefined, activationRead: Promise<void> | undefined
  let installations: readonly InstallationFacts[] = [], operations: readonly Operation[] = [], read: Promise<void> | undefined, disposal: Promise<void> | undefined
  const observations = new AbortController(), work = new Set<Promise<unknown>>(), uncertain = new Set<string>(), controlling = new Map<string, Set<ControlAction>>()
  function makeButton(text: string, action: () => void) { const element = document.createElement('button'); element.type = 'button'; element.textContent = text; element.addEventListener('click', action); return element }
  function track<T>(task: Promise<T>): Promise<T> { work.add(task); void task.then(() => work.delete(task), () => work.delete(task)); return task }
  function render() {
    if (closed) return
    const changing = preparingActivation || !!activationAttempt
    input.disabled = changing || busy || available !== true || trustedPublisherCount === 0
    directoryInput.disabled = changing || busy || available !== true
    archiveButton.disabled = input.disabled; directoryButton.disabled = directoryInput.disabled
    clearButton.hidden = !selected; clearButton.disabled = changing || busy
    trustLabel.hidden = selected?.sourceFormat !== 'directory'
    trustInput.disabled = changing || busy || selected?.sourceFormat !== 'directory'; trustInput.checked = trustedDirectory
    installButton.disabled = changing || busy || !selected || available !== true || (selected.sourceFormat === 'directory' ? !trustedDirectory : trustedPublisherCount === 0)
    refreshButton.disabled = !!read
    applyButton.disabled = changing || busy || !options.activation || !lifecycleAvailable || !installations.some(facts => facts.pending) || registryRevision === undefined
    directoryLabel.className = `package-source-option${selected?.sourceFormat === 'directory' ? ' selected' : ''}`
    label.className = `package-source-option${selected?.sourceFormat === 'archive' ? ' selected' : ''}`
    chosen.textContent = selected ? `${selected.name}${selected.sourceFormat === 'directory' ? ` · ${selected.files.length} 个文件` : ''} · ${(selected.size / (1024 * 1024)).toFixed(1)} MiB` : '尚未选择文件夹或应用包'
    notice.textContent = message || (available === false ? '当前宿主未启用应用安装。' : available === undefined ? '正在读取安装状态…' : trustedPublisherCount === 0 && selected?.sourceFormat !== 'directory' ? '尚未配置信任的发布者。你可以选择并明确信任本地应用文件夹。' : '')
    notice.hidden = !notice.textContent
    const pendingCount = installations.filter(facts => facts.pending).length
    pendingBanner.hidden = !pendingCount && !changing
    pendingCopy.textContent = changing ? '正在应用更改，请等待所有相关角色就绪。' : `${pendingCount} 个应用有更改待生效。应用更改会检查并关闭已打开的应用界面。`
    factsList.replaceChildren()
    const visibleFacts = installations.filter(facts => facts && typeof facts.appId === 'string' && Array.isArray(facts.installed) && facts.installed.some(item => item.state !== 'removed'))
    if (visibleFacts.length) {
      const title = document.createElement('h3'); title.textContent = '已安装版本'; factsList.append(title)
    }
    for (const facts of visibleFacts) {
      const app = document.createElement('article'); app.className = 'package-installed-app'
      const header = document.createElement('div'); header.className = 'package-installed-header'
      const title = document.createElement('strong'); title.textContent = facts.appId
      const remove = makeButton(`卸载 ${facts.appId}`, () => { void removeApplication(facts.appId) }); remove.className = 'package-uninstall'
      remove.setAttribute('aria-label', `卸载 ${facts.appId}，保留应用数据`); remove.setAttribute('title', '卸载本机应用文件，保留应用数据')
      remove.disabled = changing || busy || !options.activation || !lifecycleAvailable || registryRevision === undefined || facts.installed.some(item => item.state === 'reclaiming') || activations.some(value => value.kind === 'remove' && !['completed', 'cancelled'].includes(value.phase) && value.targets?.some(target => target.identity.appId === facts.appId))
      header.append(title, remove); app.append(header)
      for (const item of facts.installed) {
        const identity = item?.identity
        if (!identity || typeof identity.version !== 'string' || item.state === 'removed') continue
        const row = document.createElement('p'); row.className = 'package-installed'
        row.textContent = `${facts.appId} ${identity.version} · ${installationLabel(identity, installations, actual, activations)}`
        app.append(row)
      }
      factsList.append(app)
    }
    activationList.replaceChildren(); operationsList.replaceChildren(); historyContent.replaceChildren()
    if (pendingCount && !lifecycleAvailable) { const hint = document.createElement('p'); hint.textContent = '当前宿主需要外部生命周期管理者完成重启，待生效版本已保留。'; activationList.append(hint) }
    for (const catalog of actual) {
      if (!catalog || typeof catalog.role !== 'string' || typeof catalog.generation !== 'string' || !Array.isArray(catalog.entries)) continue
      const row = document.createElement('p'); row.className = 'package-actual'
      row.textContent = `${catalog.role} · 实际代次 ${catalog.generation} · ${catalog.state === 'ready' ? '已就绪' : '正在核对'} · ${catalog.entries.map(entry => `${entry.identity.appId} ${entry.identity.version}`).join('、')}`; historyContent.append(row)
    }
    for (const value of activations) {
      const row = document.createElement('article'); row.className = 'package-activation'; row.dataset.activationId = value.id
      row.dataset.phase = value.phase
      const removing = value.kind === 'remove'
      const text = document.createElement('p'); text.textContent = `${removing ? '卸载应用' : '版本生效'} · ${({ prepared: '已保护应用，等待界面退出', handoff: '正在交接并等待重启', loading: '正在等待新角色就绪', reclaiming: '正在回收应用文件，尚未卸载', completed: removing ? '已卸载，应用数据已保留' : '新版本已生效', cancelled: removing ? '已取消卸载' : '已取消生效', 'recovery-required': removing ? '尚未卸载，需要核对恢复' : '需要核对生效恢复' } as Record<string, string>)[value.phase] ?? '正在核对'}`; row.append(text)
      if (value.phase === 'recovery-required') { const reason = document.createElement('p'); reason.className = 'package-operation-reason'; reason.textContent = removing ? failureMessage(value.error) + ' 卸载尚未完成，应用数据已保留。' : '尚未确认全部角色就绪，已保留版本和操作记录。请核对恢复状态。'; row.append(reason) }
      if (value.phase === 'recovery-required') { const resume = makeButton(removing ? '核对并恢复卸载' : '核对并恢复生效', () => { void recoverActivation(value.id) }); resume.disabled = preparingActivation || !!activationAttempt && (activationAttempt.id !== value.id || activationAttempt.driving) || !lifecycleAvailable || !options.activation; row.append(resume) }
      ;(['completed', 'cancelled'].includes(value.phase) ? historyContent : activationList).append(row)
    }
    const latestByApplication = new Map<string, Operation>()
    for (const item of operations) {
      const key = item.identity?.appId ?? item.filename ?? item.requestId, previous = latestByApplication.get(key)
      if (!previous || !previous.updatedAt || !item.updatedAt || item.updatedAt >= previous.updatedAt) latestByApplication.set(key, item)
    }
    for (const item of operations) {
      const row = document.createElement('article'); row.className = 'package-operation'; row.dataset.operationId = item.id; row.dataset.phase = item.phase
      const text = document.createElement('p'); text.textContent = `${item.identity ? `${item.identity.appId} ${item.identity.version} · ` : ''}${operationLabel(item, installations, actual, activations)}`; row.append(text)
      if (item.phase === 'failed' || item.phase === 'recovery-required') { const reason = document.createElement('p'); reason.className = 'package-operation-reason'; reason.textContent = failureMessage(receiptError(item)); row.append(reason) }
      if (!finished(item.phase)) { const cancelButton = makeButton('取消安装', () => { void control(item.id, 'cancel') }); cancelButton.disabled = controlling.get(item.id)?.has('cancel') ?? false; row.append(cancelButton) }
      if (item.phase === 'recovery-required') { const recoverButton = makeButton('核对并恢复安装', () => { void control(item.id, 'recover') }); recoverButton.disabled = controlling.has(item.id); row.append(recoverButton)
        const discardButton = makeButton('清理本次暂存', () => { void control(item.id, 'discard') }); discardButton.disabled = controlling.has(item.id); row.append(discardButton) }
      if (controlling.has(item.id)) { const waiting = document.createElement('p'); waiting.textContent = controlling.get(item.id)?.has('cancel') ? '正在等待宿主确认操作已退出…' : '正在核对安装事实…'; row.append(waiting) }
      const key = item.identity?.appId ?? item.filename ?? item.requestId
      const needsAttention = !finished(item.phase) || item.phase === 'recovery-required' || controlling.has(item.id) || item.phase === 'failed' && latestByApplication.get(key)?.id === item.id
      ;(needsAttention ? operationsList : historyContent).append(row)
    }
    history.hidden = !historyContent.children.length
    if (uncertain.size) { const pending = document.createElement('p'); pending.textContent = '请求结果尚未确认。请核对安装状态，系统不会自动重复提交或上传。'; operationsList.append(pending) }
    activity.hidden = !activationList.children.length && !operationsList.children.length
  }
  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetcher(path, { method: 'GET', credentials: 'same-origin', ...init })
    const value: unknown = await response.json()
    if (!response.ok) throw object(value) && value.error ? value.error : { code: 'request-failed' }
    return value
  }
  function latestOperation(value: Operation): Operation {
    const previous = operations.find(item => item.id === value.id)
    return typeof previous?.revision === 'number' && typeof value.revision === 'number' && previous.revision > value.revision ? previous : value
  }
  function remember(value: Operation): Operation {
    const latest = latestOperation(value)
    operations = [...operations.filter(item => item.id !== latest.id), latest]
    uncertain.delete(value.requestId)
    return latest
  }
  function select(file: File | null) {
    if (closed || busy) return
    selected = null; trustedDirectory = false; input.value = ''; directoryInput.value = ''; message = ''
    if (file) { const issue = validateLocalApplicationArchive(file); if (issue) message = issue; else selected = { sourceFormat: 'archive', file, name: file.name, size: file.size } }
    render()
  }
  function selectDirectory(files: readonly File[]) {
    if (closed || busy) return
    selected = null; trustedDirectory = false; input.value = ''; directoryInput.value = ''; message = ''
    if (files.length) { try { selected = { sourceFormat: 'directory', ...browserApplicationDirectory(files) } } catch (error) { message = failureMessage(error) } }
    render()
  }
  function trustDirectory(trusted: boolean) { if (closed || busy || selected?.sourceFormat !== 'directory') return; trustedDirectory = trusted; render() }
  input.addEventListener('change', () => { select(input.files?.item(0) ?? null) })
  directoryInput.addEventListener('change', () => { selectDirectory(Array.from(directoryInput.files ?? [])) })
  trustInput.addEventListener('change', () => { trustDirectory(trustInput.checked) })
  function refresh(fresh = false): Promise<void> {
    if (closed) return Promise.resolve()
    if (read) return fresh ? read.then(() => refresh()) : read
    const observed = revision
    let task!: Promise<void>
    task = (async () => {
      try {
        const value = await request(api, { signal: observations.signal })
        if (closed || observed !== revision) return
        if (!status(value)) throw { code: 'invalid-response' }
        registryRevision = value.registryRevision; lifecycleAvailable = value.lifecycleAvailable === true; actual = value.actual ?? []; activations = (value.activations ?? []).filter(activation)
        available = value.available; trustedPublisherCount = value.trustedPublisherCount; installations = value.installations
        const seen = new Set(value.operations.map(item => item.id))
        // File jobs remain durable in the ledger. A delayed list cannot remove
        // a newly accepted job or replace its newer mutation receipt.
        operations = [...value.operations.map(latestOperation), ...operations.filter(item => !seen.has(item.id))]
        for (const item of operations) uncertain.delete(item.requestId)
        const currentActivation = activationAttempt && activations.find(item => item.requestId === activationAttempt!.requestId)
        if (currentActivation) { activationAttempt!.id = currentActivation.id; void continueActivation(currentActivation) }
        if (message === '暂时无法读取安装状态，请核对宿主连接。') message = ''
      } catch { if (!closed && observed === revision) { available = undefined; message = '暂时无法读取安装状态，请核对宿主连接。' } }
      finally { if (read === task) read = undefined; render() }
    })()
    read = task; render(); return track(task)
  }
  function rememberActivation(value: Activation) {
    const previous = activations.find(item => item.id === value.id)
    if (previous && previous.revision > value.revision) return previous
    activations = [...activations.filter(item => item.id !== value.id), value]; return value
  }
  function finishActivation(value: Activation) {
    const attempt = activationAttempt; if (!attempt || value.requestId !== attempt.requestId) return
    if (value.phase === 'completed' && (value.roles ?? []).every(role => role.ready)) {
      message = value.kind === 'remove' ? '应用已卸载，数据已保留，正在重新载入界面…' : '全部相关角色已报告就绪，正在重新载入界面…'; render()
      activationAttempt = undefined
      if (closed && timer !== undefined) clearInterval(timer)
      ;(options.reload ?? (() => location.reload()))(removedApplicationIds(value)); return
    }
    if (value.phase === 'cancelled') { attempt.lease.release(); activationAttempt = undefined; message = value.kind === 'remove' ? '已取消卸载，应用文件和数据已保留。' : '已取消版本生效，待生效版本已保留。'; if (closed && timer !== undefined) clearInterval(timer) }
    else if (value.phase === 'recovery-required') { message = value.kind === 'remove' ? '卸载尚未完成，当前界面保持保护。请核对并恢复原操作，不会自动重复卸载。' : '版本生效结果需要核对，当前界面保持保护，不会重复请求重启。'; if (closed && timer !== undefined) clearInterval(timer) }
    render()
  }
  function continueActivation(value: Activation): Promise<void> {
    const attempt = activationAttempt
    if (!attempt || attempt.requestId !== value.requestId) return Promise.resolve()
    value = rememberActivation(value); if (attempt.recoveryRequested && value.protected === true) attempt.recovery = true; finishActivation(value)
    if (value.protected !== true || value.phase !== 'prepared' && !(value.phase === 'recovery-required' && attempt.recovery) || attempt.commitSent || attempt.driving || attempt.aborted || activationAttempt !== attempt) return Promise.resolve()
    attempt.driving = true
    return track((async () => {
      try {
        // The backend has frozen activity; recheck and join every interface's
        // real disposal before granting permission to restart any process.
        await attempt.lease.disposeForRestart()
      } catch (error) {
        const issue = failureMessage(error); message = issue; render(); attempt.aborted = true
        let confirmed = false
        try {
          const cancelled = await request(`${api}/activations/${encodeURIComponent(value.id)}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          if (!activation(cancelled)) throw { code: 'invalid-response' }
          finishActivation(rememberActivation(cancelled)); confirmed = true
        } catch { /* Unknown release remains protected and is never automatically replayed. */ }
        message = issue + (confirmed ? '' : ' 生效保护的释放结果尚未确认，请核对状态。')
        render(); if (confirmed) attempt.lease.release(); attempt.driving = false; return
      }
      attempt.commitSent = true; message = '界面已退出，正在交接版本并等待全部角色就绪…'; render()
      try {
        const committed = await request(`${api}/activations/${encodeURIComponent(value.id)}/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        if (!activation(committed)) throw { code: 'invalid-response' }
        finishActivation(rememberActivation(committed))
      } catch { message = '重启请求的结果尚未确认。正在观察原操作，不会重复请求重启。'; render() }
      finally { attempt.driving = false }
    })())
  }
  function pollActivation(): Promise<void> {
    const attempt = activationAttempt
    if (!attempt || activationRead || attempt.driving) return activationRead ?? Promise.resolve()
    const task = (async () => {
      try { const result = await request(attempt.id ? `${api}/activations/${encodeURIComponent(attempt.id)}` : `${api}?requestId=${encodeURIComponent(attempt.requestId)}`); const value = attempt.id ? result : object(result) && Array.isArray(result.activations) ? result.activations.find(activation) : undefined; if (activation(value)) { attempt.id = value.id; await continueActivation(value) } }
      catch { if (!closed) { message = '正在等待宿主重新连接，并核对原生效操作。'; render() } }
    })().finally(() => { if (activationRead === task) activationRead = undefined })
    activationRead = task; return track(task)
  }
  function applyChanges(): Promise<void> { return beginChange('activate') }
  function removeApplication(appId: string): Promise<void> {
    if (activations.some(value => value.kind === 'remove' && !['completed', 'cancelled'].includes(value.phase) && value.targets?.some(target => target.identity.appId === appId))) return Promise.resolve()
    if (!installations.some(facts => facts.appId === appId && facts.installed.some(item => item.state !== 'removed' && item.state !== 'reclaiming'))) return Promise.resolve()
    return beginChange('remove', [appId])
  }
  function beginChange(kind: 'activate' | 'remove', appIds?: readonly string[]): Promise<void> {
    if (closed || busy || preparingActivation || activationAttempt || !options.activation || !lifecycleAvailable || registryRevision === undefined || kind === 'activate' && !installations.some(facts => facts.pending)) return Promise.resolve()
    const expectedRegistryRevision = registryRevision, requestId = nextRequestId(); preparingActivation = true; message = '正在检查所有已打开应用的界面…'; render()
    return track((async () => {
      let lease: ApplicationInterfaceLease | undefined
      try {
        lease = await options.activation!.prepare()
        if (closed) { lease.release(); return }
        activationAttempt = { requestId, lease, commitSent: false, driving: false }
        message = '正在保护同进程的全部应用…'; render()
        const value = await request(`${api}/activations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, expectedRegistryRevision, ...(kind === 'remove' ? { kind, appIds } : {}) }) })
        if (!activation(value)) throw { code: 'invalid-response' }
        activationAttempt.id = value.id; await continueActivation(value)
      } catch (error) {
        if (code(error) && code(error) !== 'invalid-response') { lease?.release(); activationAttempt = undefined; message = failureMessage(error) }
        else message = '生效请求结果尚未确认。请核对原操作，系统不会自动重复提交。'
      } finally { preparingActivation = false; render(); if (!closed) void refresh(true) }
    })())
  }
  function recoverActivation(id: string): Promise<void> {
    const prior = activations.find(value => value.id === id)
    if (closed || busy || preparingActivation || activationAttempt && (activationAttempt.id !== id || activationAttempt.driving) || !options.activation || !lifecycleAvailable || prior?.phase !== 'recovery-required') return Promise.resolve()
    preparingActivation = true; message = '正在检查全部应用界面，再核对原生效操作…'; render()
    return track((async () => {
      let lease: ApplicationInterfaceLease | undefined
      try {
        lease = await options.activation!.prepare()
        if (closed) { lease.release(); return }
        const attempt = { requestId: prior.requestId, id, lease, commitSent: false, driving: false, recovery: false, recoveryRequested: true }; activationAttempt = attempt
        const value = await request(`${api}/activations/${encodeURIComponent(id)}/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        if (!activation(value)) throw { code: 'invalid-response' }
        attempt.recovery = true; await continueActivation(value)
      } catch (error) {
        if (code(error) && code(error) !== 'invalid-response') { lease?.release(); activationAttempt = undefined; message = failureMessage(error) }
        else message = '恢复保护的结果尚未确认。请核对原操作，不会自动重复请求恢复或重启。'
      } finally { preparingActivation = false; render(); if (!closed) void refresh(true) }
    })())
  }
  function install(): Promise<void> {
    if (closed || busy || preparingActivation || activationAttempt || !selected || available !== true || (selected.sourceFormat === 'directory' ? !trustedDirectory : trustedPublisherCount === 0)) return Promise.resolve()
    const source = selected, requestId = nextRequestId()
    busy = true; revision++; message = source.sourceFormat === 'directory' ? '正在读取应用文件夹…' : '正在计算应用包校验值…'; render()
    return track((async () => {
      let accepted = false
      try {
        const file = source.sourceFormat === 'directory' ? await readBrowserApplicationDirectory(source, observations.signal) : source.file
        if (closed) return
        const digest = await hash(file)
        if (closed) return
        if (!/^[a-f0-9]{64}$/.test(digest)) throw { code: 'digest-invalid' }
        message = '正在提交安装请求…'; uncertain.add(requestId); render()
        // Accepted mutations are joined on disposal; closing the panel never cancels a server job.
        const value = await request(`${api}/operations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, filename: file.name, archiveDigest: digest, archiveSize: file.size, ...(source.sourceFormat === 'directory' ? { sourceFormat: 'directory', localTrust: true } : {}) }) })
        accepted = true
        if (closed) return
        if (!operation(value)) throw { code: 'invalid-response' }
        const acceptedJob = remember(value)
        if (acceptedJob.phase !== 'accepted' && acceptedJob.phase !== 'receiving') { message = operationMessage(acceptedJob, installations, actual, activations); return }
        message = '正在上传应用包…'; render()
        const uploaded = await request(`${api}/operations/${encodeURIComponent(value.id)}/archive`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: file })
        if (closed) return
        if (!operation(uploaded)) throw { code: 'invalid-response' }
        message = operationMessage(remember(uploaded), installations, actual, activations)
      } catch (error) {
        if (!closed) { message = uncertain.has(requestId) || accepted ? '请求结果尚未确认，请核对安装状态。不会自动重复上传。' : failureMessage(error) }
      } finally {
        selected = null; trustedDirectory = false; input.value = ''; directoryInput.value = ''; busy = false
        if (!closed) { render(); void refresh(true) }
      }
    })())
  }
  function control(id: string, action: ControlAction): Promise<void> {
    const previous = controlling.get(id)
    if (closed || previous?.has(action) || action !== 'cancel' && previous?.size) return Promise.resolve()
    const actions = previous ?? new Set<ControlAction>(); actions.add(action); controlling.set(id, actions)
    revision++; message = ''; render()
    return track((async () => {
      try {
        const value = await request(`${api}/operations/${encodeURIComponent(id)}/${action === 'cancel' ? 'cancel' : 'recover'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action === 'cancel' ? {} : { action: action === 'discard' ? 'discard' : 'resume' }) })
        if (closed) return
        if (!operation(value)) throw { code: 'invalid-response' }
        remember(value); message = action === 'cancel' ? '宿主已确认本次取消结果。' : action === 'discard' ? '已核对并清理本次暂存；已安装版本保持不变。' : '已核对安装事实。'
      } catch { if (!closed) message = '操作结果尚未确认，请核对安装状态。不会自动重试。' }
      finally { actions.delete(action); if (!actions.size) controlling.delete(id); if (!closed) { render(); void refresh(true) } }
    })())
  }
  const pollMs = options.pollMs ?? 2000
  const timer = pollMs > 0 ? setInterval(() => { if (activationAttempt) void pollActivation(); if (!closed && !document.hidden && (uncertain.size || operations.some(item => !finished(item.phase)))) void refresh() }, pollMs) : undefined
  function dispose(): Promise<void> {
    if (disposal) return disposal
    closed = true; observations.abort(); if (!activationAttempt && timer !== undefined) clearInterval(timer)
    selected = null; trustedDirectory = false; input.value = ''; directoryInput.value = ''; root.remove()
    disposal = Promise.allSettled([...work]).then(() => undefined); return disposal
  }
  render(); void refresh()
  return { select, selectDirectory, trustDirectory, install, applyChanges, removeApplication, recoverActivation, refresh: async (fresh = false) => { await refresh(fresh); await pollActivation() }, cancel: (id: string) => control(id, 'cancel'), recover: (id: string) => control(id, 'recover'), discard: (id: string) => control(id, 'discard'), dispose,
    snapshot: () => ({ closed, busy, available, selectedFilename: selected?.name ?? null, selectedSourceFormat: selected?.sourceFormat ?? null, trustedDirectory, message, installations, operations, registryRevision, lifecycleAvailable, actual, activations, activationPending: preparingActivation || !!activationAttempt, uncertainRequestIds: [...uncertain] }) }
}
