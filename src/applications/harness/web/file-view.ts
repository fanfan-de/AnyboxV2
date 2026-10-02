import type { SessionController, SessionSnapshot } from './session-client.js'
import type { DraftFile } from './draft-client.js'
import { fileLabel, mentionAt } from './file-client.js'
import type { FileRef } from '../core/project-files/domain.js'
import type { SessionRef } from './workspace-layout.js'
import type { FilePreviewRequest } from './file-sidebar.js'

let viewSequence = 0
/** Composer selection remains pane-local; previews live in the thread-bound sidebar. */
export function createFileView(compose: HTMLFormElement, input: HTMLTextAreaElement, controller: SessionController,
  ref: SessionRef, open?: (request: FilePreviewRequest) => void) {
  const list = document.createElement('div'); list.className = 'composer-files'; list.setAttribute('aria-label', '待发送文件')
  compose.insertBefore(list, input)
  const picker = document.createElement('div'); picker.className = 'file-picker'; picker.hidden = true
  const search = document.createElement('input'); search.type = 'search'; search.placeholder = '搜索项目文件路径'; search.setAttribute('aria-label', '搜索项目文件')
  const results = document.createElement('div'); results.setAttribute('role', 'listbox'); results.setAttribute('aria-label', '项目文件候选')
  const hint = document.createElement('p'); hint.className = 'file-hint'; hint.setAttribute('role', 'status')
  picker.append(search, results, hint); compose.insertBefore(picker, input.nextSibling)
  const attach = document.createElement('button'); attach.type = 'button'; attach.className = 'attach-files'; attach.textContent = '引用项目文件'; attach.title = '也可输入 @ 搜索项目文件'
  compose.querySelector('.actions')!.prepend(attach)
  const namespace = `agent--file-options-${++viewSequence}`
  let paths: readonly string[] = [], selected = 0, timer: ReturnType<typeof setTimeout> | undefined
  let searchAbort: AbortController | undefined, parent = controller.snapshot().position.viewNodeId, listKey = '', disposed = false
  let mention: { start: number; end: number } | undefined
  const listeners = new AbortController(), options = { signal: listeners.signal }
  const closePicker = () => {
    clearTimeout(timer); searchAbort?.abort(); searchAbort = undefined; picker.hidden = true; paths = []; mention = undefined
    input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant')
  }
  const locked = () => { const state = controller.snapshot(); return !open || state.loading || state.busy || Boolean(state.pending) || !state.session || Boolean(state.session.archivedAt) || state.session.historyMode === 'dialogue-v1' }
  const preview = (item: DraftFile, kind: FilePreviewRequest['kind']) => {
    const position = controller.snapshot().position.viewNodeId
    const fragment = kind === 'current' && mention ? { ...mention, text: input.value.slice(mention.start, mention.end) } : undefined
    open?.({ ref, parentNodeId: position, kind, item, ...(fragment ? { mention: fragment } : {}) })
    closePicker()
  }
  function choose(path: string) {
    if (locked()) return
    preview({ id: crypto.randomUUID(), selection: { kind: 'project-file', path } }, 'current')
  }
  const paintResults = () => {
    results.replaceChildren(...paths.map((path, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = path
      button.id = `${namespace}-${index}`; button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(selected === index))
      button.addEventListener('click', () => choose(path), options); return button
    }))
    const id = results.children[selected]?.id
    if (id) input.setAttribute('aria-activedescendant', id)
  }
  const find = (query: string) => {
    clearTimeout(timer); searchAbort?.abort(); paths = []; selected = 0; paintResults(); hint.textContent = '正在搜索…'
    picker.hidden = false; input.setAttribute('aria-expanded', 'true')
    const abort = new AbortController(); searchAbort = abort
    timer = setTimeout(() => {
      void controller.searchFiles(query, abort.signal).then(value => {
        if (abort.signal.aborted || disposed) return
        paths = value.paths; paintResults()
        hint.textContent = value.incomplete ? '结果未完整显示，请输入更具体的路径。' : paths.length ? '↑ ↓ 选择 · Enter 在侧栏预览 · Esc 关闭' : '没有匹配的文件。'
      }).catch(error => { if (!abort.signal.aborted && !disposed) hint.textContent = controller.fileMessage(error) })
    }, 250)
  }
  attach.addEventListener('click', () => { mention = undefined; search.hidden = false; search.value = ''; find(''); search.focus() }, options)
  search.addEventListener('input', () => find(search.value), options)
  const keydown = (event: KeyboardEvent): boolean => {
    if (picker.hidden || event.isComposing) return false
    if (event.key === 'Escape') { event.preventDefault(); closePicker(); input.focus(); return true }
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault(); selected = paths.length ? (selected + (event.key === 'ArrowDown' ? 1 : -1) + paths.length) % paths.length : 0; paintResults(); return true
    }
    if (event.key === 'Enter') { event.preventDefault(); if (paths[selected]) choose(paths[selected]); return true }
    return false
  }
  search.addEventListener('keydown', keydown, options)
  input.addEventListener('input', event => {
    if ((event as InputEvent).isComposing || locked()) return
    const match = mentionAt(input.value, input.selectionStart)
    if (!match) { closePicker(); return }
    mention = { start: match.start, end: input.selectionStart }; search.hidden = true; find(match.query)
  }, options)
  const snapshotButton = (file: FileRef) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'message-file'
    button.textContent = fileLabel({ kind: 'snapshot', snapshotId: file.snapshotId }, file); button.title = '在侧栏查看发送时固定的文件内容'; button.disabled = !open
    button.addEventListener('click', () => preview({ id: file.snapshotId, file, selection: { kind: 'snapshot', snapshotId: file.snapshotId } }, 'history'), options)
    return button
  }
  return {
    keydown, snapshotButton,
    render(state: SessionSnapshot) {
      if (parent !== state.position.viewNodeId || state.loading) { parent = state.position.viewNodeId; closePicker() }
      attach.disabled = locked()
      if (locked()) closePicker()
      const key = JSON.stringify([state.files, attach.disabled])
      if (key === listKey) return
      listKey = key; list.hidden = !state.files.length
      list.replaceChildren(...state.files.map(item => {
        const chip = document.createElement('div'); chip.className = 'draft-file'
        const button = document.createElement('button'); button.type = 'button'; button.textContent = fileLabel(item.selection, item.file)
        button.disabled = !item.selection || !open; button.addEventListener('click', () => preview(item, 'draft'), options)
        const label = document.createElement('small'); label.textContent = item.error ?? (item.selection?.kind === 'snapshot' ? '已固定快照' : '发送时读取')
        if (item.error) label.className = 'file-error'
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '移除'; remove.disabled = attach.disabled
        remove.addEventListener('click', () => controller.setFiles(controller.snapshot().files.filter(file => file.id !== item.id)), options)
        chip.append(button, label, remove); return chip
      }))
    },
    dispose() { disposed = true; closePicker(); listeners.abort() },
  }
}
