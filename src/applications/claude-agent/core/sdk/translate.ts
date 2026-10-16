import type { CanUseTool, PermissionResult, PermissionUpdate, SDKMessage, SDKResultMessage, SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { boundedJson, boundedText } from '../events.js'
import type { ApprovalQuestionView, HistoryMessageView, RunResultView, TranscriptBlockView } from '../view.js'
import type { SdkPermissionDecision, SdkPermissionRequest, SdkRunEvent, SdkSessionInfo, SdkSessionProject } from './port.js'

/** Pure translations between SDK objects and the application's own views. SDK types do not leave this directory. */
export const translationLimits = Object.freeze({ toolResult: 32 * 1024, toolInput: 16 * 1024, resultText: 64 * 1024, errorText: 4096 })
type CanUseToolOptions = Parameters<CanUseTool>[2]
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const text = (value: unknown): string => typeof value === 'string' ? value : ''

const toolResultText = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => { const value = record(part); return value?.type === 'text' ? text(value.text) : `[${text(value?.type) || 'content'}]` }).join('\n')
}
/** Anthropic content block (request or response shape) to a bounded display block. */
export function blockView(block: unknown): TranscriptBlockView {
  const value = record(block)
  if (!value) return { kind: 'unsupported', type: typeof block }
  switch (value.type) {
    case 'text': return { kind: 'text', ...boundedText(text(value.text)) }
    case 'thinking': return { kind: 'thinking', ...boundedText(text(value.thinking)) }
    case 'tool_use': { const input = boundedJson(value.input, translationLimits.toolInput); return { kind: 'tool_use', toolUseId: text(value.id), name: text(value.name), input: input.input, inputTruncated: input.truncated } }
    case 'tool_result': return { kind: 'tool_result', toolUseId: text(value.tool_use_id), ...boundedText(toolResultText(value.content), translationLimits.toolResult), isError: value.is_error === true }
    default: return { kind: 'unsupported', type: text(value.type) || 'unknown' }
  }
}
export function resultView(message: SDKResultMessage): RunResultView {
  const usage = message.usage
  return Object.freeze({ subtype: message.subtype, isError: message.is_error, durationMs: message.duration_ms, durationApiMs: message.duration_api_ms, numTurns: message.num_turns,
    totalCostUsd: message.total_cost_usd, stopReason: message.stop_reason,
    usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, cacheReadInputTokens: usage.cache_read_input_tokens, cacheCreationInputTokens: usage.cache_creation_input_tokens },
    ...(message.subtype === 'success' ? { text: boundedText(message.result, translationLimits.resultText).text } : { errors: message.errors.map(error => boundedText(error, translationLimits.errorText).text) }) })
}
/** Stateful only for the current streaming message id, which stream events do not repeat. */
export function createMessageTranslator(): (message: SDKMessage) => SdkRunEvent[] {
  let streaming: string | undefined
  return message => {
    switch (message.type) {
      case 'system':
        switch (message.subtype) {
          case 'init': return [{ type: 'init', init: { nativeSessionId: message.session_id, model: message.model, cwd: message.cwd, permissionMode: message.permissionMode,
            claudeCodeVersion: message.claude_code_version, toolCount: message.tools.length } }]
          case 'status': return [{ type: 'status', status: message.status }]
          case 'compact_boundary': return [{ type: 'compact', trigger: message.compact_metadata.trigger, preTokens: message.compact_metadata.pre_tokens }]
          case 'permission_denied': return [{ type: 'notice', notice: { code: 'permission-denied', message: `${message.tool_name}: ${boundedText(message.message, translationLimits.errorText).text}` } }]
          case 'api_retry': return [{ type: 'notice', notice: { code: 'api-retry', message: `Retrying the request (${message.attempt}/${message.max_retries}): ${message.error}` } }]
          default: return []
        }
      case 'stream_event': {
        const event = message.event
        if (message.parent_tool_use_id !== null) return []
        switch (event.type) {
          case 'message_start': streaming = event.message.id; return [{ type: 'message-start', messageId: streaming }]
          case 'content_block_start': {
            if (!streaming) return []
            const block = event.content_block
            if (block.type === 'tool_use') return [{ type: 'block-start', messageId: streaming, index: event.index, block: 'tool_use', toolUseId: block.id, name: block.name }]
            if (block.type === 'text' || block.type === 'thinking') return [{ type: 'block-start', messageId: streaming, index: event.index, block: block.type }]
            return []
          }
          case 'content_block_delta': {
            if (!streaming) return []
            if (event.delta.type === 'text_delta') return [{ type: 'text-delta', messageId: streaming, index: event.index, text: event.delta.text }]
            if (event.delta.type === 'thinking_delta') return [{ type: 'thinking-delta', messageId: streaming, index: event.index, text: event.delta.thinking }]
            return []
          }
          case 'content_block_stop': return streaming ? [{ type: 'block-stop', messageId: streaming, index: event.index }] : []
          case 'message_stop': streaming = undefined; return []
          default: return []
        }
      }
      case 'assistant':
        if (message.parent_tool_use_id !== null) return []
        return [{ type: 'assistant', messageId: message.message.id, blocks: message.message.content.map(blockView) }]
      case 'user': {
        if (message.parent_tool_use_id !== null || !Array.isArray(message.message.content)) return []
        return message.message.content.flatMap((block): SdkRunEvent[] => {
          const view = blockView(block)
          return view.kind === 'tool_result' ? [{ type: 'tool-result', toolUseId: view.toolUseId, text: view.text, isError: view.isError, truncated: view.truncated }] : []
        })
      }
      case 'result': return [{ type: 'result', result: resultView(message) }]
      case 'rate_limit_event':
        return message.rate_limit_info.status === 'allowed' ? [] : [{ type: 'notice', notice: { code: 'rate-limit', message: `Rate limit ${message.rate_limit_info.status}${message.rate_limit_info.rateLimitType ? ` (${message.rate_limit_info.rateLimitType})` : ''}.` } }]
      default: return []
    }
  }
}
/** AskUserQuestion input as the browser sees it; malformed entries are dropped rather than guessed. */
export function questionViews(input: unknown): readonly ApprovalQuestionView[] | null {
  const questions = record(input)?.questions
  if (!Array.isArray(questions)) return null
  const views = questions.flatMap((entry, index): ApprovalQuestionView[] => {
    const value = record(entry), question = text(value?.question).trim()
    if (!value || !question) return []
    const options = Array.isArray(value.options) ? value.options.flatMap(option => { const item = record(option), label = text(item?.label).trim(); return label ? [{ label, description: text(item?.description).trim() }] : [] }) : []
    return [{ question, header: text(value.header).trim() || `Question ${index + 1}`, options, multiSelect: value.multiSelect === true }]
  })
  return views.length ? views : null
}
export function permissionRequest(toolName: string, input: Record<string, unknown>, options: CanUseToolOptions): SdkPermissionRequest {
  const questions = toolName === 'AskUserQuestion' ? questionViews(input) : null
  return { toolUseId: options.toolUseID, toolName, input, title: options.title ?? null, description: options.description ?? null, reason: options.decisionReason ?? null,
    defaultToNo: options.defaultToNo === true, allowSessionAvailable: (options.suggestions?.length ?? 0) > 0 && options.suppressAlwaysAllowRule !== true, questions, signal: options.signal }
}
const sessionUpdates = (toolName: string, suggestions: readonly PermissionUpdate[] | undefined): PermissionUpdate[] => {
  const updates = (suggestions ?? []).map((suggestion): PermissionUpdate => ({ ...suggestion, destination: 'session' }))
  return updates.length ? updates : [{ type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'session' }]
}
export function permissionResult(decision: SdkPermissionDecision, toolName: string, input: Record<string, unknown>, options: CanUseToolOptions): PermissionResult {
  if (decision.behavior === 'deny') return { behavior: 'deny', message: decision.message, toolUseID: options.toolUseID, decisionClassification: 'user_reject' }
  if (decision.answers) return { behavior: 'allow', updatedInput: { ...input, answers: { ...decision.answers } }, toolUseID: options.toolUseID, decisionClassification: 'user_temporary' }
  return { behavior: 'allow', updatedInput: input, toolUseID: options.toolUseID, decisionClassification: decision.session ? 'user_permanent' : 'user_temporary',
    ...(decision.session ? { updatedPermissions: sessionUpdates(toolName, options.suggestions) } : {}) }
}
/** Main-thread user and assistant messages of a transcript; subagent messages and empty entries are skipped. */
export function historyMessages(messages: readonly SessionMessage[]): HistoryMessageView[] {
  return messages.flatMap((message): HistoryMessageView[] => {
    if ((message.type !== 'user' && message.type !== 'assistant') || message.parent_tool_use_id !== null) return []
    const content = record(message.message)?.content
    const blocks = typeof content === 'string' ? [{ kind: 'text' as const, ...boundedText(content) }] : Array.isArray(content) ? content.map(blockView) : []
    return blocks.length ? [{ id: message.uuid, role: message.type, blocks }] : []
  })
}
/** Distinct `cwd` values of the worker's session list, newest first; entries without a directory are skipped. */
export function sessionProjects(raw: unknown): SdkSessionProject[] {
  if (!Array.isArray(raw)) return []
  const newest = new Map<string, number>()
  for (const entry of raw) {
    const value = record(entry), cwd = text(value?.cwd), modified = typeof value?.lastModified === 'number' && Number.isFinite(value.lastModified) ? value.lastModified : 0
    if (!cwd) continue
    newest.set(cwd, Math.max(newest.get(cwd) ?? 0, modified))
  }
  return [...newest].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([path, modified]) => ({ path, lastUsedAt: new Date(modified).toISOString() }))
}
export const sessionTitleLimit = 200
/** First line of the environment's title, bounded; `undefined` when the worker found no session. */
export function sessionInfo(raw: unknown): SdkSessionInfo | undefined {
  const value = record(raw)
  if (!value) return undefined
  const candidate = [value.customTitle, value.summary, value.firstPrompt].map(text).map(entry => entry.trim().split(/\r?\n/, 1)[0].replace(/\s+/g, ' ').trim()).find(Boolean) ?? ''
  return { title: candidate ? candidate.slice(0, sessionTitleLimit) : null }
}
