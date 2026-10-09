import type { Api } from './client-types.js'
import type { SessionRef } from './workspace-layout.js'
import type { DraftFile } from './draft-client.js'
import { restoreDraftFiles } from './draft-client.js'
import type { FileMention, SessionController } from './session-client.js'
import { sameFileReference } from './session-client.js'
import { fileLabel } from './file-client.js'
import { validateFilePath, validateFileRange } from '../core/project-files/domain.js'
import type { FilePreview, FileContent, FileRange, FileSelection } from '../core/project-files/domain.js'
import { createFileTreeClient } from './file-tree-client.js'
import type { FileTreeClient, FileTreeEntry } from './file-tree-client.js'

export interface FilePreviewRequest {
  readonly ref: SessionRef; readonly parentNodeId: string | null; readonly kind: 'current' | 'draft' | 'history'
  readonly item: DraftFile; readonly mention?: FileMention
}
export interface FileSidebarTab {
  readonly id: string; readonly kind: FilePreviewRequest['kind']; readonly parentNodeId: string | null
  readonly item: DraftFile; readonly range?: FileRange; readonly scrollTop: number; readonly scrollLeft: number
}
export interface FileSidebarSessionState {
  readonly tabs: readonly FileSidebarTab[]; readonly activeTabId: string | null
  readonly treeExpanded: readonly string[]; readonly treeCollapsed: boolean; readonly treeScroll: number; readonly treeWidth: number
}
export interface FileSidebar {
  setSession(ref: SessionRef | undefined, controller: SessionController | undefined, state?: FileSidebarSessionState): void
  open(request: FilePreviewRequest): void
  snapshot(): FileSidebarSessionState
  setVisible(visible: boolean): void
  refresh(): void
  dispose(): Promise<void>
}
const treeDefaultWidth = 220, treeMinimumWidth = 180, treeMaximumWidth = 360, readerMinimumWidth = 280, treeSeparatorWidth = 1
/** The saved preference survives automatic fitting into a narrower file panel. */
export function clampFileTreeWidth(width: number, available = 0): number {
  const maximum = available > 480 ? Math.min(treeMaximumWidth, available - readerMinimumWidth - treeSeparatorWidth) : treeMaximumWidth
  return Math.max(treeMinimumWidth, Math.min(maximum, Number.isFinite(width) ? width : treeDefaultWidth))
}
const emptyState: FileSidebarSessionState = Object.freeze({ tabs: [], activeTabId: null, treeExpanded: [], treeCollapsed: false, treeScroll: 0, treeWidth: treeDefaultWidth })
const tabId = (item: DraftFile, kind: FilePreviewRequest['kind']) => item.selection?.kind === 'snapshot' ? `snapshot:${kind}:${item.selection.snapshotId}`
  : item.selection?.kind === 'project-file' ? `current:${item.selection.path}` : undefined
const scrollValue = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
/** Only descriptors survive refresh; previews, requests and directory cursors remain private. */
export function restoreFileSidebarSessionState(value: unknown): FileSidebarSessionState {
  if (!value || typeof value !== 'object') return emptyState
  const record = value as Partial<FileSidebarSessionState>, ids = new Set<string>(), tabs: FileSidebarTab[] = []
  for (const raw of Array.isArray(record.tabs) ? record.tabs : []) {
    if (!raw || !['current', 'draft', 'history'].includes(raw.kind) || (raw.parentNodeId !== null && typeof raw.parentNodeId !== 'string')) continue
    const [item] = restoreDraftFiles([raw.item]), id = item?.selection ? tabId(item, raw.kind) : undefined
    if (!id || ids.has(id)) continue
    let range: FileRange | undefined
    try { range = validateFileRange(raw.range) } catch { continue }
    ids.add(id); tabs.push({ id, kind: raw.kind, parentNodeId: raw.parentNodeId, item, ...(range ? { range } : {}), scrollTop: scrollValue(raw.scrollTop), scrollLeft: scrollValue(raw.scrollLeft) })
  }
  const treeExpanded = new Set<string>()
  for (const path of Array.isArray(record.treeExpanded) ? record.treeExpanded : []) {
    try { treeExpanded.add(validateFilePath(path)) } catch { /* Invalid paths cannot reserve directory reads. */ }
  }
  return { tabs, activeTabId: tabs.find(tab => tab.id === record.activeTabId)?.id ?? tabs[0]?.id ?? null,
    treeExpanded: [...treeExpanded], treeCollapsed: record.treeCollapsed === true, treeScroll: scrollValue(record.treeScroll),
    treeWidth: typeof record.treeWidth === 'number' ? clampFileTreeWidth(record.treeWidth) : treeDefaultWidth }
}

interface Preview { readonly key: string; readonly value?: FilePreview | FileContent; readonly error?: string; readonly loading: boolean }
const previewKey = (tab: FileSidebarTab) => JSON.stringify([tab.item.selection, tab.range])
const currentSelection = (tab: FileSidebarTab): Extract<FileSelection, { kind: 'project-file' }> => ({
  kind: 'project-file', path: (tab.item.selection as Extract<FileSelection, { kind: 'project-file' }>).path, ...(tab.range ? { range: tab.range } : {}),
})
const tabLabel = (tab: FileSidebarTab) => fileLabel(tab.item.selection?.kind === 'project-file' ? currentSelection(tab) : tab.item.selection, tab.item.file)
const tabPath = (tab: FileSidebarTab) => tab.item.selection?.kind === 'project-file' ? tab.item.selection.path : tab.item.file?.path ?? '文件快照'
const fileIcon = (path: string) => /\.mdx?$/i.test(path) ? 'markdown' : /\.(?:[cm]?[jt]sx?|json|css|html|ya?ml|toml|sh)$/i.test(path) ? 'file-code' : 'file'
let viewSequence = 0
/** One visible sidebar reuses the active thread's controller and joins all of its own reads. */
export function createFileSidebar(container: HTMLElement, environment: {
  api: Api; messageFor(error: unknown): string; changed(sessionId: string, state: FileSidebarSessionState): void
  projectLabel?(ref: SessionRef): string | undefined
}): FileSidebar {
  const document = container.ownerDocument, lifetime = new AbortController(), options = { signal: lifetime.signal }
  const icon = (name: string, className = '') => {
    const image = document.createElement('img'); image.className = `icon ${className}`.trim()
    image.src = `/apps/agent/icons/${name}.svg`; image.alt = ''; image.setAttribute('aria-hidden', 'true'); return image
  }
  const view = document.createElement('div'); view.className = 'file-sidebar-view'
  const pathbar = document.createElement('div'); pathbar.className = 'file-pathbar'
  const split = document.createElement('div'); split.className = 'file-sidebar-split'
  const treeSection = document.createElement('section'); treeSection.className = 'file-tree-section'
  const collapse = document.createElement('button'); collapse.type = 'button'; collapse.append(icon('files')); collapse.setAttribute('aria-label', '折叠项目文件树')
  const refreshTree = document.createElement('button'); refreshTree.type = 'button'; refreshTree.append(icon('refresh')); refreshTree.title = '刷新项目文件树'; refreshTree.setAttribute('aria-label', refreshTree.title)
  const pathbarActions = document.createElement('div'); pathbarActions.className = 'file-pathbar-actions'; pathbarActions.append(refreshTree, collapse)
  const filterBox = document.createElement('label'); filterBox.className = 'file-tree-filter'
  const filter = document.createElement('input'); filter.type = 'search'; filter.placeholder = '筛选文件…'; filter.setAttribute('aria-label', '筛选已加载的项目文件'); filter.title = '筛选已加载的目录和文件；展开目录或加载更多可查看更多条目'
  filterBox.append(icon('search'), filter)
  const treeList = document.createElement('div'); treeList.className = 'file-tree-list'; treeList.setAttribute('role', 'tree'); treeList.setAttribute('aria-label', '项目文件目录')
  treeSection.append(filterBox, treeList)
  const separator = document.createElement('div'); separator.className = 'file-tree-separator'; separator.tabIndex = 0
  separator.setAttribute('role', 'separator'); separator.setAttribute('aria-label', '调整项目文件目录宽度'); separator.setAttribute('aria-orientation', 'vertical')
  const content = document.createElement('section'); content.className = 'file-content-section file-preview-pane'
  const empty = document.createElement('div'); empty.className = 'file-preview-empty'
  const emptyTitle = document.createElement('strong'); emptyTitle.textContent = '预览项目文件'
  const emptyHint = document.createElement('p'); empty.append(icon('files'), emptyTitle, emptyHint)
  const tabs = document.createElement('div'); tabs.className = 'file-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '打开的文件')
  const body = document.createElement('div'); body.className = 'file-preview-body'
  const toolbar = document.createElement('div'); toolbar.className = 'file-preview-toolbar'
  const title = document.createElement('h3'); title.className = 'file-preview-heading'
  const breadcrumbs = document.createElement('div'); breadcrumbs.className = 'file-preview-breadcrumbs'; breadcrumbs.setAttribute('aria-label', '当前文件路径')
  title.append(breadcrumbs); pathbar.append(title, pathbarActions)
  const detail = document.createElement('p'); detail.className = 'file-preview-detail'; detail.setAttribute('role', 'status')
  const rangeBox = document.createElement('div'); rangeBox.className = 'file-preview-range'
  const start = document.createElement('input'), end = document.createElement('input')
  for (const [input, label] of [[start, '起始行'], [end, '结束行']] as const) {
    input.type = 'number'; input.min = '1'; input.setAttribute('aria-label', label)
    const wrapper = document.createElement('label'); wrapper.textContent = label; wrapper.append(input); rangeBox.append(wrapper)
  }
  const previewRange = document.createElement('button'); previewRange.type = 'button'; previewRange.textContent = '预览范围'; rangeBox.append(previewRange)
  const pre = document.createElement('pre'); pre.className = 'file-preview-text'; pre.tabIndex = 0; pre.setAttribute('aria-label', '只读文件内容')
  const actions = document.createElement('div'); actions.className = 'file-preview-actions'
  const apply = document.createElement('button'); apply.type = 'button'; apply.textContent = '引用文件'
  const current = document.createElement('button'); current.type = 'button'; current.textContent = '查看当前文件'
  const reload = document.createElement('button'); reload.type = 'button'; reload.textContent = '重新读取'
  actions.append(current, reload, apply); toolbar.append(actions); body.append(toolbar, detail, rangeBox, pre); content.append(tabs, body, empty)
  split.append(content, separator, treeSection); view.append(pathbar, split); container.append(view)
  const namespace = `agent--file-sidebar-${++viewSequence}`; body.id = `${namespace}-preview`; body.setAttribute('role', 'tabpanel')
  treeSection.id = `${namespace}-tree`; separator.setAttribute('aria-controls', treeSection.id); collapse.setAttribute('aria-controls', treeSection.id)
  let ref: SessionRef | undefined, controller: SessionController | undefined, state = emptyState
  let visible = true, disposed = false, generation = 0, tree: FileTreeClient | undefined, previewAbort: AbortController | undefined
  let dirtyRange = false, notice = '', rendering = false, exit: Promise<void> | undefined, treeQuery = '', selectedTreePath: string | undefined
  let drag: { readonly pointerId: number; readonly origin: number; readonly width: number } | undefined
  const pending = new Set<Promise<unknown>>(), failures: unknown[] = [], previews = new Map<string, Preview>(), mentions = new Map<string, FileMention>()
  // Search may reveal previously loaded rows after collapse; these copies own no server cursor.
  const loadedTreeEntries = new Map<string, readonly FileTreeEntry[]>()
  const track = <T>(job: Promise<T>): Promise<T> => { pending.add(job); void job.finally(() => pending.delete(job)).catch(() => {}); return job }
  const activeTab = () => state.tabs.find(tab => tab.id === state.activeTabId)
  const editable = () => {
    const snapshot = controller?.snapshot()
    return Boolean(snapshot?.session && !snapshot.loading && !snapshot.busy && !snapshot.pending && !snapshot.session.archivedAt && snapshot.session.historyMode !== 'dialogue-v1')
  }
  const changed = () => { if (ref && !disposed) environment.changed(ref.sessionId, state) }
  const splitWidth = () => split.getBoundingClientRect?.().width ?? 0
  const stopDrag = () => {
    const previous = drag; drag = undefined
    if (previous) { try { separator.releasePointerCapture(previous.pointerId) } catch { /* Capture may already be released. */ } }
    split.classList.toggle('is-resizing', false)
  }
  const renderLayout = () => {
    if (disposed || !visible) return
    const available = splitWidth(), stacked = available > 0 && available <= 480
    const width = clampFileTreeWidth(state.treeWidth, available)
    split.style.setProperty('--file-tree-width', `${width}px`)
    split.classList.toggle('tree-collapsed', state.treeCollapsed)
    separator.hidden = state.treeCollapsed || stacked; treeSection.hidden = state.treeCollapsed
    separator.setAttribute('aria-valuemin', String(treeMinimumWidth))
    separator.setAttribute('aria-valuemax', String(clampFileTreeWidth(treeMaximumWidth, available)))
    separator.setAttribute('aria-valuenow', String(width)); separator.setAttribute('aria-valuetext', `${width} 像素`)
    if (state.treeCollapsed || stacked) {
      stopDrag()
      if (document.activeElement === separator || state.treeCollapsed && treeSection.contains(document.activeElement)) collapse.focus()
    }
  }
  const resizeTree = (width: number) => {
    state = { ...state, treeWidth: clampFileTreeWidth(width, splitWidth()) }; renderLayout(); changed()
  }
  const cancelPreview = () => {
    previewAbort?.abort(); previewAbort = undefined
    for (const [id, preview] of previews) if (preview.loading) previews.delete(id)
  }
  const capture = () => {
    const tab = activeTab()
    if (tab && visible) state = { ...state, tabs: state.tabs.map(item => item.id === tab.id ? { ...item, scrollTop: pre.scrollTop, scrollLeft: pre.scrollLeft } : item) }
    if (visible && !state.treeCollapsed && !treeQuery) state = { ...state, treeScroll: treeList.scrollTop }
  }
  const stop = () => {
    generation++; cancelPreview(); stopDrag()
    loadedTreeEntries.clear()
    const previous = tree; tree = undefined
    if (previous) track(previous.dispose().catch(error => { failures.push(error) }))
  }
  const saveTab = (tab: FileSidebarTab) => { state = { ...state, tabs: state.tabs.map(item => item.id === tab.id ? tab : item) }; changed() }
  const renderTree = () => {
    if (disposed) return
    const focused = treeList.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.treePath : undefined
    const scroll = treeList.scrollTop, rows: HTMLElement[] = [], client = tree
    if (!ref || !controller) {
      const hint = document.createElement('p'); hint.className = 'file-tree-status'; hint.textContent = '选择一个会话以浏览项目文件'; rows.push(hint)
    } else if (!client) {
      const hint = document.createElement('p'); hint.className = 'file-tree-status'; hint.textContent = '正在读取项目文件…'; rows.push(hint)
    } else {
      const expanded = new Set(state.treeExpanded)
      const query = treeQuery.trim().toLocaleLowerCase(), included = new Set<string>()
      const directories = new Map(client.snapshot())
      for (const [path, directory] of directories) if (!directory.loading && !directory.error) loadedTreeEntries.set(path, directory.entries)
      if (query) for (const [path, entries] of loadedTreeEntries) if (!directories.has(path)) directories.set(path, { path, entries, loading: false, nextPage: null })
      let matches = 0
      const includeAncestors = (path: string) => {
        const parts = path.split('/')
        while (parts.length) { included.add(parts.join('/')); parts.pop() }
      }
      if (query) {
        const paths = ['']
        for (let index = 0; index < paths.length; index++) {
          const path = paths[index]!, directory = directories.get(path)
          if (!directory) continue
          if (path && expanded.has(path) && (directory.loading || directory.error || directory.nextPage !== null)) includeAncestors(path)
          for (const entry of directory.entries) {
            if (entry.kind === 'directory') paths.push(entry.path)
            if (entry.path.toLocaleLowerCase().includes(query)) { matches++; includeAncestors(entry.path) }
          }
        }
      }
      const branch = (path: string, level: number) => {
        const directory = directories.get(path)
        if (!directory && !query) {
          queueMicrotask(() => { if (tree === client && visible && !state.treeCollapsed && (!path || state.treeExpanded.includes(path))) void client.open(path) })
          return
        }
        if (!directory) return
        for (const entry of directory.entries) {
          if (query && !included.has(entry.path)) continue
          const button = document.createElement('button'); button.type = 'button'; button.className = 'file-tree-entry'
          button.dataset.treePath = entry.path; button.dataset.treeKind = entry.kind; button.style.setProperty('--file-tree-level', String(level))
          button.setAttribute('role', 'treeitem'); button.setAttribute('aria-level', String(level + 1)); button.title = entry.path
          const chevron = document.createElement('span'); chevron.className = 'file-tree-chevron'
          const showChildren = expanded.has(entry.path) || Boolean(query && included.has(entry.path) && directories.has(entry.path))
          if (entry.kind === 'directory') chevron.append(icon(showChildren ? 'chevron-down' : 'chevron-right'))
          const name = document.createElement('span'); name.className = 'file-tree-name'; name.textContent = entry.name
          button.append(chevron, icon(entry.kind === 'directory' ? showChildren ? 'folder-opened' : 'folder' : fileIcon(entry.path), 'file-tree-icon'), name)
          if (entry.kind === 'directory') button.setAttribute('aria-expanded', String(showChildren))
          button.setAttribute('aria-selected', String(selectedTreePath === entry.path))
          button.tabIndex = -1; rows.push(button)
          if (entry.kind === 'directory' && showChildren) branch(entry.path, level + 1)
        }
        if (directory.loading || directory.error || !directory.entries.length) {
          const hint = document.createElement('p'); hint.className = 'file-tree-status'; hint.style.setProperty('--file-tree-level', String(level))
          hint.textContent = directory.loading ? '正在读取…' : directory.error ? environment.messageFor(directory.error) : directory.nextPage !== null ? '尚无已加载条目，请加载更多。' : '此目录为空。'; rows.push(hint)
          if (directory.error) {
            const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'file-tree-retry'; retry.textContent = '重试'; retry.dataset.retryTreePath = path; rows.push(retry)
          }
        }
        if (directory.nextPage !== null && !directory.loading && !directory.error) {
          const more = document.createElement('button'); more.type = 'button'; more.className = 'file-tree-more'; more.textContent = '加载更多'; more.dataset.moreTreePath = path; rows.push(more)
        }
      }
      branch('', 0)
      if (query && !matches) {
        const hint = document.createElement('p'); hint.className = 'file-tree-status'; hint.textContent = '已加载的条目中没有匹配项。可展开目录或加载更多后再筛选。'; rows.push(hint)
      }
    }
    treeList.replaceChildren(...rows)
    const buttons = [...treeList.querySelectorAll<HTMLButtonElement>('[data-tree-path]')]
    const selected = buttons.find(button => button.dataset.treePath === focused) ?? buttons[0]
    if (selected) selected.tabIndex = 0
    if (focused !== undefined && selected && visible) selected.focus({ preventScroll: true })
    treeList.scrollTop = treeQuery ? scroll : scroll || state.treeScroll
    refreshTree.disabled = !ref || !controller || state.treeCollapsed
    filter.disabled = !ref || !controller
  }
  const ensureTree = () => {
    if (tree || !visible || !ref || !controller || state.treeCollapsed || disposed) return
    const version = generation
    tree = createFileTreeClient(environment.api, ref, () => { if (version === generation) renderTree() })
    void tree.open('')
  }
  const renderPreview = () => {
    const tab = activeTab(), preview = tab ? previews.get(tab.id) : undefined
    const currentFile = tab?.item.selection?.kind === 'project-file'
    tabs.hidden = !tab; body.hidden = !tab; empty.hidden = Boolean(tab); view.classList.toggle('has-file-tabs', Boolean(tab))
    emptyHint.textContent = ref ? '从右侧目录选择文件，在这里查看内容。' : '选择一个会话以浏览项目文件。'
    treeList.hidden = state.treeCollapsed; filterBox.hidden = state.treeCollapsed; collapse.setAttribute('aria-expanded', String(!state.treeCollapsed)); collapse.setAttribute('aria-label', state.treeCollapsed ? '展开项目文件树' : '折叠项目文件树')
    collapse.title = collapse.getAttribute('aria-label')!; collapse.setAttribute('aria-pressed', String(!state.treeCollapsed)); renderLayout()
    const scope = ref ? environment.projectLabel?.(ref) || '项目' : '选择会话', parts = [scope, ...(tab ? tabPath(tab).split('/') : [])]
    breadcrumbs.title = parts.join(' / ')
    breadcrumbs.replaceChildren(...parts.flatMap((part, index) => {
      const crumb = document.createElement('span'); crumb.className = 'file-preview-breadcrumb'; crumb.textContent = part; crumb.title = part
      if (!index) return [crumb]
      return [icon('chevron-right', 'file-preview-breadcrumb-separator'), crumb]
    }))
    if (!tab) { pre.textContent = ''; title.title = scope; return }
    title.title = tabLabel(tab)
    pre.setAttribute('aria-label', `只读文件内容 ${tabLabel(tab)}`)
    rangeBox.hidden = !currentFile; current.hidden = currentFile || !tab.item.file
    current.textContent = tab.kind === 'draft' ? '更新为当前文件' : '查看当前文件'
    reload.hidden = !currentFile; previewRange.disabled = Boolean(preview?.loading)
    if (currentFile && !dirtyRange && document.activeElement !== start && document.activeElement !== end) {
      const range = tab.range
      start.value = range ? String(range.start) : ''; end.value = range ? String(range.end) : ''
    }
    const value = preview?.value
    const nextText = value?.text ?? ''
    if (pre.textContent !== nextText) pre.textContent = nextText
    if (notice) detail.textContent = notice
    else if (preview?.loading) detail.textContent = '正在读取…'
    else if (preview?.error) detail.textContent = preview.error
    else if (value && 'file' in value) detail.textContent = `${tab.kind === 'history' ? '发送时快照' : '已固定快照'} · ${value.file.createdAt} · ${value.file.byteLength} 字节`
    else if (value) detail.textContent = `当前文件预览，发送时重新读取 · 共 ${value.totalLines} 行 · ${value.byteLength} 字节${value.canReference ? '' : ' · 仅显示开头，请缩小行范围后引用'}`
    else detail.textContent = '选择文件查看只读内容。'
    const loaded = Boolean(value && !preview?.loading && preview.key === previewKey(tab))
    apply.disabled = !loaded || !editable() || dirtyRange || Boolean(value && 'canReference' in value && !value.canReference)
    const snapshot = controller?.snapshot(), previous = snapshot?.files.find(item => item.id === tab.item.id)
    const staleDraft = tab.kind === 'draft' && (tab.parentNodeId !== snapshot?.position.viewNodeId || !sameFileReference(previous, tab.item))
    if (staleDraft) apply.disabled = true
    current.disabled = tab.kind === 'draft' && (!editable() || staleDraft)
    apply.textContent = tab.kind === 'draft' ? currentFile ? '保存引用' : '引用此快照' : currentFile ? '引用文件' : '引用此快照'
  }
  const renderTabs = () => {
    const focused = tabs.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.fileTab : undefined
    tabs.replaceChildren(...state.tabs.map((tab, index) => {
      const wrapper = document.createElement('div'); wrapper.className = 'file-tab-item'; wrapper.setAttribute('role', 'presentation')
      const button = document.createElement('button'); button.type = 'button'; button.className = 'file-tab'; button.dataset.fileTab = tab.id
      button.id = `${namespace}-tab-${index}`; button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', body.id)
      button.setAttribute('aria-selected', String(tab.id === state.activeTabId)); button.tabIndex = tab.id === state.activeTabId ? 0 : -1
      const label = document.createElement('span'); label.textContent = tabPath(tab).split('/').at(-1)!
      button.append(icon(fileIcon(tabPath(tab))), label); button.title = `${tabLabel(tab)}${tab.item.selection?.kind === 'snapshot' ? ' · 快照' : ' · 当前文件'}`
      button.setAttribute('aria-label', button.title)
      const close = document.createElement('button'); close.type = 'button'; close.className = 'file-tab-close'; close.dataset.closeFileTab = tab.id; close.append(icon('close')); close.setAttribute('aria-label', `关闭文件 ${tabLabel(tab)}`)
      wrapper.append(button, close); return wrapper
    }))
    const index = state.tabs.findIndex(tab => tab.id === state.activeTabId)
    if (index >= 0) body.setAttribute('aria-labelledby', `${namespace}-tab-${index}`)
    if (focused !== undefined && visible) [...tabs.querySelectorAll<HTMLButtonElement>('[data-file-tab]')].find(button => button.dataset.fileTab === focused)?.focus({ preventScroll: true })
  }
  const loadPreview = (force = false) => {
    const tab = activeTab(), bound = controller
    if (!visible || disposed || !tab || !bound) return
    const key = previewKey(tab)
    if (!force && previews.get(tab.id)?.key === key) { renderPreview(); pre.scrollTop = tab.scrollTop; pre.scrollLeft = tab.scrollLeft; return }
    cancelPreview(); const abort = new AbortController(); previewAbort = abort
    const version = generation, selection = tab.item.selection!
    previews.set(tab.id, { key, loading: true }); renderPreview()
    const job = (async () => {
      try {
        const value = selection.kind === 'snapshot' ? await bound.readFile(selection.snapshotId, abort.signal) : await bound.previewFile(currentSelection(tab), abort.signal)
        if (disposed || abort.signal.aborted || version !== generation || controller !== bound || activeTab()?.id !== tab.id) return
        previews.set(tab.id, { key, value, loading: false })
      } catch (error) {
        if (disposed || abort.signal.aborted || version !== generation || controller !== bound || activeTab()?.id !== tab.id) return
        previews.set(tab.id, { key, error: environment.messageFor(error), loading: false })
      } finally {
        if (previewAbort === abort) previewAbort = undefined
        if (!disposed && !abort.signal.aborted && version === generation && activeTab()?.id === tab.id) { renderPreview(); pre.scrollTop = tab.scrollTop; pre.scrollLeft = tab.scrollLeft }
      }
    })()
    track(job)
  }
  const selectTab = (id: string) => {
    if (!state.tabs.some(tab => tab.id === id)) return
    capture(); cancelPreview(); const previous = activeTab()
    if (previous && previews.get(previous.id)?.loading) previews.delete(previous.id)
    state = { ...state, activeTabId: id }; dirtyRange = false; notice = ''
    const selection = activeTab()?.item.selection; selectedTreePath = selection?.kind === 'project-file' ? selection.path : undefined
    changed(); renderTabs(); renderTree(); loadPreview()
  }
  const canResizeTree = () => visible && !disposed && !state.treeCollapsed && splitWidth() > 480
  separator.addEventListener('keydown', event => {
    if (!canResizeTree()) return
    const width = clampFileTreeWidth(state.treeWidth, splitWidth())
    const next = event.key === 'ArrowLeft' ? width + 10 : event.key === 'ArrowRight' ? width - 10
      : event.key === 'Home' ? treeMinimumWidth : event.key === 'End' ? treeMaximumWidth : undefined
    if (next === undefined) return
    event.preventDefault(); resizeTree(next)
  }, options)
  separator.addEventListener('dblclick', () => { if (canResizeTree()) resizeTree(treeDefaultWidth) }, options)
  separator.addEventListener('pointerdown', event => {
    if (!canResizeTree() || event.button !== 0) return
    event.preventDefault(); separator.focus(); separator.setPointerCapture(event.pointerId)
    drag = { pointerId: event.pointerId, origin: event.clientX, width: clampFileTreeWidth(state.treeWidth, splitWidth()) }
    split.classList.toggle('is-resizing', true)
  }, options)
  separator.addEventListener('pointermove', event => {
    if (!canResizeTree() || !drag || event.pointerId !== drag.pointerId) return
    resizeTree(drag.width + drag.origin - event.clientX)
  }, options)
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) separator.addEventListener(name, stopDrag, options)
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => {
    if (!disposed && visible && splitWidth() > 0) renderLayout()
  })
  observer?.observe(split)
  filter.addEventListener('input', () => { treeQuery = filter.value; treeList.scrollTop = 0; renderTree() }, options)
  filter.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !treeQuery) return
    event.preventDefault(); event.stopPropagation(); treeQuery = ''; filter.value = ''; treeList.scrollTop = state.treeScroll; renderTree()
  }, options)
  treeList.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button')
    if (!button || !visible || !ref || !controller) return
    if (button.dataset.retryTreePath !== undefined) { void tree?.open(button.dataset.retryTreePath); return }
    if (button.dataset.moreTreePath !== undefined) { void tree?.more(button.dataset.moreTreePath); return }
    const path = button.dataset.treePath
    if (path === undefined) return
    selectedTreePath = path
    if (button.dataset.treeKind === 'directory') {
      const expanded = new Set(state.treeExpanded)
      // A matching branch is temporarily revealed during filtering. Clicking it keeps that branch open.
      if (!treeQuery && expanded.delete(path)) void tree?.close(path)
      else { expanded.add(path); if (!tree?.snapshot().has(path)) void tree?.open(path) }
      state = { ...state, treeExpanded: [...expanded] }; changed(); renderTree()
    } else sidebar.open({ ref, parentNodeId: controller.snapshot().position.viewNodeId, kind: 'current', item: { id: crypto.randomUUID(), selection: { kind: 'project-file', path } } })
  }, options)
  treeList.addEventListener('keydown', event => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-tree-path]')
    if (!target) return
    const buttons = [...treeList.querySelectorAll<HTMLButtonElement>('[data-tree-path]')], index = buttons.indexOf(target)
    let next: HTMLButtonElement | undefined
    if (event.key === 'ArrowDown') next = buttons[index + 1]
    else if (event.key === 'ArrowUp') next = buttons[index - 1]
    else if (event.key === 'Home') next = buttons[0]
    else if (event.key === 'End') next = buttons.at(-1)
    else if (event.key === 'ArrowRight') {
      if (target.dataset.treeKind === 'directory' && target.getAttribute('aria-expanded') !== 'true') target.click()
      else next = buttons[index + 1]
    } else if (event.key === 'ArrowLeft') {
      if (target.dataset.treeKind === 'directory' && target.getAttribute('aria-expanded') === 'true') target.click()
      else next = buttons.find(button => button.dataset.treePath === target.dataset.treePath?.split('/').slice(0, -1).join('/'))
    } else return
    event.preventDefault(); if (next) { target.tabIndex = -1; next.tabIndex = 0; next.focus() }
  }, options)
  collapse.addEventListener('click', () => {
    capture(); state = { ...state, treeCollapsed: !state.treeCollapsed }; changed()
    if (state.treeCollapsed) { const previous = tree; tree = undefined; if (previous) track(previous.dispose().catch(error => failures.push(error))) }
    else ensureTree()
    renderPreview(); renderTree()
  }, options)
  refreshTree.addEventListener('click', () => {
    if (state.treeCollapsed) return
    loadedTreeEntries.clear()
    const previous = tree; tree = undefined
    if (previous) track(previous.dispose().catch(error => failures.push(error)))
    ensureTree(); renderTree()
  }, options)
  tabs.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button')
    if (button?.dataset.fileTab) selectTab(button.dataset.fileTab)
    if (button?.dataset.closeFileTab) {
      capture(); const id = button.dataset.closeFileTab, index = state.tabs.findIndex(tab => tab.id === id), activeClosed = state.activeTabId === id
      const next = state.tabs.filter(tab => tab.id !== id)
      state = { ...state, tabs: next, activeTabId: state.activeTabId === id ? next[index]?.id ?? next[index - 1]?.id ?? null : state.activeTabId }
      previews.delete(id); mentions.delete(id)
      if (activeClosed) {
        cancelPreview(); dirtyRange = false; notice = ''
        const selection = activeTab()?.item.selection; selectedTreePath = selection?.kind === 'project-file' ? selection.path : undefined
      }
      changed(); renderTabs(); renderTree(); renderPreview(); loadPreview()
      if (!state.tabs.length) collapse.focus()
      else if (activeClosed) tabs.querySelector<HTMLButtonElement>(`#${namespace}-tab-${state.tabs.findIndex(tab => tab.id === state.activeTabId)}`)?.focus()
    }
  }, options)
  tabs.addEventListener('keydown', event => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-file-tab]')
    if (!target || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault(); const index = state.tabs.findIndex(tab => tab.id === target.dataset.fileTab)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? state.tabs.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + state.tabs.length) % state.tabs.length
    selectTab(state.tabs[next].id); tabs.querySelector<HTMLButtonElement>(`#${namespace}-tab-${next}`)?.focus()
  }, options)
  for (const field of [start, end]) field.addEventListener('input', () => { cancelPreview(); dirtyRange = true; notice = '范围已改变，请先预览。'; renderPreview() }, options)
  previewRange.addEventListener('click', () => {
    const tab = activeTab()
    if (!tab || tab.item.selection?.kind !== 'project-file') return
    try {
      const range = !start.value && !end.value ? undefined : validateFileRange({ start: Number(start.value), end: Number(end.value) })
      saveTab({ ...tab, range }); dirtyRange = false; notice = ''; renderTabs(); loadPreview(true)
    } catch { notice = '行范围无效，请填写完整的起止行。'; renderPreview() }
  }, options)
  reload.addEventListener('click', () => { notice = ''; loadPreview(true) }, options)
  current.addEventListener('click', () => {
    const tab = activeTab()
    if (!tab?.item.file || !ref || !controller || current.disabled) return
    const selection: FileSelection = { kind: 'project-file', path: tab.item.file.path, ...(tab.item.file.range ? { range: tab.item.file.range } : {}) }
    if (tab.kind === 'draft') {
      const item: DraftFile = { id: tab.item.id, selection }
      if (!controller.applyFileReference({ sessionId: ref.sessionId, parentNodeId: tab.parentNodeId, item, expectedItem: tab.item })) {
        notice = controller.snapshot().notice || '当前引用暂不可修改，请重新打开。'; renderPreview(); return
      }
      state = { ...state, tabs: state.tabs.filter(item => item.id !== tab.id) }; previews.delete(tab.id); mentions.delete(tab.id)
      sidebar.open({ ref, kind: 'draft', parentNodeId: tab.parentNodeId, item })
    } else sidebar.open({ ref, kind: 'current', parentNodeId: controller.snapshot().position.viewNodeId, item: { id: crypto.randomUUID(), selection } })
  }, options)
  apply.addEventListener('click', () => {
    const tab = activeTab(), snapshot = controller?.snapshot()
    if (!tab || !ref || !controller || !snapshot || apply.disabled) return
    const mention = mentions.get(tab.id), original = tab.item, selection = original.selection!
    const parentNodeId = tab.kind === 'draft' || mention ? tab.parentNodeId : snapshot.position.viewNodeId
    const item: DraftFile = selection.kind === 'project-file' ? { id: tab.kind === 'draft' ? original.id : crypto.randomUUID(), selection: currentSelection(tab) }
      : { id: tab.kind === 'draft' ? original.id : crypto.randomUUID(), selection, file: original.file }
    const accepted = controller.applyFileReference({ sessionId: ref.sessionId, parentNodeId, item, ...(tab.kind === 'draft' ? { expectedItem: original } : {}), ...(mention ? { mention } : {}) })
    if (accepted) { mentions.delete(tab.id); notice = '已引用到当前输入。'; if (tab.kind === 'draft') saveTab({ ...tab, item }); renderPreview() }
    else { notice = controller.snapshot().notice || '当前输入暂不可修改，请稍后重新引用。'; renderPreview() }
  }, options)
  pre.addEventListener('scroll', () => { if (!rendering) { capture(); changed() } }, options)
  treeList.addEventListener('scroll', () => { if (!rendering) { capture(); changed() } }, options)
  const sidebar: FileSidebar = {
    setSession(nextRef, nextController, restored) {
      if (disposed) return
      if (ref?.sessionId === nextRef?.sessionId && ref?.projectId === nextRef?.projectId && controller === nextController) { sidebar.refresh(); return }
      capture(); changed(); stop(); previews.clear(); mentions.clear()
      ref = nextRef; controller = nextController; state = restoreFileSidebarSessionState(restored); notice = ''; dirtyRange = false
      treeQuery = ''; filter.value = ''
      const selection = activeTab()?.item.selection; selectedTreePath = selection?.kind === 'project-file' ? selection.path : undefined
      pre.scrollTop = 0; pre.scrollLeft = 0; treeList.scrollTop = state.treeScroll
      ensureTree(); renderTabs(); renderTree(); renderPreview(); loadPreview()
    },
    open(request) {
      if (disposed || !ref || !controller || request.ref.sessionId !== ref.sessionId || request.ref.projectId !== ref.projectId) return
      const id = tabId(request.item, request.kind)
      if (!id) return
      capture(); cancelPreview()
      const previous = state.tabs.find(tab => tab.id === id)
      const range = request.item.selection?.kind === 'project-file' ? request.item.selection.range : undefined
      const tab: FileSidebarTab = { id, kind: request.kind, parentNodeId: request.parentNodeId, item: request.item, ...(range ? { range } : {}), scrollTop: previous?.scrollTop ?? 0, scrollLeft: previous?.scrollLeft ?? 0 }
      state = { ...state, tabs: previous ? state.tabs.map(value => value.id === id ? tab : value) : [...state.tabs, tab], activeTabId: id }
      selectedTreePath = request.item.selection?.kind === 'project-file' ? request.item.selection.path : undefined
      if (request.mention) mentions.set(id, request.mention); else mentions.delete(id)
      if (previews.get(id)?.loading) previews.delete(id)
      dirtyRange = false; notice = ''; changed(); renderTabs(); renderTree(); renderPreview(); loadPreview()
    },
    snapshot() { capture(); return state },
    setVisible(value) {
      if (disposed || visible === value) return
      if (!value) { capture(); changed(); stop(); previews.clear() }
      visible = value
      if (value) { ensureTree(); renderTree(); renderPreview(); loadPreview() }
    },
    refresh() { if (disposed) return; rendering = true; try { renderPreview() } finally { rendering = false } },
    dispose() {
      if (exit) return exit
      capture(); changed(); disposed = true; lifetime.abort(); observer?.disconnect(); stop(); view.remove()
      exit = (async () => { while (pending.size) await Promise.all([...pending]); if (failures.length) throw new AggregateError(failures, '文件侧栏清理失败。') })()
      return exit
    },
  }
  renderTree(); renderPreview()
  return sidebar
}
