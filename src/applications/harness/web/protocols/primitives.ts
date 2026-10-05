import type { ProtocolCitation, ProtocolViewBlock, ProtocolNativeState } from '../../core/view/types.js'
import { safeSourceUrl } from '../../core/view/decode.js'
import { renderMarkdown } from '../markdown.js'
import { findProtocolToolFact, summarizeToolRequest, parseToolArguments, mountToolCallDetails, createToolCopyButton,
  type ToolRequestView, type ToolSummary, type MountedToolCallDetails } from '../tool-call-view.js'
import { formatTraceDuration } from '../run-trace.js'
import type { NativeBlockContext, MountedNativeBlock } from './view.js'

export interface TextPart { readonly id: string; readonly text: string; readonly citations?: readonly ProtocolCitation[] }
export interface TextMount { readonly element: HTMLElement; update(part: TextPart): void; dispose(): void }
export function mountText(initial: TextPart): TextMount {
  const element = document.createElement('div'); element.className = 'native-text'
  let content = ''
  const update = (part: TextPart) => {
    const value = JSON.stringify([part.text, part.citations])
    if (value === content) return
    content = value
    element.replaceChildren(renderMarkdown(part.text, part.citations))
    if (part.citations?.length) {
      const sources = document.createElement('ol'); sources.className = 'native-sources'; sources.setAttribute('aria-label', '引用来源')
      for (const citation of part.citations) {
        const url = safeSourceUrl(citation.url)
        if (!url) continue
        const item = document.createElement('li'), link = document.createElement('a')
        link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'
        link.textContent = citation.title || new URL(url).hostname; link.title = part.text.slice(citation.start, citation.end)
        item.append(link); sources.append(item)
      }
      element.append(sources)
    }
  }
  update(initial)
  return { element, update, dispose() { element.remove() } }
}

export function mountParts(container: HTMLElement) {
  const mounted = new Map<string, TextMount>()
  return {
    update(parts: readonly TextPart[]) {
      const retained = new Set<string>(); let cursor: ChildNode | null = container.firstChild
      for (const part of parts) {
        retained.add(part.id)
        let view = mounted.get(part.id)
        if (!view) { view = mountText(part); view.element.dataset.partId = part.id; mounted.set(part.id, view) }
        else view.update(part)
        if (view.element === cursor) cursor = cursor.nextSibling
        else container.insertBefore(view.element, cursor)
      }
      while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next }
      for (const [id, view] of mounted) if (!retained.has(id)) { view.dispose(); mounted.delete(id) }
    },
    dispose() { for (const view of mounted.values()) view.dispose(); mounted.clear() },
  }
}

export function nativeElement(type: string, className = ''): HTMLElement {
  const element = document.createElement('section')
  element.className = `protocol-block native-${type.replace(/[._]/g, '-')} ${className}`.trim()
  element.dataset.nativeType = type
  return element
}

function generationLabel(state: ProtocolNativeState | undefined, status: NativeBlockContext['snapshotStatus']): string {
  if (state?.diagnostic) return state.partial ? '部分记录' : '诊断记录'
  const returned = state?.type === 'responses.state' ? ['completed', 'incomplete', 'failed', 'cancelled', 'error'].includes(state.status ?? '') :
    state?.type === 'anthropic.state' ? Boolean(state.stopReason) : state?.type === 'chat.state' ? Boolean(state.finishReason) :
    state?.type === 'gemini.state' && ['completed', 'requires_action', 'incomplete', 'budget_exceeded', 'failed', 'cancelled'].includes(state.status ?? '')
  return returned ? '已返回' : status === 'provisional' ? '生成中' : '已记录'
}

export function createDisclosureChevron(): HTMLImageElement {
  const chevron = document.createElement('img')
  chevron.src = '/apps/agent/icons/chevron-right.svg'; chevron.alt = ''; chevron.setAttribute('aria-hidden', 'true')
  chevron.className = 'native-disclosure-chevron'
  return chevron
}

/** Only the folding mechanism is shared. The caller owns the native meaning and text. */
export function mountReasoning(type: string, title: string, parts: readonly TextPart[], context: NativeBlockContext) {
  const element = nativeElement(type, 'native-reasoning'), toggle = document.createElement('button')
  const label = document.createElement('span'), state = document.createElement('span'), body = document.createElement('div')
  toggle.type = 'button'; toggle.className = 'native-disclosure-toggle native-reasoning-toggle'; toggle.setAttribute('aria-expanded', 'false')
  label.className = 'native-reasoning-title'; label.textContent = title; state.className = 'native-content-state'
  toggle.append(createDisclosureChevron(), label, state)
  body.className = 'native-reasoning-body'; body.hidden = true; body.inert = true
  element.append(toggle, body)
  const children = mountParts(body), listeners = new AbortController()
  toggle.addEventListener('click', () => {
    body.hidden = !body.hidden; body.inert = body.hidden; toggle.setAttribute('aria-expanded', String(!body.hidden))
  }, { signal: listeners.signal })
  const update = (next: readonly TextPart[], ctx: NativeBlockContext) => {
    state.textContent = ' · ' + generationLabel(ctx.exchange.nativeState, ctx.snapshotStatus)
    children.update(next)
  }
  update(parts, context)
  return { element, update, dispose() { listeners.abort(); children.dispose(); element.remove() } }
}

export type FunctionRequest = ToolRequestView

let disclosureId = 0
/** Stable disclosure UI. Protocol adapters own the meaning of its summary. */
export function mountToolDisclosure(type: string, initial: ToolSummary, context: NativeBlockContext, className = '') {
  const element = nativeElement(type, className), toggle = document.createElement('button'), body = document.createElement('div')
  const chevron = createDisclosureChevron(), title = document.createElement('span'), preview = document.createElement('span')
  const state = document.createElement('span'), duration = document.createElement('span'), reason = document.createElement('p')
  toggle.type = 'button'; toggle.className = 'native-disclosure-toggle native-tool-summary'; toggle.dataset.toolDisclosure = String(++disclosureId)
  title.className = 'native-tool-title'; preview.className = 'native-tool-preview'; state.className = 'native-tool-state'; duration.className = 'native-tool-duration'
  reason.className = 'native-tool-reason'; body.className = 'native-tool-details'; body.id = `agent--tool-details-${disclosureId}`
  body.tabIndex = 0; body.setAttribute('role', 'region'); toggle.setAttribute('aria-controls', body.id)
  toggle.append(chevron, title, preview, state, duration); element.append(toggle, reason, body)
  let expanded = false, compact = context.presentation === 'compact', disposed = false
  const listeners = new AbortController()
  const applyFold = () => {
    body.hidden = compact && !expanded; body.inert = body.hidden
    toggle.setAttribute('aria-expanded', String(expanded))
  }
  toggle.addEventListener('click', () => {
    if (disposed || !compact) return
    if (expanded && body.contains(document.activeElement)) toggle.focus({ preventScroll: true })
    expanded = !expanded; applyFold()
  }, { signal: listeners.signal })
  const update = (summary: ToolSummary, ctx: NativeBlockContext) => {
    if (disposed) return
    compact = ctx.presentation === 'compact'
    element.classList.toggle('native-tool-compact', compact); toggle.hidden = !compact
    element.dataset.tone = summary.tone; toggle.dataset.tone = summary.tone
    title.textContent = summary.title; preview.textContent = summary.preview; preview.title = summary.preview
    state.textContent = summary.statusLabel; duration.textContent = summary.elapsedMs === undefined ? '' : formatTraceDuration(summary.elapsedMs)
    duration.hidden = summary.elapsedMs === undefined
    reason.textContent = summary.shortReason ?? ''; reason.title = summary.shortReason ?? ''; reason.hidden = !compact || !summary.shortReason
    body.setAttribute('aria-label', `${summary.title}详情`)
    toggle.setAttribute('aria-label', `${summary.title} · ${summary.preview} · ${summary.statusLabel}`)
    applyFold()
  }
  update(initial, context)
  return { element, body, update, isExpanded: () => expanded, dispose() { if (disposed) return; disposed = true; listeners.abort(); element.remove() } }
}

export function mountFunctionRequest(type: string, initial: FunctionRequest, context: NativeBlockContext) {
  let summary = summarizeToolRequest(initial)
  const disclosure = mountToolDisclosure(type, summary, context, 'native-function-request')
  const { element, body } = disclosure, heading = document.createElement('strong'), request = document.createElement('code')
  const requestField = document.createElement('div'), requestBar = document.createElement('div'), requestLabel = document.createElement('span')
  const outcome = document.createElement('div'), note = document.createElement('p')
  const raw = document.createElement('details'), rawLabel = document.createElement('summary'), args = document.createElement('pre')
  const argsSource = document.createElement('small'); argsSource.className = 'trace-empty'
  const listeners = new AbortController()
  let requestedValue = ''
  heading.className = 'native-function-heading'; request.className = 'native-request-input'
  requestField.className = 'tool-detail-field'; requestBar.className = 'tool-detail-toolbar'; requestLabel.className = 'tool-output-label'
  outcome.className = 'native-tool-observation'; note.className = 'native-tool-pending'
  raw.className = 'native-tool-raw'; rawLabel.textContent = '原始参数'; args.className = 'native-tool-arguments'
  const rawCopy = createToolCopyButton('原始参数', 'arguments', () => args.textContent ?? '', listeners.signal)
  const requestCopy = createToolCopyButton('请求内容', 'request', () => requestedValue, listeners.signal)
  requestBar.append(requestLabel, requestCopy); requestField.append(requestBar, request)
  raw.append(rawLabel, argsSource, args, rawCopy)
  body.append(heading, requestField, note, outcome, raw)
  let details: MountedToolCallDetails | undefined, outcomeKey = '', disposed = false
  const update = (value: FunctionRequest, ctx: NativeBlockContext) => {
    if (disposed) return
    heading.textContent = `工具请求 · ${value.name}`
    heading.hidden = ctx.presentation === 'compact'
    const fact = value.requestId ? findProtocolToolFact(ctx.toolContext, ctx.exchange.id, value.requestId, value.name, ctx.toolOccurrence) : undefined
    const parsed = parseToolArguments(value.arguments)
    const useExecutionArguments = !parsed && fact && fact.name !== 'bash' && fact.name !== 'apply_patch'
    const displayedArguments = useExecutionArguments ? JSON.stringify(fact.arguments, null, 2) : value.arguments
    argsSource.hidden = !useExecutionArguments
    argsSource.textContent = useExecutionArguments ? '模型请求的参数展示不完整，以下参数来自执行记录。' : ''
    if (args.textContent !== displayedArguments) {
      args.textContent = displayedArguments; rawCopy.textContent = '复制'; rawCopy.title = ''; requestCopy.textContent = '复制'; requestCopy.title = ''
    }
    summary = summarizeToolRequest(value, fact, ctx.toolContext?.readiness, ctx.toolContext?.runStatus)
    disclosure.update(summary, ctx)
    requestedValue = value.name === 'bash' && typeof parsed?.command === 'string' ? parsed.command :
      value.name === 'apply_patch' && typeof parsed?.patch === 'string' ? parsed.patch :
        typeof parsed?.cmd === 'string' ? parsed.cmd : typeof parsed?.command === 'string' ? parsed.command :
          typeof parsed?.file_path === 'string' ? parsed.file_path : typeof parsed?.path === 'string' ? parsed.path : ''
    const requested = value.name === 'bash' && requestedValue ? `$ ${requestedValue}` : requestedValue
    if (request.textContent !== requested) request.textContent = requested
    const hideRequest = Boolean(fact) || !requested
    if ((hideRequest && requestField.contains(document.activeElement)) || (!fact && outcome.contains(document.activeElement))) body.focus({ preventScroll: true })
    requestField.hidden = hideRequest; requestField.inert = hideRequest
    requestLabel.textContent = value.name === 'bash' || typeof parsed?.cmd === 'string' || typeof parsed?.command === 'string' ? '命令请求' :
      value.name === 'apply_patch' ? '补丁请求' : '请求内容'
    note.hidden = Boolean(fact); note.textContent = fact ? '' : summary.statusLabel
    outcome.hidden = !fact; outcome.inert = !fact
    const nextKey = JSON.stringify(fact)
    if (nextKey !== outcomeKey) {
      outcomeKey = nextKey ?? ''
      if (fact) {
        if (!details) { details = mountToolCallDetails(fact, ctx.sessionId, { showArguments: false }); outcome.append(details.element) }
        else details.update(fact)
      }
    }
  }
  update(initial, context)
  return { element, update, localTool: { summary: () => summary, isExpanded: disclosure.isExpanded },
    dispose() { if (disposed) return; disposed = true; listeners.abort(); details?.dispose(); disclosure.dispose() } }
}

export function mountNotice(type: string, text: string) {
  const element = nativeElement(type, 'native-notice')
  const update = (next: string) => { element.textContent = next }
  update(text)
  return { element, update, dispose() { element.remove() } }
}

export function asNativeBlock<T extends ProtocolViewBlock>(view: {
  readonly element: HTMLElement; readonly localTool?: MountedNativeBlock['localTool']; update(value: T, context: NativeBlockContext): void; dispose(): void
}): MountedNativeBlock { return { element: view.element, ...(view.localTool ? { localTool: view.localTool } : {}),
  update: (value, context) => view.update(value as T, context), dispose: () => view.dispose() } }

export function mountHarnessBlock(block: ProtocolViewBlock): MountedNativeBlock | undefined {
  if (block.type !== 'harness.display_limit' && block.type !== 'harness.unsupported') return undefined
  const notice = mountNotice(block.type, block.text)
  return asNativeBlock<typeof block>({ ...notice, update: value => notice.update(value.text) })
}
