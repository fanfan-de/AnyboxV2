import type { SessionController, SessionSnapshot } from './session-client.js'
import type { DraftFile } from './draft-client.js'
import { fileLabel, mentionAt } from './file-client.js'
import { fileLimits, validateFileRange } from '../harness/project-files/domain.js'
import type { FileRef, FileSelection } from '../harness/project-files/domain.js'

/** A pane owns its picker, previews and abort controllers; nothing is shared between projects. */
export function createFileView(compose: HTMLFormElement, input: HTMLTextAreaElement, controller: SessionController) {
  const list = document.createElement('div'); list.className = 'composer-files'; list.setAttribute('aria-label', '待发送文件')
  compose.insertBefore(list, input)
  const picker = document.createElement('div'); picker.className = 'file-picker'; picker.hidden = true
  const search = document.createElement('input'); search.type = 'search'; search.placeholder = '搜索项目文件路径'; search.setAttribute('aria-label', '搜索项目文件')
  const results = document.createElement('div'); results.setAttribute('role', 'listbox'); results.setAttribute('aria-label', '项目文件候选')
  const hint = document.createElement('p'); hint.className = 'file-hint'; hint.setAttribute('role', 'status')
  picker.append(search, results, hint); compose.insertBefore(picker, input.nextSibling)
  const attach = document.createElement('button'); attach.type = 'button'; attach.className = 'attach-files'; attach.textContent = '引用项目文件'; attach.title = '也可输入 @ 搜索项目文件'
  compose.querySelector('.actions')!.prepend(attach)
  const dialog = document.createElement('dialog'); dialog.className = 'file-preview'
  dialog.innerHTML = `<h3></h3><p class="file-hint" role="status"></p>
    <div class="file-range"><label>起始行<input type="number" min="1" aria-label="起始行"></label>
    <label>结束行<input type="number" min="1" aria-label="结束行"></label><button type="button" data-preview>预览范围</button></div>
    <pre tabindex="0"></pre><div class="file-preview-actions"><button type="button" data-current>更新为当前文件</button>
    <button type="button" data-apply>引用文件</button><button type="button" data-close>关闭</button></div>`
  compose.parentElement!.append(dialog)
  const title = dialog.querySelector('h3')!, detail = dialog.querySelector('p')!, pre = dialog.querySelector('pre')!
  const rangeBox = dialog.querySelector<HTMLElement>('.file-range')!
  const [start, end] = Array.from(dialog.querySelectorAll<HTMLInputElement>('input'))
  const previewButton = dialog.querySelector<HTMLButtonElement>('[data-preview]')!
  const apply = dialog.querySelector<HTMLButtonElement>('[data-apply]')!, current = dialog.querySelector<HTMLButtonElement>('[data-current]')!
  let paths: readonly string[] = [], selected = 0, timer: ReturnType<typeof setTimeout> | undefined
  let searchAbort: AbortController | undefined, previewAbort: AbortController | undefined
  let parent = controller.snapshot().position.viewNodeId, listKey = '', disposed = false
  let mention: { start: number; end: number } | undefined, activeItem: DraftFile | undefined
  let previewSelection: Extract<FileSelection, { kind: 'project-file' }> | undefined, historical = false
  const listeners = new AbortController(), options = { signal: listeners.signal }
  const closePicker = () => {
    clearTimeout(timer); searchAbort?.abort(); searchAbort = undefined; picker.hidden = true; paths = []; mention = undefined
    input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant')
  }
  const closePreview = () => { previewAbort?.abort(); previewAbort = undefined; if (dialog.open) dialog.close(); activeItem = undefined }
  const locked = () => { const state = controller.snapshot(); return state.busy || Boolean(state.pending) || Boolean(state.session?.archivedAt) || state.session?.historyMode === 'dialogue-v1' }
  const paintResults = () => {
    results.replaceChildren(...paths.map((path, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = path
      button.id = `file-option-${controller.snapshot().session?.id ?? 'new'}-${index}`
      button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(selected === index))
      button.addEventListener('click', () => choose(path), options)
      return button
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
        hint.textContent = value.incomplete ? '结果未完整显示，请输入更具体的路径。' : paths.length ? '↑ ↓ 选择 · Enter 预览 · Esc 关闭' : '没有匹配的文件。'
      }).catch(error => { if (!abort.signal.aborted && !disposed) hint.textContent = controller.fileMessage(error) })
    }, 250)
  }
  const loadPreview = async () => {
    previewAbort?.abort(); const abort = new AbortController(); previewAbort = abort
    apply.disabled = true; pre.textContent = ''; detail.textContent = '正在读取…'
    try {
      if (activeItem?.selection?.kind === 'snapshot') {
        const value = await controller.readFile(activeItem.selection.snapshotId, abort.signal)
        if (abort.signal.aborted || disposed) return
        pre.textContent = value.text
        detail.textContent = `已固定快照 · ${value.file.createdAt} · ${value.file.byteLength} 字节`
      } else if (previewSelection) {
        const range = !start.value && !end.value ? undefined : validateFileRange({ start: Number(start.value), end: Number(end.value) })
        previewSelection = { kind: 'project-file', path: previewSelection.path, ...(range ? { range } : {}) }
        const value = await controller.previewFile(previewSelection, abort.signal)
        if (abort.signal.aborted || disposed) return
        pre.textContent = value.text
        detail.textContent = `当前文件预览，发送时重新读取 · 共 ${value.totalLines} 行 · 选中 ${value.byteLength} 字节${value.canReference ? '' : ' · 超过 64 KiB，预览仅显示开头，请缩小行范围'}`
        apply.disabled = !value.canReference || locked()
      }
    } catch (error) {
      if (!abort.signal.aborted && !disposed) detail.textContent = error instanceof Error && error.name === 'ProjectFileError' ? '行范围无效，请填写完整的起止行。' : controller.fileMessage(error)
    }
  }
  const openPreview = (item: DraftFile, history = false) => {
    previewAbort?.abort(); activeItem = item; historical = history
    previewSelection = item.selection?.kind === 'project-file' ? item.selection : undefined
    title.textContent = fileLabel(item.selection, item.file)
    rangeBox.hidden = !previewSelection; apply.hidden = !previewSelection || history
    current.hidden = history || item.selection?.kind !== 'snapshot' || !item.file || locked()
    apply.textContent = controller.snapshot().files.some(file => file.id === item.id) ? '保存引用' : '引用文件'
    start.value = previewSelection?.range ? String(previewSelection.range.start) : ''
    end.value = previewSelection?.range ? String(previewSelection.range.end) : ''
    if (!dialog.open) dialog.showModal()
    void loadPreview()
  }
  function choose(path: string) {
    if (locked()) return
    // Keep the typed mention until the user confirms an actual reference.
    searchAbort?.abort(); picker.hidden = true
    openPreview({ id: crypto.randomUUID(), selection: { kind: 'project-file', path } })
  }
  const applyReference = () => {
    if (!activeItem || !previewSelection || apply.disabled || locked()) return
    const state = controller.snapshot(), item: DraftFile = { id: activeItem.id, selection: previewSelection }
    const rest = state.files.filter(file => file.id !== item.id)
    if (rest.some(file => JSON.stringify(file.selection) === JSON.stringify(item.selection))) { detail.textContent = '已添加相同文件与范围。'; return }
    const next = state.files.some(file => file.id === item.id) ? state.files.map(file => file.id === item.id ? item : file) : [...state.files, item]
    if (next.length > fileLimits.maxFiles) { detail.textContent = '每次最多引用 8 个文件。'; return }
    if (mention) {
      const value = input.value.slice(0, mention.start) + input.value.slice(mention.end)
      input.value = value; controller.setDraft(value)
    }
    controller.setFiles(next); closePreview(); closePicker(); input.focus()
  }
  apply.addEventListener('click', applyReference, options)
  previewButton.addEventListener('click', () => { void loadPreview() }, options)
  for (const field of [start, end]) field.addEventListener('input', () => { previewAbort?.abort(); apply.disabled = true; detail.textContent = '范围已改变，请先预览。' }, options)
  current.addEventListener('click', () => {
    if (!activeItem?.file || historical || locked()) return
    const file = activeItem.file, id = activeItem.id
    controller.setFiles(controller.snapshot().files.map(item => item.id === id
      ? { id, selection: { kind: 'project-file', path: file.path, ...(file.range ? { range: file.range } : {}) } } : item))
    closePreview()
  }, options)
  dialog.querySelector('[data-close]')!.addEventListener('click', () => { closePreview(); closePicker() }, options)
  dialog.addEventListener('cancel', () => { closePreview(); closePicker() }, options)
  dialog.addEventListener('close', () => { previewAbort?.abort() }, options)
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
    button.textContent = fileLabel({ kind: 'snapshot', snapshotId: file.snapshotId }, file); button.title = '查看发送时固定的文件内容'
    button.addEventListener('click', () => openPreview({ id: file.snapshotId, file, selection: { kind: 'snapshot', snapshotId: file.snapshotId } }, true), options)
    return button
  }
  return {
    keydown, snapshotButton,
    render(state: SessionSnapshot) {
      if (parent !== state.position.viewNodeId || state.loading) { parent = state.position.viewNodeId; closePicker(); closePreview() }
      attach.disabled = locked() || state.loading
      if (locked()) closePicker()
      const key = JSON.stringify([state.files, attach.disabled])
      if (key === listKey) return
      listKey = key; list.hidden = !state.files.length
      list.replaceChildren(...state.files.map(item => {
        const chip = document.createElement('div'); chip.className = 'draft-file'
        const button = document.createElement('button'); button.type = 'button'; button.textContent = fileLabel(item.selection, item.file)
        button.disabled = !item.selection; button.addEventListener('click', () => openPreview(item), options)
        const label = document.createElement('small'); label.textContent = item.error ?? (item.selection?.kind === 'snapshot' ? '已固定快照' : '发送时读取')
        if (item.error) label.className = 'file-error'
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '移除'; remove.disabled = attach.disabled
        remove.addEventListener('click', () => controller.setFiles(controller.snapshot().files.filter(file => file.id !== item.id)), options)
        chip.append(button, label, remove); return chip
      }))
    },
    dispose() { disposed = true; closePicker(); closePreview(); listeners.abort(); dialog.remove() },
  }
}
