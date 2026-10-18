import { splitScopedId } from './harness-client.js'
import { createFileView } from './file-view.js'
import type { FilePreviewRequest } from './file-sidebar.js'
import type { FileRef } from '../core/project-files/domain.js'
import { canUseModel, modelAvailability, type ModelsCatalog } from './models-client.js'
import type { ImageRef, SessionViewMode } from './client-types.js'
import { imageURL } from './image-client.js'
import type { SessionController } from './session-client.js'
import { isActive } from './session-client.js'
import type { Pane } from './workspace-layout.js'
import { createTrajectoryView } from './trajectory-view.js'
import { conversationTree } from './conversation-tree.js'
import { createConversationTreeView } from './conversation-tree-view.js'
import { getProtocolWebModule, type MountedProtocolTurn } from './protocols/modules.js'
import { renderMarkdown } from './markdown.js'
import { protocolToolContext, toolContextReadiness, toolSelectionDisplayName } from './tool-call-view.js'
export { createToolCallCard } from './tool-call-view.js'

export interface SessionScrollPosition {
  readonly dialogue: number
  /** Undefined until the records have been viewed at a measurable size. */
  readonly runs?: number
}
export interface SessionPanel {
  readonly element: HTMLElement
  setProjectName(name: string): void
  render(): void
  captureScroll(): SessionScrollPosition
  restoreScroll(position: SessionScrollPosition): void
  resizeInput(): void
  dispose(): SessionScrollPosition
}

export function createSessionPanel(pane: Pane, projectName: string, controller: SessionController,
  focus: () => void, close: () => void, initialScroll: SessionScrollPosition = { dialogue: 0 }, models?: ModelsCatalog, restore?: () => Promise<void>,
  openFile?: (request: FilePreviewRequest) => void): SessionPanel {
  const element = document.createElement('section')
  element.className = 'conversation session-pane'
  element.tabIndex = -1
  element.dataset.paneId = pane.id
  element.setAttribute('aria-label', `${projectName} · 会话 ${(splitScopedId(pane.sessionId)?.id ?? pane.sessionId).slice(0, 8)}`)
  element.innerHTML = `
    <div class="pane-heading">
      <svg class="pane-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-4 3V11.5A7.5 7.5 0 0 1 9.5 4h3a7.5 7.5 0 0 1 7.5 7.5Z"/></svg>
      <div class="pane-title"><strong></strong><small></small></div>
      <span class="run-status" role="status"></span>
      <button class="pane-close" type="button" aria-label="关闭会话面板" title="关闭会话面板"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m7 7 10 10M7 17 17 7"/></svg></button>
    </div>
    <div class="branch-navigation" aria-label="对话与轨迹导航">
      <div class="branch-controls" aria-label="对话分支导航">
      <button class="branch-tree-toggle" type="button" data-toggle-tree aria-expanded="false" aria-label="打开分支总览" title="打开分支总览"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M6 5v14M6 9h9M6 17h9"/><circle cx="6" cy="4" r="2"/><circle cx="17" cy="9" r="2"/><circle cx="17" cy="17" r="2"/></svg><span>分支</span></button>
      <button type="button" data-go-root title="返回会话起点" aria-label="返回会话起点"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m3 11 9-8 9 8M5 9v12h14V9M9 21v-8h6v8"/></svg></button>
      <button type="button" data-go-parent title="查看上一级对话" aria-label="查看上一级对话"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg></button>
      <span class="branch-position"></span>
      <select aria-label="选择后续分支"></select><button type="button" data-more-children title="加载更多后续分支" hidden>更多</button>
      </div>
      <span class="run-history-scope" hidden>本会话全部运行</span>
      <div class="session-view-switch" role="tablist" aria-label="会话视图">
        <button type="button" role="tab" data-view-mode="dialogue" aria-selected="true">对话</button>
        <button type="button" role="tab" data-view-mode="runs" aria-selected="false" tabindex="-1">轨迹<span class="run-count" hidden><span class="run-count-wide"></span><span class="run-count-compact"></span></span></button>
      </div>
    </div>
    <aside class="conversation-tree-panel" aria-label="分支总览" hidden inert></aside>
    <div class="archive-banner" hidden><span>此会话已归档，仅供查看。</span><button type="button" data-restore-session>恢复会话</button></div>
    <div class="pane-notice notice" role="alert" hidden></div>
    <div class="transcript" role="log" aria-label="对话内容" aria-live="polite" tabindex="0" hidden></div>
    <div class="run-history" role="tabpanel" aria-label="轨迹" tabindex="0" hidden inert></div>
    <div class="empty-state">
      <svg class="empty-logo" aria-hidden="true" viewBox="0 0 128 128"><use href="#agent--anybox-mark"/></svg>
      <h2>有什么想法？</h2><p>从这里开始，与 Anybox Harness 一起完成。</p>
      <div class="empty-branches" aria-label="选择已有对话分支" hidden></div>
    </div>
    <form class="composer">
      <div class="composer-model-row"><select class="composer-model" aria-label="本会话使用的模型"></select></div>
      <p class="composer-tools" aria-label="本会话固定工具" hidden></p>
      <p class="composer-model-hint" role="status" hidden></p>
      <div class="composer-images" aria-label="待发送图片" aria-live="polite" hidden></div>
      <textarea rows="2" placeholder="随心输入" aria-label="消息"></textarea>
      <input class="image-picker" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden>
      <div class="composer-footer"><div class="composer-meta">
        <span class="composer-agent"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7L12 3Z"/></svg><span>Agent</span></span>
        <span class="compose-position"></span>
      </div><div class="actions">
        <button class="attach-images" type="button" title="添加图片，也可粘贴或拖入 · 最多 8 张，每张 10 MiB">添加图片</button>
        <span class="composer-hint">↵ 发送</span>
        <button class="cancel-button" type="button" aria-label="取消运行" title="取消运行" hidden><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg></button>
        <button class="send-button" type="submit" aria-label="发送消息" title="发送消息 · Enter"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg></button>
      </div></div>
    </form>`
  const get = <T extends HTMLElement>(selector: string) => element.querySelector<T>(selector)!
  const heading = get<HTMLElement>('.pane-heading')
  heading.dataset.dragSession = pane.sessionId
  heading.dataset.projectId = pane.projectId
  heading.title = '拖动标题，将会话移动到其他面板边缘'
  get('strong').textContent = '新建会话'
  get('small').textContent = projectName
  const transcript = get<HTMLElement>('.transcript'), messageInput = get<HTMLTextAreaElement>('textarea')
  const runHistory = get<HTMLElement>('.run-history'), viewSwitch = get<HTMLElement>('.session-view-switch')
  const viewButtons = [...viewSwitch.querySelectorAll<HTMLButtonElement>('[data-view-mode]')]
  const compose = get<HTMLFormElement>('form'), cancel = get<HTMLButtonElement>('.cancel-button')
  const send = get<HTMLButtonElement>('.send-button'), notice = get<HTMLElement>('.pane-notice')
  const empty = get<HTMLElement>('.empty-state'), status = get<HTMLElement>('.run-status')
  const emptyBranches = get<HTMLElement>('.empty-branches')
  let contentKey = '', savedScroll = { ...initialScroll }
  let dialogueAtBottom = initialScroll.dialogue === 0, dialogueNeedsBottom = dialogueAtBottom
  let dialogueScrollReady = false, runsScrollReady = false
  let visibleMode: SessionViewMode = controller.snapshot().position.viewMode === 'runs' ? 'runs' : 'dialogue'
  let locateRunId: string | undefined
  const turns = new Map<string, MountedProtocolTurn>()
  let renderNodes: Node[] = []
  const active = isActive
  const listeners = new AbortController(), options = { signal: listeners.signal }
  const measurable = (container: HTMLElement): boolean => !element.hidden && element.isConnected &&
    element.clientWidth > 0 && element.clientHeight > 0 && !container.hidden && container.clientWidth > 0 && container.clientHeight > 0
  const selectMode = (mode: SessionViewMode): void => { panel.captureScroll(); controller.setViewMode(mode) }
  const treeContainer = get<HTMLElement>('.conversation-tree-panel'), treeToggle = get<HTMLButtonElement>('[data-toggle-tree]')
  treeContainer.id = `agent--conversation-tree-${pane.id}`
  treeToggle.setAttribute('aria-controls', treeContainer.id)
  let treeOpen = false
  const closeTree = (restoreFocus = true): void => {
    treeOpen = false
    panel.render()
    if (restoreFocus) treeToggle.focus({ preventScroll: true })
  }
  const treeView = createConversationTreeView(treeContainer, {
    navigate: id => { selectMode('dialogue'); void controller.navigate(id) },
    showRun: id => { locateRunId = id; selectMode('runs'); controller.focusRun(id) },
    close: () => closeTree(),
  })
  treeToggle.addEventListener('click', () => {
    treeOpen = !treeOpen
    panel.render()
    if (treeOpen) treeView.locate()
  }, options)
  element.addEventListener('keydown', event => {
    if (event.key === 'Escape' && treeOpen && !treeContainer.hidden) {
      event.preventDefault(); event.stopPropagation(); closeTree()
    }
  }, options)
  element.addEventListener('pointerdown', event => {
    const target = event.target as Node | null
    if (treeOpen && !treeContainer.hidden && !treeContainer.contains(target) && !treeToggle.contains(target)) closeTree(false)
  }, options)
  for (const button of viewButtons) button.addEventListener('click', () => selectMode(button.dataset.viewMode as SessionViewMode), options)
  viewSwitch.addEventListener('keydown', event => {
    const current = viewButtons.indexOf(event.target as HTMLButtonElement)
    if (current < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? viewButtons.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + viewButtons.length) % viewButtons.length
    selectMode(viewButtons[next]!.dataset.viewMode as SessionViewMode)
    viewButtons[next]!.focus({ preventScroll: true })
  }, options)
  const restoreButton = get<HTMLButtonElement>('[data-restore-session]')
  let restoring = false
  restoreButton.addEventListener('click', () => {
    if (!restore || restoring) return
    restoring = true; restoreButton.disabled = true
    void restore().finally(() => { restoring = false; restoreButton.disabled = false })
  }, options)
  const modelSelect = get<HTMLSelectElement>('.composer-model')
  get<HTMLElement>('.composer-model-row').hidden = !models
  modelSelect.addEventListener('change', () => { if (modelSelect.value) void controller.setModel(modelSelect.value) }, options)
  const modelReady = () => {
    const session = controller.snapshot().session
    const model = models?.snapshot().models.find(value => value.id === session?.modelId)
    return Boolean(getProtocolWebModule(model?.parameters.protocolId ?? session?.protocolId)) && (!models || canUseModel(model))
  }
  const imageModelReady = () => {
    const session = controller.snapshot().session
    const model = models?.snapshot().models.find(value => value.id === session?.modelId)
    return Boolean(getProtocolWebModule(model?.parameters.protocolId ?? session?.protocolId)?.imageInput) && (!models || Boolean(model?.effectiveCapabilities?.imageInput))
  }
  const imagePicker = get<HTMLInputElement>('.image-picker'), imageList = get<HTMLElement>('.composer-images')
  const attachImages = get<HTMLButtonElement>('.attach-images')
  const fileView = createFileView(compose, messageInput, controller, pane, openFile)
  let imageListKey = ''
  attachImages.addEventListener('click', () => imagePicker.click(), options)
  imagePicker.addEventListener('change', () => { controller.addImages(Array.from(imagePicker.files ?? [])); imagePicker.value = '' }, options)
  compose.addEventListener('paste', event => {
    const files = Array.from(event.clipboardData?.items ?? []).filter(item => item.kind === 'file').flatMap(item => { const file = item.getAsFile(); return file ? [file] : [] })
    if (files.length && !attachImages.disabled) { event.preventDefault(); controller.addImages(files) }
  }, options)
  compose.addEventListener('dragover', event => {
    if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); compose.classList.add('is-image-drop') }
  }, options)
  compose.addEventListener('dragleave', event => { if (!compose.contains(event.relatedTarget as Node | null)) compose.classList.remove('is-image-drop') }, options)
  compose.addEventListener('drop', event => {
    if (!event.dataTransfer?.types.includes('Files')) return
    event.preventDefault(); event.stopPropagation(); compose.classList.remove('is-image-drop')
    if (!attachImages.disabled) controller.addImages(Array.from(event.dataTransfer.files))
  }, options)
  imageList.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button')
    if (button?.dataset.removeImage) controller.removeImage(button.dataset.removeImage)
    if (button?.dataset.retryImage) controller.retryImage(button.dataset.retryImage)
  }, options)
  const branchSelect = get<HTMLSelectElement>('.branch-navigation select')
  get('[data-go-root]').addEventListener('click', () => { void controller.navigate(null) }, options)
  get('[data-go-parent]').addEventListener('click', () => { void controller.navigate(controller.snapshot().path.at(-1)?.parentId ?? null) }, options)
  branchSelect.addEventListener('change', () => { if (branchSelect.value) void controller.navigate(branchSelect.value) }, options)
  get('[data-more-children]').addEventListener('click', () => { void controller.moreChildren() }, options)
  element.addEventListener('pointerdown', focus, options)
  element.addEventListener('focusin', focus, options)
  get('.pane-close').addEventListener('click', event => { event.stopPropagation(); close() }, options)
  const resizeInput = (): void => {
    if (element.hidden || compose.hidden || !element.isConnected) return
    if (!element.isConnected || element.clientWidth === 0) return
    messageInput.style.height = 'auto'
    if (messageInput.scrollHeight) messageInput.style.height = `${Math.min(messageInput.scrollHeight, 200)}px`
  }
  const updateSend = (): void => {
    const state = controller.snapshot()
    const imagesReady = !state.images.length || (imageModelReady() && state.images.every(image => image.status === 'ready'))
    send.disabled = !state.session || Boolean(state.session.archivedAt) || state.session.historyMode === 'dialogue-v1' || state.busy || state.loading || (!state.pending && (!modelReady() || !imagesReady || state.files.some(file => !file.selection || Boolean(file.error)) || (!messageInput.value.trim() && !state.images.length && !state.files.length)))
  }
  messageInput.addEventListener('input', () => { controller.setDraft(messageInput.value); resizeInput(); updateSend() }, options)
  messageInput.addEventListener('keydown', event => {
    if (fileView.keydown(event)) return
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); compose.requestSubmit() }
  }, options)
  compose.addEventListener('submit', event => { event.preventDefault(); if (!send.disabled) void controller.submit() }, options)
  cancel.addEventListener('click', () => { const id = controller.snapshot().run?.id; if (id) void controller.cancel(id) }, options)
  emptyBranches.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-view-node]')
    if (button?.dataset.viewNode) void controller.navigate(button.dataset.viewNode)
  }, options)
  const contentAction = (event: MouseEvent): void => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button')
    if (!button) return
    const data = button.dataset
    if (data.focusRun || data.showRun) {
      const id = data.focusRun ?? data.showRun!
      locateRunId = id
      selectMode('runs')
      controller.focusRun(id)
    }
    if (data.cancelRun) void controller.cancel(data.cancelRun)
    if (data.viewNode) { selectMode('dialogue'); void controller.navigate(data.viewNode) }
    if (data.locateNode) { treeOpen = true; panel.render(); treeView.locate(data.locateNode) }
    const node = controller.snapshot().path.find(item => item.id === (data.editNode ?? data.regenerateNode))
    if (node && !controller.snapshot().session?.archivedAt && controller.snapshot().session?.historyMode !== 'dialogue-v1' && data.editNode) void controller.navigate(node.parentId, node.input, node.images, node.files).then(() => messageInput.focus())
    if (node && data.regenerateNode) void controller.regenerate(node)
  }
  for (const container of [transcript, notice]) container.addEventListener('click', contentAction, options)
  const trajectory = createTrajectoryView(runHistory, {
    viewport: ids => controller.setTraceViewport(ids), search: query => controller.setTraceSearch(query),
    retry: id => controller.retryTrace(id), answer: id => { selectMode('dialogue'); void controller.navigate(id) },
    cancel: id => { void controller.cancel(id) },
  })
  const traceScroll = trajectory.scrollElement
function imagePreview(image: ImageRef, index: number): HTMLAnchorElement {
  const link = document.createElement('a')
  link.href = imageURL(pane.sessionId, image.assetId); link.target = '_blank'; link.rel = 'noopener noreferrer'
  link.className = 'message-image-link'; link.title = `查看图片 ${index + 1} · ${image.width} × ${image.height}`
  const preview = document.createElement('img')
  preview.src = link.href; preview.alt = `图片 ${index + 1}`; preview.loading = 'lazy'
  preview.width = image.width; preview.height = image.height
  link.append(preview)
  return link
}
function addMessage(role: 'user' | 'assistant', content: string, isPending = false, images: readonly ImageRef[] = [], files: readonly FileRef[] = []): void {
  const item = document.createElement('div')
  item.className = `message ${role}${isPending ? ' pending' : ''}`
  const label = document.createElement('span')
  label.className = 'message-label'
  label.textContent = role === 'user' ? '你' : 'Agent'
  const text = role === 'assistant' ? renderMarkdown(content) : document.createElement('span')
  if (role === 'user') { text.className = 'message-content'; text.textContent = content }
  item.append(label, text)
  if (files.length) { const refs = document.createElement('div'); refs.className = 'message-files'; files.forEach(file => refs.append(fileView.snapshotButton(file))); item.append(refs) }
  if (images.length) {
    const gallery = document.createElement('div'); gallery.className = 'message-images'
    images.forEach((image, index) => gallery.append(imagePreview(image, index)))
    item.append(gallery)
  }
  renderNodes.push(item)
}

  const panel: SessionPanel = {
    element,
    resizeInput,
    captureScroll() {
      if (dialogueScrollReady && measurable(transcript)) {
        savedScroll.dialogue = transcript.scrollTop
        dialogueAtBottom = transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop < 72
      }
      if (runsScrollReady && measurable(traceScroll)) savedScroll.runs = traceScroll.scrollTop
      return { ...savedScroll }
    },
    restoreScroll(position) {
      savedScroll = { ...position }
      if (measurable(transcript)) {
        transcript.scrollTop = dialogueNeedsBottom ? transcript.scrollHeight : savedScroll.dialogue
        savedScroll.dialogue = transcript.scrollTop
        dialogueNeedsBottom = false
        dialogueScrollReady = true
      }
      if (measurable(traceScroll)) {
        traceScroll.scrollTop = savedScroll.runs ?? traceScroll.scrollHeight
        if (locateRunId) {
          trajectory.locateRun(locateRunId); locateRunId = undefined
        }
        savedScroll.runs = traceScroll.scrollTop
        runsScrollReady = true
      }
    },
    render() {
      panel.captureScroll()
      const state = controller.snapshot()
      const selectedTools = state.session?.toolSelection?.tools
      const toolsSummary = get<HTMLElement>('.composer-tools')
      toolsSummary.hidden = !selectedTools
      toolsSummary.textContent = selectedTools ? `工具：${selectedTools.length ? selectedTools.map(tool => toolSelectionDisplayName(tool.toolId)).join('、') : '未启用'} · 创建时固定` : ''
      const tree = conversationTree(state)
      visibleMode = state.position.viewMode === 'runs' ? 'runs' : 'dialogue'
      const records = visibleMode === 'runs'
      runHistory.hidden = !records
      runHistory.inert = !records
      compose.hidden = records
      compose.inert = records
      get('.branch-controls').hidden = records
      get('.branch-controls').inert = records
      get('.run-history-scope').hidden = !records
      const showTree = treeOpen && !records
      treeContainer.hidden = !showTree
      treeContainer.inert = !showTree
      treeToggle.disabled = !state.session
      treeToggle.setAttribute('aria-expanded', String(showTree))
      treeToggle.setAttribute('aria-label', showTree ? '关闭分支总览' : '打开分支总览')
      treeToggle.title = showTree ? '关闭分支总览' : '打开分支总览'
      if (showTree) treeView.update(state, tree)
      for (const button of viewButtons) {
        const selected = button.dataset.viewMode === visibleMode
        button.setAttribute('aria-selected', String(selected))
        button.tabIndex = selected ? 0 : -1
      }
      fileView.render(state)
      const readOnly = (Boolean(state.session?.archivedAt) || state.session?.historyMode === 'dialogue-v1')
      const activeCount = state.runs.filter(active).length
      get('.run-count').hidden = activeCount === 0
      get('.run-count-wide').textContent = `${activeCount} 运行中`
      get('.run-count-compact').textContent = String(activeCount)
      get('[data-view-mode="runs"]').setAttribute('aria-label', activeCount ? `轨迹，${activeCount} 个运行中` : '轨迹')
      get('[data-view-mode="runs"]').title = activeCount ? `${activeCount} 个运行中（含正在取消）` : '查看本会话全部运行'
      const conversationTitle = state.session?.title
      if (conversationTitle) {
        get('.pane-title strong').textContent = conversationTitle
        get('.pane-title strong').title = conversationTitle
      }
      get('.archive-banner').hidden = !state.session?.archivedAt
      restoreButton.hidden = !restore
      restoreButton.disabled = restoring
      status.textContent = state.loading ? '正在加载' : state.busy ? '正在处理' : activeCount ? `${activeCount} 个运行中` : state.session?.archivedAt ? '已归档' : '准备就绪'
      notice.hidden = !state.notice
      notice.textContent = state.notice
      if (!records && state.notice && state.run && ['failed', 'cancelled', 'interrupted'].includes(state.run.status)) {
        const summary = { failed: '本次运行失败。', cancelled: '本次运行已取消。', interrupted: '本次运行意外中断。' }
        if (state.notice.startsWith('本次运行')) notice.textContent = summary[state.run.status as keyof typeof summary]
        const details = document.createElement('button')
        details.type = 'button'; details.dataset.showRun = state.run.id; details.textContent = '查看轨迹'
        notice.append(details)
      }
      messageInput.disabled = !state.session || Boolean(state.session.archivedAt) || state.session.historyMode === 'dialogue-v1' || state.busy || state.loading
      attachImages.disabled = messageInput.disabled || Boolean(state.pending)
      const nextImagesKey = JSON.stringify([state.images, attachImages.disabled])
      if (nextImagesKey !== imageListKey) {
        imageListKey = nextImagesKey
        imageList.replaceChildren(...state.images.map((item, index) => {
          const card = document.createElement('div'); card.className = 'draft-image'; card.dataset.status = item.status
          if (item.image && item.status === 'ready') card.append(imagePreview(item.image, index))
          const label = document.createElement('span'); label.className = 'draft-image-name'; label.textContent = `${index + 1}. ${item.name}`; label.title = item.name; card.append(label)
          const status = document.createElement('span'); status.className = 'draft-image-status'
          status.textContent = item.status === 'queued' ? '等待上传' : item.status === 'uploading' ? '正在上传…' : item.status === 'ready' ? `${item.image!.width} × ${item.image!.height}` : item.error ?? '图片已失效，请重新添加'
          card.append(status)
          if (item.status === 'failed') { const retry = document.createElement('button'); retry.type = 'button'; retry.dataset.retryImage = item.id; retry.textContent = '重试'; retry.disabled = attachImages.disabled; card.append(retry) }
          const remove = document.createElement('button'); remove.type = 'button'; remove.dataset.removeImage = item.id; remove.textContent = '移除'; remove.setAttribute('aria-label', `移除图片 ${index + 1}`); remove.disabled = attachImages.disabled; card.append(remove)
          return card
        }))
      }
      imageList.hidden = state.images.length === 0
      send.setAttribute('aria-label', state.pending ? '重试提交' : '发送消息')
      send.title = state.pending ? '重试提交 · Enter' : '发送消息 · Enter'
      cancel.hidden = !active(state.run)
      cancel.disabled = state.busy || state.run?.status === 'cancelling'
      cancel.title = cancel.disabled ? '正在取消运行' : '取消运行'
      get('.composer-agent > span').textContent = (state.session?.agentId ? splitScopedId(state.session.agentId)?.id ?? state.session.agentId : 'Agent')
      if (models) {
        const catalog = models.snapshot(), selected = state.session?.modelId ?? ''
        const key = JSON.stringify([catalog.models.map(value => [value.id, value.name, value.connectionId, value.available, value.effectiveCapabilities?.tools, value.effectiveCapabilities?.imageInput, value.parameters.protocolId]), catalog.providers.map(value => [value.id, value.name]), selected, state.session?.protocolId])
        if (modelSelect.dataset.choices !== key) {
          modelSelect.dataset.choices = key
          const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '选择模型'
          modelSelect.replaceChildren(placeholder)
          const groups = new Map<string, HTMLOptGroupElement>()
          for (const value of catalog.models) {
            let group = groups.get(value.connectionId)
            if (!group) {
              group = document.createElement('optgroup'); group.label = catalog.providers.find(provider => provider.id === value.connectionId)?.name ?? value.connectionId
              groups.set(value.connectionId, group); modelSelect.append(group)
            }
            const choice = document.createElement('option'); choice.value = value.id
            const incompatible = Boolean(state.session?.protocolId && value.parameters.protocolId !== state.session.protocolId)
            const unsupported = !getProtocolWebModule(value.parameters.protocolId)
            choice.textContent = incompatible ? `${value.name} · 需新建其他协议会话` : unsupported ? `${value.name} · 网页输入组件不可用` : canUseModel(value) ? value.name : `${value.name} · ${modelAvailability(value)}`
            choice.disabled = !canUseModel(value) || incompatible || unsupported; group.append(choice)
          }
          if (selected && !catalog.models.some(value => value.id === selected)) {
            const unavailable = document.createElement('option'); unavailable.value = selected; unavailable.textContent = '原模型已不可用'; unavailable.disabled = true; modelSelect.append(unavailable)
          }
        }
        modelSelect.value = selected
        modelSelect.disabled = (Boolean(state.session?.archivedAt) || state.session?.historyMode === 'dialogue-v1') || state.busy || state.loading || Boolean(state.pending) || catalog.loading
        const hint = get<HTMLElement>('.composer-model-hint')
        hint.textContent = state.session?.archivedAt ? '恢复会话后可继续使用。' : state.session?.historyMode === 'dialogue-v1' ? '旧版文本会话仅供查看；请新建会话使用原生协议。' : catalog.error ?? (catalog.loading ? '正在读取模型…' : !catalog.models.some(canUseModel) ? '请在“Anybox Harness 设置”的“模型管理”中选择提供方并配置 API Key。' : !modelReady() ? '选择本会话使用的模型后即可发送。' : '')
        hint.hidden = !hint.textContent
        if (state.images.length && !imageModelReady()) { hint.textContent = '当前模型不支持图片，请切换支持图片的模型，或移除图片后发送。'; hint.hidden = false }
      }
      get('.compose-position').textContent = readOnly ? '只读历史' : state.position.viewNodeId ? '继续此分支' : '新分支'
      get('.compose-position').title = readOnly ? state.session?.archivedAt ? '恢复会话后可继续' : '旧版文本会话仅供查看' : state.position.viewNodeId ? `从节点 ${state.position.viewNodeId} 继续` : '从会话起点发送'
      get('.composer-hint').hidden = readOnly
      get('.branch-position').textContent = state.position.viewNodeId ? `第 ${state.path.length} 轮` : '会话起点'
      get<HTMLButtonElement>('[data-go-root]').disabled = state.loading || !state.position.viewNodeId
      get<HTMLButtonElement>('[data-go-parent]').disabled = state.loading || !state.position.viewNodeId
      get('[data-more-children]').hidden = !state.moreChildren
      const choices = JSON.stringify([readOnly, state.children.map(node => [node.id, node.input, node.images?.length])])
      if (branchSelect.dataset.choices !== choices) {
        branchSelect.dataset.choices = choices
        const placeholder = document.createElement('option')
        placeholder.value = ''
        placeholder.textContent = state.children.length ? `后续分支（${state.children.length}）` : '暂无后续分支'
        branchSelect.replaceChildren(placeholder, ...state.children.map(node => {
          const option = document.createElement('option')
          option.value = node.id
          option.textContent = node.input.slice(0, 45) || (node.files?.length ? `${node.files.length} 个文件` : `${node.images?.length ?? 0} 张图片`)
          return option
        }))
        emptyBranches.replaceChildren(...state.children.slice(0, 3).map(node => {
          const button = document.createElement('button')
          button.type = 'button'
          button.dataset.viewNode = node.id
          button.textContent = node.input || (node.files?.length ? `${node.files.length} 个文件` : `${node.images?.length ?? 0} 张图片`)
          button.title = `${readOnly ? '查看历史' : '继续对话'}：${button.textContent}`
          return button
        }))
      }
      branchSelect.value = ''
      branchSelect.disabled = state.loading || !state.children.length
      if (messageInput.value !== state.draft) messageInput.value = state.draft
      resizeInput()
      updateSend()
      const progressRuns = state.runs.filter(run => (active(run) || (run.status === 'completed' && run.resultNodeId &&
        state.position.follow?.runId === run.id && state.position.follow.parentNodeId === state.position.viewNodeId)) &&
        run.history.kind === 'tree' && run.history.parentNodeId === state.position.viewNodeId && state.views.has(run.id))
      const hasVisibleMessages = Boolean(state.path.length || progressRuns.length || (state.pending && !state.runs.some(item => item.id === state.pending?.runId)))
      empty.hidden = records || hasVisibleMessages
      empty.inert = records || hasVisibleMessages
      transcript.hidden = records || !hasVisibleMessages
      transcript.inert = records || !hasVisibleMessages
      element.classList.toggle('is-empty', !records && !hasVisibleMessages)
      emptyBranches.hidden = state.loading || !state.children.length
      for (const button of emptyBranches.querySelectorAll('button')) button.disabled = state.loading || state.busy
      empty.classList.toggle('has-branches', !emptyBranches.hidden)
      get('.empty-state h2').textContent = state.loading ? '正在打开对话…' : readOnly ? state.session?.archivedAt ? '已归档会话' : '旧版会话历史' : state.children.length ? '从这里，继续你的想法' : activeCount ? 'Agent 正在思考…' : state.runs.length ? '你正在会话起点' : '有什么想法？'
      get('.empty-state > p').textContent = state.loading ? '正在读取会话内容。' : readOnly ? state.children.length ? '选择已有分支，查看保存的对话。' : state.session?.archivedAt ? '恢复此会话后可继续使用。' : '此会话仅供查看；请新建会话继续使用。' : state.children.length ? '选择已有分支，或输入消息开启新的分支。' : activeCount ? '当前任务正在运行，回答完成后即可查看。' : state.runs.length ? '输入消息，从这里开启一个新的分支。' : '从这里开始，与 Anybox Harness 一起完成。'
      trajectory.update(state)
      const key = JSON.stringify([state.path, state.children, state.runs, [...state.events], [...state.expanded], state.pending, state.position.focusedRunId, state.position.follow, state.busy, readOnly, state.session?.historyMode, [...state.views], state.traceLoading && [...state.traceLoading.states]])
      if (key === contentKey) { panel.restoreScroll(savedScroll); return }
      contentKey = key
      const content = records ? runHistory : transcript
      const focused = content.contains(document.activeElement) ? document.activeElement as HTMLButtonElement : undefined
      const focusedData = focused && Object.keys(focused.dataset).length ? JSON.stringify(focused.dataset) : undefined
      renderNodes = []
      const appendTurn = (runId: string | null): boolean => {
        if (!runId) return false
        const view = state.views.get(runId)
        if (!view) return false
        const module = getProtocolWebModule(view.protocolId)
        if (!module) return false
        let turn = turns.get(runId)
        const run = state.runs.find(value => value.id === runId)
        const toolContext = run ? protocolToolContext(run, state.events.get(runId) ?? [],
          toolContextReadiness(state.traceLoading?.states.get(runId), state.events.has(runId))) : undefined
        if (!turn) { turn = module.mount(view, { toolContext, presentation: 'compact' }); turns.set(runId, turn) }
        else turn.update(view, { toolContext, presentation: 'compact' })
        renderNodes.push(turn.element)
        return true
      }
      const action = (text: string, key: string, id: string): HTMLButtonElement => {
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = text
        button.dataset[key] = id
        return button
      }
      for (const node of state.path) {
        addMessage('user', node.input, false, node.images, node.files)
        if (!appendTurn(node.sourceRunId)) {
          if (state.session?.historyMode === 'dialogue-v1') addMessage('assistant', node.output)
          else {
            const message = document.createElement('p'), loading = node.sourceRunId ? state.traceLoading?.states.get(node.sourceRunId) : undefined
            message.className = 'native-display-missing streaming-label'; message.setAttribute('role', 'status')
            message.textContent = state.loading || loading === 'unloaded' || loading === 'loading' ? '正在读取原生模型展示…' : '原生模型展示暂不可用。'
            renderNodes.push(message)
          }
        }
        const actions = document.createElement('div')
        actions.className = 'node-actions'
        const siblings = tree.children.get(node.parentId) ?? [], siblingIndex = siblings.findIndex(value => value.id === node.id)
        if (siblings.length > 1 && siblingIndex >= 0) {
          const versions = document.createElement('div'); versions.className = 'node-versions'
          versions.setAttribute('aria-label', '此轮分支切换')
          const previous = action('‹', 'viewNode', siblings[Math.max(0, siblingIndex - 1)]!.id)
          previous.setAttribute('aria-label', '查看此轮的上一个分支'); previous.title = '查看此轮的上一个分支'
          previous.disabled = siblingIndex === 0 || state.loading
          const label = action(`${siblingIndex + 1} / ${siblings.length}`, 'locateNode', node.id)
          label.className = 'node-version-label'; label.title = '在分支总览中定位此轮'
          label.setAttribute('aria-label', `此轮有 ${siblings.length} 个分支，当前第 ${siblingIndex + 1} 个；在分支总览中定位`)
          const next = action('›', 'viewNode', siblings[Math.min(siblings.length - 1, siblingIndex + 1)]!.id)
          next.setAttribute('aria-label', '查看此轮的下一个分支'); next.title = '查看此轮的下一个分支'
          next.disabled = siblingIndex === siblings.length - 1 || state.loading
          versions.append(previous, label, next); actions.append(versions)
        }
        actions.append(action(readOnly ? '查看此处' : '从这里继续', 'viewNode', node.id), action('编辑重发', 'editNode', node.id), action('重新生成', 'regenerateNode', node.id))
        for (const button of actions.querySelectorAll<HTMLButtonElement>('button')) {
          if (button.closest('.node-versions')) continue
          button.disabled = Boolean(readOnly && !button.dataset.viewNode) || state.busy || Boolean(state.pending)
        }
        renderNodes.push(actions)
      }
      for (const run of progressRuns) {
        addMessage('user', run.input, false, run.images, run.files)
        appendTurn(run.id)
        const label = document.createElement('p'); label.className = 'streaming-label'; label.textContent = active(run) ? '正在生成 · 临时输出' : '已完成'
        renderNodes.push(label)
      }
      if (state.pending && !state.runs.some(item => item.id === state.pending?.runId)) addMessage('user', state.pending.input, true, state.pending.images, state.pending.files)
      // Move only changed siblings; protocol components retain their DOM and local state.
      const retainedNodes = new Set(renderNodes)
      for (const child of Array.from(transcript.childNodes)) if (!retainedNodes.has(child)) child.remove()
      let cursor: ChildNode | null = transcript.firstChild
      for (const node of renderNodes) {
        if (node === cursor) cursor = cursor.nextSibling
        else transcript.insertBefore(node, cursor)
      }
      while (cursor) { const next: ChildNode | null = cursor.nextSibling; cursor.remove(); cursor = next }
      if (dialogueAtBottom) dialogueNeedsBottom = true
      panel.restoreScroll(savedScroll)
      if (focused?.isConnected && content.contains(focused)) focused.focus({ preventScroll: true })
      else if (focusedData) [...content.querySelectorAll('button')].find(button => JSON.stringify(button.dataset) === focusedData)?.focus({ preventScroll: true })
    },
    setProjectName(name) { get('small').textContent = name; element.setAttribute('aria-label', `${name} · 会话 ${(splitScopedId(pane.sessionId)?.id ?? pane.sessionId).slice(0, 8)}`) },
    dispose() { const scroll = panel.captureScroll(); fileView.dispose(); trajectory.dispose(); treeView.dispose(); listeners.abort(); for (const turn of turns.values()) turn.dispose(); turns.clear(); return scroll },
  }
  panel.render()
  return panel
}
