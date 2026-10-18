import type { AnthropicViewBlock, NativeToolRequest, ProtocolViewBlock, ProtocolViewExchange } from '../../core/view/types.js'
import type { MountedNativeBlock, NativeBlockContext } from './view.js'
import { parseToolArguments, type ToolSummary } from '../tool-call-view.js'
import { asNativeBlock, nativeElement, mountText, mountReasoning, mountFunctionRequest, mountNotice, mountHarnessBlock, mountToolDisclosure } from './primitives.js'

export function mountAnthropicText(initial: Extract<AnthropicViewBlock, { type: 'anthropic.text' }>): MountedNativeBlock {
  const element = nativeElement(initial.type), text = mountText(initial); element.append(text.element)
  return asNativeBlock<typeof initial>({ element, update: value => text.update(value), dispose() { text.dispose(); element.remove() } })
}
export function mountAnthropicThinking(initial: Extract<AnthropicViewBlock, { type: 'anthropic.thinking' }>, context: NativeBlockContext): MountedNativeBlock {
  const view = mountReasoning(initial.type, '思考内容', [initial], context)
  return asNativeBlock<typeof initial>({ ...view, update: (value, ctx) => view.update([value], ctx) })
}
export function mountAnthropicRedactedThinking(initial: Extract<AnthropicViewBlock, { type: 'anthropic.redacted_thinking' }>): MountedNativeBlock {
  const view = mountNotice(initial.type, '思考内容未公开')
  return asNativeBlock<typeof initial>({ ...view, update() {} })
}
export function mountAnthropicToolUse(initial: Extract<AnthropicViewBlock, NativeToolRequest>, context: NativeBlockContext): MountedNativeBlock {
  return asNativeBlock<typeof initial>(mountFunctionRequest('anthropic.tool_use', initial, context))
}
function serverToolSummary(value: Extract<AnthropicViewBlock, NativeToolRequest>, context: NativeBlockContext): ToolSummary {
  const args = parseToolArguments(value.arguments), query = typeof args?.query === 'string' ? args.query : ''
  const state = context.exchange.nativeState
  const busy = context.snapshotStatus === 'provisional' && !(state?.type === 'anthropic.state' && state.stopReason)
  return { title: '服务端工具请求', preview: [value.name, query].filter(Boolean).join(' · '), statusLabel: busy ? '生成中' : '请求已记录',
    busy, attention: false, awaitingFacts: false, success: false, tone: 'neutral' }
}
export function mountAnthropicServerToolUse(initial: Extract<AnthropicViewBlock, NativeToolRequest>, context: NativeBlockContext): MountedNativeBlock {
  const disclosure = mountToolDisclosure('anthropic.server_tool_use', serverToolSummary(initial, context), context, 'native-server-tool')
  const label = document.createElement('strong'), args = document.createElement('pre')
  disclosure.body.append(label, args)
  const update = (value: typeof initial, ctx: NativeBlockContext) => {
    disclosure.update(serverToolSummary(value, ctx), ctx)
    label.textContent = `服务端工具请求 · ${value.name}`; if (args.textContent !== value.arguments) args.textContent = value.arguments
  }
  update(initial, context); return asNativeBlock<typeof initial>({ element: disclosure.element, update, dispose() { disclosure.dispose() } })
}
function webSearchResultSummary(value: Extract<AnthropicViewBlock, { type: 'anthropic.web_search_tool_result' }>): ToolSummary {
  const failed = value.status === 'failed'
  return { title: '网页搜索结果', preview: `${value.sources.length} 个来源`, statusLabel: failed ? '失败' : '已返回',
    busy: false, attention: failed, awaitingFacts: false, success: !failed, tone: failed ? 'danger' : 'neutral',
    ...(value.errorCode ? { shortReason: value.errorCode } : {}) }
}
export function mountAnthropicWebSearchResult(initial: Extract<AnthropicViewBlock, { type: 'anthropic.web_search_tool_result' }>, context: NativeBlockContext): MountedNativeBlock {
  const disclosure = mountToolDisclosure(initial.type, webSearchResultSummary(initial), context, 'native-server-tool')
  const label = document.createElement('strong'), sources = document.createElement('ol')
  sources.setAttribute('aria-label', '搜索结果来源'); disclosure.body.append(label, sources); let sourceKey = ''
  const update = (value: typeof initial, ctx: NativeBlockContext) => {
    disclosure.update(webSearchResultSummary(value), ctx)
    label.textContent = `网页搜索结果 · ${value.status === 'failed' ? '失败' : '已返回'}${value.errorCode ? ` · ${value.errorCode}` : ''}`
    const key = JSON.stringify(value.sources)
    if (key !== sourceKey) {
      sourceKey = key; sources.replaceChildren()
      for (const source of value.sources) { const item = document.createElement('li'), link = document.createElement('a'); link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = source.title || new URL(source.url).hostname; item.append(link); sources.append(item) }
    }
  }
  update(initial, context); return asNativeBlock<typeof initial>({ element: disclosure.element, update, dispose() { disclosure.dispose() } })
}
export function mountAnthropicBlock(block: ProtocolViewBlock, context: NativeBlockContext): MountedNativeBlock {
  const common = mountHarnessBlock(block); if (common) return common
  switch (block.type) {
    case 'anthropic.text': return mountAnthropicText(block)
    case 'anthropic.thinking': return mountAnthropicThinking(block, context)
    case 'anthropic.redacted_thinking': return mountAnthropicRedactedThinking(block)
    case 'anthropic.tool_use': return mountAnthropicToolUse(block, context)
    case 'anthropic.server_tool_use': return mountAnthropicServerToolUse(block, context)
    case 'anthropic.web_search_tool_result': return mountAnthropicWebSearchResult(block, context)
    default: throw new TypeError('Anthropic 内容类型不兼容。')
  }
}
export function anthropicStateText(exchange: ProtocolViewExchange, presentation: NativeBlockContext['presentation'] = 'detail'): string {
  const state = exchange.nativeState
  if (state?.type !== 'anthropic.state') return ''
  const toolCaption = presentation === 'compact' && state.stopReason === 'tool_use' && exchange.blocks.some(block => block.type === 'anthropic.tool_use')
  const label = toolCaption ? '' : ({ end_turn: '模型响应已完成', stop_sequence: '已遇到停止序列', tool_use: '模型已请求工具', pause_turn: '服务端工具正在续轮', max_tokens: '达到输出上限', model_context_window_exceeded: '超出上下文窗口', refusal: '请求被拒绝' } as Record<string, string>)[state.stopReason ?? ''] ?? (state.stopReason ? `原生停止原因：${state.stopReason}` : '')
  return [state.diagnostic ? '诊断记录' : '', state.partial ? '部分内容' : '', label, state.stopSequence, state.stopDetailsType === 'refusal' ? '请求被拒绝' : '', state.errorCode].filter(Boolean).join(' · ')
}
