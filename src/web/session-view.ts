import type { ToolTrace, RunView, RunEventView } from './client-types.js'
import type { SessionController } from './session-client.js'
import { isActive } from './session-client.js'
import type { Pane } from './workspace-layout.js'
import { toolTrace } from './tool-trace.js'

export interface SessionPanel {
  readonly element: HTMLElement
  render(): void
  captureScroll(): number
  restoreScroll(top: number): void
  dispose(): number
}

export function createSessionPanel(pane: Pane, projectName: string, controller: SessionController,
  focus: () => void, close: () => void, initialScroll = 0): SessionPanel {
  const element = document.createElement('section')
  element.className = 'conversation session-pane'
  element.dataset.paneId = pane.id
  element.setAttribute('aria-label', `${projectName} · 会话 ${pane.sessionId.slice(0, 8)}`)
  element.innerHTML = `
    <div class="pane-heading">
      <div class="pane-title"><strong></strong><small></small></div>
      <span class="run-status" role="status"></span>
      <button class="pane-close" type="button" aria-label="关闭会话面板">×</button>
    </div>
    <div class="branch-navigation">
      <button type="button" data-go-root>起点</button><button type="button" data-go-parent>上一级</button>
      <select aria-label="选择后续分支"></select><button type="button" data-more-children hidden>更多</button>
    </div>
    <div class="pane-notice notice" role="alert" hidden></div>
    <div class="transcript" role="log" aria-label="对话内容" aria-live="polite" tabindex="0" hidden></div>
    <div class="empty-state"><span class="empty-icon" aria-hidden="true">✳</span><h2>从一个想法开始</h2><p>在下方输入消息。</p></div>
    <form class="composer">
      <label class="compose-position">消息</label><textarea rows="3" placeholder="输入消息…" aria-label="消息"></textarea>
      <div class="composer-footer"><span>Enter 发送 · Shift + Enter 换行</span><div class="actions">
        <button class="cancel-button" type="button" hidden>取消运行</button>
        <button class="send-button" type="submit">发送消息 ↗</button>
      </div></div>
    </form>`
  const get = <T extends HTMLElement>(selector: string) => element.querySelector<T>(selector)!
  const heading = get<HTMLElement>('.pane-heading')
  heading.dataset.dragSession = pane.sessionId
  heading.dataset.projectId = pane.projectId
  heading.title = '拖动标题，将会话移动到其他面板边缘'
  get('strong').textContent = projectName
  get('small').textContent = `会话 · ${pane.sessionId.slice(0, 8)}`
  const transcript = get<HTMLElement>('.transcript'), messageInput = get<HTMLTextAreaElement>('textarea')
  const compose = get<HTMLFormElement>('form'), cancel = get<HTMLButtonElement>('.cancel-button')
  const send = get<HTMLButtonElement>('.send-button'), notice = get<HTMLElement>('.pane-notice')
  const empty = get<HTMLElement>('.empty-state'), status = get<HTMLElement>('.run-status')
  let eventCache: ReadonlyMap<string, readonly RunEventView[]> = new Map(), expandedTraces: ReadonlySet<string> = new Set()
  let contentKey = '', rendered = false, savedScroll = initialScroll
  const active = isActive
  const listeners = new AbortController(), options = { signal: listeners.signal }
  const branchSelect = get<HTMLSelectElement>('.branch-navigation select')
  get('[data-go-root]').addEventListener('click', () => { void controller.navigate(null) }, options)
  get('[data-go-parent]').addEventListener('click', () => { void controller.navigate(controller.snapshot().path.at(-1)?.parentId ?? null) }, options)
  branchSelect.addEventListener('change', () => { if (branchSelect.value) void controller.navigate(branchSelect.value) }, options)
  get('[data-more-children]').addEventListener('click', () => { void controller.moreChildren() }, options)
  element.addEventListener('pointerdown', focus, options)
  element.addEventListener('focusin', focus, options)
  get('.pane-close').addEventListener('click', event => { event.stopPropagation(); close() }, options)
  messageInput.addEventListener('input', () => controller.setDraft(messageInput.value), options)
  messageInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); compose.requestSubmit() }
  }, options)
  compose.addEventListener('submit', event => { event.preventDefault(); void controller.submit() }, options)
  cancel.addEventListener('click', () => { const id = controller.snapshot().run?.id; if (id) void controller.cancel(id) }, options)
  transcript.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button')
    if (!button) return
    const data = button.dataset
    if (data.traceRunId) controller.toggleTrace(data.traceRunId)
    if (data.focusRun) controller.focusRun(data.focusRun)
    if (data.cancelRun) void controller.cancel(data.cancelRun)
    if (data.viewNode) void controller.navigate(data.viewNode)
    const node = controller.snapshot().path.find(item => item.id === (data.editNode ?? data.regenerateNode))
    if (node && data.editNode) void controller.navigate(node.parentId, node.input).then(() => messageInput.focus())
    if (node && data.regenerateNode) void controller.regenerate(node)
  }, options)
function addMessage(role: 'user' | 'assistant', content: string, isPending = false): void {
  const item = document.createElement('div')
  item.className = `message ${role}${isPending ? ' pending' : ''}`
  const label = document.createElement('span')
  label.className = 'message-label'
  label.textContent = role === 'user' ? '你' : 'Agent'
  const text = document.createElement('span')
  text.textContent = content
  item.append(label, text)
  transcript.append(item)
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
    captureScroll() {
      if (!element.hidden && element.isConnected) savedScroll = transcript.scrollTop
      return savedScroll
    },
    restoreScroll(top) { savedScroll = top; if (!element.hidden) transcript.scrollTop = top },
    render() {
      const state = controller.snapshot()
      eventCache = state.events
      expandedTraces = state.expanded
      const activeCount = state.runs.filter(active).length
      status.textContent = state.loading ? '正在加载' : state.busy ? '正在处理' : activeCount ? `${activeCount} 个运行中` : '准备就绪'
      notice.hidden = !state.notice
      notice.textContent = state.notice
      messageInput.disabled = !state.session || state.busy || state.loading
      send.disabled = !state.session || state.busy || state.loading
      send.textContent = state.pending ? '重试提交 ↗' : '发送消息 ↗'
      cancel.hidden = !active(state.run)
      cancel.disabled = state.busy || state.run?.status === 'cancelling'
      get('.compose-position').textContent = state.position.viewNodeId ? `继续当前分支 · ${state.position.viewNodeId.slice(0, 8)}` : '从会话起点发送'
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
      }
      branchSelect.value = ''
      branchSelect.disabled = state.loading || !state.children.length
      if (messageInput.value !== state.draft) messageInput.value = state.draft
      const key = JSON.stringify([state.path, state.runs, [...state.events], [...state.expanded], state.pending, state.position.focusedRunId, state.busy])
      if (key === contentKey) return
      contentKey = key
      const top = rendered ? panel.captureScroll() : initialScroll
      const atBottom = !element.hidden && (rendered ? transcript.scrollHeight - transcript.clientHeight - top < 72 : initialScroll === 0)
      const focused = transcript.contains(document.activeElement) ? document.activeElement as HTMLButtonElement : undefined
      const focusedData = focused ? JSON.stringify(focused.dataset) : undefined
      transcript.replaceChildren()
      const action = (text: string, key: string, id: string): HTMLButtonElement => {
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = text
        button.dataset[key] = id
        return button
      }
      for (const node of state.path) {
        addMessage('user', node.input)
        addMessage('assistant', node.output)
        const actions = document.createElement('div')
        actions.className = 'node-actions'
        actions.append(action('从这里继续', 'viewNode', node.id), action('编辑重发', 'editNode', node.id), action('重新生成', 'regenerateNode', node.id))
        for (const button of actions.querySelectorAll('button')) button.disabled = state.busy || Boolean(state.pending)
        transcript.append(actions)
      }
      if (state.runs.length) {
        const heading = document.createElement('h3')
        heading.className = 'run-list-heading'
        heading.textContent = '运行记录'
        transcript.append(heading)
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
        transcript.append(card)
      }
      if (state.pending && !state.runs.some(item => item.id === state.pending?.runId)) addMessage('user', state.pending.input, true)
      empty.hidden = Boolean(state.path.length || state.runs.length || state.pending)
      transcript.hidden = !empty.hidden
      panel.restoreScroll(atBottom ? transcript.scrollHeight : top)
      if (focusedData) [...transcript.querySelectorAll('button')].find(button => JSON.stringify(button.dataset) === focusedData)?.focus({ preventScroll: true })
      if (state.path.length || state.runs.length) rendered = true
    },
    dispose() { listeners.abort(); return panel.captureScroll() },
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
