import type { RunEventView, RunView, ToolTrace } from './client-types.js'
import type { NativeToolRequest, ProtocolViewBlock, ProtocolViewExchange, ProtocolViewSnapshot } from '../core/view/types.js'
import { runTrace, traceElapsed, type RunTraceStep, type ToolTraceStep } from './run-trace.js'
import { toolContextReadiness } from './tool-call-view.js'

export type TrajectoryRole = 'system' | 'user' | 'context' | 'assistant' | 'tool' | 'status'
export interface TrajectoryRow {
  readonly id: string
  readonly runId: string
  readonly turn: number
  readonly role: TrajectoryRole
  readonly label: string
  readonly input: string
  readonly output: string
  readonly preview?: string
  readonly state: string
  readonly startedAt?: string
  readonly finishedAt?: string
  readonly elapsedMs?: number
  readonly tool?: ToolTrace
  readonly step?: RunTraceStep
  readonly provisional?: boolean
  /** Structured presentation is the renderer source; output/preview are only derived search strings. */
  readonly protocolView?: ProtocolViewSnapshot
  readonly savedOutput?: string
  readonly requestOnly?: boolean
}
export type TrajectoryTimelineMode = 'sequence' | 'duration'
export interface TrajectoryTimelineSpan {
  readonly id: string
  readonly rowId: string
  readonly lane: 0 | 1 | 2
  /** Fractions of the whole overview, in the inclusive range 0..1. */
  readonly left: number
  readonly width: number
  readonly state: string
}
export interface TrajectoryTimeline {
  readonly spans: readonly TrajectoryTimelineSpan[]
  readonly mode: TrajectoryTimelineMode
  readonly hasTiming: boolean
}

const timestamp = (value: string | undefined): string | undefined =>
  value && Number.isFinite(Date.parse(value)) ? value : undefined
function timing(start: string | undefined, end: string | undefined): Pick<TrajectoryRow, 'startedAt' | 'finishedAt' | 'elapsedMs'> {
  const startedAt = timestamp(start), finishedAt = timestamp(end), elapsedMs = traceElapsed(startedAt, finishedAt)
  return { ...(startedAt ? { startedAt } : {}), ...(finishedAt ? { finishedAt } : {}),
    ...(elapsedMs === undefined ? {} : { elapsedMs }) }
}
function exchangeFor(view: ProtocolViewSnapshot | undefined, operationId: string): ProtocolViewExchange | undefined {
  // Event IDs are local facts; the client qualifies view IDs for their execution device.
  const prefix = view?.runId.match(/^(h:[0-9a-f-]{36}:)/)?.[1]
  return view?.exchanges.find(exchange => exchange.id === operationId || Boolean(prefix && exchange.id === prefix + operationId))
}
function exchangeProjection(view: ProtocolViewSnapshot, exchange: ProtocolViewExchange): ProtocolViewSnapshot {
  const limits = view.exchanges.filter(candidate => candidate !== exchange &&
    (candidate.id === 'display-limit' || candidate.id.endsWith(':display-limit'))).map(candidate => ({
    id: candidate.id, blocks: candidate.blocks.filter(block => block.type === 'harness.display_limit'),
  })).filter(candidate => candidate.blocks.length)
  return { ...view, exchanges: [...limits, exchange] }
}
function toolOutput(call: ToolTrace): string {
  const failure = call.category ? `失败类别：${call.category}` : ''
  if (call.name === 'apply_patch') return [call.result ? JSON.stringify(call.result, null, 2) : '', failure,
    call.patchTruncated ? '补丁预览已截断' : ''].filter(Boolean).join('\n\n')
  return [typeof call.exitCode === 'number' ? `退出码：${call.exitCode}` : '', call.signal ? `信号：${call.signal}` : '',
    call.stdout ? `stdout\n${call.stdout}` : '', call.stderr ? `stderr\n${call.stderr}` : '', failure,
    call.truncated ? '输出摘要已截断' : ''].filter(Boolean).join('\n\n')
}
function startedTool(step: ToolTraceStep, steps: readonly RunTraceStep[], events: readonly RunEventView[]): boolean {
  const next = steps.find(candidate => candidate.kind === 'tool' && candidate.eventIndex > step.eventIndex &&
    candidate.call.id === step.call.id && candidate.call.name === step.call.name)?.eventIndex ?? events.length
  return events.slice(step.eventIndex, next).some(event => event.kind === 'tool-started' &&
    event.requestId === step.call.id && event.name === step.call.name)
}
function toolRowId(runId: string, step: ToolTraceStep, steps: readonly RunTraceStep[]): string {
  const model = [...steps].reverse().find(candidate => candidate.kind === 'model' && candidate.eventIndex < step.eventIndex)
  if (!model) return `${runId}:tool:${step.eventIndex}:${step.id}`
  const earlier = steps.some(candidate => candidate.kind === 'tool' && candidate.eventIndex > model.eventIndex &&
    candidate.eventIndex < step.eventIndex && candidate.call.id === step.call.id && candidate.call.name === step.call.name)
  // A requested row keeps its identity when the durable start/observation arrives.
  return `${runId}:tool:${model.eventIndex}:${step.call.name}:${step.call.id}${earlier ? `:${step.eventIndex}` : ''}`
}
function localRequest(block: ProtocolViewBlock): NativeToolRequest | undefined {
  return ['responses.function_call', 'anthropic.tool_use', 'chat.tool_call', 'gemini.function_call'].includes(block.type) &&
    'arguments' in block ? block : undefined
}
function requestedTool(block: NativeToolRequest): ToolTrace | undefined {
  if (!block.requestId || (block.name !== 'bash' && block.name !== 'apply_patch')) return undefined
  let args: Record<string, unknown> = {}
  try {
    const value: unknown = JSON.parse(block.arguments)
    if (value && typeof value === 'object' && !Array.isArray(value)) args = value as Record<string, unknown>
  } catch { /* Partial streaming arguments remain a display request, never an execution fact. */ }
  return block.name === 'bash'
    ? { id: block.requestId, name: 'bash', command: typeof args.command === 'string' ? args.command : block.arguments, state: 'queued' }
    : { id: block.requestId, name: 'apply_patch', patch: typeof args.patch === 'string' ? args.patch : block.arguments, patchTruncated: false, state: 'queued' }
}
function blockText(block: ProtocolViewBlock, preview = false): string {
  switch (block.type) {
    case 'responses.message': return block.content.filter(part => !preview || part.type === 'output_text').map(part => part.text).join('\n\n')
    case 'gemini.model_output': return block.content.map(part => part.text).join('\n\n')
    case 'anthropic.text': case 'chat.content': return block.text
    case 'responses.reasoning': case 'gemini.thought': return preview ? '' : `推理摘要\n${block.summary.map(part => part.text).join('\n\n')}`
    case 'anthropic.thinking': case 'chat.reasoning_content': return preview ? '' : `推理摘要\n${block.text}`
    case 'anthropic.redacted_thinking': return preview ? '' : '私有推理已保留'
    case 'chat.refusal': case 'harness.display_limit': case 'harness.unsupported': return preview ? '' : block.text
    case 'responses.web_search_call': return preview ? '' : `Web search · ${block.status ?? 'requested'}${block.query ? `\n${block.query}` : ''}${block.sources?.length ? `\n${block.sources.map(source => `${source.title ?? ''} ${source.url}`).join('\n')}` : ''}`
    case 'anthropic.web_search_tool_result': return preview ? '' : `Web search results · ${block.status}\n${block.sources.map(source => `${source.title ?? ''} ${source.url}`).join('\n')}`
    default: return preview ? '' : `工具请求 ${block.name}\n${block.arguments}`
  }
}
function displayOutput(exchange: ProtocolViewExchange | undefined): { output: string; preview: string | undefined } {
  const blocks = exchange?.blocks ?? []
  const preview = blocks.map(block => blockText(block, true)).filter(Boolean).join('\n\n') || undefined
  const state = exchange?.nativeState
  const nativeState = state ? Object.entries(state).filter(([key, value]) => key !== 'type' && typeof value === 'string').map(([key, value]) => `${key}: ${value}`).join('\n') : ''
  const output = [...blocks.map(block => blockText(block)), nativeState].filter(Boolean).join('\n\n')
  return { output, preview }
}
function unstartedState(status: RunView['status']): ToolTrace['state'] {
  return status === 'cancelled' || status === 'interrupted' ? status
    : status === 'failed' || status === 'completed' ? 'skipped' : 'queued'
}

/** Project browser-safe facts only; this ledger is never a native recovery context. */
export function sessionTrajectory(runs: readonly RunView[], eventsMap: ReadonlyMap<string, readonly RunEventView[]>,
  viewsMap: ReadonlyMap<string, ProtocolViewSnapshot>, traceStates?: ReadonlyMap<string, string>): readonly TrajectoryRow[] {
  const rows: TrajectoryRow[] = []
  for (const [index, run] of [...runs].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)).entries()) {
    const turn = index + 1, base = { runId: run.id, turn }
    const initialization = new Set<string>()
    const events = eventsMap.get(run.id) ?? [], trace = runTrace(run, events)
    const readiness = toolContextReadiness(traceStates?.get(run.id), eventsMap.has(run.id))
    const candidate = viewsMap.get(run.id)
    const protocolId = run.protocolBinding?.protocolId ?? run.modelSnapshot?.protocolId
    const view = candidate?.viewSchemaVersion === 2 && candidate.runId === run.id && candidate.sessionId === run.sessionId &&
      (!protocolId || candidate.protocolId === protocolId) ? candidate : undefined
    const images = run.images?.length ?? 0, files = run.files?.length ?? 0
    const original = [run.input, images ? `${images} 张图片` : '', files ? `${files} 个文件` : ''].filter(Boolean).join('\n')
    const firstModel = trace.steps.find(step => step.kind === 'model' && !step.legacy)
    const firstExchange = firstModel && exchangeFor(view, firstModel.id)
    const native = events.length > 0 && run.history.kind !== 'legacy-unknown'
    const inputRows = (exchange: ProtocolViewExchange | undefined) => {
      for (const input of exchange?.inputs ?? []) {
        if (input.role === 'user') continue
        const key = JSON.stringify([run.sessionId, view?.protocolId, input.role, input.text])
        if (initialization.has(key)) continue
        initialization.add(key)
        rows.push({ ...base, id: `${run.id}:input:${exchange!.id}:${input.id}`, role: input.role,
          label: input.role === 'system' ? '系统提示词' : '上下文', input: input.text, output: '', state: 'recorded',
          ...(view?.status === 'provisional' ? { provisional: true } : {}) })
      }
    }
    if (native) inputRows(firstExchange)
    const actualInputs = native ? [...new Set(view?.exchanges.flatMap(exchange =>
      (exchange.inputs ?? []).filter(input => input.role === 'user' && input.text !== run.input).map(input => input.text)) ?? [])] : []
    rows.push({ ...base, id: `${run.id}:user`, role: 'user', label: '用户', input: [original,
      ...actualInputs.map(text => `实际模型输入\n${text}`)].filter(Boolean).join('\n\n'), preview: original, output: '', state: 'recorded',
      ...timing(run.createdAt, undefined) })
    let lastAssistant = -1
    if (native) for (const [stepIndex, step] of trace.steps.entries()) {
      if (step.kind === 'tool') {
        const started = startedTool(step, trace.steps, events), call = step.call
        rows.push({ ...base, id: toolRowId(run.id, step, trace.steps), role: 'tool',
          label: call.name === 'bash' ? 'Bash' : 'Apply Patch', input: call.name === 'bash' ? call.command : call.patch,
          output: started ? toolOutput(call) : '未开始执行', state: call.state, tool: call,
          ...(started ? { step, ...timing(call.startedAt, call.finishedAt) } : {}) })
        continue
      }
      if (step.kind === 'operation') {
        rows.push({ ...base, id: `${run.id}:operation:${step.eventIndex}:${step.id}`, role: 'status', label: '运行操作',
          input: '', output: step.category ? `失败类别：${step.category}` : '', state: step.state, step,
          ...timing(step.startedAt, step.finishedAt) })
        continue
      }
      // Retired events do not identify an exchange or its actual exit.
      if (step.legacy) continue
      const exchange = exchangeFor(view, step.id)
      inputRows(exchange)
      const blocks = exchange?.blocks ?? []
      const display = displayOutput(exchange)
      rows.push({ ...base, id: `${run.id}:model:${step.eventIndex}:${step.id}`, role: 'assistant',
        label: trace.modelName ?? '模型调用', input: '', output: [display.output, step.category ? `失败类别：${step.category}` : ''].filter(Boolean).join('\n\n'),
        preview: display.preview, state: step.state, step, ...timing(step.startedAt, step.finishedAt),
        ...(exchange && view ? { protocolView: exchangeProjection(view, exchange) } : {}),
        ...(view?.status === 'provisional' ? { provisional: true } : {}) })
      lastAssistant = rows.length - 1
      const nextModel = trace.steps.slice(stepIndex + 1).find(candidate => candidate.kind === 'model')?.eventIndex ?? events.length
      for (const block of blocks) {
        const request = localRequest(block)
        const call = request && requestedTool(request)
        if (!call || trace.steps.some(candidate => candidate.kind === 'tool' && candidate.eventIndex > step.eventIndex &&
          candidate.eventIndex < nextModel && candidate.call.id === call.id && candidate.call.name === call.name)) continue
        call.state = readiness === 'ready' ? unstartedState(run.status) : 'queued'
        const requestId = `${run.id}:tool:${step.eventIndex}:${call.name}:${call.id}`
        rows.push({ ...base, id: rows.some(row => row.id === requestId) ? `${requestId}:${block.id}` : requestId,
          role: 'tool', label: call.name === 'bash' ? 'Bash' : 'Apply Patch',
          input: call.name === 'bash' ? call.command : call.patch,
          output: readiness === 'failed' ? '执行结果读取失败' : readiness === 'loading' ? '正在读取执行结果' : '执行结果未记录',
          state: call.state, tool: call, requestOnly: true,
          ...(view?.status === 'provisional' ? { provisional: true } : {}) })
      }
    }
    const knownViewOutput = run.history.kind !== 'legacy-unknown' && !native ?
      view?.exchanges.map(exchange => displayOutput(exchange).output).filter(Boolean).join('\n\n') : undefined
    if ((run.output || knownViewOutput) && lastAssistant === -1) rows.push({ ...base, id: `${run.id}:output`, role: 'assistant',
      label: trace.modelName ?? '可用模型展示', input: '', output: run.output || knownViewOutput!, state: run.status,
      ...(knownViewOutput && view ? { protocolView: view } : {}),
      ...(view?.status === 'provisional' && !run.output ? { provisional: true } : {}) })
    else if (run.output && lastAssistant >= 0 && rows[lastAssistant]!.preview !== run.output) rows[lastAssistant] = { ...rows[lastAssistant]!,
      output: [rows[lastAssistant]!.output, `已保存最终回复\n${run.output}`].filter(Boolean).join('\n\n'), preview: run.output, savedOutput: run.output }
    const missing = trace.legacy || trace.steps.some(step => step.kind === 'model' && step.legacy)
      ? '旧版记录未保存完整执行步骤与耗时。'
      : run.status !== 'running' && run.status !== 'cancelling' && eventsMap.has(run.id) && !events.length ? '此记录未保存执行步骤。' : ''
    if (run.error || run.errorCategory || lastAssistant === -1 || missing) rows.push({ ...base, id: `${run.id}:status`, role: 'status', label: '运行状态', input: '',
      output: [missing, run.error ?? '', run.errorCategory ? `失败类别：${run.errorCategory}` : ''].filter(Boolean).join('\n'), state: run.status })
    for (const exchange of native ? view?.exchanges.filter(exchange => exchange.id === 'display-limit' || exchange.id.endsWith(':display-limit')) ?? [] : []) {
      rows.push({ ...base, id: `${run.id}:display-limit`, role: 'status', label: '展示范围', input: '',
        output: exchange.blocks.flatMap(block => block.type === 'harness.display_limit' ? [block.text] : []).join('\n'), state: 'recorded' })
    }
  }
  return rows
}

/** Search full loaded display strings, including text omitted by one-line summaries. */
export function filterTrajectory(rows: readonly TrajectoryRow[], query: string): readonly TrajectoryRow[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return rows
  return rows.filter(row => {
    const text = [row.label, row.role, row.input, row.output, row.preview ?? '', row.state,
      row.tool ? toolOutput(row.tool) : ''].join('\n').toLocaleLowerCase()
    return terms.every(term => text.includes(term))
  })
}
function lane(row: TrajectoryRow): 0 | 1 | 2 {
  return row.role === 'tool' ? 2 : row.role === 'assistant' ? 1 : 0
}
/** Remove only uncovered wall-clock gaps, retaining real overlap across all lanes. */
export function trajectoryTimeline(rows: readonly TrajectoryRow[], mode: TrajectoryTimelineMode = 'sequence'): TrajectoryTimeline {
  const eligible = rows.filter(row => row.state !== 'queued' && !(row.role === 'status' && !row.step) &&
    !(row.role === 'tool' && !row.step && !row.startedAt))
  const timed = eligible.flatMap(row => {
    const duration = traceElapsed(row.startedAt, row.finishedAt)
    return duration === undefined ? [] : [{ row, start: Date.parse(row.startedAt!), end: Date.parse(row.finishedAt!) }]
  })
  if (mode === 'sequence') return { mode, hasTiming: timed.length > 0,
    spans: eligible.map((row, index) => ({ id: row.id, rowId: row.id, lane: lane(row),
      left: index / eligible.length, width: 1 / eligible.length, state: row.state })) }
  if (!timed.length) return { mode, spans: [], hasTiming: false }
  const offsets = new Map<string, number>()
  let removed = 0, covered: number | undefined
  for (const item of [...timed].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (covered !== undefined && item.start > covered) removed += item.start - covered
    offsets.set(item.row.id, removed)
    covered = covered === undefined ? item.end : Math.max(covered, item.end)
  }
  const start = Math.min(...timed.map(item => item.start - offsets.get(item.row.id)!))
  const end = Math.max(...timed.map(item => item.end - offsets.get(item.row.id)!)), duration = end - start
  return { mode, hasTiming: true, spans: timed.map(item => ({ id: item.row.id, rowId: item.row.id,
    lane: lane(item.row), left: duration ? (item.start - offsets.get(item.row.id)! - start) / duration : 0,
    width: duration ? (item.end - item.start) / duration : 0, state: item.row.state })) }
}
