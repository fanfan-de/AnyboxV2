import type { RunEventView, RunView, ToolTrace } from './client-types.js'
import { runTrace, traceElapsed } from './run-trace.js'
import { imageURL } from './image-client.js'

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined
const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const isCommand = (name: string): boolean => ['codex_exec_command', 'codex_write_stdin', 'claude_code_Bash', 'deepseek_harness_bash'].includes(name)
const planNames = new Set(['codex_update_plan', 'claude_code_TodoWrite', 'deepseek_harness_todo_write'])
export interface CommittedToolPlan {
  readonly name: string
  readonly explanation?: string
  readonly items: readonly { readonly text: string; readonly status: 'pending' | 'in_progress' | 'completed' }[]
}
function committedPlan(name: string, result: unknown): CommittedToolPlan | undefined {
  if (!planNames.has(name)) return undefined
  const value = record(result), rows = value?.plan ?? value?.todos
  if (value?.status !== 'updated' || !Array.isArray(rows)) return undefined
  const items: CommittedToolPlan['items'][number][] = []
  for (const row of rows) {
    const item = record(row), text = string(item?.step ?? item?.content), status = item?.status
    if (text === undefined || status !== 'pending' && status !== 'in_progress' && status !== 'completed') return undefined
    items.push({ text, status })
  }
  return { name, items, ...(typeof value.explanation === 'string' ? { explanation: value.explanation } : {}) }
}
/** Only committed observations update the Run's latest full plan. */
export function latestRunPlan(events: readonly RunEventView[]): CommittedToolPlan | undefined {
  let latest: CommittedToolPlan | undefined
  for (const event of events) {
    if (event.kind !== 'tool-observed' || !('result' in event)) continue
    const plan = committedPlan(event.name, event.result)
    if (plan) latest = plan
  }
  return latest
}
export function createToolPlanList(plan: CommittedToolPlan, className = 'tool-plan'): HTMLElement {
  const section = document.createElement('section'), title = document.createElement('strong'), list = document.createElement('ol')
  section.className = className; title.textContent = `最新计划 · ${toolDisplayName(plan.name)}`
  list.setAttribute('aria-label', '已保存的计划')
  for (const item of plan.items) {
    const row = document.createElement('li'), status = document.createElement('span'), text = document.createElement('span')
    row.dataset.status = item.status; status.className = 'tool-plan-status'
    status.textContent = { pending: '待完成', in_progress: '进行中', completed: '已完成' }[item.status]
    text.textContent = item.text; row.append(status, text); list.append(row)
  }
  section.append(title)
  if (plan.explanation) { const note = document.createElement('p'); note.textContent = plan.explanation; section.append(note) }
  if (plan.items.length) section.append(list)
  else { const empty = document.createElement('p'); empty.textContent = '计划已清空。'; section.append(empty) }
  return section
}

function fileFacts(value: unknown, pending = false): readonly string[] {
  if (!Array.isArray(value)) return []
  const labels: Readonly<Record<string, string>> = pending ? { add: '创建', update: '修改', delete: '删除' } : { added: '创建', updated: '修改', deleted: '删除' }
  return value.flatMap(raw => {
    const item = record(raw), label = typeof item?.kind === 'string' ? labels[item.kind] : undefined
    return label && typeof item?.path === 'string' ? [`${label} ${item.path}${pending && typeof item.moveTo === 'string' ? ` → ${item.moveTo}` : ''}`] : []
  })
}

export interface ProtocolToolFact {
  readonly exchangeId: string
  readonly requestId: string
  readonly name: ToolTrace['name']
  readonly occurrence: number
  readonly eventIndex: number
  readonly modelEventIndex: number
  readonly call: ToolTrace
}
export interface ProtocolToolContext {
  readonly runId: string
  readonly readiness: 'loading' | 'ready' | 'failed'
  readonly runStatus: RunView['status']
  readonly facts: readonly ProtocolToolFact[]
}

export function toolContextReadiness(state: string | undefined, hasEvents: boolean): ProtocolToolContext['readiness'] {
  return state === 'failed' ? 'failed' : state === 'loaded' || (!state && hasEvents) ? 'ready' : 'loading'
}

/** Model boundaries and event position disambiguate provider IDs reused in later calls. */
export function protocolToolContext(run: RunView, events: readonly RunEventView[], readiness: ProtocolToolContext['readiness']): ProtocolToolContext {
  const facts: ProtocolToolFact[] = [], occurrences = new Map<string, number>()
  let model: { id: string; eventIndex: number } | undefined
  for (const step of runTrace(run, events).steps) {
    if (step.kind === 'model') {
      model = step.legacy ? undefined : { id: step.id, eventIndex: step.eventIndex }
    } else if (step.kind === 'tool' && model) {
      const key = JSON.stringify([model.id, step.call.id, step.call.name])
      const occurrence = occurrences.get(key) ?? 0
      occurrences.set(key, occurrence + 1)
      facts.push({ exchangeId: model.id, requestId: step.call.id, name: step.call.name, occurrence,
        eventIndex: step.eventIndex, modelEventIndex: model.eventIndex, call: step.call })
    }
  }
  return { runId: run.id, readiness, runStatus: run.status, facts }
}

export function findProtocolToolFact(context: ProtocolToolContext | undefined, exchangeId: string, requestId: string,
  name: string, occurrence = 0): ToolTrace | undefined {
  if (!context) return undefined
  const prefix = context.runId.match(/^(h:[0-9a-f-]{36}:)/)?.[1]
  return context.facts.find(fact => (fact.exchangeId === exchangeId || Boolean(prefix && prefix + fact.exchangeId === exchangeId)) &&
    fact.requestId === requestId && fact.name === name && fact.occurrence === occurrence)?.call
}

export function toolTraceStatus(call: ToolTrace): string {
  if (call.name !== 'bash' && call.name !== 'apply_patch' && isCommand(call.name)) {
    const value = record(call.result)
    if (value?.timed_out === true) return '执行超时'
    if (value?.terminated === true) return '进程已终止'
    if (call.state === 'failed' && typeof value?.exit_code === 'number' && value.exit_code !== 0) return '非零退出'
    if (call.state === 'failed' && typeof value?.signal === 'string') return '信号终止'
    if (call.state === 'completed' && value?.closed !== true && typeof value?.session_id === 'number' && value.exit_code === null) return '进程运行中'
    if (call.state === 'completed' && value?.closed === true) return '进程已退出'
  }
  return {
    queued: '等待执行', running: '执行中', completed: '已完成', applied: '已应用',
    rejected: '已拒绝', partial: '部分完成',
    failed: call.name === 'bash' && typeof call.exitCode === 'number' && call.exitCode !== 0 ? '非零退出' : call.name === 'bash' && call.signal ? '信号终止' : '执行失败',
    skipped: '未执行', cancelled: '已取消', interrupted: '意外中断',
  }[call.state]
}

export interface ToolRequestView {
  readonly id: string
  readonly requestId?: string
  readonly name: string
  readonly arguments: string
  readonly status?: string
}
/** UI metadata, not a native protocol or an execution record. */
export interface ToolSummary {
  readonly title: string
  readonly preview: string
  readonly statusLabel: string
  readonly busy: boolean
  readonly attention: boolean
  readonly awaitingFacts: boolean
  readonly success: boolean
  readonly tone: 'neutral' | 'warning' | 'danger'
  readonly shortReason?: string
  readonly elapsedMs?: number
}

export function parseToolArguments(value: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch { return undefined }
}
const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim()
export function toolDisplayName(name: string): string {
  if (name === 'bash') return 'Bash'
  if (name === 'apply_patch') return 'Apply Patch'
  for (const [prefix, source] of [['codex_', 'Codex'], ['claude_code_', 'Claude Code'], ['deepseek_harness_', 'DeepSeek Harness']]) {
    if (name.startsWith(prefix)) return `${source} · ${name.slice(prefix.length)}`
  }
  return name || '工具'
}
export function toolSelectionDisplayName(toolId: string): string {
  const separator = toolId.indexOf('.'), source = toolId.slice(0, separator), name = toolId.slice(separator + 1)
  const label = ({ codex: 'Codex', 'claude-code': 'Claude Code', 'deepseek-harness': 'DeepSeek Harness', anybox: 'Anybox' } as Readonly<Record<string, string>>)[source]
  return separator > 0 && label ? `${label} · ${name}` : toolId
}
function argumentPreview(args: Readonly<Record<string, unknown>> | undefined): string {
  if (!args) return '参数生成中'
  for (const key of ['cmd', 'command', 'file_path', 'path', 'pattern', 'explanation']) {
    if (typeof args[key] === 'string') return oneLine(args[key] as string)
  }
  return '工具请求'
}

/** Only an observed result can establish success or actual file changes. */
export function summarizeToolRequest(request: ToolRequestView, fact?: ToolTrace,
  readiness: ProtocolToolContext['readiness'] = 'loading', runStatus?: ProtocolToolContext['runStatus']): ToolSummary {
  const title = toolDisplayName(request.name)
  const args = parseToolArguments(request.arguments)
  let preview = fact?.name === 'bash' ? oneLine(fact.command) : fact?.name === 'apply_patch' ? '补丁请求' :
    !args ? '参数生成中' : request.name === 'bash' && typeof args.command === 'string' ? oneLine(args.command) :
      request.name === 'apply_patch' ? '补丁请求' : /^(codex_|claude_code_|deepseek_harness_)/.test(request.name) ? argumentPreview(args) : '工具请求'
  if (!fact) {
    const awaitingFacts = readiness !== 'failed' && (readiness === 'loading' || runStatus === 'running' || runStatus === 'cancelling')
    const statusLabel = readiness === 'failed' ? '执行记录读取失败' : awaitingFacts ? '执行事实待同步' : '执行结果未记录'
    return { title, preview, statusLabel, busy: false, attention: !awaitingFacts,
      awaitingFacts, success: false, tone: awaitingFacts ? 'neutral' : 'warning',
      ...(!awaitingFacts ? { shortReason: statusLabel } : {}) }
  }
  const busy = fact.state === 'running' || fact.state === 'queued'
  const success = fact.state === 'completed' || fact.state === 'applied'
  const attention = !busy && !success
  const tone = fact.state === 'failed' || fact.state === 'rejected' ? 'danger' : attention ? 'warning' : 'neutral'
  let shortReason: string | undefined
  if (fact.name === 'apply_patch' && fact.result) {
    const { changes, pending, diagnostic } = fact.result
    preview = `已变更 ${changes.length} 个文件${pending.length ? `，${pending.length} 项未完成` : ''}`
    if (attention && diagnostic) shortReason = `${diagnostic.code}：${diagnostic.message}`
  }
  if (fact.name !== 'bash' && fact.name !== 'apply_patch') {
    const value = record(fact.result), changes = fileFacts(value?.changes), pending = fileFacts(value?.pending, true), note = record(value?.diagnostic)
    if (Array.isArray(value?.changes)) preview = `已变更 ${changes.length} 个文件${pending.length ? `，${pending.length} 项未完成` : ''}`
    if (attention && typeof note?.code === 'string' && typeof note.message === 'string') shortReason = `${note.code}：${note.message}`
    else if (attention && typeof value?.message === 'string') shortReason = `${typeof value.code === 'string' ? value.code + '：' : ''}${value.message}`
    else if (attention && typeof value?.error === 'string') shortReason = value.error
    else if (attention && typeof value?.exit_code === 'number' && value.exit_code !== 0) shortReason = `退出码：${value.exit_code}`
    else if (attention && typeof value?.signal === 'string') shortReason = `信号：${value.signal}`
  }
  if (attention && !shortReason) {
    if (fact.category) shortReason = `失败类别：${fact.category}`
    else if (fact.name === 'bash' && fact.signal) shortReason = `信号：${fact.signal}`
    else if (fact.name === 'bash' && typeof fact.exitCode === 'number' && fact.exitCode !== 0) shortReason = `退出码：${fact.exitCode}`
    else shortReason = toolTraceStatus(fact)
  }
  const elapsedMs = busy ? undefined : traceElapsed(fact.startedAt, fact.finishedAt)
  return { title, preview, statusLabel: toolTraceStatus(fact), busy, attention, awaitingFacts: false, success, tone,
    ...(shortReason ? { shortReason: oneLine(shortReason) } : {}),
    ...(elapsedMs === undefined ? {} : { elapsedMs }) }
}

/** A copy action owns no global listener or timer and reads the latest literal text. */
export function createToolCopyButton(label: string, field: string, read: () => string, signal: AbortSignal): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'; button.className = 'tool-copy'; button.dataset.copyField = field
  button.textContent = '复制'; button.setAttribute('aria-label', `复制${label}`)
  button.addEventListener('click', () => {
    if (button.disabled || signal.aborted) return
    const content = read()
    button.disabled = true
    void (async () => {
      try { await navigator.clipboard.writeText(content); if (!signal.aborted && read() === content) button.textContent = '已复制' }
      catch { if (!signal.aborted) { button.textContent = '复制失败'; button.title = '请选中文字后复制。' } }
      finally { if (!signal.aborted) button.disabled = false }
    })()
  }, { signal })
  return button
}

export interface MountedToolCallDetails {
  readonly element: HTMLElement
  update(call: ToolTrace): void
  dispose(): void
}

/** Keep sections and their copy controls mounted while durable facts arrive. */
export function mountToolCallDetails(initial: ToolTrace, sessionId?: string,
  options: { readonly showArguments?: boolean } = {}): MountedToolCallDetails {
  const element = document.createElement('article'), heading = document.createElement('div')
  element.className = 'tool-call'; element.tabIndex = -1; heading.className = 'tool-call-heading'
  const label = document.createElement('strong'), status = document.createElement('span')
  heading.append(label, status); element.append(heading)
  const listeners = new AbortController()
  const fields = new Map<string, { element: HTMLElement; content: HTMLElement; copy: HTMLButtonElement; value: string }>()
  const field = (key: string, title: string, tag = 'pre', className = 'tool-output', collapsed = false) => {
    const section = document.createElement(collapsed ? 'details' : 'div'), bar = document.createElement('div'), name = document.createElement('span')
    section.className = 'tool-detail-field'; bar.className = 'tool-detail-toolbar'; name.className = 'tool-output-label'; name.textContent = title
    if (collapsed) { const summary = document.createElement('summary'); summary.textContent = title; section.append(summary) }
    const content = document.createElement(tag); content.className = className
    const copy = createToolCopyButton(title, key, () => fields.get(key)!.value, listeners.signal)
    bar.append(name, copy); section.append(bar, content); element.append(section)
    fields.set(key, { element: section, content, copy, value: '' })
  }
  field('command', '命令', 'code', 'tool-command')
  const result = document.createElement('p'); result.className = 'tool-result'; element.append(result)
  field('patch', '补丁'); field('stdout', 'stdout'); field('stderr', 'stderr')
  field('changes', '实际文件变更'); field('pending', '未完成操作')
  field('output', '输出'); field('text', '文件内容'); field('matches', '搜索结果')
  if (options.showArguments !== false) field('arguments', '原始参数', 'pre', 'tool-output', true)
  field('result', '原始结果', 'pre', 'tool-output', true)
  const images = document.createElement('div'), plan = document.createElement('div')
  images.className = 'tool-images'; plan.className = 'tool-plan-container'; element.append(images, plan)
  let imageKey = '', planKey = ''
  const diagnostic = document.createElement('p'), truncation = document.createElement('small')
  diagnostic.className = 'tool-result'; truncation.className = 'trace-empty'; element.append(diagnostic, truncation)
  let disposed = false
  const set = (key: string, text: string | undefined) => {
    const entry = fields.get(key)!, value = text ?? ''
    if (!value && document.activeElement && entry.element.contains(document.activeElement)) element.focus({ preventScroll: true })
    entry.element.hidden = !value; entry.element.inert = !value
    if (entry.value !== value) {
      entry.value = value; entry.content.textContent = key === 'command' ? `$ ${value}` : value
      entry.copy.textContent = '复制'; entry.copy.title = ''
    }
  }
  const update = (call: ToolTrace) => {
    if (disposed) return
    label.textContent = toolDisplayName(call.name); status.textContent = toolTraceStatus(call)
    const library = call.name !== 'bash' && call.name !== 'apply_patch'
    const value = library ? record(call.result) : undefined
    if (options.showArguments !== false) set('arguments', library ? JSON.stringify(call.arguments, null, 2) : undefined)
    set('result', library && call.result !== undefined ? typeof call.result === 'string' ? call.result : JSON.stringify(call.result, null, 2) : undefined)
    set('command', call.name === 'bash' ? call.command : library && isCommand(call.name) ? string(call.arguments.cmd ?? call.arguments.command) : undefined)
    set('patch', call.name === 'apply_patch' ? call.patch : library && call.name === 'codex_apply_patch' ? string(call.arguments.patch) : undefined)
    set('stdout', call.name === 'bash' ? call.stdout : undefined); set('stderr', call.name === 'bash' ? call.stderr : undefined)
    set('output', library ? string(value?.output) : undefined); set('text', library ? string(value?.text) : undefined)
    const matches = value?.paths ?? value?.matches
    set('matches', library && Array.isArray(matches) ? matches.map(item => {
      if (typeof item === 'string') return item
      const match = record(item)
      return [string(match?.path), typeof match?.line === 'number' ? `:${match.line}` : '', typeof match?.count === 'number' ? ` (${match.count})` : '', string(match?.text)].filter(Boolean).join('')
    }).join('\n') : undefined)
    if (call.name === 'bash') {
      result.textContent = [call.exitCode === undefined ? '' : `退出码：${call.exitCode === null ? '无' : call.exitCode}`,
        call.signal ? `信号：${call.signal}` : '', call.category ? `失败类别：${call.category}` : ''].filter(Boolean).join(' · ')
      set('changes', undefined); set('pending', undefined); diagnostic.textContent = ''
      truncation.textContent = call.truncated ? '输出摘要已截断' : ''
    } else if (call.name === 'apply_patch') {
      const observed = call.result
      result.textContent = [observed ? `补丁结果：${toolTraceStatus({ ...call, state: observed.status })}` : '',
        call.category ? `失败类别：${call.category}` : ''].filter(Boolean).join(' · ')
      set('changes', observed?.changes.map(change => `${{ added: '创建', updated: '修改', deleted: '删除' }[change.kind]} ${change.path}`).join('\n'))
      set('pending', observed?.pending.map(operation => `${{ add: '创建', update: '修改', delete: '删除' }[operation.kind]} ${operation.path}${operation.moveTo ? ` → ${operation.moveTo}` : ''}`).join('\n'))
      const note = observed?.diagnostic
      diagnostic.textContent = note ? `${note.code}：${note.message}${note.path ? ` · ${note.path}` : ''}${note.line === undefined ? '' : `:${note.line}`}` : ''
      truncation.textContent = call.patchTruncated ? '补丁预览已截断' : ''
    } else {
      const notes = [call.category ? `失败类别：${call.category}` : '', typeof value?.path === 'string' ? `文件：${value.path}` : '',
        call.images?.length ? `已读取 ${call.images.length} 张图片` : '']
      if (isCommand(call.name)) notes.push(typeof value?.session_id === 'number' ? `进程：${value.session_id}` : '',
        value?.exit_code === undefined ? '' : `退出码：${value.exit_code === null ? '无' : value.exit_code}`, typeof value?.signal === 'string' ? `信号：${value.signal}` : '',
        typeof value?.wall_time_seconds === 'number' ? `耗时：${value.wall_time_seconds.toFixed(2)} 秒` : '', value?.timed_out === true ? '已超时' : '', value?.terminated === true ? '已终止' : '', value?.closed === true ? '已退出' : '')
      result.textContent = notes.filter(Boolean).join(' · ')
      set('changes', fileFacts(value?.changes).join('\n')); set('pending', fileFacts(value?.pending, true).join('\n'))
      const note = record(value?.diagnostic)
      diagnostic.textContent = note ? [string(note.code), string(note.message), string(note.path)].filter(Boolean).join(' · ') :
        [string(value?.code), string(value?.message), string(value?.error)].filter(Boolean).join(' · ')
      truncation.textContent = value?.truncated === true ? '输出摘要已截断' : ''
    }
    const nextImageKey = library ? JSON.stringify(call.images ?? []) : '[]'
    if (nextImageKey !== imageKey) {
      imageKey = nextImageKey; images.textContent = ''
      if (sessionId && library) for (const image of call.images ?? []) {
        const link = document.createElement('a'), thumbnail = document.createElement('img')
        link.href = imageURL(sessionId, image.assetId); link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = `查看图片 · ${image.width} × ${image.height}`
        thumbnail.src = link.href; thumbnail.alt = `工具读取的图片，${image.width} × ${image.height}`; thumbnail.loading = 'lazy'; thumbnail.decoding = 'async'
        link.append(thumbnail); images.append(link)
      }
    }
    images.hidden = !sessionId || !library || !call.images?.length
    const observedPlan = library ? committedPlan(call.name, call.result) : undefined, nextPlanKey = JSON.stringify(observedPlan) ?? ''
    if (nextPlanKey !== planKey) { planKey = nextPlanKey; plan.textContent = ''; if (observedPlan) plan.append(createToolPlanList(observedPlan)) }
    plan.hidden = !observedPlan
    result.hidden = !result.textContent; diagnostic.hidden = !diagnostic.textContent; truncation.hidden = !truncation.textContent
  }
  update(initial)
  return { element, update, dispose() { if (disposed) return; disposed = true; listeners.abort(); element.remove() } }
}

/** The trajectory's standalone card keeps its existing entry point. */
export function createToolCallCard(call: ToolTrace): HTMLElement { return mountToolCallDetails(call).element }
