import type { RunEventView, RunView, ToolTrace } from './client-types.js'
import { runTrace, traceElapsed } from './run-trace.js'

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
  if (!context || (name !== 'bash' && name !== 'apply_patch')) return undefined
  const prefix = context.runId.match(/^(h:[0-9a-f-]{36}:)/)?.[1]
  return context.facts.find(fact => (fact.exchangeId === exchangeId || Boolean(prefix && prefix + fact.exchangeId === exchangeId)) &&
    fact.requestId === requestId && fact.name === name && fact.occurrence === occurrence)?.call
}

export function toolTraceStatus(call: ToolTrace): string {
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

/** Only an observed result can establish success or actual file changes. */
export function summarizeToolRequest(request: ToolRequestView, fact?: ToolTrace,
  readiness: ProtocolToolContext['readiness'] = 'loading', runStatus?: ProtocolToolContext['runStatus']): ToolSummary {
  const title = request.name === 'bash' ? 'Bash' : request.name === 'apply_patch' ? 'Apply Patch' : request.name || '工具'
  const args = parseToolArguments(request.arguments)
  let preview = fact?.name === 'bash' ? oneLine(fact.command) : fact?.name === 'apply_patch' ? '补丁请求' :
    !args ? '参数生成中' : request.name === 'bash' && typeof args.command === 'string' ? oneLine(args.command) :
      request.name === 'apply_patch' ? '补丁请求' : '工具请求'
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
export function mountToolCallDetails(initial: ToolTrace): MountedToolCallDetails {
  const element = document.createElement('article'), heading = document.createElement('div')
  element.className = 'tool-call'; element.tabIndex = -1; heading.className = 'tool-call-heading'
  const label = document.createElement('strong'), status = document.createElement('span')
  heading.append(label, status); element.append(heading)
  const listeners = new AbortController()
  const fields = new Map<string, { element: HTMLElement; content: HTMLElement; copy: HTMLButtonElement; value: string }>()
  const field = (key: string, title: string, tag = 'pre', className = 'tool-output') => {
    const section = document.createElement('div'), bar = document.createElement('div'), name = document.createElement('span')
    section.className = 'tool-detail-field'; bar.className = 'tool-detail-toolbar'; name.className = 'tool-output-label'; name.textContent = title
    const content = document.createElement(tag); content.className = className
    const copy = createToolCopyButton(title, key, () => fields.get(key)!.value, listeners.signal)
    bar.append(name, copy); section.append(bar, content); element.append(section)
    fields.set(key, { element: section, content, copy, value: '' })
  }
  field('command', '命令', 'code', 'tool-command')
  const result = document.createElement('p'); result.className = 'tool-result'; element.append(result)
  field('patch', '补丁'); field('stdout', 'stdout'); field('stderr', 'stderr')
  field('changes', '实际文件变更'); field('pending', '未完成操作')
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
    label.textContent = call.name === 'bash' ? 'Bash' : 'Apply Patch'; status.textContent = toolTraceStatus(call)
    set('command', call.name === 'bash' ? call.command : undefined)
    set('patch', call.name === 'apply_patch' ? call.patch : undefined)
    set('stdout', call.name === 'bash' ? call.stdout : undefined); set('stderr', call.name === 'bash' ? call.stderr : undefined)
    if (call.name === 'bash') {
      result.textContent = [call.exitCode === undefined ? '' : `退出码：${call.exitCode === null ? '无' : call.exitCode}`,
        call.signal ? `信号：${call.signal}` : '', call.category ? `失败类别：${call.category}` : ''].filter(Boolean).join(' · ')
      set('changes', undefined); set('pending', undefined); diagnostic.textContent = ''
      truncation.textContent = call.truncated ? '输出摘要已截断' : ''
    } else {
      const observed = call.result
      result.textContent = [observed ? `补丁结果：${toolTraceStatus({ ...call, state: observed.status })}` : '',
        call.category ? `失败类别：${call.category}` : ''].filter(Boolean).join(' · ')
      set('changes', observed?.changes.map(change => `${{ added: '创建', updated: '修改', deleted: '删除' }[change.kind]} ${change.path}`).join('\n'))
      set('pending', observed?.pending.map(operation => `${{ add: '创建', update: '修改', delete: '删除' }[operation.kind]} ${operation.path}${operation.moveTo ? ` → ${operation.moveTo}` : ''}`).join('\n'))
      const note = observed?.diagnostic
      diagnostic.textContent = note ? `${note.code}：${note.message}${note.path ? ` · ${note.path}` : ''}${note.line === undefined ? '' : `:${note.line}`}` : ''
      truncation.textContent = call.patchTruncated ? '补丁预览已截断' : ''
    }
    result.hidden = !result.textContent; diagnostic.hidden = !diagnostic.textContent; truncation.hidden = !truncation.textContent
  }
  update(initial)
  return { element, update, dispose() { if (disposed) return; disposed = true; listeners.abort(); element.remove() } }
}

/** The trajectory's standalone card keeps its existing entry point. */
export function createToolCallCard(call: ToolTrace): HTMLElement { return mountToolCallDetails(call).element }
