import type { RunView } from './client-types.js'
import type { SessionSnapshot } from './session-client.js'
import { isActive } from './session-client.js'
import { splitScopedId } from './harness-client.js'
import { runTrace, formatTraceDuration } from './run-trace.js'
import { sessionTrajectory, filterTrajectory, trajectoryTimeline, type TrajectoryRow } from './trajectory.js'
import { getProtocolWebModule, type MountedProtocolTurn } from './protocols/modules.js'
import { mountToolCallDetails, protocolToolContext, toolContextReadiness, latestRunPlan, createToolPlanList, type MountedToolCallDetails } from './tool-call-view.js'

interface TrajectoryActions {
  readonly viewport: (ids: readonly string[]) => void
  readonly search: (query: string) => void
  readonly retry: (id: string) => void
  readonly answer: (id: string) => void
  readonly cancel: (id: string) => void
}
export interface MountedTrajectory {
  readonly scrollElement: HTMLElement
  update(snapshot: SessionSnapshot): void
  locateRun(id: string): void
  dispose(): void
}
const roles = { system: '系统', context: '上下文', user: '用户', assistant: '助手', tool: '工具', status: '状态' }
const states: Readonly<Record<string, string>> = {
  running: '进行中', cancelling: '正在取消', completed: '已完成', failed: '失败', cancelled: '已取消',
  interrupted: '意外中断', queued: '等待执行', recorded: '结果未记录', applied: '已应用', partial: '部分完成',
  rejected: '已拒绝', skipped: '未执行',
}
const short = (text: string): string => text.replace(/\s+/g, ' ').trim()
const stateLabel = (row: TrajectoryRow): string => row.state === 'recorded' && (!row.step || ['user', 'context', 'system'].includes(row.role))
  ? '已记录' : states[row.state] ?? row.state
const time = (value: string | undefined): string => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未记录'
const origin = (run: RunView): string => run.history.kind === 'legacy-unknown' ? '旧版记录 · 起点未记录'
  : run.history.parentNodeId ? `起点 ${(splitScopedId(run.history.parentNodeId)?.id ?? run.history.parentNodeId).slice(0, 8)}` : '会话起点'

/** The toolbar and selection stay mounted while derived rows are replaced. */
export function createTrajectoryView(container: HTMLElement, actions: TrajectoryActions): MountedTrajectory {
  container.innerHTML = `<div class="trajectory-toolbar" role="toolbar" aria-label="轨迹显示选项">
    <div class="trajectory-controls"><button type="button" data-duration aria-pressed="false">时长</button><button type="button" data-turns aria-pressed="false">轮次</button><button type="button" data-calls aria-pressed="false">调用</button></div>
    <label class="trajectory-search"><img src="/apps/agent/icons/search.svg" alt="" aria-hidden="true"><input type="search" aria-label="搜索轨迹内容" placeholder="搜索轨迹" autocomplete="off"></label>
  </div><div class="trajectory-timeline" aria-label="轨迹时间轴"><div class="trajectory-lane-labels"><span>输入</span><span>模型</span><span>工具</span></div><div class="trajectory-lanes"></div></div>
  <p class="trajectory-progress" role="status"></p><div class="trajectory-body"><div class="trajectory-scroll" tabindex="0" aria-label="轨迹列表"><div class="trajectory-ledger" role="grid" aria-label="本会话全部运行轨迹"></div></div><aside class="trajectory-inspector" aria-label="轨迹明细" hidden></aside></div>`
  const get = <T extends HTMLElement>(selector: string): T => container.querySelector<T>(selector)!
  const scroll = get('.trajectory-scroll'), ledger = get('.trajectory-ledger'), inspector = get('.trajectory-inspector')
  const body = get('.trajectory-body'), lanes = get('.trajectory-lanes'), progress = get('.trajectory-progress')
  const search = get<HTMLInputElement>('.trajectory-search input'), duration = get<HTMLButtonElement>('[data-duration]')
  const turns = get<HTMLButtonElement>('[data-turns]'), calls = get<HTMLButtonElement>('[data-calls]')
  const abort = new AbortController(), options = { signal: abort.signal }
  const foldedRuns = new Set<string>(), foldedCalls = new Set<string>()
  let snapshot: SessionSnapshot | undefined, rows: readonly TrajectoryRow[] = [], visibleRows: readonly TrajectoryRow[] = []
  let selected: string | undefined, mode: 'sequence' | 'duration' = 'sequence', query = '', key = '', detailKey = ''
  let viewportKey = '', timer: ReturnType<typeof setTimeout> | undefined
  let beforeSearch: { selected?: string; scroll: number } | undefined
  let detailScroll = 0, detailRow: string | undefined, detailVisible = false
  const detailTurns = new Map<string, { readonly runId: string; readonly turn: MountedProtocolTurn }>()
  const disposeDetailTurns = (): void => { for (const { turn } of detailTurns.values()) turn.dispose(); detailTurns.clear() }
  const detailTools = new Map<string, { readonly runId: string; readonly detail: MountedToolCallDetails }>()
  const disposeDetailTools = (): void => { for (const { detail } of detailTools.values()) detail.dispose(); detailTools.clear() }
  const measurableDetail = (): boolean => !container.hidden && container.isConnected && inspector.clientWidth > 0 && inspector.clientHeight > 0
  const callOwners = (): readonly string[] => {
    const owners = new Set<string>(); let assistant: string | undefined, runId: string | undefined
    for (const row of rows) {
      if (runId !== row.runId) { runId = row.runId; assistant = undefined }
      if (row.role === 'assistant') assistant = row.id
      if (row.role === 'tool' && assistant) owners.add(assistant)
    }
    return [...owners]
  }
  const button = (label: string, action: () => void, className = ''): HTMLButtonElement => {
    const value = document.createElement('button'); value.type = 'button'; value.className = className
    value.textContent = label; value.title = label; value.setAttribute('aria-label', label)
    value.addEventListener('click', action, options); return value
  }
  const scheduleViewport = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      if (!snapshot || container.hidden || !container.isConnected || !scroll.clientWidth || !scroll.clientHeight) return
      const rect = scroll.getBoundingClientRect?.()
      const groups = [...ledger.querySelectorAll<HTMLElement>('.trajectory-group')]
      const ids = rect ? groups.filter(group => {
        const bounds = group.getBoundingClientRect(); return bounds.bottom >= rect.top - 96 && bounds.top <= rect.bottom + 96
      }).map(group => group.dataset.runId!) : snapshot.runs.slice(0, 3).map(run => run.id)
      const next = JSON.stringify(ids)
      if (viewportKey !== next) { viewportKey = next; actions.viewport(ids) }
    }, 0)
  }
  const focusRow = (id: string, locate: boolean): void => {
    const row = [...ledger.querySelectorAll<HTMLButtonElement>('.trajectory-row')].find(item => item.dataset.rowId === id)
    if (!row) return
    if (locate) scroll.scrollTop += row.getBoundingClientRect && scroll.getBoundingClientRect
      ? row.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 32 : row.offsetTop - scroll.offsetTop
    row.focus({ preventScroll: true }); scheduleViewport()
  }
  const closeDetails = (): void => {
    const previous = selected; selected = undefined; detailKey = ''; render()
    if (previous) focusRow(previous, false)
  }
  const select = (id: string, locate = false): void => {
    const row = rows.find(item => item.id === id)
    if (!row) return
    if (locate && query && !filterTrajectory(rows, query).some(item => item.id === id)) {
      query = ''; search.value = ''; beforeSearch = undefined; selected = id; actions.search('')
    }
    foldedRuns.delete(row.runId)
    // Timeline selection reveals a tool hidden under its assistant call.
    let owner: string | undefined
    for (const item of rows.filter(item => item.runId === row.runId)) {
      if (item.role === 'assistant') owner = item.id
      if (item.id === id) { if (owner) foldedCalls.delete(owner); break }
    }
    selected = id; render(); focusRow(id, locate)
  }
  const renderDetails = (): void => {
    const row = rows.find(item => item.id === selected), run = snapshot?.runs.find(item => item.id === row?.runId)
    inspector.hidden = !row || !run; body.classList.toggle('has-inspector', !inspector.hidden)
    if (!row || !run) { inspector.replaceChildren(); detailVisible = false; return }
    const measured = measurableDetail()
    const focused = detailRow === row.id && inspector.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined
    if (detailRow !== row.id) { detailRow = row.id; detailScroll = 0 }
    else if (measured && detailVisible) detailScroll = inspector.scrollTop
    const next = JSON.stringify([row, run, snapshot?.busy, snapshot?.events.get(run.id), snapshot?.traceLoading?.states.get(run.id)])
    if (detailKey === next) {
      if (measured && !detailVisible) inspector.scrollTop = detailScroll
      detailVisible = measured; return
    }
    detailKey = next
    const heading = document.createElement('div'), title = document.createElement('strong')
    heading.className = 'trajectory-detail-heading'; title.textContent = `${roles[row.role]} · ${row.label}`
    const close = button('关闭轨迹明细', closeDetails, 'trajectory-detail-close')
    const image = document.createElement('img'); image.src = '/apps/agent/icons/close.svg'; image.alt = ''; image.setAttribute('aria-hidden', 'true'); close.replaceChildren(image)
    heading.append(title, close)
    const metadata = document.createElement('p'); metadata.className = 'trajectory-detail-meta'
    metadata.textContent = [`第 ${row.turn} 次运行`, origin(run), stateLabel(row),
      row.elapsedMs === undefined ? undefined : formatTraceDuration(row.elapsedMs)].filter(Boolean).join(' · ')
    const nodes: Node[] = [heading, metadata]
    const append = (label: string, text: string): void => {
      if (!text) return
      const name = document.createElement('h4'), content = document.createElement('pre')
      name.textContent = label; content.textContent = text; content.className = 'trajectory-detail-text'; nodes.push(name, content)
    }
    if (row.provisional) append('临时展示', '模型正在生成，最终以已提交记录为准。')
    if (row.tool && !row.requestOnly) {
      let mounted = detailTools.get(row.id)
      if (!mounted) { mounted = { runId: run.id, detail: mountToolCallDetails(row.tool, run.sessionId) }; detailTools.set(row.id, mounted) }
      else mounted.detail.update(row.tool)
      nodes.push(mounted.detail.element)
    }
    else if (row.protocolView) {
      const module = getProtocolWebModule(row.protocolView.protocolId)
      if (module) {
        const key = JSON.stringify([row.id, row.protocolView.protocolId])
        const toolContext = protocolToolContext(run, snapshot?.events.get(run.id) ?? [],
          toolContextReadiness(snapshot?.traceLoading?.states.get(run.id), Boolean(snapshot?.events.has(run.id))))
        let detailTurn = detailTurns.get(key)
        if (!detailTurn) { detailTurn = { runId: run.id, turn: module.mount(row.protocolView, { toolContext, presentation: 'detail' }) }; detailTurns.set(key, detailTurn) }
        else detailTurn.turn.update(row.protocolView, { toolContext, presentation: 'detail' })
        nodes.push(detailTurn.turn.element)
      } else append('模型展示', '此协议的展示组件尚不可用。')
    }
    else if (row.role === 'assistant' && run.history.kind !== 'legacy-unknown' && (run.protocolBinding || run.modelSnapshot?.protocolId)) {
      const missing = document.createElement('p'), loading = snapshot?.traceLoading?.states.get(run.id)
      missing.className = 'native-display-missing'; missing.setAttribute('role', 'status')
      missing.textContent = loading === 'unloaded' || loading === 'loading' ? '正在读取原生模型展示…' : '原生模型展示暂不可用。'
      nodes.push(missing)
    } else {
      append(row.role === 'user' ? '用户原文与实际模型输入' : row.role === 'system' ? '系统提示词' : row.role === 'context' ? '上下文' : '输入与工具请求', row.input)
      append(row.role === 'assistant' ? '模型输出' : '结果', row.output)
    }
    if (run.error) append('运行错误', run.error)
    const fields = document.createElement('dl'); fields.className = 'trajectory-detail-fields'
    for (const [label, value] of [['模型', run.modelSnapshot?.remoteModelId ?? '未记录'], ['协议', run.protocolBinding?.protocolId ?? '未记录'],
      ['开始', time(row.startedAt)], ['结束', time(row.finishedAt)], ['Run ID', run.id]]) {
      const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label!; dd.textContent = value!; fields.append(dt, dd)
    }
    nodes.push(fields)
    const controls = document.createElement('div'); controls.className = 'trajectory-detail-actions'
    if (run.resultNodeId) controls.append(button('查看回答', () => actions.answer(run.resultNodeId!)))
    if (isActive(run)) { const cancel = button('取消此运行', () => actions.cancel(run.id)); cancel.disabled = Boolean(snapshot?.busy) || run.status === 'cancelling'; controls.append(cancel) }
    nodes.push(controls)
    const retained = new Set(nodes)
    for (const child of Array.from(inspector.childNodes)) if (!retained.has(child)) child.remove()
    let cursor: ChildNode | null = inspector.firstChild
    for (const node of nodes) {
      if (node === cursor) cursor = cursor.nextSibling
      else inspector.insertBefore(node, cursor)
    }
    if (focused?.isConnected && inspector.contains(focused)) focused.focus({ preventScroll: true })
    if (measured) inspector.scrollTop = detailScroll
    detailVisible = measured
  }
  const render = (): void => {
    if (!snapshot) return
    const loaded = snapshot.traceLoading
    const all = filterTrajectory(rows, query), matchIds = new Set(all.map(row => row.id))
    const hasQuery = Boolean(query.trim()), runOrder = [...snapshot.runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    const nextKey = JSON.stringify([all, [...foldedRuns], [...foldedCalls], selected, runOrder, loaded && [...loaded.states], snapshot.loading, query])
    duration.setAttribute('aria-pressed', String(mode === 'duration')); duration.title = mode === 'duration' ? '切换到等宽时间轴' : '按已记录耗时显示'
    duration.setAttribute('aria-label', duration.title)
    const collapsible = callOwners()
    const allTurns = Boolean(runOrder.length) && runOrder.every(run => foldedRuns.has(run.id)), allCalls = Boolean(collapsible.length) && collapsible.every(id => foldedCalls.has(id))
    turns.setAttribute('aria-pressed', String(allTurns)); turns.title = allTurns ? '展开所有轮次' : '折叠所有轮次'; turns.setAttribute('aria-label', turns.title)
    calls.setAttribute('aria-pressed', String(allCalls)); calls.title = allCalls ? '展开所有调用' : '折叠所有调用'; calls.setAttribute('aria-label', calls.title)
    const remaining = loaded?.pending ?? 0, failed = loaded?.failed ?? 0
    progress.textContent = hasQuery ? `${all.length} 条匹配 · 已读取 ${loaded?.loaded ?? 0}/${loaded?.total ?? snapshot.runs.length} 次运行${remaining ? ' · 其余历史正在读取…' : ''}${failed ? ` · ${failed} 次读取失败` : ''}`
      : `本会话 ${runOrder.length} 次运行${loaded ? ` · 已读取 ${loaded.loaded}/${loaded.total}` : ''}${remaining ? ' · 滚动读取更多' : ''}${failed ? ` · ${failed} 次读取失败` : ''} · 搜索覆盖已加载的展示内容`
    if (key !== nextKey) {
      key = nextKey
      const focused = ledger.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined
      const oldFocus = focused?.dataset.rowId, oldTurn = focused?.dataset.turnRun
      const nodes: Node[] = [], shown: TrajectoryRow[] = []
      for (const [index, run] of runOrder.entries()) {
        const groupRows = all.filter(row => row.runId === run.id)
        if (hasQuery && !groupRows.length) continue
        const group = document.createElement('section'); group.className = 'trajectory-group'; group.dataset.runId = run.id; group.setAttribute('role', 'rowgroup')
        const header = button('', () => { foldedRuns.has(run.id) ? foldedRuns.delete(run.id) : foldedRuns.add(run.id); render() }, 'trajectory-group-heading')
        header.dataset.turnRun = run.id; header.title = `第 ${index + 1} 次运行 · ${origin(run)} · ${states[run.status]} · ${run.id}`
        header.setAttribute('aria-label', header.title); header.setAttribute('aria-expanded', String(!foldedRuns.has(run.id)))
        const number = document.createElement('span'), context = document.createElement('span'), status = document.createElement('span')
        number.textContent = `第 ${index + 1} 次运行`; context.textContent = origin(run); context.className = 'trajectory-origin'
        const counts = runTrace(run, snapshot.events.get(run.id) ?? []).counts
        status.textContent = [states[run.status], counts.modelCalls ? `${counts.modelCalls} 次模型` : '', counts.toolCalls ? `${counts.toolCalls} 次工具` : ''].filter(Boolean).join(' · ')
        status.className = 'trajectory-group-state'; status.dataset.state = run.status; header.append(number, context, status); group.append(header)
        const plan = latestRunPlan(snapshot.events.get(run.id) ?? [])
        if (plan && !hasQuery && !foldedRuns.has(run.id)) group.append(createToolPlanList(plan, 'trajectory-plan'))
        let assistant: string | undefined
        for (const row of groupRows) {
          if (!hasQuery && foldedRuns.has(run.id) && row.role !== 'user') continue
          if (row.role === 'assistant') assistant = row.id
          if (!hasQuery && row.role === 'tool' && assistant && foldedCalls.has(assistant)) continue
          shown.push(row)
          const item = button('', () => select(row.id), 'trajectory-row'); item.dataset.rowId = row.id; item.dataset.runId = run.id; item.dataset.role = row.role
          item.setAttribute('role', 'row'); item.setAttribute('aria-selected', String(selected === row.id)); item.tabIndex = selected === row.id ? 0 : -1
          const role = document.createElement('span'), text = document.createElement('span'), status = document.createElement('span')
          role.className = 'trajectory-role'; role.textContent = roles[row.role]; role.setAttribute('role', 'gridcell')
          text.className = 'trajectory-preview'; text.setAttribute('role', 'gridcell')
          const preview = row.preview ?? (row.role === 'tool' ? `${row.label} ${short(row.input)}${row.output ? ` → ${short(row.output)}` : ''}` : short(row.output || row.input) || row.label)
          text.textContent = preview
          if (row.role === 'tool') {
            const input = document.createElement('span'), arrow = document.createElement('span'), output = document.createElement('span')
            input.className = 'trajectory-tool-input'; input.textContent = `${row.label} ${short(row.input)}`
            arrow.className = 'trajectory-tool-arrow'; arrow.textContent = '→'
            output.className = 'trajectory-tool-output'
            const result = row.tool?.name === 'apply_patch' ? row.tool.result : undefined
            output.textContent = result ? [
              `${result.changes.length} 个文件已变更`, result.pending.length ? `${result.pending.length} 项未完成` : '',
              result.changes.map(change => change.path).join('、'), result.diagnostic?.code ?? '',
            ].filter(Boolean).join(' · ') : short(row.output) || stateLabel(row)
            text.replaceChildren(input, arrow, output)
          }
          if (!hasQuery && row.role === 'assistant' && foldedCalls.has(row.id)) {
            let tools = 0
            for (const following of rows.slice(rows.indexOf(row) + 1)) { if (following.runId !== row.runId || following.role === 'assistant') break; if (following.role === 'tool') tools++ }
            if (tools) text.textContent += ` · ${tools} 个工具调用已折叠`
          }
          status.className = 'trajectory-row-state'; status.dataset.state = row.state; status.setAttribute('role', 'gridcell')
          status.textContent = row.elapsedMs === undefined ? (['system', 'context', 'user'].includes(row.role) ? '' : stateLabel(row)) : formatTraceDuration(row.elapsedMs)
          item.title = `${roles[row.role]} · ${row.label} · ${stateLabel(row)}${row.elapsedMs === undefined ? '' : ` · ${formatTraceDuration(row.elapsedMs)}`}`
          item.setAttribute('aria-label', `${item.title} · ${preview}`); item.append(role, text, status); group.append(item)
        }
        const state = loaded?.states.get(run.id)
        if (state && state !== 'loaded') {
          const message = document.createElement('p'); message.className = 'trajectory-load-state'
          message.textContent = state === 'failed' ? loaded!.errors.get(run.id) ?? '轨迹读取失败' : state === 'loading' ? '正在读取执行轨迹…' : '执行轨迹尚未加载'
          if (state === 'failed') message.append(button('重试读取', () => actions.retry(run.id)))
          group.append(message)
        }
        nodes.push(group)
      }
      if (!nodes.length) {
        const empty = document.createElement('p'); empty.className = 'run-history-empty'
        empty.textContent = snapshot.loading ? '正在读取运行记录…' : hasQuery ? remaining ? '正在搜索其余历史…' : failed ? '已读取内容没有匹配；部分历史读取失败。' : '已加载的展示内容中没有匹配结果。' : '暂无运行记录'
        nodes.push(empty)
      }
      visibleRows = shown; ledger.replaceChildren(...nodes); ledger.setAttribute('aria-rowcount', String(shown.length))
      if (!shown.some(row => row.id === selected) && shown.length) ledger.querySelector<HTMLButtonElement>('.trajectory-row')!.tabIndex = 0
      if (oldFocus) focusRow(oldFocus, false)
      if (oldTurn) [...ledger.querySelectorAll<HTMLButtonElement>('[data-turn-run]')].find(item => item.dataset.turnRun === oldTurn)?.focus({ preventScroll: true })
      scheduleViewport()
    }
    const timeline = trajectoryTimeline(rows, mode)
    const timelineKey = JSON.stringify([timeline, selected, query])
    if (lanes.dataset.content !== timelineKey) {
      lanes.dataset.content = timelineKey
      lanes.replaceChildren(...timeline.spans.map(span => {
        const row = rows.find(row => row.id === span.rowId)!
        const bar = button(`${roles[row.role]} · ${row.label}${row.elapsedMs === undefined ? '' : ` · ${formatTraceDuration(row.elapsedMs)}`}`, () => select(span.rowId, true), 'trajectory-bar')
        bar.textContent = ''; bar.dataset.role = row.role; bar.dataset.state = span.state; bar.dataset.rowId = span.rowId
        bar.classList.toggle('is-selected', selected === span.rowId); bar.classList.toggle('is-dimmed', hasQuery && !matchIds.has(span.rowId))
        bar.style.left = `${span.left * 100}%`; bar.style.width = `${span.width * 100}%`; bar.style.top = `${span.lane * 14 + 4}px`
        return bar
      }))
      if (mode === 'duration') { const note = document.createElement('span'); note.className = 'trajectory-timing-note'; note.textContent = timeline.hasTiming ? '仅显示已记录时间' : '暂无可用耗时记录'; lanes.append(note) }
    }
    renderDetails()
  }
  duration.addEventListener('click', () => { mode = mode === 'sequence' ? 'duration' : 'sequence'; render() }, options)
  turns.addEventListener('click', () => {
    const all = snapshot?.runs.every(run => foldedRuns.has(run.id))
    for (const run of snapshot?.runs ?? []) { if (all) foldedRuns.delete(run.id); else foldedRuns.add(run.id) }
    render()
  }, options)
  calls.addEventListener('click', () => {
    const assistants = callOwners(), all = assistants.every(id => foldedCalls.has(id))
    for (const id of assistants) { if (all) foldedCalls.delete(id); else foldedCalls.add(id) }
    render()
  }, options)
  search.addEventListener('input', () => {
    const next = search.value
    if (!query && next) beforeSearch = { selected, scroll: scroll.scrollTop }
    query = next; actions.search(query); render()
    if (!query && beforeSearch) { selected = beforeSearch.selected; scroll.scrollTop = beforeSearch.scroll; beforeSearch = undefined; render() }
  }, options)
  search.addEventListener('keydown', event => {
    if (event.key === 'Escape' && query) { event.preventDefault(); search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true })) }
  }, options)
  scroll.addEventListener('scroll', scheduleViewport, options)
  ledger.addEventListener('keydown', event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('.trajectory-row'), index = visibleRows.findIndex(row => row.id === target?.dataset.rowId)
    if (index < 0) return
    if (event.key === 'Escape') { event.preventDefault(); closeDetails(); return }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? visibleRows.length - 1 : Math.max(0, Math.min(visibleRows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
    select(visibleRows[next]!.id, true)
  }, options)
  inspector.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); closeDetails() } }, options)
  inspector.addEventListener('scroll', () => { if (measurableDetail()) detailScroll = inspector.scrollTop }, options)
  return {
    scrollElement: scroll,
    update(value) {
      snapshot = value
      const retainedRuns = new Set(value.runs.map(run => run.id))
      for (const [key, entry] of detailTurns) if (!retainedRuns.has(entry.runId)) { entry.turn.dispose(); detailTurns.delete(key) }
      rows = sessionTrajectory(value.runs, value.events, value.views, value.traceLoading?.states)
      const retainedTools = new Set(rows.filter(row => row.tool && !row.requestOnly).map(row => row.id))
      for (const [id, entry] of detailTools) if (!retainedRuns.has(entry.runId) || !retainedTools.has(id)) { entry.detail.dispose(); detailTools.delete(id) }
      render(); scheduleViewport()
    },
    locateRun(id) { const row = rows.find(item => item.runId === id); if (row) select(row.id, true) },
    dispose() { disposeDetailTools(); disposeDetailTurns(); abort.abort(); if (timer !== undefined) clearTimeout(timer) },
  }
}
