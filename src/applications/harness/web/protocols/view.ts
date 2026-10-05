import type { ProtocolViewBlock, ProtocolViewExchange, ProtocolViewSnapshot } from '../../core/view/types.js'
import type { ProtocolToolContext, ToolSummary } from '../tool-call-view.js'
import { createDisclosureChevron } from './primitives.js'
export { safeSourceUrl, decodeProtocolView, reduceProtocolView } from '../../core/view/decode.js'

export type ProtocolPresentation = 'compact' | 'detail'
export interface ProtocolTurnOptions {
  readonly toolContext?: ProtocolToolContext
  readonly presentation?: ProtocolPresentation
}
export interface NativeBlockContext extends ProtocolTurnOptions {
  readonly presentation: ProtocolPresentation
  readonly sessionId?: string
  readonly runId: string
  readonly exchange: ProtocolViewExchange
  readonly snapshotStatus: ProtocolViewSnapshot['status']
  readonly toolOccurrence: number
}
export interface MountedNativeBlock {
  readonly element: HTMLElement
  /** The owning renderer identifies local requests and supplies only display facts. */
  readonly localTool?: { summary(): ToolSummary; isExpanded(): boolean }
  update(block: ProtocolViewBlock, context: NativeBlockContext): void
  dispose(): void
}
export interface MountedProtocolTurn {
  readonly element: HTMLElement
  update(snapshot: ProtocolViewSnapshot, options?: ProtocolTurnOptions): void
  dispose(): void
}

interface LocalToolBlock extends MountedNativeBlock {
  readonly localTool: NonNullable<MountedNativeBlock['localTool']>
}
interface MountedToolGroup {
  readonly element: HTMLElement
  update(tools: readonly LocalToolBlock[]): void
  prune(): void
  dispose(): void
}

function containsElement(element: HTMLElement, descendant: Element | null): boolean {
  for (let current = descendant; current; current = current.parentElement) if (current === element) return true
  return false
}

function hasFocus(element: HTMLElement): boolean { return containsElement(element, document.activeElement) }

function reconcileChildren(container: HTMLElement, nodes: readonly HTMLElement[], prune = true): void {
  let cursor: ChildNode | null = container.firstChild
  for (const node of nodes) {
    if (node === cursor) cursor = cursor.nextSibling
    else container.insertBefore(node, cursor)
  }
  if (prune) while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next }
}

/** A group counts public presentation facts without interpreting native protocol content. */
function groupSummary(summaries: readonly ToolSummary[]): ToolSummary {
  const busy = summaries.filter(summary => summary.busy).length
  const awaiting = summaries.filter(summary => summary.awaitingFacts).length
  const success = summaries.filter(summary => summary.success).length
  const danger = summaries.filter(summary => summary.attention && summary.tone === 'danger').length
  const warning = summaries.filter(summary => summary.attention && summary.tone !== 'danger').length
  const current = summaries.find(summary => summary.busy) ?? summaries.find(summary => summary.awaitingFacts) ?? summaries.at(-1)
  const issue = summaries.find(summary => summary.attention && summary.shortReason)
  const reason = issue ? [issue.title, issue.preview, issue.shortReason].filter(Boolean).join(' · ') : undefined
  const allSuccess = success === summaries.length
  return {
    title: `${summaries.length} 个工具`,
    preview: current ? [current.title, current.preview].filter(Boolean).join(' · ') : '',
    statusLabel: allSuccess ? '已完成' : [busy ? `${busy} 个执行中` : '', awaiting ? `${awaiting} 个待同步` : '',
      danger + warning ? `${danger + warning} 项需关注` : ''].filter(Boolean).join(' · ') || '已记录',
    busy: busy > 0, awaitingFacts: awaiting > 0, success: allSuccess,
    attention: danger + warning > 0, tone: danger ? 'danger' : warning ? 'warning' : 'neutral',
    ...(reason ? { shortReason: reason } : {}),
  }
}

let toolGroupId = 0
/** The shell exists for a singleton, so growth never reparents its focused tool. */
function mountToolGroup(key: string): MountedToolGroup {
  const element = document.createElement('section'), toggle = document.createElement('button')
  const chevron = createDisclosureChevron(), title = document.createElement('span')
  const preview = document.createElement('span'), state = document.createElement('span')
  const reason = document.createElement('p'), body = document.createElement('div')
  element.className = 'native-tool-group'; element.dataset.toolGroupId = key
  toggle.type = 'button'; toggle.className = 'native-disclosure-toggle native-tool-summary native-tool-group-toggle'; toggle.dataset.toolGroupId = key
  title.className = 'native-tool-title'; preview.className = 'native-tool-preview'; state.className = 'native-tool-state'
  reason.className = 'native-tool-reason native-tool-group-reason'; body.className = 'native-tool-group-body'
  body.id = `agent--tool-group-details-${++toolGroupId}`; body.setAttribute('role', 'region')
  toggle.setAttribute('aria-controls', body.id)
  toggle.append(chevron, title, preview, state); element.append(toggle, reason, body)
  const listeners = new AbortController()
  let count = 0, expanded = true, explicitExpanded: boolean | undefined
  let members: readonly HTMLElement[] = []
  const applyExpansion = (): void => {
    const multiple = count > 1
    toggle.hidden = !multiple; toggle.inert = !multiple
    if (multiple && !expanded && hasFocus(body)) toggle.focus({ preventScroll: true })
    body.hidden = multiple && !expanded; body.inert = body.hidden
    toggle.setAttribute('aria-expanded', String(!body.hidden))
    element.dataset.singleton = String(!multiple)
  }
  toggle.addEventListener('click', () => {
    if (count < 2) return
    expanded = !expanded; explicitExpanded = expanded; applyExpansion()
  }, { signal: listeners.signal })
  return {
    element,
    update(tools) {
      const previousCount = count
      count = tools.length
      if (count < 2) expanded = true
      else if (previousCount < 2) expanded = tools.some(tool => tool.localTool.isExpanded() || hasFocus(tool.element)) || (explicitExpanded ?? false)
      const summary = groupSummary(tools.map(tool => tool.localTool.summary()))
      title.textContent = summary.title; preview.textContent = summary.preview; state.textContent = summary.statusLabel
      preview.title = summary.preview
      const label = [summary.title, summary.preview, summary.statusLabel, summary.shortReason].filter(Boolean).join(' · ')
      toggle.title = label; toggle.setAttribute('aria-label', label); body.setAttribute('aria-label', `${summary.title}详情`)
      element.dataset.tone = summary.tone; toggle.dataset.tone = summary.tone
      reason.textContent = summary.shortReason ?? ''; reason.title = summary.shortReason ?? ''; reason.hidden = count < 2 || !summary.shortReason
      applyExpansion()
      members = tools.map(tool => tool.element)
      // A retained tool may move to a later group after a separator arrives.
      reconcileChildren(body, members, false)
    },
    prune() { reconcileChildren(body, members) },
    dispose() { listeners.abort(); element.remove() },
  }
}

/** Shared ownership and ordering; each protocol supplies its own content factories. */
export function mountProtocolTurn(initial: ProtocolViewSnapshot, binding: {
  readonly name: string
  reduce(current: ProtocolViewSnapshot | undefined, next: ProtocolViewSnapshot): ProtocolViewSnapshot | undefined
  mountBlock(block: ProtocolViewBlock, context: NativeBlockContext): MountedNativeBlock
  stateText(exchange: ProtocolViewExchange, presentation?: ProtocolPresentation): string
}, initialOptions: ProtocolTurnOptions = {}): MountedProtocolTurn {
  const element = document.createElement('article'), heading = document.createElement('p')
  element.className = 'protocol-turn'; element.dataset.runId = initial.runId; element.dataset.protocol = initial.protocolId
  heading.className = 'streaming-label'; element.append(heading)
  const mounted = new Map<string, { type: string; view: MountedNativeBlock }>()
  const states = new Map<string, HTMLElement>()
  const containers = new Map<string, HTMLElement>()
  const groups = new Map<string, MountedToolGroup>()
  let model: ProtocolViewSnapshot | undefined, disposed = false
  const update = (next: ProtocolViewSnapshot, options: ProtocolTurnOptions = {}) => {
    if (disposed) return
    const reduced = binding.reduce(model, next)
    if (!reduced) return
    const focused = hasFocus(element) ? document.activeElement as HTMLElement : undefined
    model = reduced
    const presentation = options.presentation ?? initialOptions.presentation ?? 'detail'
    heading.textContent = `${binding.name}${model.status === 'provisional' ? ' · 临时输出' : ''}`
    const retained = new Set<string>(), stateIds = new Set<string>(), groupIds = new Set<string>(), ordered: HTMLElement[] = []
    for (const exchange of model.exchanges) {
      let container = containers.get(exchange.id)
      if (!container) { container = document.createElement('section'); container.className = 'native-exchange'; container.dataset.exchangeId = exchange.id; containers.set(exchange.id, container) }
      const children: HTMLElement[] = []
      const occurrences = new Map<string, number>()
      const exchangeGroups: MountedToolGroup[] = []
      let pendingGroup: { key: string; tools: LocalToolBlock[] } | undefined
      const appendGroup = (): void => {
        if (!pendingGroup) return
        groupIds.add(pendingGroup.key)
        let group = groups.get(pendingGroup.key)
        if (!group) { group = mountToolGroup(pendingGroup.key); groups.set(pendingGroup.key, group) }
        group.update(pendingGroup.tools); exchangeGroups.push(group); children.push(group.element); pendingGroup = undefined
      }
      for (const block of exchange.blocks) {
        const requestKey = 'requestId' in block && 'name' in block ? JSON.stringify([block.requestId, block.name]) : undefined
        const toolOccurrence = requestKey ? occurrences.get(requestKey) ?? 0 : 0
        if (requestKey) occurrences.set(requestKey, toolOccurrence + 1)
        const context: NativeBlockContext = { exchange, presentation, sessionId: model.sessionId, runId: model.runId, snapshotStatus: model.status, toolOccurrence,
          ...(options.toolContext?.runId === model.runId ? { toolContext: options.toolContext } : {}) }
        const key = JSON.stringify([exchange.id, block.id])
        retained.add(key)
        let entry = mounted.get(key)
        if (!entry || entry.type !== block.type) {
          entry?.view.dispose()
          entry = { type: block.type, view: binding.mountBlock(block, context) }; mounted.set(key, entry)
          entry.view.element.dataset.exchangeId = exchange.id; entry.view.element.dataset.blockId = block.id
        }
        entry.view.update(block, context)
        if (presentation === 'compact' && entry.view.localTool) {
          pendingGroup ??= { key, tools: [] }
          pendingGroup.tools.push(entry.view as LocalToolBlock)
        } else { appendGroup(); children.push(entry.view.element) }
      }
      appendGroup()
      for (const group of exchangeGroups) group.prune()
      const label = binding.stateText(exchange, presentation)
      if (label) {
        stateIds.add(exchange.id)
        let state = states.get(exchange.id)
        if (!state) { state = document.createElement('p'); state.className = 'native-exchange-state'; state.dataset.exchangeId = exchange.id; states.set(exchange.id, state) }
        state.textContent = label; children.push(state)
      }
      reconcileChildren(container, children)
      ordered.push(container)
    }
    let cursor: ChildNode | null = heading.nextSibling
    for (const node of ordered) {
      if (node === cursor) cursor = cursor.nextSibling
      else element.insertBefore(node, cursor)
    }
    while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next }
    for (const [key, entry] of mounted) if (!retained.has(key)) { entry.view.dispose(); mounted.delete(key) }
    for (const [key, group] of groups) if (!groupIds.has(key)) { group.dispose(); groups.delete(key) }
    for (const [id, state] of states) if (!stateIds.has(id)) { state.remove(); states.delete(id) }
    const exchangeIds = new Set(model.exchanges.map(exchange => exchange.id))
    for (const [id, container] of containers) if (!exchangeIds.has(id)) { container.remove(); containers.delete(id) }
    // Moving a retained mount between shells can blur it in the browser.
    if (focused && containsElement(element, focused)) {
      let visible = true
      for (let ancestor: HTMLElement | null = focused; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor.hidden || ancestor.inert) { visible = false; break }
      }
      if (visible) focused.focus({ preventScroll: true })
    }
  }
  update(initial, initialOptions)
  return { element, update, dispose() {
    if (disposed) return
    disposed = true
    for (const { view } of mounted.values()) view.dispose()
    for (const group of groups.values()) group.dispose()
    mounted.clear(); groups.clear(); states.clear(); containers.clear(); element.remove()
  } }
}
