import { requestJSON, requireApplicationHttp } from '@anybox/application-api/web'
import type { ApplicationWebContext, MountedApplication } from '@anybox/application-api/web'
import type { Agent, AgentConfiguration, Artifact, ModelState, Run, Work, WorkDetail, WorkKind, WorkspaceState } from '../contracts.js'
import { append, button, downloadText, element as el, errorMessage, formattedTime, runStatus, workStatus } from './view.js'

interface Editor { node: HTMLDialogElement; status: HTMLParagraphElement; dirty: boolean; busy: boolean; resume: boolean }
const emptyState = (): WorkspaceState => ({ agents: [], works: [], preferredAgentId: null })
const emptyModels = (): ModelState => ({ models: [], connections: [] })
const encode = encodeURIComponent

/** UI requests own observation only. Disposing a page never cancels a business Run. */
export async function mount(container: HTMLElement, input: ApplicationWebContext): Promise<MountedApplication> {
  const context = requireApplicationHttp(input)
  const lifetime = new AbortController(), requests = new Set<Promise<unknown>>()
  let disposed = false, active = true, mutations = 0, timer: ReturnType<typeof setTimeout> | undefined, noticeTimer: ReturnType<typeof setTimeout> | undefined
  let state = emptyState(), models = emptyModels(), detail: WorkDetail | undefined
  let agentId: string | null = null, workId: string | null = null, kind: WorkKind = 'conversation'
  let editor: Editor | undefined, refreshing: Promise<void> | undefined
  let listKey = '', agentsKey = '', transcriptKey = '', resultsKey = '', taskKey = '', headerKey = '', welcomeKey = '', composerWorkId: string | null = null
  const drafts = new Map<string, string>()
  const app = el('div', 'pa-app'); app.lang = 'zh-CN'
  const agentList = el('nav', 'pa-agent-list'); agentList.setAttribute('aria-label', 'Agent 列表')
  const workList = el('nav', 'pa-work-list'); workList.setAttribute('aria-label', '对话与任务列表')
  const notice = el('div', 'pa-notice'); notice.setAttribute('role', 'status'); notice.hidden = true
  const noticeText = el('span')
  const hideNotice = () => { notice.hidden = true; if (noticeTimer) clearTimeout(noticeTimer); noticeTimer = undefined }
  append(notice, noticeText, button('关闭', hideNotice, 'pa-text-button'))
  const show = (message: string) => {
    if (disposed) return
    hideNotice(); noticeText.textContent = message; notice.hidden = false
    noticeTimer = setTimeout(hideNotice, 6000)
    if (editor) { editor.status.textContent = message; editor.status.hidden = false }
  }
  const api = <T>(path: string, body?: object): Promise<T> => {
    if (disposed || lifetime.signal.aborted) return Promise.reject(new DOMException('Page closed', 'AbortError'))
    const request = requestJSON<T>(`${context.apiBase}${path}`, body, lifetime.signal)
    requests.add(request)
    void request.then(() => requests.delete(request), () => requests.delete(request))
    return request
  }
  const act = async (work: () => Promise<unknown>, done?: () => void) => {
    mutations++; renderComposer()
    try { await work(); if (!disposed) { done?.(); await refresh() } }
    catch (error) { if (!lifetime.signal.aborted) { show(errorMessage(error)); await refresh() } }
    finally { mutations--; renderComposer() }
  }
  const currentAgent = () => state.agents.find(agent => agent.id === agentId)
  const currentWork = () => detail?.work.id === workId ? detail.work : state.works.find(work => work.id === workId)
  const isRunning = () => detail?.work.id === workId && detail.runs.some(run => run.status === 'running')
  const routeTo = (path: string) => { if (context.route.read() !== path) context.route.navigate(path) }
  const selectWork = (work: Work, route = true) => {
    workId = work.id; agentId = work.agentId; kind = work.kind; detail = undefined; transcriptKey = ''
    if (route) routeTo(`/works/${encode(work.id)}`)
    render(); void refresh()
  }
  const selectAgent = (id: string, route = true) => {
    agentId = id; workId = null; detail = undefined; transcriptKey = ''
    if (route) routeTo(`/agents/${encode(id)}`)
    render(); void refresh()
  }
  const followRoute = () => {
    const path = context.route.read()
    const workMatch = /^\/?works\/([^/]+)$/.exec(path), agentMatch = /^\/?agents\/([^/]+)$/.exec(path)
    let id: string | undefined
    try { id = decodeURIComponent(workMatch?.[1] ?? agentMatch?.[1] ?? '') } catch { return }
    if (workMatch) { const work = state.works.find(value => value.id === id); if (work && work.id !== workId) selectWork(work, false) }
    else if (agentMatch && state.agents.some(agent => agent.id === id) && id !== agentId) selectAgent(id, false)
  }

  const brand = append(el('div', 'pa-brand'), el('span', 'pa-mark', '✳'), append(el('div'), el('strong', '', 'Personal Agent'), el('small', '', '把想法，一步步变成成果')))
  const sidebar = append(el('aside', 'pa-sidebar'), brand,
    append(el('div', 'pa-section-label'), el('span', '', '我的 AGENTS'), button('＋', () => openAgent(), 'pa-icon-button')),
    agentList,
    append(el('div', 'pa-sidebar-foot'), append(el('span', 'pa-local'), el('i'), '本机运行 · 文本执行'), button('模型设置', () => openModels(), 'pa-model-settings'), el('small', '', '每个 Agent 同级，用途由你定义。')))
  const listHeading = el('h2', '', '工作空间')
  const conversationTab = button('对话', () => { kind = 'conversation'; listKey = ''; renderLists() }, 'pa-tab')
  const taskTab = button('任务', () => { kind = 'task'; listKey = ''; renderLists() }, 'pa-tab')
  const workPane = append(el('aside', 'pa-work-pane'), append(el('header', 'pa-list-heading'), listHeading, button('＋ 新建', () => openWork(), 'pa-text-button')),
    append(el('div', 'pa-tabs'), conversationTab, taskTab), workList)
  const heading = el('h1', '', '让一个想法，开始有进展')
  const subtitle = el('p', 'pa-subtitle', '先创建一个 Agent，再开始交流或交给它一个任务。')
  const headerActions = el('div', 'pa-header-actions')
  const mainHeader = append(el('header', 'pa-main-header'), append(el('div'), heading, subtitle), headerActions)
  const taskBar = el('section', 'pa-task-bar'); taskBar.hidden = true
  const workNotice = el('p', 'pa-waiting'); workNotice.hidden = true; workNotice.setAttribute('role', 'status')
  const transcript = el('div', 'pa-transcript'); transcript.setAttribute('aria-label', '执行记录')
  const welcome = el('div', 'pa-welcome')
  const resultPanel = el('section', 'pa-results'); resultPanel.hidden = true
  const composer = el('form', 'pa-composer')
  const prompt = el('textarea', 'pa-prompt'); prompt.rows = 3; prompt.placeholder = '说说你想做什么…'; prompt.setAttribute('aria-label', '消息或下一步指令'); prompt.maxLength = 100000
  prompt.addEventListener('input', () => { if (workId) drafts.set(workId, prompt.value); renderComposer() })
  const composerHint = el('span', 'pa-composer-hint')
  const send = el('button', 'pa-primary', '发送'); send.type = 'submit'
  const cancel = button('停止本轮', () => {
    const work = currentWork(), run = detail?.runs.find(value => value.status === 'running')
    if (work && run) void act(() => api(`/works/${encode(work.id)}/runs/${encode(run.id)}/cancel`, {}))
  }, 'pa-stop')
  append(composer, prompt, append(el('div', 'pa-composer-bottom'), composerHint, append(el('div', 'pa-composer-buttons'), cancel, send)))
  composer.addEventListener('submit', event => {
    event.preventDefault()
    const work = currentWork(), value = prompt.value
    if (!work || !value.trim() || send.disabled) return
    void act(() => api<Run>(`/works/${encode(work.id)}/runs`, { input: value, expectedRevision: work.revision }), () => {
      if (drafts.get(work.id) === value) drafts.delete(work.id)
      if (workId === work.id && prompt.value === value) prompt.value = ''
    })
  })
  prompt.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); composer.requestSubmit() }
  })
  const main = append(el('main', 'pa-main'), notice, mainHeader, workNotice, taskBar, welcome, transcript, resultPanel, composer)
  append(app, sidebar, workPane, main); container.replaceChildren(app)

  function renderLists() {
    const nextAgentsKey = JSON.stringify([state.agents, agentId, state.preferredAgentId])
    if (nextAgentsKey !== agentsKey) {
      agentsKey = nextAgentsKey; agentList.replaceChildren()
      for (const agent of state.agents) {
        const selected = agent.id === agentId
        const item = button('', () => selectAgent(agent.id), `pa-agent${selected ? ' is-selected' : ''}`)
        item.setAttribute('aria-current', selected ? 'true' : 'false')
        append(item, el('span', 'pa-avatar', agent.name.slice(0, 1)), append(el('span', 'pa-agent-copy'), el('strong', '', agent.name), el('small', '', agent.description || '自由配置的 Agent')))
        if (agent.id === state.preferredAgentId) append(item, el('span', 'pa-default', '默认'))
        agentList.append(item)
      }
      if (!state.agents.length) append(agentList, el('p', 'pa-list-empty', '你的第一个 Agent，\n从一个名字开始。'), button('创建 Agent', () => openAgent(), 'pa-outline'))
    }
    listHeading.textContent = currentAgent()?.name ?? '工作空间'
    conversationTab.classList.toggle('is-selected', kind === 'conversation'); conversationTab.setAttribute('aria-pressed', String(kind === 'conversation'))
    taskTab.classList.toggle('is-selected', kind === 'task'); taskTab.setAttribute('aria-pressed', String(kind === 'task'))
    const works = state.works.filter(work => work.agentId === agentId && work.kind === kind).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const nextListKey = JSON.stringify([works, workId, kind, agentId])
    if (nextListKey === listKey) return
    listKey = nextListKey; workList.replaceChildren()
    for (const work of works) {
      const item = button('', () => selectWork(work), `pa-work${work.id === workId ? ' is-selected' : ''}`)
      append(item, append(el('span', 'pa-work-line'), el('strong', '', work.title), el('i', `pa-status-dot is-${work.status}`)), el('small', '', work.progress || work.goal || '开始一段新的交流'), append(el('span', 'pa-work-meta'), el('span', '', workStatus(work.status)), el('time', '', formattedTime(work.updatedAt))))
      workList.append(item)
    }
    if (!works.length) append(workList, el('p', 'pa-list-empty', kind === 'conversation' ? '还没有对话。\n随时聊聊你的想法。' : '还没有任务。\n给它一个独立的目标。'), button(kind === 'conversation' ? '开始对话' : '创建任务', () => openWork(), 'pa-outline'))
  }
  function renderComposer() {
    const work = currentWork(), agent = currentAgent(), running = isRunning()
    if (composerWorkId !== workId) {
      if (composerWorkId) drafts.set(composerWorkId, prompt.value)
      composerWorkId = workId; prompt.value = workId ? drafts.get(workId) ?? '' : ''
    }
    composer.hidden = !work
    const available = models.models.find(model => model.id === agent?.modelId)?.available
    const closed = work?.status === 'completed' || work?.status === 'cancelled'
    send.textContent = running ? '执行中…' : work?.kind === 'task' ? '推进任务 ↗' : '发送 ↗'
    send.disabled = !work || !prompt.value.trim() || running || closed || !available || mutations > 0
    prompt.disabled = !!closed
    cancel.hidden = !running; cancel.disabled = mutations > 0
    composerHint.textContent = running ? '这一轮正在实际执行，可切换任务或关闭界面。' : closed ? '任务已结束。重新打开后可以继续。' : !agent?.modelId ? '请在 Agent 配置中选择模型。' : !available ? '所选模型不可用，请检查模型设置。' : `上下文段 ${work?.contextSegment ?? 1} · Ctrl / ⌘ + Enter 发送`
  }
  function render() {
    if (disposed) return
    renderLists(); renderComposer()
    const work = currentWork(), agent = currentAgent()
    heading.textContent = work?.title ?? (agent ? `和 ${agent.name} 一起，推进一些事` : '让一个想法，开始有进展')
    subtitle.textContent = work ? `${work.kind === 'task' ? '独立任务' : '对话'} · ${agent?.name ?? ''} · ${workStatus(work.status)} · 上下文段 ${work.contextSegment}` : agent?.description || '先创建一个 Agent，再开始交流或交给它一个任务。'
    const nextHeaderKey = JSON.stringify([agent, state.preferredAgentId, work?.id, work?.status, isRunning()])
    if (nextHeaderKey !== headerKey) {
    headerKey = nextHeaderKey; headerActions.replaceChildren()
    if (agent) {
      append(headerActions, button('Agent 配置', () => openAgent(agent), 'pa-outline'))
      if (agent.id !== state.preferredAgentId) append(headerActions, button('设为默认', () => { void act(() => api('/preferences', { agentId: agent.id })) }, 'pa-text-button'))
    }
    if (work && !isRunning() && work.status !== 'completed' && work.status !== 'cancelled') append(headerActions, button('新上下文段', () => openContext(work), 'pa-text-button'))
    }
    welcome.hidden = !!work; transcript.hidden = !work; taskBar.hidden = !work || work.kind !== 'task'
    workNotice.hidden = !work?.waitReason || work.kind === 'task'
    workNotice.textContent = work?.waitReason ? waitingReason(work.waitReason) : ''
    if (!work) {
      const nextWelcomeKey = JSON.stringify([agent, models.models]);
      if (nextWelcomeKey !== welcomeKey) { welcomeKey = nextWelcomeKey
      welcome.replaceChildren(el('span', 'pa-welcome-symbol', '✳'), el('span', 'pa-eyebrow', '一个 Agent，一个新的可能'), el('h2', '', agent ? '先聊聊，或者给它一个目标。' : '把你的做事方式，交给一个 Agent。'), el('p', '', '对话用来交流想法，任务独立记录目标、推进与成果。每次执行都使用 Agent 最新的配置。'),
        append(el('div', 'pa-welcome-actions'), button(agent ? '开始对话 ↗' : '创建第一个 Agent ↗', () => agent ? openWork('conversation') : openAgent(), 'pa-primary'), ...(agent ? [button('创建一个任务', () => openWork('task'), 'pa-outline')] : [])))
      if (agent && !agent.modelId) append(welcome, append(el('div', 'pa-setup-hint'), el('strong', '', '还差一个模型'), el('p', '', 'Personal Agent 单独管理模型配置和 Key。先添加模型，再到 Agent 配置中选择它。'), button('配置模型', () => openModels(), 'pa-text-button')))
      }
      resultPanel.hidden = true; return
    }
    if (work.kind === 'task') renderTaskBar(work)
    if (!detail || detail.work.id !== workId) { transcript.replaceChildren(el('p', 'pa-loading', '正在读取执行记录…')); resultPanel.hidden = true; return }
    renderTranscript(detail)
    renderResults(detail)
  }
  function waitingReason(reason: string): string {
    return reason === 'context-capacity' ? '上下文容量不足。请开始新的上下文段，再决定如何继续。' : reason === 'interrupted' ? '上次执行中断，未自动重放。请检查历史记录，再明确发送新的推进指令。' : reason === 'cancelled' ? '上一轮已取消。你可以发送新的指令继续。' : reason
  }
  function renderTaskBar(work: Work) {
    const key = JSON.stringify([work, isRunning()]); if (key === taskKey) return; taskKey = key
    taskBar.replaceChildren(append(el('div', 'pa-task-goal'), el('span', 'pa-eyebrow', '任务目标'), el('p', '', work.goal)))
    if (work.progress) append(taskBar, append(el('div', 'pa-task-progress'), el('span', 'pa-eyebrow', '当前进展'), el('p', '', work.progress)))
    if (work.waitReason) append(taskBar, append(el('div', 'pa-waiting'), el('strong', '', '等待条件'), el('p', '', waitingReason(work.waitReason))))
    const actions = el('div', 'pa-task-actions')
    if (work.sourceWorkId) append(actions, button('← 来源任务', () => { const source = state.works.find(value => value.id === work.sourceWorkId); if (source) selectWork(source) }, 'pa-text-button'))
    if (!isRunning()) {
      append(actions, button('更新进展', () => openProgress(work), 'pa-text-button'))
      if (work.status !== 'completed' && work.status !== 'cancelled') {
        append(actions, button('移交给另一 Agent', () => openDelegate(work), 'pa-text-button'), button('标记完成', () => { void act(() => api(`/works/${encode(work.id)}`, { expectedRevision: work.revision, status: 'completed' })) }, 'pa-text-button'), button('取消任务', () => openCancel(work), 'pa-text-button pa-danger'))
      } else append(actions, button('重新打开', () => { void act(() => api(`/works/${encode(work.id)}`, { expectedRevision: work.revision, status: 'open', waitReason: '' })) }, 'pa-text-button'))
    }
    append(taskBar, actions)
  }
  function renderTranscript(value: WorkDetail) {
    const key = JSON.stringify([value.work.id, value.runs])
    if (key === transcriptKey) return
    transcriptKey = key
    const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 100
    const scroll = transcript.scrollTop
    transcript.replaceChildren()
    if (!value.runs.length) append(transcript, append(el('div', 'pa-first-message'), el('span', 'pa-welcome-symbol', '✳'), el('h2', '', value.work.kind === 'task' ? '目标已记下，从第一步开始。' : '这里是你们独立的对话。'), el('p', '', value.work.kind === 'task' ? '在下方写一条推进指令。每轮执行后，你可以继续、等待或保存成果。' : '说说你的想法。这里的上下文与其他任务和对话相互独立。')))
    let segment: number | undefined
    for (const run of value.runs) {
      if (segment !== run.contextSegment) { segment = run.contextSegment; append(transcript, el('div', 'pa-segment', `上下文段 ${segment}`)) }
      const user = append(el('article', 'pa-message pa-user'), append(el('header'), el('strong', '', '你'), el('time', '', formattedTime(run.createdAt))), el('div', 'pa-message-text', run.input))
      const answer = append(el('article', 'pa-message pa-assistant'), append(el('header'), el('span', 'pa-small-mark', '✳'), el('strong', '', run.agent.name), el('span', `pa-run-status is-${run.status}`, runStatus(run.status))))
      if (run.output) append(answer, el('div', 'pa-message-text', run.output))
      else if (run.status === 'running') append(answer, el('div', 'pa-thinking', '正在执行这一轮，结果会在实际退出后保存…'))
      if (run.error) append(answer, el('p', 'pa-run-error', errorMessage({ code: run.error })))
      const foot = el('footer', 'pa-message-actions')
      if (run.output) append(foot, button('保存为成果', () => openArtifact(value.work, run), 'pa-text-button'), button('下载文本', () => downloadText(`${value.work.title}-${run.id.slice(0, 8)}`, run.output), 'pa-text-button'))
      const history = append(el('details', 'pa-run-facts'), el('summary', '', `执行事实 · Agent r${run.agent.revision} · ${run.protocolId ?? '待返回'}${run.modelRevision === null ? '' : ` · 模型 r${run.modelRevision}`}`),
        el('pre', '', JSON.stringify({ agent: run.agent, instruction: run.instruction, context: run.context, createdAt: run.createdAt, finishedAt: run.finishedAt }, null, 2)))
      append(answer, foot, history); append(transcript, user, answer)
    }
    transcript.scrollTop = nearBottom ? transcript.scrollHeight : scroll
  }
  function renderResults(value: WorkDetail) {
    resultPanel.hidden = !value.artifacts.length && !value.delegations.length && value.work.kind !== 'task'
    const key = JSON.stringify([value.work.id, value.work.kind, value.artifacts, value.delegations, state.agents.map(agent => [agent.id, agent.name])]); if (key === resultsKey) return; resultsKey = key
    resultPanel.replaceChildren(); resultPanel.hidden = !value.artifacts.length && !value.delegations.length && value.work.kind !== 'task'
    if (value.work.kind === 'task' || value.artifacts.length) {
      const section = append(el('div'), append(el('header', 'pa-results-heading'), el('h3', '', '成果'), button('＋ 保存文本', () => openArtifact(value.work), 'pa-text-button')))
      for (const artifact of value.artifacts) append(section, renderArtifact(artifact))
      if (!value.artifacts.length) append(section, el('p', 'pa-muted', '把有价值的输出保存到这里，也可以自行记录一份成果。'))
      append(resultPanel, section)
    }
    if (value.delegations.length) {
      const section = append(el('div'), el('h3', '', '已移交的独立任务'))
      for (const child of value.delegations) append(section, button('', () => selectWork(child), 'pa-delegation'))
      Array.from(section.querySelectorAll('button')).forEach((node, index) => {
        const child = value.delegations[index]
        append(node, el('strong', '', child.title), el('span', '', `${state.agents.find(agent => agent.id === child.agentId)?.name ?? 'Agent'} · ${workStatus(child.status)} →`), el('small', '', child.progress || '打开查看进展与成果'))
      })
      append(section, el('p', 'pa-muted', '移交形成独立任务；取消来源任务不会撤回它。')); append(resultPanel, section)
    }
  }
  function renderArtifact(artifact: Artifact) {
    return append(el('details', 'pa-artifact'), append(el('summary'), el('strong', '', artifact.title), el('small', '', formattedTime(artifact.createdAt))), el('div', 'pa-message-text', artifact.content), button('下载成果', () => downloadText(artifact.title, artifact.content), 'pa-text-button'))
  }

  function openEditor(title: string, description: string): { body: HTMLDivElement; form: HTMLFormElement; footer: HTMLDivElement; submit(text: string, callback: () => Promise<unknown>, success?: () => void): void } | undefined {
    if (editor) { if (active && !editor.node.open) editor.node.showModal(); show('请先保存或放弃当前编辑。'); return }
    const node = el('dialog', 'pa-dialog'), body = el('div', 'pa-dialog-body'), form = el('form'), footer = el('div', 'pa-dialog-footer'), status = el('p', 'pa-dialog-notice')
    status.hidden = true; status.setAttribute('role', 'alert')
    const value: Editor = { node, status, dirty: false, busy: false, resume: true }; editor = value
    append(node, append(el('header', 'pa-dialog-header'), el('h2', '', title), el('p', '', description)), status, form)
    append(form, body, footer); append(app, node)
    form.addEventListener('input', () => { value.dirty = formDirty(form) })
    form.addEventListener('change', () => { value.dirty = formDirty(form) })
    node.addEventListener('cancel', event => { event.preventDefault(); if (value.dirty || value.busy) show('请先保存，或点击“放弃编辑”。'); else closeEditor() })
    const abandon = button('放弃编辑', () => { if (!value.busy) closeEditor() }, 'pa-outline')
    append(footer, abandon)
    if (active) node.showModal()
    return { body, form, footer,
      submit(text, callback, success) {
        const save = el('button', 'pa-primary', text); save.type = 'submit'; append(footer, save)
        form.addEventListener('submit', event => {
          event.preventDefault(); if (value.busy || !form.reportValidity()) return
          value.busy = true; save.disabled = true; abandon.disabled = true
          void act(callback, () => { closeEditor(); success?.() }).finally(() => { value.busy = false; save.disabled = false; abandon.disabled = false })
        })
      },
    }
  }
  function formDirty(form: HTMLFormElement) {
    return Array.from(form.elements).some(control => control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement ? control.value !== control.defaultValue : control instanceof HTMLSelectElement ? Array.from(control.options).some(option => option.selected !== option.defaultSelected) : false)
  }
  function closeEditor() { if (editor) { editor.node.close(); editor.node.remove(); editor = undefined } }
  function field(body: HTMLElement, label: string, multiline = false, value = '', hint?: string) {
    const labelNode = el('label', 'pa-field'), control = multiline ? el('textarea') : el('input')
    control.defaultValue = value; control.value = value; control.setAttribute('aria-label', label)
    if (control instanceof HTMLTextAreaElement) control.rows = 4
    append(labelNode, el('span', '', label), control)
    if (hint) append(labelNode, el('small', '', hint))
    append(body, labelNode); return control
  }
  function selectField(body: HTMLElement, label: string, choices: { value: string; text: string; disabled?: boolean }[], selected: string) {
    const control = el('select'); control.setAttribute('aria-label', label)
    for (const choice of choices) { const option = el('option', '', choice.text); option.value = choice.value; option.disabled = !!choice.disabled; option.defaultSelected = choice.value === selected; append(control, option) }
    control.value = selected; append(body, append(el('label', 'pa-field'), el('span', '', label), control)); return control
  }
  function openAgent(agent?: Agent) {
    const dialog = openEditor(agent ? `配置 ${agent.name}` : '创建一个 Agent', 'Agent 之间没有上下级。每轮新执行采用最新配置，已有执行和历史保持原样。')
    if (!dialog) return
    const name = field(dialog.body, '名称', false, agent?.name ?? ''); name.required = true; name.maxLength = 100
    const description = field(dialog.body, '用途描述', false, agent?.description ?? ''); description.maxLength = 500
    const systemPrompt = field(dialog.body, '系统提示词', true, agent?.systemPrompt ?? '你是一个认真、可靠的个人助手。帮助用户澄清目标，给出具体可用的回答与成果。'); systemPrompt.maxLength = 50000
    const modelChoices = models.models.map(model => ({ value: model.id, text: `${model.name}${model.available ? '' : '（不可用）'}` }))
    if (agent?.modelId && !modelChoices.some(model => model.value === agent.modelId)) modelChoices.push({ value: agent.modelId, text: '原模型（已不可用）' })
    const model = selectField(dialog.body, '执行模型', [{ value: '', text: '稍后选择模型' }, ...modelChoices], agent?.modelId ?? '')
    const memory = field(dialog.body, '明确记忆', true, agent?.memory ?? '', '只填写你明确希望它记住的内容；对话不会自动写入记忆。'); memory.maxLength = 50000
    const skills = field(dialog.body, 'Skills', true, agent?.skills ?? '', '由你维护的做事方法和指引文本。本版不执行脚本或文件工具。'); skills.maxLength = 50000
    const limit = field(dialog.body, '上下文字符上限', false, String(agent?.contextLimit ?? 24000), '包括系统提示词、记忆、Skills 与本段历史。达到上限会暂停，由你决定如何继续。') as HTMLInputElement
    limit.type = 'number'; limit.min = '256'; limit.max = '1000000'; limit.step = '1'; limit.required = true
    dialog.submit('保存 Agent', async () => {
      const config: AgentConfiguration = { name: name.value, description: description.value, systemPrompt: systemPrompt.value, memory: memory.value, skills: skills.value, modelId: model.value || null, contextLimit: Number(limit.value) }
      const saved = await api<Agent>('/agents', { ...config, ...(agent ? { id: agent.id, expectedRevision: agent.revision } : {}) })
      if (!agent) { agentId = saved.id; workId = null; detail = undefined; routeTo(`/agents/${encode(saved.id)}`) }
    })
  }
  function openWork(selectedKind: WorkKind = kind) {
    const agent = currentAgent(); if (!agent) { openAgent(); return }
    const dialog = openEditor(selectedKind === 'task' ? '给它一个独立任务' : '开始一段新对话', `由 ${agent.name} 负责。这段上下文与其他对话、任务独立。`)
    if (!dialog) return
    const title = field(dialog.body, selectedKind === 'task' ? '任务名称' : '对话标题'); title.required = true; title.maxLength = 200
    const goal = field(dialog.body, selectedKind === 'task' ? '任务目标' : '交流主题（可选）', true); goal.required = selectedKind === 'task'; goal.maxLength = 10000
    let created: Work | undefined
    dialog.submit(selectedKind === 'task' ? '创建任务' : '开始对话', async () => { created = await api<Work>('/works', { agentId: agent.id, kind: selectedKind, title: title.value, goal: goal.value }) }, () => { if (created) selectWork(created) })
  }
  function openProgress(work: Work) {
    const dialog = openEditor('更新任务进展', '进展和等待条件由你明确记录；再次推进仍需发送一条指令。')
    if (!dialog) return
    const progress = field(dialog.body, '当前进展', true, work.progress)
    const status = selectField(dialog.body, '任务状态', [{ value: 'open', text: '待推进' }, { value: 'waiting', text: '等待中' }, { value: 'completed', text: '已完成' }], work.status === 'cancelled' ? 'open' : work.status)
    const waitReason = field(dialog.body, '等待条件', true, work.waitReason)
    dialog.submit('保存进展', () => api(`/works/${encode(work.id)}`, { expectedRevision: work.revision, progress: progress.value, status: status.value, waitReason: waitReason.value }))
  }
  function openContext(work: Work) {
    const dialog = openEditor('开始新的上下文段', '已有执行记录和成果会保留。下一轮保留当前 Agent 配置和任务目标，不再携带前一段的对话历史。请在新指令中补充你决定保留的要点。')
    if (!dialog) return
    append(dialog.body, el('p', 'pa-context-explanation', `当前为第 ${work.contextSegment} 段；确认后建立第 ${work.contextSegment + 1} 段。`))
    dialog.submit('保留历史并开始新段', () => api(`/works/${encode(work.id)}/context`, { expectedRevision: work.revision }))
  }
  function openCancel(work: Work) {
    const dialog = openEditor('取消这个任务', '这会结束来源任务。已移交的独立任务会保留，可分别查看和处理。')
    if (!dialog) return
    dialog.submit('确认取消任务', () => api(`/works/${encode(work.id)}`, { expectedRevision: work.revision, status: 'cancelled' }))
  }
  function openDelegate(work: Work) {
    const options = state.agents.filter(agent => agent.id !== work.agentId)
    if (!options.length) { show('先创建另一位 Agent，再将独立任务移交给它。'); return }
    const dialog = openEditor('移交一个独立任务', '只传递你写下的目标，不共享来源上下文。新任务不会自动执行；移交后可独立推进和取消。')
    if (!dialog) return
    const target = selectField(dialog.body, '接收 Agent', options.map(agent => ({ value: agent.id, text: agent.name })), options[0].id)
    const title = field(dialog.body, '任务名称', false, work.title); title.required = true; title.maxLength = 200
    const goal = field(dialog.body, '交给它的目标与必要背景', true, work.goal); goal.required = true; goal.maxLength = 10000
    let created: Work | undefined
    dialog.submit('移交并查看任务', async () => { created = await api<Work>(`/works/${encode(work.id)}/delegate`, { agentId: target.value, title: title.value, goal: goal.value }) }, () => { if (created) selectWork(created) })
  }
  function openArtifact(work: Work, run?: Run) {
    const dialog = openEditor('保存一份成果', '成果是你明确保存的文本，独立保留在这个任务或对话下。')
    if (!dialog) return
    const title = field(dialog.body, '成果名称', false, `${work.title} · 成果`); title.required = true; title.maxLength = 200
    const content = field(dialog.body, '成果内容', true, run?.output ?? ''); content.required = true; content.maxLength = 200000
    dialog.submit('保存成果', () => api(`/works/${encode(work.id)}/artifacts`, { title: title.value, content: content.value, ...(run ? { runId: run.id } : {}) }))
  }
  function openModels() {
    const dialog = openEditor('Personal Agent 的模型', '模型配置和 Key 由此应用单独管理。Key 保存到系统凭据服务，不进入 Agent、任务和执行历史。')
    if (!dialog) return
    const owner = editor!
    for (const connection of models.connections) {
      const row = append(el('div', 'pa-connection'), el('strong', '', connection.name), el('small', '', `${connection.protocolId} · ${connection.baseUrl}`), el('span', '', connection.credentialConfigured ? 'Key 已配置' : '未配置 Key'))
      const key = el('input'); key.type = 'password'; key.autocomplete = 'new-password'; key.placeholder = '填写新 Key'; key.setAttribute('aria-label', `更新 ${connection.name} 的 Key`)
      const save = button('更新 Key', () => {
        if (!key.value.trim() || owner.busy) return
        owner.busy = true; save.disabled = true; key.disabled = true
        void act(async () => { models = await api<ModelState>(`/models/connections/${encode(connection.id)}/key`, { expectedRevision: connection.revision, apiKey: key.value }); key.value = ''; connection.revision = models.connections.find(value => value.id === connection.id)?.revision ?? connection.revision; row.querySelector('span')!.textContent = 'Key 已配置'; owner.dirty = formDirty(dialog.form) }, () => show('Key 已更新。')).finally(() => { owner.busy = false; save.disabled = false; key.disabled = false })
      }, 'pa-text-button')
      append(row, append(el('div', 'pa-key-row'), key, save)); append(dialog.body, row)
    }
    append(dialog.body, el('h3', 'pa-new-model-title', models.models.length ? '添加另一个模型' : '添加第一个模型'))
    const name = field(dialog.body, '模型显示名称'); name.required = true; name.maxLength = 100
    const protocol = selectField(dialog.body, '协议', [
      { value: 'chat-completions', text: 'Chat Completions' }, { value: 'responses', text: 'Responses' }, { value: 'anthropic-messages', text: 'Anthropic Messages' }, { value: 'gemini-interactions', text: 'Gemini Interactions' },
    ], 'chat-completions')
    const baseUrl = field(dialog.body, 'API 基础地址', false, '', '填写不带 /chat/completions、/responses 等端点后缀的基础地址。'); baseUrl.required = true
    const remoteModelId = field(dialog.body, '远端模型 ID'); remoteModelId.required = true; remoteModelId.maxLength = 200
    const auth = selectField(dialog.body, '认证方式', [{ value: 'api-key', text: 'API Key' }, { value: 'none', text: '无需认证（例如本机服务）' }], 'api-key')
    const apiKey = field(dialog.body, 'API Key（可稍后补充）') as HTMLInputElement; apiKey.type = 'password'; apiKey.autocomplete = 'new-password'
    dialog.submit('保存模型', async () => {
      try { models = await api<ModelState>('/models', { name: name.value, protocolId: protocol.value, baseUrl: baseUrl.value, remoteModelId: remoteModelId.value, auth: auth.value, ...(apiKey.value ? { apiKey: apiKey.value } : {}) }) }
      catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'credential-unavailable' && !disposed) {
          models = await api<ModelState>('/models'); closeEditor(); openModels()
        }
        throw error
      }
    }, () => show('模型已保存。请在 Agent 配置中选择它。'))
  }

  async function refresh() {
    if (disposed) return
    if (refreshing) { await refreshing; if (workId && detail?.work.id !== workId) return refresh(); return }
    refreshing = (async () => {
      try {
        const [nextState, nextModels] = await Promise.all([api<WorkspaceState>('/state'), api<ModelState>('/models')])
        if (disposed) return
        state = nextState; models = nextModels
        if (!agentId || !state.agents.some(agent => agent.id === agentId)) agentId = state.preferredAgentId ?? state.agents[0]?.id ?? null
        followRoute()
        const target = workId
        if (target) { const value = await api<WorkDetail>(`/works/${encode(target)}`); if (!disposed && workId === target) detail = value }
        render()
      } catch (error) { if (!lifetime.signal.aborted) show(errorMessage(error)) }
    })()
    try { await refreshing } finally { refreshing = undefined }
  }
  function schedule() {
    if (disposed) return
    timer = setTimeout(() => { void refresh().finally(schedule) }, active ? state.works.some(work => work.status === 'running') ? 1100 : 4000 : 7000)
  }
  const unsubscribe = context.route.subscribe(() => { followRoute(); render() })
  const abort = () => { lifetime.abort(); if (timer) clearTimeout(timer); hideNotice() }
  context.signal.addEventListener('abort', abort, { once: true }); if (context.signal.aborted) abort()
  await refresh(); schedule()
  return {
    setActive(value) {
      active = value
      if (!value && editor?.node.open) { editor.resume = true; editor.node.close() }
      else if (value && editor?.resume && !editor.node.open) editor.node.showModal()
      if (value) void refresh()
    },
    canClose: () => mutations === 0 && !editor?.dirty && !editor?.busy && !Array.from(drafts.values()).some(value => value.trim()) && !prompt.value.trim(),
    async dispose() {
      if (disposed) return
      disposed = true; abort(); unsubscribe(); context.signal.removeEventListener('abort', abort)
      await Promise.allSettled([...requests]); closeEditor(); drafts.clear(); container.replaceChildren()
    },
  }
}
