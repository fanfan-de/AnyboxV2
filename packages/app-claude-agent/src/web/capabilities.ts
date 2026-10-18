import type { CapabilitiesView, RunControlInput, RunLiveView } from '../core/view.js'
import { el, renderItem } from './view.js'
import { messageFor } from './state.js'

export interface CapabilityTarget { readonly key: string; readonly path: string; readonly runId?: string; readonly live?: RunLiveView }
type Tab = 'skills' | 'mcp' | 'agents'
const labels = { skills: '技能', mcp: 'MCP', agents: '子 Agent' }
const statuses = { connected: '已连接', failed: '连接失败', 'needs-auth': '需要登录', pending: '连接中', disabled: '已停用' }
const taskStatuses = { running: '运行中', pending: '等待中', paused: '已暂停', completed: '已完成', failed: '失败', stopped: '已停止' }
/** A contextual inspector over the selected execution device. Closing only cancels reads, never an accepted control. */
export function createCapabilitiesPanel(domId: (value: string) => string, options: {
  target(): CapabilityTarget | undefined
  request<T>(path: string, body: object | undefined, signal?: AbortSignal): Promise<T>
  insert(text: string): void
  report(message: string): void
}) {
  const closeButton = el('button', { type: 'button', text: '×', 'aria-label': '关闭能力面板' })
  const refresh = el('button', { type: 'button', text: '刷新', class: 'ca-capability-refresh' })
  const subtitle = el('p', { class: 'ca-capability-subtitle' })
  const search = el('input', { type: 'search', placeholder: '搜索技能', 'aria-label': '搜索技能或能力', class: 'ca-capability-search' })
  const status = el('p', { class: 'ca-capability-status', role: 'status' })
  const body = el('div', { class: 'ca-capability-content', role: 'tabpanel', id: domId('capability-content') })
  const tabs = (Object.keys(labels) as Tab[]).map(tab => {
    const button = el('button', { type: 'button', role: 'tab', text: labels[tab], id: domId(`capability-${tab}`), 'aria-controls': body.id, 'data-capability-tab': tab })
    button.addEventListener('click', () => { selected = tab; search.value = ''; render() })
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const index = tabs.indexOf(button), next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowLeft' ? 2 : 1)) % 3
      tabs[next].click(); tabs[next].focus()
    })
    return button
  })
  const element = el('dialog', { class: 'ca-capabilities-dialog', 'aria-labelledby': domId('capabilities-title') },
    el('header', { class: 'ca-capability-head' }, el('div', {}, el('h2', { id: domId('capabilities-title'), text: '技能与工具' }), subtitle), closeButton),
    el('nav', { role: 'tablist', 'aria-label': '能力分类', class: 'ca-capability-tabs' }, ...tabs),
    el('div', { class: 'ca-capability-toolbar' }, search, refresh), status, body)
  let selected: Tab = 'skills', snapshot: CapabilitiesView | undefined, target: CapabilityTarget | undefined
  let reads = new AbortController(), version = 0, loading = false, busy = false, destroyed = false, returnFocus: HTMLElement | undefined
  const matches = (text: string) => text.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase())
  const relevant = (key: string, runId: string | undefined) => !destroyed && element.open && options.target()?.key === key && options.target()?.runId === runId
  const close = () => { reads.abort(); version++; loading = false; element.close(); returnFocus?.focus() }
  const action = (label: string, input: RunControlInput) => {
    const button = el('button', { type: 'button', text: label, disabled: busy || !target?.runId, class: 'ca-capability-action' })
    button.addEventListener('click', () => { void control(input) })
    return button
  }
  const render = () => {
    if (!element.open) return
    subtitle.textContent = snapshot?.source === 'run' ? '当前任务 · 操作仅对本次任务有效' : '当前项目 · 来自执行设备的 Claude 环境'
    for (const button of tabs) { const chosen = button.dataset.capabilityTab === selected; button.setAttribute('aria-selected', String(chosen)); button.setAttribute('tabindex', chosen ? '0' : '-1') }
    body.setAttribute('aria-labelledby', domId(`capability-${selected}`))
    search.placeholder = selected === 'skills' ? '搜索技能或命令' : selected === 'mcp' ? '搜索 MCP 服务' : '搜索子 Agent'
    refresh.disabled = loading || busy
    refresh.textContent = selected === 'skills' && target?.runId ? '重新加载技能' : '刷新'
    body.setAttribute('aria-busy', String(loading || busy))
    if (!snapshot) { body.replaceChildren(); return }
    const entries: HTMLElement[] = []
    if (selected === 'skills') {
      entries.push(el('p', { class: 'ca-capability-help', text: '选择技能后先填入输入框，补充任务并发送。内置命令会单独标记。' }))
      for (const skill of snapshot.skills.filter(skill => matches(`${skill.name} ${skill.description}`))) {
        const use = el('button', { type: 'button', class: 'ca-capability-use', text: `/${skill.name}`, 'aria-label': `使用 ${skill.name}` })
        use.addEventListener('click', () => { close(); options.insert(`/${skill.name} `) })
        entries.push(el('section', { class: 'ca-capability-entry' }, el('div', { class: 'ca-capability-entry-head' }, use, el('small', { text: skill.builtin ? '内置命令' : '技能' })),
          el('p', { text: skill.description || '无描述' }), ...(skill.argumentHint ? [el('code', { text: skill.argumentHint })] : [])))
      }
      if (entries.length === 1) entries.push(el('p', { class: 'ca-capability-empty', text: search.value ? '没有匹配的技能或命令。' : '此项目的 Claude 环境未返回技能或命令。' }))
    } else if (selected === 'mcp') {
      entries.push(el('p', { class: 'ca-capability-help', text: target?.runId ? '启停、重连只作用于当前任务，不改写 Claude 配置文件。' : '发送任务后，可在这里启停或重连当前任务的 MCP 服务。服务配置沿用 Claude 环境。' }))
      for (const server of snapshot.mcp.filter(server => matches(server.name))) {
        const controls = el('div', { class: 'ca-capability-actions' })
        if (target?.runId) {
          controls.append(action(server.status === 'disabled' ? '启用' : '停用', { action: 'mcp-toggle', name: server.name, enabled: server.status === 'disabled' }))
          if (server.status === 'failed' || server.status === 'needs-auth') controls.append(action('重连', { action: 'mcp-reconnect', name: server.name }))
        }
        const row = el('section', { class: 'ca-capability-entry' }, el('div', { class: 'ca-capability-entry-head' }, el('strong', { text: server.name }), el('span', { class: 'ca-mcp-status', 'data-state': server.status, text: statuses[server.status] })),
          el('small', { text: `${server.tools.length} 个工具${server.source ? ` · ${server.source}` : ''}` }), controls)
        if(target?.runId){row.append(action('逐次确认',{action:'mcp-permission',name:server.name,mode:'default'}),action('沿用任务权限',{action:'mcp-permission',name:server.name,mode:null}))}
        if (server.status === 'needs-auth') row.append(el('p', { text: '请在执行设备的 Claude 环境完成此服务登录，再重连。' }))
        if (server.tools.length) row.append(el('details', {}, el('summary', { text: '查看工具' }), el('ul', {}, ...server.tools.map(name => el('li', { text: name })))))
        entries.push(row)
      }
      if (entries.length === 1) entries.push(el('p', { class: 'ca-capability-empty', text: search.value ? '没有匹配的 MCP 服务。' : '当前 Claude 环境未配置 MCP 服务。' }))
    } else {
      const live = options.target()?.live, tasks = live?.tasks ?? []
      entries.push(el('h3', { text: '当前任务活动' }))
      if (!tasks.length) entries.push(el('p', { class: 'ca-capability-empty', text: '尚未观察到子 Agent 或后台任务。' }))
      if(target?.runId)entries.push(action('将前台任务转入后台',{action:'background-tasks'}))
      for (const task of tasks) {
        const row = el('section', { class: 'ca-capability-entry' }, el('div', { class: 'ca-capability-entry-head' }, el('strong', { text: task.agentType || task.taskType || '任务' }), el('span', { text: task.status ? taskStatuses[task.status] : '状态未知' })),
          el('p', { text: task.description || task.id }), ...(task.summary ? [el('p', { text: task.summary })] : []))
        if (task.toolUses !== undefined) row.append(el('small', { text: `${task.toolUses} 次工具调用 · ${task.tokens ?? 0} tokens${task.lastTool ? ` · ${task.lastTool}` : ''}` }))
        if (target?.runId && ['running', 'pending', 'paused'].includes(task.status ?? '')) row.append(action('停止此任务', { action: 'stop-task', taskId: task.id }))
        const messages = (live?.agentMessages ?? []).filter(entry => entry.parentToolUseId === task.toolUseId)
        if (messages.length) row.append(el('details', {}, el('summary', { text: `查看子 Agent 输出 · ${messages.length}` }), ...messages.map(entry => renderItem({ ...entry.message, streaming: false }))))
        entries.push(row)
      }
      entries.push(el('h3', { text: '可委派的子 Agent' }), el('p', { class: 'ca-capability-help', text: '选择后在输入框补充目标并发送，由 Claude 按任务调用。运行状态与停止操作显示在上方。' }))
      for (const agent of snapshot.agents.filter(agent => matches(`${agent.name} ${agent.description}`))) {
        const use = el('button', { type: 'button', text: '委派任务…', class: 'ca-capability-use' })
        use.addEventListener('click', () => { close(); options.insert(`请使用 ${agent.name} 子 Agent 完成以下任务：\n`) })
        entries.push(el('section', { class: 'ca-capability-entry' }, el('div', { class: 'ca-capability-entry-head' }, el('strong', { text: agent.name }), use), el('p', { text: agent.description }), el('small', { text: agent.model ? `模型：${agent.model}` : '沿用 Claude 环境模型设置' })))
      }
      if (!snapshot.agents.length) entries.push(el('p', { class: 'ca-capability-empty', text: '当前环境未返回可用的子 Agent。' }))
    }
    const openDetails = [...body.querySelectorAll<HTMLDetailsElement>('details')].map((node, index) => node.open ? index : -1)
    body.replaceChildren(...entries)
    for (const [index, node] of [...body.querySelectorAll<HTMLDetailsElement>('details')].entries()) node.open = openDetails.includes(index)
  }
  const load = async () => {
    const latest = options.target()
    if (!latest || destroyed || !element.open) return
    reads.abort(); reads = new AbortController()
    const signal = reads.signal, currentVersion = ++version
    target = latest; loading = true; status.textContent = '正在读取当前 Claude 环境…'; render()
    try {
      const view = await options.request<CapabilitiesView>(latest.path, undefined, signal)
      if (signal.aborted || version !== currentVersion || !relevant(latest.key, latest.runId)) return
      snapshot = view; status.textContent = ''
    } catch (error) { if (!signal.aborted && version === currentVersion && relevant(latest.key, latest.runId)) status.textContent = `读取失败：${messageFor(error)}。可点击刷新重试。` }
    finally { if (version === currentVersion) { loading = false; render() } }
  }
  const control = async (input: RunControlInput) => {
    const current = target
    if (!current?.runId || busy || !relevant(current.key, current.runId)) return
    busy = true; status.textContent = '正在等待 Claude 确认…'; render()
    try {
      await options.request(`/apps/claude-agent/runs/${encodeURIComponent(current.runId)}/control`, input)
      if (relevant(current.key, current.runId)) await load()
    } catch (error) {
      const message = `操作未确认：${messageFor(error)}。请刷新状态核对，操作不会自动重试。`
      if (relevant(current.key, current.runId)) status.textContent = message; else options.report(message)
    } finally { busy = false; render() }
  }
  closeButton.addEventListener('click', close)
  element.addEventListener('cancel', event => { event.preventDefault(); close() })
  search.addEventListener('input', render)
  refresh.addEventListener('click', () => { if (selected === 'skills' && target?.runId) void control({ action: 'reload-skills' }); else void load() })
  return { element,
    open(tab: Tab, focus?: HTMLElement) { selected = tab; returnFocus = focus; search.value = ''; snapshot = undefined; status.textContent = ''; if (!element.open) element.showModal(); render(); search.focus(); void load() },
    update() { if (!element.open) return; const latest = options.target(); if (!latest || latest.key !== target?.key) { close(); return }; if (latest.runId !== target?.runId) { snapshot = undefined; void load() } else render() },
    close,
    dispose() { destroyed = true; close() },
  }
}
