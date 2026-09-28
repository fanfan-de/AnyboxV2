import { canUseModel, modelAvailability, type ModelsCatalog } from './models-client.js'
import type { ToolTrace, RunView, RunEventView } from './client-types.js'
import type { SessionController } from './session-client.js'
import { isActive } from './session-client.js'
import type { Pane } from './workspace-layout.js'
import { toolTrace } from './tool-trace.js'
import { getProtocolWebModule, type MountedProtocolTurn } from './protocols/modules.js'

export interface SessionPanel {
  readonly element: HTMLElement
  render(): void
  captureScroll(): number
  restoreScroll(top: number): void
  resizeInput(): void
  dispose(): number
}

export function createSessionPanel(pane: Pane, projectName: string, controller: SessionController,
  focus: () => void, close: () => void, initialScroll = 0, models?: ModelsCatalog, configureModels?: () => void): SessionPanel {
  const element = document.createElement('section')
  element.className = 'conversation session-pane'
  element.dataset.paneId = pane.id
  element.setAttribute('aria-label', `${projectName} · 会话 ${pane.sessionId.slice(0, 8)}`)
  element.innerHTML = `
    <div class="pane-heading">
      <svg class="pane-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-4 3V11.5A7.5 7.5 0 0 1 9.5 4h3a7.5 7.5 0 0 1 7.5 7.5Z"/></svg>
      <div class="pane-title"><strong></strong><small></small></div>
      <span class="run-status" role="status"></span>
      <button class="pane-close" type="button" aria-label="关闭会话面板" title="关闭会话面板"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m7 7 10 10M7 17 17 7"/></svg></button>
    </div>
    <div class="branch-navigation" aria-label="对话分支导航">
      <button type="button" data-go-root title="返回会话起点" aria-label="返回会话起点"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m3 11 9-8 9 8M5 9v12h14V9M9 21v-8h6v8"/></svg></button>
      <button type="button" data-go-parent title="查看上一级对话" aria-label="查看上一级对话"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg></button>
      <span class="branch-position"></span>
      <select aria-label="选择后续分支"></select><button type="button" data-more-children title="加载更多后续分支" hidden>更多</button>
    </div>
    <div class="pane-notice notice" role="alert" hidden></div>
    <div class="transcript" role="log" aria-label="对话内容" aria-live="polite" tabindex="0" hidden></div>
    <div class="empty-state">
      <svg class="empty-logo" aria-hidden="true" viewBox="0 0 128 128"><use href="#anybox-mark"/></svg>
      <h2>有什么想法？</h2><p>从这里开始，与 Anybox 一起完成。</p>
      <div class="empty-branches" aria-label="选择已有对话分支" hidden></div>
    </div>
    <form class="composer">
      <div class="composer-model-row"><select class="composer-model" aria-label="本会话使用的模型"></select><button class="configure-models" type="button">配置模型</button></div>
      <p class="composer-model-hint" role="status" hidden></p>
      <textarea rows="2" placeholder="随心输入" aria-label="消息"></textarea>
      <div class="composer-footer"><div class="composer-meta">
        <span class="composer-agent"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7L12 3Z"/></svg><span>Agent</span></span>
        <span class="compose-position"></span>
      </div><div class="actions">
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
  const compose = get<HTMLFormElement>('form'), cancel = get<HTMLButtonElement>('.cancel-button')
  const send = get<HTMLButtonElement>('.send-button'), notice = get<HTMLElement>('.pane-notice')
  const empty = get<HTMLElement>('.empty-state'), status = get<HTMLElement>('.run-status')
  const emptyBranches = get<HTMLElement>('.empty-branches')
  let eventCache: ReadonlyMap<string, readonly RunEventView[]> = new Map(), expandedTraces: ReadonlySet<string> = new Set()
  let contentKey = '', rendered = false, savedScroll = initialScroll
  const turns = new Map<string, MountedProtocolTurn>()
  let renderNodes: Node[] = []
  let conversationTitle: string | undefined
  const active = isActive
  const listeners = new AbortController(), options = { signal: listeners.signal }
  const modelSelect = get<HTMLSelectElement>('.composer-model')
  get<HTMLElement>('.composer-model-row').hidden = !models
  modelSelect.addEventListener('change', () => { if (modelSelect.value) void controller.setModel(modelSelect.value) }, options)
  get('.configure-models').addEventListener('click', () => configureModels?.(), options)
  const modelReady = () => {
    const session = controller.snapshot().session
    const model = models?.snapshot().models.find(value => value.id === session?.modelId)
    return Boolean(getProtocolWebModule(model?.parameters.protocolId ?? session?.protocolId)) && (!models || canUseModel(model))
  }
  const branchSelect = get<HTMLSelectElement>('.branch-navigation select')
  get('[data-go-root]').addEventListener('click', () => { void controller.navigate(null) }, options)
  get('[data-go-parent]').addEventListener('click', () => { void controller.navigate(controller.snapshot().path.at(-1)?.parentId ?? null) }, options)
  branchSelect.addEventListener('change', () => { if (branchSelect.value) void controller.navigate(branchSelect.value) }, options)
  get('[data-more-children]').addEventListener('click', () => { void controller.moreChildren() }, options)
  element.addEventListener('pointerdown', focus, options)
  element.addEventListener('focusin', focus, options)
  get('.pane-close').addEventListener('click', event => { event.stopPropagation(); close() }, options)
  const resizeInput = (): void => {
    if (element.hidden || !element.isConnected) return
    messageInput.style.height = 'auto'
    if (messageInput.scrollHeight) messageInput.style.height = `${Math.min(messageInput.scrollHeight, 200)}px`
  }
  const updateSend = (): void => {
    const state = controller.snapshot()
    send.disabled = !state.session || state.session.historyMode === 'dialogue-v1' || state.busy || state.loading || (!state.pending && (!modelReady() || !messageInput.value.trim()))
  }
  messageInput.addEventListener('input', () => { controller.setDraft(messageInput.value); resizeInput(); updateSend() }, options)
  messageInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); compose.requestSubmit() }
  }, options)
  compose.addEventListener('submit', event => { event.preventDefault(); if (!send.disabled) void controller.submit() }, options)
  cancel.addEventListener('click', () => { const id = controller.snapshot().run?.id; if (id) void controller.cancel(id) }, options)
  emptyBranches.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-view-node]')
    if (button?.dataset.viewNode) void controller.navigate(button.dataset.viewNode)
  }, options)
  transcript.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button')
    if (!button) return
    const data = button.dataset
    if (data.traceRunId) controller.toggleTrace(data.traceRunId)
    if (data.focusRun) controller.focusRun(data.focusRun)
    if (data.cancelRun) void controller.cancel(data.cancelRun)
    if (data.viewNode) void controller.navigate(data.viewNode)
    const node = controller.snapshot().path.find(item => item.id === (data.editNode ?? data.regenerateNode))
    if (node && controller.snapshot().session?.historyMode !== 'dialogue-v1' && data.editNode) void controller.navigate(node.parentId, node.input).then(() => messageInput.focus())
    if (node && data.regenerateNode) void controller.regenerate(node)
  }, options)
function addMessage(role: 'user' | 'assistant', content: string, isPending = false): void {
  const item = document.createElement('div')
  item.className = `message ${role}${isPending ? ' pending' : ''}`
  const label = document.createElement('span')
  label.className = 'message-label'
  label.textContent = role === 'user' ? '你' : 'Agent'
  const text = document.createElement('span')
  text.className = 'message-content'
  text.textContent = content
  item.append(label, text)
  renderNodes.push(item)
}

function addRunTrace(runValue: RunView, container: HTMLElement = transcript): void {
  const section = document.createElement('section')
  section.className = 'run-trace'
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'trace-toggle'
  toggle.dataset.traceRunId = runValue.id
  const expanded = expandedTraces.has(runValue.id)
  toggle.setAttribute('aria-expanded', String(expanded))
  toggle.textContent = expanded ? '执行过程 ▾' : '执行过程 ▸'
  section.append(toggle)
  if (expanded) {
    const events = eventCache.get(runValue.id)
    if (!events) {
      const loading = document.createElement('p')
      loading.className = 'trace-empty'
      loading.textContent = '正在读取执行过程…'
      section.append(loading)
    } else {
      const calls = toolTrace(runValue, events)
      if (!calls.length) {
        const empty = document.createElement('p')
        empty.className = 'trace-empty'
        empty.textContent = active(runValue) ? '正在等待模型回答或工具请求…' : '本次运行没有工具调用。'
        section.append(empty)
      }
      for (const call of calls) section.append(createToolCallCard(call))
    }
  }
  container.append(section)
}


  const panel: SessionPanel = {
    element,
    resizeInput,
    captureScroll() {
      if (!element.hidden && element.isConnected) savedScroll = transcript.scrollTop
      return savedScroll
    },
    restoreScroll(top) { savedScroll = top; if (!element.hidden) transcript.scrollTop = top },
    render() {
      const state = controller.snapshot()
      const readOnly = state.session?.historyMode === 'dialogue-v1'
      eventCache = state.events
      expandedTraces = state.expanded
      const activeCount = state.runs.filter(active).length
      if (!state.loading && !conversationTitle) conversationTitle = state.path[0]?.input ?? state.children[0]?.input ?? state.runs.at(-1)?.input
      if (conversationTitle) {
        get('.pane-title strong').textContent = conversationTitle
        get('.pane-title strong').title = conversationTitle
      }
      status.textContent = state.loading ? '正在加载' : state.busy ? '正在处理' : activeCount ? `${activeCount} 个运行中` : '准备就绪'
      notice.hidden = !state.notice
      notice.textContent = state.notice
      messageInput.disabled = !state.session || state.session.historyMode === 'dialogue-v1' || state.busy || state.loading
      send.setAttribute('aria-label', state.pending ? '重试提交' : '发送消息')
      send.title = state.pending ? '重试提交 · Enter' : '发送消息 · Enter'
      cancel.hidden = !active(state.run)
      cancel.disabled = state.busy || state.run?.status === 'cancelling'
      cancel.title = cancel.disabled ? '正在取消运行' : '取消运行'
      get('.composer-agent > span').textContent = state.session?.agentId ?? 'Agent'
      if (models) {
        const catalog = models.snapshot(), selected = state.session?.modelId ?? ''
        const key = JSON.stringify([catalog.models.map(value => [value.id, value.name, value.connectionId, value.available, value.effectiveCapabilities?.tools, value.parameters.protocolId]), catalog.providers.map(value => [value.id, value.name]), selected, state.session?.protocolId])
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
        modelSelect.disabled = state.session?.historyMode === 'dialogue-v1' || state.busy || state.loading || Boolean(state.pending) || catalog.loading
        const hint = get<HTMLElement>('.composer-model-hint')
        hint.textContent = state.session?.historyMode === 'dialogue-v1' ? '旧版文本会话仅供查看；请新建会话使用原生协议。' : catalog.error ?? (catalog.loading ? '正在读取模型…' : !catalog.models.some(canUseModel) ? '请打开“配置模型”，选择提供方并配置 API Key。' : !modelReady() ? '选择本会话使用的模型后即可发送。' : '')
        hint.hidden = !hint.textContent
      }
      get('.compose-position').textContent = readOnly ? '只读历史' : state.position.viewNodeId ? '继续此分支' : '新分支'
      get('.compose-position').title = readOnly ? '旧版文本会话仅供查看' : state.position.viewNodeId ? `从节点 ${state.position.viewNodeId} 继续` : '从会话起点发送'
      get('.composer-hint').hidden = readOnly
      get('.branch-position').textContent = state.position.viewNodeId ? `第 ${state.path.length} 轮` : '会话起点'
      get<HTMLButtonElement>('[data-go-root]').disabled = state.loading || !state.position.viewNodeId
      get<HTMLButtonElement>('[data-go-parent]').disabled = state.loading || !state.position.viewNodeId
      get('[data-more-children]').hidden = !state.moreChildren
      const choices = JSON.stringify(state.children.map(node => [node.id, node.input]))
      if (branchSelect.dataset.choices !== choices) {
        branchSelect.dataset.choices = choices
        const placeholder = document.createElement('option')
        placeholder.value = ''
        placeholder.textContent = state.children.length ? `后续分支（${state.children.length}）` : '暂无后续分支'
        branchSelect.replaceChildren(placeholder, ...state.children.map(node => {
          const option = document.createElement('option')
          option.value = node.id
          option.textContent = node.input.slice(0, 45)
          return option
        }))
        emptyBranches.replaceChildren(...state.children.slice(0, 3).map(node => {
          const button = document.createElement('button')
          button.type = 'button'
          button.dataset.viewNode = node.id
          button.textContent = node.input
          button.title = `${readOnly ? '查看历史' : '继续对话'}：${node.input}`
          return button
        }))
      }
      branchSelect.value = ''
      branchSelect.disabled = state.loading || !state.children.length
      if (messageInput.value !== state.draft) messageInput.value = state.draft
      resizeInput()
      updateSend()
      const progressRuns = state.runs.filter(run => active(run) && run.history.kind === 'tree' && run.history.parentNodeId === state.position.viewNodeId && state.views.has(run.id))
      const hasVisibleMessages = Boolean(state.path.length || progressRuns.length || (state.pending && !state.runs.some(item => item.id === state.pending?.runId)))
      empty.hidden = hasVisibleMessages
      transcript.hidden = !hasVisibleMessages
      element.classList.toggle('is-empty', !hasVisibleMessages)
      emptyBranches.hidden = state.loading || !state.children.length
      for (const button of emptyBranches.querySelectorAll('button')) button.disabled = state.loading || state.busy
      empty.classList.toggle('has-branches', !emptyBranches.hidden)
      get('.empty-state h2').textContent = state.loading ? '正在打开对话…' : readOnly ? '旧版会话历史' : state.children.length ? '从这里，继续你的想法' : activeCount ? 'Agent 正在思考…' : state.runs.length ? '你正在会话起点' : '有什么想法？'
      get('.empty-state > p').textContent = state.loading ? '正在读取会话内容。' : readOnly ? state.children.length ? '选择已有分支，查看保存的对话。' : '此会话仅供查看；请新建会话继续使用。' : state.children.length ? '选择已有分支，或输入消息开启新的分支。' : activeCount ? '当前任务正在运行，回答完成后即可查看。' : state.runs.length ? '输入消息，从这里开启一个新的分支。' : '从这里开始，与 Anybox 一起完成。'
      const key = JSON.stringify([state.path, state.runs, [...state.events], [...state.expanded], state.pending, state.position.focusedRunId, state.busy, readOnly, [...state.views]])
      if (key === contentKey) return
      contentKey = key
      const top = rendered ? panel.captureScroll() : initialScroll
      const atBottom = !element.hidden && (rendered ? transcript.scrollHeight - transcript.clientHeight - top < 72 : initialScroll === 0)
      const focused = transcript.contains(document.activeElement) ? document.activeElement as HTMLButtonElement : undefined
      const focusedData = focused ? JSON.stringify(focused.dataset) : undefined
      renderNodes = []
      const retainedTurns = new Set<string>()
      const appendTurn = (runId: string | null): boolean => {
        if (!runId) return false
        const view = state.views.get(runId)
        if (!view) return false
        const module = getProtocolWebModule(view.protocolId)
        if (!module) return false
        let turn = turns.get(runId)
        if (!turn) { turn = module.mount(view); turns.set(runId, turn) }
        else turn.update(view)
        retainedTurns.add(runId)
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
        addMessage('user', node.input)
        if (!appendTurn(node.sourceRunId)) addMessage('assistant', node.output)
        const actions = document.createElement('div')
        actions.className = 'node-actions'
        actions.append(action(readOnly ? '查看此处' : '从这里继续', 'viewNode', node.id), action('编辑重发', 'editNode', node.id), action('重新生成', 'regenerateNode', node.id))
        for (const button of actions.querySelectorAll('button')) button.disabled = Boolean(readOnly && !button.dataset.viewNode) || state.busy || Boolean(state.pending)
        renderNodes.push(actions)
      }
      if (state.runs.length) {
        const heading = document.createElement('h3')
        heading.className = 'run-list-heading'
        heading.textContent = '运行记录'
        renderNodes.push(heading)
      }
      for (const item of state.runs) {
        const card = document.createElement('section')
        card.className = 'run-card'
        card.classList.toggle('focused-run', item.id === state.position.focusedRunId)
        const label = document.createElement('p')
        const statuses = { running: '运行中', cancelling: '正在取消', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '意外中断' }
        label.textContent = `${statuses[item.status]} · ${item.history.kind === 'legacy-unknown' ? '旧版运行，起点未知' : item.history.parentNodeId ? `起点 ${item.history.parentNodeId.slice(0, 8)}` : '会话起点'}`
        const input = document.createElement('p')
        input.className = 'run-input'
        input.textContent = item.input
        const actions = document.createElement('div')
        actions.className = 'node-actions'
        actions.append(action('关注过程', 'focusRun', item.id))
        if (item.resultNodeId) actions.append(action('查看回答', 'viewNode', item.resultNodeId))
        if (active(item)) {
          const stop = action('取消此运行', 'cancelRun', item.id)
          stop.disabled = state.busy || item.status === 'cancelling'
          actions.append(stop)
        }
        card.append(label, input, actions)
        if (item.error) { const error = document.createElement('p'); error.textContent = item.error; card.append(error) }
        if (item.history.kind === 'legacy-unknown' && item.output) {
          const details = document.createElement('details'), summary = document.createElement('summary'), output = document.createElement('p')
          summary.textContent = '查看旧版结果'; output.textContent = item.output; details.append(summary, output); card.append(details)
        }
        addRunTrace(item, card)
        renderNodes.push(card)
      }
      for (const run of progressRuns) {
        addMessage('user', run.input)
        appendTurn(run.id)
        const label = document.createElement('p'); label.className = 'streaming-label'; label.textContent = '正在生成 · 临时输出'
        renderNodes.push(label)
      }
      if (state.pending && !state.runs.some(item => item.id === state.pending?.runId)) addMessage('user', state.pending.input, true)
      // Move only changed siblings; protocol components retain their DOM and local state.
      let cursor: ChildNode | null = transcript.firstChild
      for (const node of renderNodes) {
        if (node === cursor) cursor = cursor.nextSibling
        else transcript.insertBefore(node, cursor)
      }
      while (cursor) { const next: ChildNode | null = cursor.nextSibling; cursor.remove(); cursor = next }
      for (const [id, turn] of turns) if (!retainedTurns.has(id)) { turn.dispose(); turns.delete(id) }
      panel.restoreScroll(atBottom ? transcript.scrollHeight : top)
      if (focusedData) [...transcript.querySelectorAll('button')].find(button => JSON.stringify(button.dataset) === focusedData)?.focus({ preventScroll: true })
      if (state.path.length || state.runs.length) rendered = true
    },
    dispose() { listeners.abort(); for (const turn of turns.values()) turn.dispose(); turns.clear(); return panel.captureScroll() },
  }
  panel.render()
  return panel
}

/** A standalone renderer keeps the process cards consistent across every session pane. */
export function createToolCallCard(call: ToolTrace): HTMLElement {
  const card = document.createElement('article')
  card.className = 'tool-call'
  const heading = document.createElement('div')
  heading.className = 'tool-call-heading'
  const label = document.createElement('strong')
  label.textContent = call.name === 'bash' ? 'Bash' : 'Apply Patch'
  const status = document.createElement('span')
  status.textContent = {
    queued: '等待执行', running: '执行中', completed: '已完成', applied: '已应用',
    rejected: '已拒绝', partial: '部分完成',
    failed: call.name === 'bash' && call.exitCode !== undefined ? '非零退出' : '执行失败',
    skipped: '未执行', cancelled: '已取消', interrupted: '意外中断',
  }[call.state]
  heading.append(label, status)
  card.append(heading)
  const append = (tag: string, className: string, text: string): void => {
    const element = document.createElement(tag)
    element.className = className
    element.textContent = text
    card.append(element)
  }
  if (call.name === 'bash') {
    append('code', 'tool-command', `$ ${call.command}`)
    if (call.exitCode !== undefined || call.category) {
      append('p', 'tool-result', call.category ? `失败类别：${call.category}` :
        `退出码：${call.exitCode === null ? '无' : call.exitCode}${call.signal ? ` · 信号：${call.signal}` : ''}`)
    }
    for (const [labelText, content] of [['stdout', call.stdout], ['stderr', call.stderr]] as const) {
      if (!content) continue
      append('span', 'tool-output-label', labelText)
      append('pre', 'tool-output', content)
    }
    if (call.truncated) append('small', 'trace-empty', '输出摘要已截断')
  } else {
    append('pre', 'tool-output', call.patch)
    if (call.patchTruncated) append('small', 'trace-empty', '补丁预览已截断')
    if (call.category) append('p', 'tool-result', `失败类别：${call.category}`)
    if (call.result) {
      const result = call.result
      append('p', 'tool-result', `补丁结果：${{ applied: '已应用', rejected: '已拒绝', partial: '部分完成', cancelled: '已取消' }[result.status]}`)
      if (result.changes.length) {
        append('span', 'tool-output-label', '实际文件变更')
        append('pre', 'tool-output', result.changes.map(change =>
          `${{ added: '创建', updated: '修改', deleted: '删除' }[change.kind]} ${change.path}`).join('\n'))
      }
      if (result.pending.length) {
        append('span', 'tool-output-label', '未完成操作')
        append('pre', 'tool-output', result.pending.map(operation =>
          `${{ add: '创建', update: '修改', delete: '删除' }[operation.kind]} ${operation.path}${operation.moveTo ? ` → ${operation.moveTo}` : ''}`).join('\n'))
      }
      if (result.diagnostic) {
        const diagnostic = result.diagnostic
        append('p', 'tool-result', `${diagnostic.code}：${diagnostic.message}${diagnostic.path ? ` · ${diagnostic.path}` : ''}${diagnostic.line === undefined ? '' : `:${diagnostic.line}`}`)
      }
    }
  }
  return card
}
