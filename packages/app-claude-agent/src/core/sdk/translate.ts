import type { CanUseTool, PermissionResult, PermissionUpdate, SDKMessage, SDKResultMessage, SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { boundedJson, boundedText } from '../events.js'
import { reusablePermissions } from './permissions.js'
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
    case 'image': return {kind:'attachment',name:'图片附件',mime:record(value.source)?.media_type ? String(record(value.source)?.media_type) : 'image'}
    case 'document': return {kind:'attachment',name:text(value.title)||'文档附件',mime:'application/pdf'}
    case 'text': return { kind: 'text', ...boundedText(text(value.text)) }
    case 'thinking': return { kind: 'thinking', ...boundedText(text(value.thinking)) }
    case 'tool_use': { const input = boundedJson(value.input, translationLimits.toolInput); return { kind: 'tool_use', toolUseId: text(value.id), name: text(value.name), input: input.input, inputTruncated: input.truncated } }
    case 'tool_result': return { kind: 'tool_result', toolUseId: text(value.tool_use_id), ...boundedText(toolResultText(value.content), translationLimits.toolResult), isError: value.is_error === true }
    default: return { kind: 'unsupported', type: text(value.type) || 'unknown' }
  }
}
/** Bounded child transcript; its complete history remains in the native Claude session. */
function childBlocks(content: readonly unknown[]): TranscriptBlockView[] {
  const blocks: TranscriptBlockView[] = []
  let size = 0
  for (const block of content.slice(0, 32)) {
    const view = blockView(block), bytes = JSON.stringify(view).length
    if (size + bytes > 32 * 1024) { blocks.push({ kind: 'text', text: '…（子 Agent 输出过长，已截断）', truncated: true }); break }
    blocks.push(view); size += bytes
  }
  return blocks
}
export function resultView(message: SDKResultMessage): RunResultView {
  const usage = message.usage
  return Object.freeze({ subtype: message.subtype, isError: message.is_error, durationMs: message.duration_ms, durationApiMs: message.duration_api_ms, numTurns: message.num_turns,
    totalCostUsd: message.total_cost_usd, stopReason: message.stop_reason,
    modelUsage: Object.entries(message.modelUsage ?? {}).slice(0, 50).map(([model, value]) => ({ model: model.slice(0, 200), inputTokens: value.inputTokens, outputTokens: value.outputTokens, costUsd: value.costUSD, thinkingTokens:value.thinkingTokens,cacheReadTokens:value.cacheReadInputTokens,cacheWriteTokens:value.cacheCreationInputTokens,webSearchRequests:value.webSearchRequests,provider:value.provider?.slice(0,100),costBasis:value.costBasis })),
    usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, cacheReadInputTokens: usage.cache_read_input_tokens, cacheCreationInputTokens: usage.cache_creation_input_tokens },
    ...(message.subtype === 'success' ? { text: boundedText(message.result, translationLimits.resultText).text } : { errors: message.errors.map(error => boundedText(error, translationLimits.errorText).text) }) })
}
/** Stateful only for the current streaming message id, which stream events do not repeat. */
export function createMessageTranslator(): (message: SDKMessage) => SdkRunEvent[] {
  let streaming: string | undefined
  const childIds = new Map<string,string>()
  return message => {
    switch (message.type) {
      case 'system':
        switch (message.subtype) {
          case 'background_tasks_changed': return [{type:'background-tasks',ids:message.tasks.filter(task=>!task.ambient).map(task=>task.task_id)}]
          case 'control_request_progress': return [{type:'notice',notice:{code:'control-progress',message:message.status==='api_retry'?`控制请求正在重试（${message.attempt??0}/${message.max_retries??0}）`:'Claude 正在处理控制请求…'}}]
          case 'task_started': return [{ type: 'task', task: { id: message.task_id, generation: message.run_id, toolUseId: message.tool_use_id, description: message.description.slice(0, 2000), agentType: message.subagent_type, taskType: message.task_type, status: 'running' } }]
          case 'task_progress': return [{ type: 'task', task: { id: message.task_id, generation: message.run_id, toolUseId: message.tool_use_id, description: message.description.slice(0, 2000), agentType: message.subagent_type,
            summary: message.summary?.slice(0, 4000), lastTool: message.last_tool_name, tokens: message.usage.total_tokens, toolUses: message.usage.tool_uses, durationMs: message.usage.duration_ms } }]
          case 'task_notification': return [{ type: 'task', task: { id: message.task_id, generation: message.run_id, toolUseId: message.tool_use_id, status: message.status, summary: message.summary.slice(0, 4000) } }]
          case 'task_updated': return [{ type: 'task', task: { id: message.task_id, generation: message.run_id, ...(message.patch.description ? { description: message.patch.description.slice(0, 2000) } : {}),
            ...(message.patch.status ? { status: message.patch.status === 'killed' ? 'stopped' : message.patch.status } : {}) } }]
          case 'init': return [{ type: 'init', init: { nativeSessionId: message.session_id, model: message.model, cwd: message.cwd, permissionMode: message.permissionMode,
            claudeCodeVersion: message.claude_code_version, toolCount: message.tools.length } }]
          case 'status': return [{ type: 'status', status: message.status }, ...(message.permissionMode ? [{ type: 'permission-mode' as const, mode: message.permissionMode }] : [])]
          case 'compact_boundary': return [{ type: 'compact', trigger: message.compact_metadata.trigger, preTokens: message.compact_metadata.pre_tokens }]
          case 'permission_denied': return [{ type: 'notice', notice: { code: 'permission-denied', message: `${message.tool_name}: ${boundedText(message.message, translationLimits.errorText).text}` } }]
          case 'api_retry': return [{ type: 'notice', notice: { code: 'api-retry', message: `Retrying the request (${message.attempt}/${message.max_retries}): ${message.error}` } }]
          default: return []
        }
      case 'stream_event': {
        const event = message.event
        if (message.parent_tool_use_id !== null) {
          const parent=message.parent_tool_use_id
          if(event.type==='message_start'){childIds.set(parent,event.message.id);return []}
          const id=childIds.get(parent);if(!id)return []
          if(event.type==='content_block_start'){const b=event.content_block;if(b.type==='text'||b.type==='thinking'||b.type==='tool_use')return [{type:'agent-stream',parentToolUseId:parent,event:{type:'start',messageId:id,index:event.index,block:b.type,...(b.type==='tool_use'?{toolUseId:b.id,name:b.name}:{})}}]}
          if(event.type==='content_block_delta'&&(event.delta.type==='text_delta'||event.delta.type==='thinking_delta'))return [{type:'agent-stream',parentToolUseId:parent,event:{type:'delta',messageId:id,index:event.index,text:event.delta.type==='text_delta'?event.delta.text:event.delta.thinking}}]
          if(event.type==='message_stop')childIds.delete(parent)
          return []
        }
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
        if (message.parent_tool_use_id !== null) return [{ type: 'agent-message', parentToolUseId: message.parent_tool_use_id, message: { id: message.message.id, role: 'assistant', blocks: childBlocks(message.message.content) } }]
        return [{ type: 'assistant', messageId: message.message.id, blocks: message.message.content.map(blockView) }]
      case 'user': {
        if (message.parent_tool_use_id !== null) return [{type:'agent-message',parentToolUseId:message.parent_tool_use_id,message:{id:`${message.parent_tool_use_id}:${message.uuid??'tool-result'}`,role:'user',blocks:typeof message.message.content==='string'?[blockView({type:'text',text:message.message.content})]:Array.isArray(message.message.content)?childBlocks(message.message.content):[]}}]
        if (!Array.isArray(message.message.content)) return []
        return message.message.content.flatMap((block): SdkRunEvent[] => {
          const view = blockView(block)
          return view.kind === 'tool_result' ? [{ type: 'tool-result', toolUseId: view.toolUseId, text: view.text, isError: view.isError, truncated: view.truncated }] : []
        })
      }
      case 'auth_status': return [{type:'auth',authenticating:message.isAuthenticating,failed:!!message.error}]
      case 'tool_progress': return [{type:'tool-progress',progress:{id:message.tool_use_id,name:message.tool_name.slice(0,200),elapsedSeconds:Math.max(0,message.elapsed_time_seconds),parentToolUseId:message.parent_tool_use_id,taskId:message.task_id}}]
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
  const rememberRules = (options.suggestions ?? []).flatMap(suggestion => {
    if ('rules' in suggestion) return suggestion.rules.map(rule => `${suggestion.type} · ${suggestion.behavior} · ${rule.toolName}${rule.ruleContent !== undefined ? `(${rule.ruleContent})` : '（全部调用）'}`)
    if ('directories' in suggestion) return suggestion.directories.map(directory => `${suggestion.type} · ${directory}`)
    return [`setMode · ${suggestion.mode}`]
  })
  const complete = rememberRules.length <= 50 && rememberRules.every(rule => rule.length <= 4000)
  const reusable = reusablePermissions(options.suggestions)
  const allowSessionAvailable = rememberRules.length > 0 && complete && !!reusable && options.suppressAlwaysAllowRule !== true
  return { toolUseId: options.toolUseID, toolName, input, title: options.title ?? null, description: options.description ?? null, reason: options.decisionReason ?? null,
    ...(allowSessionAvailable ? { reusablePermissions: reusable } : {}), rememberRules: complete ? rememberRules : [], blockedPath: options.blockedPath?.slice(0, 4096) ?? null,
    rememberUnavailableReason: allowSessionAvailable ? null : options.suppressAlwaysAllowRule ? 'Claude 要求此操作逐次确认。' : !complete ? '规则过大，无法完整展示，只能允许这一次。' : 'Claude 未提供可安全复用的允许规则，此次批准只适用于这个调用。',
    defaultToNo: options.defaultToNo === true, allowSessionAvailable, questions, signal: options.signal }
}
const sessionUpdates = (_toolName: string, suggestions: readonly PermissionUpdate[] | undefined): PermissionUpdate[] => {
  const updates = (suggestions ?? []).map((suggestion): PermissionUpdate => ({ ...suggestion, destination: 'session' }))
  return updates
}
export function permissionResult(decision: SdkPermissionDecision, toolName: string, input: Record<string, unknown>, options: CanUseToolOptions): PermissionResult {
  if (decision.behavior === 'deny') return { behavior: 'deny', message: decision.message, toolUseID: options.toolUseID, decisionClassification: 'user_reject' }
  if (decision.answers) return { behavior: 'allow', updatedInput: { ...input, answers: { ...decision.answers } }, toolUseID: options.toolUseID, decisionClassification: 'user_temporary' }
  if (decision.session && !permissionRequest(toolName, input, options).allowSessionAvailable) return { behavior: 'deny', message: 'Claude did not provide a reusable permission rule.', toolUseID: options.toolUseID, decisionClassification: 'user_reject' }
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
