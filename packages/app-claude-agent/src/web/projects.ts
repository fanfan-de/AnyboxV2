import type { DirectoryListingView, RecentProjectsView } from '../core/view.js'
import { isApiError, relativeTime } from './state.js'
import { el, sourceI18n } from './i18n.js'
import type { ClaudeI18n } from './i18n.js'

const app = '/apps/claude-agent'
const validateDelayMs = 350, placeholderDelayMs = 200
const sourceKeys = { threads: 'project.sourceApp', claude: 'project.sourceClaude', both: 'project.sourceBoth' } as const
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
const delayedPlaceholder = (node: HTMLElement, text: () => string, signal: AbortSignal, i18n: ClaudeI18n) => {
  const timer = setTimeout(() => { if (!signal.aborted) node.replaceChildren(i18n.element('li', { class: 'ca-empty', text })) }, placeholderDelayMs)
  return () => clearTimeout(timer)
}

/** On-demand project selection on the execution device; the first prompt can create the thread. */
export function createProjectPanel(domId: (local: string) => string, handlers: ProjectPanelHandlers, i18n: ClaudeI18n = sourceI18n): ProjectPanel {
  const { t, element: el } = i18n
  const newButton = el('button', { type: 'button', class: 'ca-new-thread primary-button', text: () => t('project.new'), 'aria-haspopup': 'dialog', 'aria-controls': domId('project-dialog'), disabled: true })
  const pathInput = el('input', { name: 'projectPath', placeholder: () => t('project.pathPlaceholder'), 'aria-label': () => t('project.path'), autocomplete: 'off', spellcheck: 'false', id: domId('project-path') })
  const pathStatus = el('p', { class: 'ca-path-status', role: 'status', id: domId('project-path-status') })
  pathInput.setAttribute('aria-describedby', pathStatus.id)
  const titleInput = el('input', { name: 'title', placeholder: () => t('project.optionalTitle'), 'aria-label': () => t('project.title'), autocomplete: 'off', id: domId('project-title') })
  const createButton = el('button', { type: 'button', class: 'ca-project-create', text: () => t('project.createEmpty'), disabled: true })
  const selectButton = el('button', { type: 'button', class: 'primary-button ca-project-select', text: () => t('project.use'), disabled: true })
  const browseButton = el('button', { type: 'button', class: 'ca-browse', text: () => t('project.browse'), 'aria-expanded': 'false', 'aria-controls': domId('project-browser') })
  const nativeButton = el('button', { type: 'button', class: 'ca-pick-native', text: () => t('project.nativePicker'), hidden: true })
  const form = el('form', { class: 'ca-project-form' },
    el('label', { class: 'ca-project-field', for: pathInput.id }, el('span', { text: () => t('project.path') }), pathInput), pathStatus,
    el('div', { class: 'ca-project-actions' }, browseButton, nativeButton),
    el('details', { class: 'ca-project-options' }, el('summary', { text: () => t('project.customTitle') }),
      el('label', { class: 'ca-project-field', for: titleInput.id }, el('span', { text: () => t('project.conversationTitle') }), titleInput), createButton))
  const browserPath = el('code', { class: 'ca-browser-path' })
  const upButton = el('button', { type: 'button', class: 'ca-browser-up', text: () => t('project.parent'), title: () => t('project.parentDirectory') })
  const hiddenToggle = el('input', { type: 'checkbox', id: domId('show-hidden') })
  const entries = el('ul', { class: 'ca-browser-entries', 'aria-label': () => t('project.subdirectories') })
  const chooseButton = el('button', { type: 'button', class: 'primary-button ca-browser-choose', text: () => t('project.chooseDirectory') })
  const browser = el('section', { class: 'ca-browser', id: domId('project-browser'), hidden: true, 'aria-label': () => t('project.browseDevice') },
    el('div', { class: 'ca-browser-head' }, upButton, browserPath),
    entries,
    el('div', { class: 'ca-browser-foot' }, el('label', { class: 'ca-browser-hidden' }, hiddenToggle, el('span', { text: () => t('project.showHidden') })), chooseButton))
  const recentList = el('ul', { class: 'ca-recent-list', 'aria-label': () => t('project.recent') })
  const recentHint = el('p', { class: 'ca-recent-hint', hidden: true })
  const closeButton = el('button', { type: 'button', class: 'ca-project-close', text: '×', 'aria-label': () => t('project.close'), title: () => t('project.close') })
  const dialog = el('dialog', { class: 'ca-project-dialog', id: domId('project-dialog'), 'aria-modal': 'true', 'aria-labelledby': domId('project-dialog-title'), 'aria-describedby': domId('project-dialog-description') },
    el('header', { class: 'ca-project-dialog-head' }, el('h2', { id: domId('project-dialog-title'), text: () => t('project.new') }), closeButton),
    el('div', { class: 'ca-project-dialog-body' },
      el('p', { class: 'ca-project-description', id: domId('project-dialog-description'), text: () => t('project.description') }),
      form, browser,
      el('section', { class: 'ca-recent-projects' }, el('h3', { text: () => t('project.recent') }), recentList, recentHint)),
    el('footer', { class: 'ca-project-dialog-foot' }, el('span', { class: 'ca-project-dialog-hint', text: () => t('project.nextStep') }), selectButton))
  const element = el('section', { class: 'ca-project-panel', 'aria-label': () => t('project.projects') }, newButton, dialog)

  let enabled = false, disposed = false, valid: string | undefined, currentPath: string | undefined, validating: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined
  let listing: DirectoryListingView | undefined, browsing: AbortController | undefined, recentLoad: AbortController | undefined
  let picking: AbortController | undefined, returnFocus: HTMLElement | undefined
  const encode = (path: string, showHidden: boolean) => `${app}/directories?path=${encodeURIComponent(path)}${showHidden ? '&showHidden=1' : ''}`
  const setStatus = (text: () => string, state: '' | 'checking' | 'valid' | 'invalid') => { i18n.bind(pathStatus, 'text', text); pathStatus.dataset.state = state }
  const markValid = (path: string) => {
    valid = path; createButton.disabled = !enabled; selectButton.disabled = !enabled; i18n.bind(titleInput, 'placeholder', () => t('project.titleDefault', { name: lastSegment(path) }))
    setStatus(() => t('project.exists'), 'valid')
  }
  const markInvalid = (text: () => string) => { valid = undefined; createButton.disabled = true; selectButton.disabled = true; i18n.bind(titleInput, 'placeholder', () => t('project.optionalTitle')); setStatus(text, 'invalid') }
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
    if (!path) { valid = undefined; createButton.disabled = true; selectButton.disabled = true; i18n.bind(titleInput, 'placeholder', () => t('project.optionalTitle')); setStatus(() => '', ''); return }
    const controller = new AbortController(); validating = controller
    setStatus(() => t('project.checking'), 'checking')
    try {
      const found = await handlers.request<DirectoryListingView>(encode(path, false), controller.signal)
      if (controller.signal.aborted) return
      markValid(found.path)
    } catch (error) {
      if (controller.signal.aborted) return
      markInvalid(() => isApiError(error) && error.status === 404 ? t('project.notFound') : isApiError(error) && error.status === 400 ? t('project.absoluteRequired') : t('project.checkFailed'))
      if (!isApiError(error) || (error.status !== 404 && error.status !== 400)) handlers.report(error)
    } finally { if (validating === controller) validating = undefined }
  }
  pathInput.addEventListener('input', () => {
    if (!enabled || disposed) return
    cancelValidation()
    const path = pathInput.value.trim()
    if (!path) { void validate('') ; return }
    setStatus(() => t('project.checking'), 'checking'); valid = undefined; createButton.disabled = true; selectButton.disabled = true
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
    if (listing && !listing.entries.length) entries.append(el('li', { class: 'ca-empty', text: () => t('project.noChildren') }))
    if (listing?.truncated) entries.append(el('li', { class: 'ca-empty', text: () => t('project.truncated') }))
  }
  const browse = async (path: string) => {
    browsing?.abort()
    const controller = new AbortController(); browsing = controller
    const cancelPlaceholder = delayedPlaceholder(entries, () => t('project.loadingDirectories'), controller.signal, i18n)
    try {
      const next = await handlers.request<DirectoryListingView>(encode(path, hiddenToggle.checked), controller.signal)
      if (controller.signal.aborted) return
      listing = next; renderBrowser()
    } catch (error) {
      if (controller.signal.aborted) return
      cancelPlaceholder(); renderBrowser()
      entries.replaceChildren(el('li', { class: 'ca-empty', text: () => isApiError(error) && error.status === 404 ? t('project.directoryGone') : isApiError(error) && error.status === 403 ? t('project.directoryDenied') : t('project.directoryFailed') }))
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
        el('span', { class: 'ca-recent-name', text: project.name }), el('small', { text: () => `${relativeTime(project.lastUsedAt, now, i18n)} · ${t(sourceKeys[project.source])}` }))
      button.addEventListener('click', () => selectProject(project.path))
      return el('li', {}, button)
    }))
    if (recent && !recent.projects.length) recentList.append(el('li', { class: 'ca-empty', text: () => t('project.noRecent') }))
    recentHint.hidden = !recent?.partial
    i18n.bind(recentHint, 'text', () => recent?.partial ? t('project.recentPartial') : '')
  }
  const refreshRecent = async () => {
    if (!enabled || disposed) return
    recentLoad?.abort()
    const controller = new AbortController(); recentLoad = controller
    const cancelPlaceholder = delayedPlaceholder(recentList, () => t('project.loadingRecent'), controller.signal, i18n)
    try {
      const recent = await handlers.request<RecentProjectsView>(`${app}/projects/recent`, controller.signal)
      if (!controller.signal.aborted) renderRecent(recent, Date.now())
    } catch (error) {
      if (controller.signal.aborted) return
      recentList.replaceChildren(el('li', { class: 'ca-empty', text: () => t('project.recentFailed') })); handlers.report(error)
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
    if (!next) { cancelValidation(); browsing?.abort(); recentLoad?.abort(); valid = undefined; currentPath = undefined; pathInput.value = ''; setStatus(() => '', ''); listing = undefined; browser.hidden = true; browseButton.setAttribute('aria-expanded', 'false'); renderBrowser(); recentList.replaceChildren(); recentHint.hidden = true }
  }
  renderBrowser()
  return { element, open, close, setEnabled, setPath, setNativePicker: available => { nativeButton.hidden = !available; if (!available) cancelPicking() }, refreshRecent, dispose() { disposed = true; setEnabled(false) } }
}
