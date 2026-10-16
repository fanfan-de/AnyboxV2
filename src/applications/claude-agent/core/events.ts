import type { ApprovalView, LiveBlockView, LiveItemView, RunEventView, RunLiveView, TranscriptBlockView } from './view.js'

/** Display bounds. The agent's own transcript keeps the complete text; the live view is a bounded projection. */
export const liveViewLimits = Object.freeze({ blockText: 64 * 1024, items: 400, notices: 50, approvals: 200 })

export function emptyRunView(runId: string, threadId: string): RunLiveView {
  return Object.freeze({ schemaVersion: 1, runId, threadId, seq: 0, init: null, items: [], approvals: [], notices: [], modelStatus: null, result: null, error: null })
}
export function boundedText(text: string, limit = liveViewLimits.blockText): { text: string; truncated: boolean } {
  return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false }
}
/** Bounded JSON for display; an oversized value keeps only a prefix of its serialization. */
export function boundedJson(value: unknown, limit: number): { input: unknown; truncated: boolean } {
  const serialized = JSON.stringify(value ?? null) ?? 'null'
  return serialized.length > limit ? { input: { preview: serialized.slice(0, limit) }, truncated: true } : { input: value ?? null, truncated: false }
}
const appendText = (block: TranscriptBlockView, text: string): TranscriptBlockView => {
  if (block.kind !== 'text' && block.kind !== 'thinking') return block
  if (block.truncated) return block
  const next = boundedText(block.text + text)
  return { ...block, text: next.text, truncated: next.truncated }
}
const replaceBlock = (item: LiveItemView, index: number, block: LiveBlockView): LiveItemView => {
  const blocks = [...item.blocks]
  blocks[index] = block
  return { ...item, blocks }
}
const withItem = (view: RunLiveView, id: string, role: LiveItemView['role'], update: (item: LiveItemView) => LiveItemView): RunLiveView => {
  const index = view.items.findIndex(item => item.id === id)
  const items = [...view.items]
  if (index < 0) {
    items.push(update({ id, role, blocks: [] }))
    while (items.length > liveViewLimits.items) items.shift()
  } else items[index] = update(items[index])
  return { ...view, items }
}
/** One completed block from the agent replaces the oldest matching streamed block that has not been finalized; otherwise it is appended. */
const finalizeBlock = (item: LiveItemView, block: TranscriptBlockView): LiveItemView => {
  const final: LiveBlockView = { block, state: 'final' }
  let match = -1
  if (block.kind === 'tool_use') match = item.blocks.findIndex(entry => entry.block.kind === 'tool_use' && entry.block.toolUseId === block.toolUseId && entry.state !== 'final')
  else {
    match = item.blocks.findIndex(entry => entry.block.kind === block.kind && entry.state === 'closed')
    if (match < 0) match = item.blocks.findIndex(entry => entry.block.kind === block.kind && entry.state === 'streaming')
  }
  return match >= 0 ? replaceBlock(item, match, final) : { ...item, blocks: [...item.blocks, final] }
}
/** Pure fold. Unknown or out-of-order fragments are ignored rather than fabricated. */
export function applyRunEvent(view: RunLiveView, event: RunEventView): RunLiveView {
  return { ...step(view, event), seq: view.seq + 1 }
}
function step(view: RunLiveView, event: RunEventView): RunLiveView {
  switch (event.type) {
    case 'init': return { ...view, init: event.init }
    case 'message-start': return withItem(view, event.messageId, 'assistant', item => item)
    case 'block-start': return withItem(view, event.messageId, 'assistant', item => {
      const block: TranscriptBlockView = event.block === 'tool_use'
        ? { kind: 'tool_use', toolUseId: event.toolUseId ?? '', name: event.name ?? '', input: null, inputTruncated: false }
        : { kind: event.block, text: '', truncated: false }
      return replaceBlock(item, event.index, { block, state: 'streaming' })
    })
    case 'text-delta':
    case 'thinking-delta': return withItem(view, event.messageId, 'assistant', item => {
      const entry = item.blocks[event.index]
      if (!entry || entry.state !== 'streaming') return item
      return replaceBlock(item, event.index, { ...entry, block: appendText(entry.block, event.text) })
    })
    case 'block-stop': return withItem(view, event.messageId, 'assistant', item => {
      const entry = item.blocks[event.index]
      return entry && entry.state === 'streaming' ? replaceBlock(item, event.index, { ...entry, state: 'closed' }) : item
    })
    case 'assistant': return withItem(view, event.messageId, 'assistant', item => event.blocks.reduce(finalizeBlock, item))
    case 'tool-result': return withItem(view, `result:${event.toolUseId}`, 'user', item => ({ ...item, blocks: [{ state: 'final',
      block: { kind: 'tool_result', toolUseId: event.toolUseId, text: event.text, isError: event.isError, truncated: event.truncated } }] }))
    case 'approval-requested': {
      const approvals = [...view.approvals.filter(approval => approval.id !== event.approval.id), event.approval]
      while (approvals.length > liveViewLimits.approvals) approvals.shift()
      return { ...view, approvals }
    }
    case 'approval-resolved': return { ...view, approvals: view.approvals.map((approval): ApprovalView => approval.id === event.approval.id ? event.approval : approval) }
    case 'status': return { ...view, modelStatus: event.status }
    case 'compact': return pushNotice(view, { code: 'compacted', message: `Context compacted (${event.trigger}, ${event.preTokens} tokens before).` })
    case 'notice': return pushNotice(view, event.notice)
    case 'result': return { ...view, result: event.result, modelStatus: null }
    case 'error': return { ...view, error: event.error }
    case 'exit': return view
  }
}
const pushNotice = (view: RunLiveView, notice: RunLiveView['notices'][number]): RunLiveView => {
  const notices = [...view.notices, notice]
  while (notices.length > liveViewLimits.notices) notices.shift()
  return { ...view, notices }
}
