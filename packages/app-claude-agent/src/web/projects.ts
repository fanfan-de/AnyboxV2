import type { DirectoryListingView, RecentProjectsView } from '../core/view.js'
import { isApiError, relativeTime } from './state.js'
import { el } from './view.js'

const app = '/apps/claude-agent'
const validateDelayMs = 350, placeholderDelayMs = 200
const sourceLabels = { threads: '本应用', claude: 'Claude 环境', both: '本应用 · Claude 环境' } as const
const lastSegment = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path

export interface ProjectPanelHandlers {
  /** Device request; rejects with the product's API error. */
  request<T>(path: string, signal?: AbortSignal): Promise<T>
  /** The project to work in; no thread exists yet, the first prompt creates one. */
  select(path: string): void
  /** Explicit "new thread" with an optional user title. */
  create(path: string, title: string | undefined): void
  /** The host's native directory window; cancelled when this panel leaves its device. Resolves null when the user cancels. */
  pickNative(signal?: AbortSignal): Promise<string | null>
  report(error: unknown): void
}
export interface ProjectPanel {
  readonly element: HTMLElement
  /** Opens project selection without creating a thread. */
  open(): void
  /** Closes selection and cancels the panel's pending directory work. */
  close(): void
  /** Enabled only while a device with a running Claude Agent is selected. */
  setEnabled(enabled: boolean): void
  /** Remembers the current project as the next dialog's default, without re-validating it. */
  setPath(path: string): void
  /** Offers the native window button; false hides it (remote device or unsupported platform). */
  setNativePicker(available: boolean): void
  refreshRecent(): Promise<void>
  dispose(): void
}
/** Placeholder text that appears only when a read takes noticeably long, so quick answers never flash it. */
const delayedPlaceholder = (node: HTMLElement, text: string, signal: AbortSignal) => {
  const timer = setTimeout(() => { if (!signal.aborted) node.replaceChildren(el('li', { class: 'ca-empty', text })) }, placeholderDelayMs)
  return () => clearTimeout(timer)
}

/** On-demand project selection on the execution device; the first prompt can create the thread. */
export function createProjectPanel(domId: (local: string) => string, handlers: ProjectPanelHandlers): ProjectPanel {
  const newButton = el('button', { type: 'button', class: 'ca-new-thread primary-button', text: '新建会话', 'aria-haspopup': 'dialog', 'aria-controls': domId('project-dialog'), disabled: true })
  const pathInput = el('input', { name: 'projectPath', placeholder: '项目目录（执行设备上的绝对路径或 ~/…）', 'aria-label': '项目目录', autocomplete: 'off', spellcheck: 'false', id: domId('project-path') })
  const pathStatus = el('p', { class: 'ca-path-status', role: 'status', id: domId('project-path-status') })
  pathInput.setAttribute('aria-describedby', pathStatus.id)
  const titleInput = el('input', { name: 'title', placeholder: '标题（可选）', 'aria-label': '标题', autocomplete: 'off', id: domId('project-title') })
  const createButton = el('button', { type: 'button', class: 'ca-project-create', text: '创建空会话', disabled: true })
  const selectButton = el('button', { type: 'button', class: 'primary-button ca-project-select', text: '使用此项目', disabled: true })
  const browseButton = el('button', { type: 'button', class: 'ca-browse', text: '浏览目录', 'aria-expanded': 'false', 'aria-controls': domId('project-browser') })
  const nativeButton = el('button', { type: 'button', class: 'ca-pick-native', text: '系统目录窗口…', hidden: true })
  const form = el('form', { class: 'ca-project-form' },
    el('label', { class: 'ca-project-field', for: pathInput.id }, el('span', { text: '项目目录' }), pathInput), pathStatus,
    el('div', { class: 'ca-project-actions' }, browseButton, nativeButton),
    el('details', { class: 'ca-project-options' }, el('summary', { text: '自定义会话标题（可选）' }),
      el('label', { class: 'ca-project-field', for: titleInput.id }, el('span', { text: '会话标题' }), titleInput), createButton))
  const browserPath = el('code', { class: 'ca-browser-path' })
  const upButton = el('button', { type: 'button', class: 'ca-browser-up', text: '上级', title: '上级目录' })
  const hiddenToggle = el('input', { type: 'checkbox', id: domId('show-hidden') })
  const entries = el('ul', { class: 'ca-browser-entries', 'aria-label': '子目录' })
  const chooseButton = el('button', { type: 'button', class: 'primary-button ca-browser-choose', text: '选择此目录' })
  const browser = el('section', { class: 'ca-browser', id: domId('project-browser'), hidden: true, 'aria-label': '浏览执行设备目录' },
    el('div', { class: 'ca-browser-head' }, upButton, browserPath),
    entries,
    el('div', { class: 'ca-browser-foot' }, el('label', { class: 'ca-browser-hidden' }, hiddenToggle, el('span', { text: '显示隐藏目录' })), chooseButton))
  const recentList = el('ul', { class: 'ca-recent-list', 'aria-label': '最近项目' })
  const recentHint = el('p', { class: 'ca-recent-hint', hidden: true })
  const closeButton = el('button', { type: 'button', class: 'ca-project-close', text: '×', 'aria-label': '关闭新建会话' })
  const dialog = el('dialog', { class: 'ca-project-dialog', id: domId('project-dialog'), 'aria-modal': 'true', 'aria-labelledby': domId('project-dialog-title'), 'aria-describedby': domId('project-dialog-description') },
    el('header', { class: 'ca-project-dialog-head' }, el('h2', { id: domId('project-dialog-title'), text: '新建会话' }), closeButton),
    el('div', { class: 'ca-project-dialog-body' },
      el('p', { class: 'ca-project-description', id: domId('project-dialog-description'), text: '选择 Claude 工作的项目。发送第一条消息后会自动创建会话。' }),
      form, browser,
      el('section', { class: 'ca-recent-projects' }, el('h3', { text: '最近项目' }), recentList, recentHint)),
    el('footer', { class: 'ca-project-dialog-foot' }, el('span', { class: 'ca-project-dialog-hint', text: '使用项目后，回到输入框描述任务。' }), selectButton))
  const element = el('section', { class: 'ca-project-panel', 'aria-label': '项目' }, newButton, dialog)

  let enabled = false, disposed = false, valid: string | undefined, currentPath: string | undefined, validating: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined
  let listing: DirectoryListingView | undefined, browsing: AbortController | undefined, recentLoad: AbortController | undefined
  let picking: AbortController | undefined, returnFocus: HTMLElement | undefined
  const encode = (path: string, showHidden: boolean) => `${app}/directories?path=${encodeURIComponent(path)}${showHidden ? '&showHidden=1' : ''}`
  const setStatus = (text: string, state: '' | 'checking' | 'valid' | 'invalid') => { pathStatus.textContent = text; pathStatus.dataset.state = state }
  const markValid = (path: string) => {
    valid = path; createButton.disabled = !enabled; selectButton.disabled = !enabled; titleInput.placeholder = `标题（默认 ${lastSegment(path)}）`
    setStatus('目录存在', 'valid')
  }
  const markInvalid = (text: string) => { valid = undefined; createButton.disabled = true; selectButton.disabled = true; titleInput.placeholder = '标题（可选）'; setStatus(text, 'invalid') }
  const cancelValidation = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined } validating?.abort(); validating = undefined }
  const cancelPicking = () => { picking?.abort(); picking = undefined; nativeButton.disabled = !enabled }
  const finishClose = () => {
    cancelValidation(); cancelPicking(); browsing?.abort(); browsing = undefined; recentLoad?.abort(); recentLoad = undefined
    browser.hidden = true; browseButton.setAttribute('aria-expanded', 'false')
    const target = returnFocus; returnFocus = undefined
    if (target && !target.hasAttribute('disabled')) target.focus()
  }
  const close = () => {
    if (dialog.open) {
      if (typeof dialog.close === 'function') dialog.close()
      else dialog.removeAttribute('open')
    }
    finishClose()
  }
  const open = () => {
    if (!enabled || disposed || dialog.open) return
    if (currentPath) { pathInput.value = currentPath; markValid(currentPath) }
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : newButton
    if (typeof dialog.showModal === 'function') dialog.showModal()
    else dialog.setAttribute('open', '')
    pathInput.focus()
    void refreshRecent()
    if (!valid && pathInput.value.trim()) void validate(pathInput.value.trim())
  }
  const selectProject = (path: string) => {
    if (!enabled || disposed) return
    setPath(path); close(); handlers.select(path)
  }
  newButton.addEventListener('click', open)
  closeButton.addEventListener('click', close)
  dialog.addEventListener('cancel', event => { event.preventDefault(); close() })
  dialog.addEventListener('close', () => { if (!dialog.open && returnFocus) finishClose() })
  selectButton.addEventListener('click', () => { if (valid) selectProject(valid) })
  /** Debounced existence check only; changing the selected project requires an explicit action. */
  const validate = async (path: string) => {
    cancelValidation()
    if (!path) { valid = undefined; createButton.disabled = true; selectButton.disabled = true; titleInput.placeholder = '标题（可选）'; setStatus('', ''); return }
    const controller = new AbortController(); validating = controller
    setStatus('正在检查…', 'checking')
    try {
      const found = await handlers.request<DirectoryListingView>(encode(path, false), controller.signal)
      if (controller.signal.aborted) return
      markValid(found.path)
    } catch (error) {
      if (controller.signal.aborted) return
      markInvalid(isApiError(error) && error.status === 404 ? '执行设备上没有这个目录' : isApiError(error) && error.status === 400 ? '需要执行设备上的绝对路径' : '无法检查目录，请稍后重试')
      if (!isApiError(error) || (error.status !== 404 && error.status !== 400)) handlers.report(error)
    } finally { if (validating === controller) validating = undefined }
  }
  pathInput.addEventListener('input', () => {
    if (!enabled || disposed) return
    cancelValidation()
    const path = pathInput.value.trim()
    if (!path) { void validate('') ; return }
    setStatus('正在检查…', 'checking'); valid = undefined; createButton.disabled = true; selectButton.disabled = true
    timer = setTimeout(() => { timer = undefined; void validate(path) }, validateDelayMs)
  })
  form.addEventListener('submit', event => {
    event.preventDefault()
    if (valid) selectProject(valid)
  })
  pathInput.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing) return
    event.preventDefault()
    if (valid) selectProject(valid)
  })
  createButton.addEventListener('click', () => {
    if (!enabled || disposed || !valid) return
    const title = titleInput.value.trim()
    const path = valid
    titleInput.value = ''
    close(); handlers.create(path, title || undefined)
  })
  const renderBrowser = () => {
    browserPath.textContent = listing?.path ?? ''
    browserPath.title = listing?.path ?? ''
    upButton.disabled = !listing?.parent
    chooseButton.disabled = !listing
    entries.replaceChildren(...(listing?.entries ?? []).map(entry => {
      const button = el('button', { type: 'button', 'data-path': entry.path, title: entry.path, text: entry.name })
      button.addEventListener('click', () => { void browse(entry.path) })
      return el('li', {}, button)
    }))
    if (listing && !listing.entries.length) entries.append(el('li', { class: 'ca-empty', text: '没有子目录' }))
    if (listing?.truncated) entries.append(el('li', { class: 'ca-empty', text: '只显示前 500 个目录' }))
  }
  const browse = async (path: string) => {
    browsing?.abort()
    const controller = new AbortController(); browsing = controller
    const cancelPlaceholder = delayedPlaceholder(entries, '正在读取目录…', controller.signal)
    try {
      const next = await handlers.request<DirectoryListingView>(encode(path, hiddenToggle.checked), controller.signal)
      if (controller.signal.aborted) return
      listing = next; renderBrowser()
    } catch (error) {
      if (controller.signal.aborted) return
      cancelPlaceholder(); renderBrowser()
      entries.replaceChildren(el('li', { class: 'ca-empty', text: isApiError(error) && error.status === 404 ? '目录不存在，请返回上级。' : isApiError(error) && error.status === 403 ? '没有权限读取这个目录。' : '无法读取目录。' }))
      if (!isApiError(error) || error.status >= 500) handlers.report(error)
    } finally { cancelPlaceholder(); if (browsing === controller) browsing = undefined }
  }
  browseButton.addEventListener('click', () => {
    if (!enabled || disposed) return
    const open = browser.hidden
    browser.hidden = !open; browseButton.setAttribute('aria-expanded', String(open))
    if (open) void browse(valid ?? (pathInput.value.trim() || '~'))
    else { browsing?.abort(); browsing = undefined }
  })
  upButton.addEventListener('click', () => { if (listing?.parent) void browse(listing.parent) })
  hiddenToggle.addEventListener('change', () => { if (listing) void browse(listing.path) })
  chooseButton.addEventListener('click', () => { if (listing) selectProject(listing.path) })
  const setPath = (path: string) => { cancelValidation(); currentPath = path; pathInput.value = path; markValid(path) }
  nativeButton.addEventListener('click', () => { void (async () => {
    if (picking || !enabled || disposed) return
    const controller = new AbortController(); picking = controller; nativeButton.disabled = true
    try {
      const path = await handlers.pickNative(controller.signal)
      if (path && !controller.signal.aborted && !disposed && enabled && picking === controller) selectProject(path)
    } catch (error) { if (!controller.signal.aborted && !disposed && picking === controller) handlers.report(error) }
    finally { if (picking === controller) { picking = undefined; nativeButton.disabled = !enabled } }
  })() })
  const renderRecent = (recent: RecentProjectsView | undefined, now: number) => {
    recentList.replaceChildren(...(recent?.projects ?? []).map(project => {
      const button = el('button', { type: 'button', 'data-path': project.path, title: project.path },
        el('span', { class: 'ca-recent-name', text: project.name }), el('small', { text: `${relativeTime(project.lastUsedAt, now)} · ${sourceLabels[project.source]}` }))
      button.addEventListener('click', () => selectProject(project.path))
      return el('li', {}, button)
    }))
    if (recent && !recent.projects.length) recentList.append(el('li', { class: 'ca-empty', text: '执行设备上还没有最近使用的项目。' }))
    recentHint.hidden = !recent?.partial
    recentHint.textContent = recent?.partial ? '暂时读不到 Claude 环境的会话目录，只显示本应用用过的项目。' : ''
  }
  const refreshRecent = async () => {
    if (!enabled || disposed) return
    recentLoad?.abort()
    const controller = new AbortController(); recentLoad = controller
    const cancelPlaceholder = delayedPlaceholder(recentList, '正在读取最近项目…', controller.signal)
    try {
      const recent = await handlers.request<RecentProjectsView>(`${app}/projects/recent`, controller.signal)
      if (!controller.signal.aborted) renderRecent(recent, Date.now())
    } catch (error) {
      if (controller.signal.aborted) return
      recentList.replaceChildren(el('li', { class: 'ca-empty', text: '无法读取最近项目。' })); handlers.report(error)
    } finally { cancelPlaceholder(); if (recentLoad === controller) recentLoad = undefined }
  }
  const setEnabled = (next: boolean) => {
    next = next && !disposed
    enabled = next
    newButton.disabled = !next
    if (!next) close()
    for (const control of [pathInput, titleInput, browseButton, upButton, hiddenToggle, chooseButton]) control.disabled = !next
    upButton.disabled = !next || !listing?.parent
    chooseButton.disabled = !next || !listing
    nativeButton.disabled = !next || !!picking
    createButton.disabled = !next || !valid
    selectButton.disabled = !next || !valid
    if (!next) { cancelValidation(); browsing?.abort(); recentLoad?.abort(); valid = undefined; currentPath = undefined; pathInput.value = ''; setStatus('', ''); listing = undefined; browser.hidden = true; browseButton.setAttribute('aria-expanded', 'false'); renderBrowser(); recentList.replaceChildren(); recentHint.hidden = true }
  }
  renderBrowser()
  return { element, open, close, setEnabled, setPath, setNativePicker: available => { nativeButton.hidden = !available; if (!available) cancelPicking() }, refreshRecent, dispose() { disposed = true; setEnabled(false) } }
}
