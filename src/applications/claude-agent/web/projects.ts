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
  /** Enabled only while a device with a running Claude Agent is selected. */
  setEnabled(enabled: boolean): void
  /** Shows a directory the controller chose (a thread group's "new thread" button) without re-validating it. */
  setPath(path: string): void
  /** Offers the native window button; false hides it (remote device or unsupported platform). */
  setNativePicker(available: boolean): void
  refreshRecent(): Promise<void>
  dispose(): void
}
/** Placeholder text that appears only when a read takes noticeably long, so quick answers never flash it. */
const delayedPlaceholder = (node: HTMLElement, text: string) => {
  const timer = setTimeout(() => { node.replaceChildren(el('li', { class: 'ca-empty', text })) }, placeholderDelayMs)
  return () => clearTimeout(timer)
}

/** Project selection on the execution device: a validated path, the device's recent directories and an in-app directory browser. */
export function createProjectPanel(domId: (local: string) => string, handlers: ProjectPanelHandlers): ProjectPanel {
  const pathInput = el('input', { name: 'projectPath', placeholder: '项目目录（执行设备上的绝对路径或 ~/…）', 'aria-label': '项目目录', autocomplete: 'off', spellcheck: 'false', id: domId('project-path') })
  const pathStatus = el('p', { class: 'ca-path-status', role: 'status', id: domId('project-path-status') })
  pathInput.setAttribute('aria-describedby', pathStatus.id)
  const titleInput = el('input', { name: 'title', placeholder: '标题（可选）', 'aria-label': '标题', autocomplete: 'off' })
  const createButton = el('button', { type: 'submit', class: 'primary-button', text: '新建线程', disabled: true })
  const browseButton = el('button', { type: 'button', class: 'ca-browse', text: '浏览…', 'aria-expanded': 'false' })
  const nativeButton = el('button', { type: 'button', class: 'ca-pick-native', text: '系统目录窗口…', hidden: true })
  const form = el('form', { class: 'ca-project-form' }, pathInput, pathStatus, el('div', { class: 'ca-project-actions' }, titleInput, createButton, browseButton, nativeButton))
  const browserPath = el('code', { class: 'ca-browser-path' })
  const upButton = el('button', { type: 'button', class: 'ca-browser-up', text: '上级', title: '上级目录' })
  const hiddenToggle = el('input', { type: 'checkbox', id: domId('show-hidden') })
  const entries = el('ul', { class: 'ca-browser-entries', 'aria-label': '子目录' })
  const chooseButton = el('button', { type: 'button', class: 'primary-button ca-browser-choose', text: '选择此目录' })
  const browser = el('section', { class: 'ca-browser', hidden: true, 'aria-label': '浏览执行设备目录' },
    el('div', { class: 'ca-browser-head' }, upButton, browserPath),
    entries,
    el('div', { class: 'ca-browser-foot' }, el('label', { class: 'ca-browser-hidden' }, hiddenToggle, el('span', { text: '显示隐藏目录' })), chooseButton))
  const recentList = el('ul', { class: 'ca-recent-list', 'aria-label': '最近项目' })
  const recentHint = el('p', { class: 'ca-recent-hint', hidden: true })
  const element = el('section', { class: 'ca-project-panel', 'aria-label': '项目' },
    el('h2', { text: '项目' }), form, browser, el('h3', { text: '最近项目' }), recentList, recentHint)

  let enabled = false, disposed = false, valid: string | undefined, validating: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined
  let listing: DirectoryListingView | undefined, browsing: AbortController | undefined, recentLoad: AbortController | undefined
  const encode = (path: string, showHidden: boolean) => `${app}/directories?path=${encodeURIComponent(path)}${showHidden ? '&showHidden=1' : ''}`
  const setStatus = (text: string, state: '' | 'checking' | 'valid' | 'invalid') => { pathStatus.textContent = text; pathStatus.dataset.state = state }
  const markValid = (path: string) => {
    valid = path; createButton.disabled = !enabled; titleInput.placeholder = `标题（默认 ${lastSegment(path)}）`
    setStatus('目录存在', 'valid')
  }
  const markInvalid = (text: string) => { valid = undefined; createButton.disabled = true; titleInput.placeholder = '标题（可选）'; setStatus(text, 'invalid') }
  const cancelValidation = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined } validating?.abort(); validating = undefined }
  /** Debounced existence check through the device's directory listing; a valid path becomes the selected project. */
  const validate = async (path: string) => {
    cancelValidation()
    if (!path) { valid = undefined; createButton.disabled = true; titleInput.placeholder = '标题（可选）'; setStatus('', ''); return }
    const controller = new AbortController(); validating = controller
    setStatus('正在检查…', 'checking')
    try {
      const found = await handlers.request<DirectoryListingView>(encode(path, false), controller.signal)
      if (controller.signal.aborted) return
      markValid(found.path)
      handlers.select(found.path)
    } catch (error) {
      if (controller.signal.aborted) return
      markInvalid(isApiError(error) && error.status === 404 ? '执行设备上没有这个目录' : isApiError(error) && error.status === 400 ? '需要执行设备上的绝对路径' : '无法检查目录，请稍后重试')
      if (!isApiError(error) || (error.status !== 404 && error.status !== 400)) handlers.report(error)
    } finally { if (validating === controller) validating = undefined }
  }
  pathInput.addEventListener('input', () => {
    cancelValidation()
    const path = pathInput.value.trim()
    if (!path) { void validate('') ; return }
    setStatus('正在检查…', 'checking'); valid = undefined; createButton.disabled = true
    timer = setTimeout(() => { timer = undefined; void validate(path) }, validateDelayMs)
  })
  form.addEventListener('submit', event => {
    event.preventDefault()
    if (!enabled || !valid) return
    const title = titleInput.value.trim()
    handlers.create(valid, title || undefined)
    titleInput.value = ''
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
    const cancelPlaceholder = delayedPlaceholder(entries, '正在读取目录…')
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
    const open = browser.hidden
    browser.hidden = !open; browseButton.setAttribute('aria-expanded', String(open))
    if (open) void browse(valid ?? (pathInput.value.trim() || '~'))
    else { browsing?.abort(); browsing = undefined }
  })
  upButton.addEventListener('click', () => { if (listing?.parent) void browse(listing.parent) })
  hiddenToggle.addEventListener('change', () => { if (listing) void browse(listing.path) })
  chooseButton.addEventListener('click', () => { if (listing) { setPath(listing.path); handlers.select(listing.path) } })
  const setPath = (path: string) => { cancelValidation(); pathInput.value = path; markValid(path) }
  let picking: AbortController | undefined
  const cancelPicking = () => { picking?.abort(); picking = undefined }
  nativeButton.addEventListener('click', () => { void (async () => {
    if (picking || !enabled || disposed) return
    const controller = new AbortController(); picking = controller; nativeButton.disabled = true
    try {
      const path = await handlers.pickNative(controller.signal)
      if (path && !controller.signal.aborted && !disposed && enabled && picking === controller) { setPath(path); handlers.select(path) }
    } catch (error) { if (!controller.signal.aborted && !disposed && picking === controller) handlers.report(error) }
    finally { if (picking === controller) { picking = undefined; nativeButton.disabled = !enabled } }
  })() })
  const renderRecent = (recent: RecentProjectsView | undefined, now: number) => {
    recentList.replaceChildren(...(recent?.projects ?? []).map(project => {
      const button = el('button', { type: 'button', 'data-path': project.path, title: project.path },
        el('span', { class: 'ca-recent-name', text: project.name }), el('small', { text: `${relativeTime(project.lastUsedAt, now)} · ${sourceLabels[project.source]}` }))
      button.addEventListener('click', () => { setPath(project.path); handlers.select(project.path) })
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
    const cancelPlaceholder = delayedPlaceholder(recentList, '正在读取最近项目…')
    try {
      const recent = await handlers.request<RecentProjectsView>(`${app}/projects/recent`, controller.signal)
      if (!controller.signal.aborted) renderRecent(recent, Date.now())
    } catch (error) {
      if (controller.signal.aborted) return
      recentList.replaceChildren(el('li', { class: 'ca-empty', text: '无法读取最近项目。' })); handlers.report(error)
    } finally { cancelPlaceholder(); if (recentLoad === controller) recentLoad = undefined }
  }
  const setEnabled = (next: boolean) => {
    enabled = next
    if (!next) cancelPicking()
    for (const control of [pathInput, titleInput, browseButton, upButton, hiddenToggle, chooseButton]) control.disabled = !next
    nativeButton.disabled = !next || !!picking
    createButton.disabled = !next || !valid
    if (!next) { cancelValidation(); browsing?.abort(); recentLoad?.abort(); valid = undefined; pathInput.value = ''; setStatus('', ''); listing = undefined; browser.hidden = true; browseButton.setAttribute('aria-expanded', 'false'); renderBrowser(); recentList.replaceChildren(); recentHint.hidden = true }
  }
  renderBrowser()
  return { element, setEnabled, setPath, setNativePicker: available => { nativeButton.hidden = !available }, refreshRecent, dispose() { disposed = true; setEnabled(false) } }
}
