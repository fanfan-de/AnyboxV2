/** Pure DeepSeek Chat Completions functions. Native request and response shapes never leave this directory. */
import { nonEmpty } from '../../validation.js'
import { LLMFailure } from '../port.js'
import type { LLMMessage, LLMToolDefinition, ModelReply, ToolRequest } from '../port.js'

export interface DeepSeekProfile {
  readonly id: string
  readonly model: string
  /** Omit to use the model API's default output budget. */
  readonly maxOutputTokens?: number
  readonly temperature: number
  readonly timeoutMs: number
}

export interface DeepSeekConfiguration {
  readonly version: string
  readonly profiles: readonly DeepSeekProfile[]
}

/** A validated profile that remembers the configuration version it came from. */
export interface DeepSeekSelection extends DeepSeekProfile {
  readonly configVersion: string
}

const profileFields: readonly string[] = ['id', 'model', 'maxOutputTokens', 'temperature', 'timeoutMs']
/** Node timers cannot exceed a signed 32-bit millisecond delay. */
const maxTimeoutMs = 2_147_483_647

export function validateDeepSeekConfiguration(config: DeepSeekConfiguration): ReadonlyMap<string, DeepSeekSelection> {
  const version = nonEmpty(config?.version, 'DeepSeek configuration version')
  for (const key of Object.keys(config)) {
    if (!['version', 'profiles'].includes(key)) throw new TypeError(`unsupported DeepSeek configuration field ${key}`)
  }
  if (!Array.isArray(config.profiles) || config.profiles.length === 0) {
    throw new TypeError('DeepSeek profiles must be a non-empty array')
  }
  const selections = new Map<string, DeepSeekSelection>()
  for (const raw of config.profiles) {
    const id = nonEmpty(raw?.id, 'DeepSeek profile id')
    const model = nonEmpty(raw?.model, 'DeepSeek model name')
    if (selections.has(id)) throw new TypeError(`duplicate DeepSeek profile ${id}`)
    for (const key of Object.keys(raw)) {
      if (!profileFields.includes(key)) throw new TypeError(`unsupported DeepSeek profile parameter ${key}`)
    }
    if (raw.maxOutputTokens !== undefined &&
      (!Number.isSafeInteger(raw.maxOutputTokens) || raw.maxOutputTokens <= 0)) {
      throw new TypeError('maxOutputTokens must be a positive integer')
    }
    if (!Number.isFinite(raw.temperature) || raw.temperature < 0 || raw.temperature > 2) {
      throw new TypeError('temperature must be between 0 and 2')
    }
    if (!Number.isSafeInteger(raw.timeoutMs) || raw.timeoutMs <= 0 || raw.timeoutMs > maxTimeoutMs) {
      throw new TypeError(`timeoutMs must be a positive integer no greater than ${maxTimeoutMs}`)
    }
    selections.set(id, Object.freeze({
      id, model, configVersion: version,
      temperature: raw.temperature, timeoutMs: raw.timeoutMs,
      ...(raw.maxOutputTokens === undefined ? {} : { maxOutputTokens: raw.maxOutputTokens }),
    }))
  }
  return selections
}

export function chatCompletionsEndpoint(baseUrl = 'https://api.deepseek.com'): URL {
  let base: URL
  try { base = new URL(baseUrl) } catch { throw new TypeError('DeepSeek base URL is invalid') }
  if (!['http:', 'https:'].includes(base.protocol)) throw new TypeError('DeepSeek base URL must use HTTP or HTTPS')
  return new URL('chat/completions', `${base.href.replace(/\/$/, '')}/`)
}

interface NativeToolCall {
  readonly id: string
  readonly type: 'function'
  readonly function: { readonly name: string; readonly arguments: string }
}

type ChatCompletionMessage =
  | { readonly role: 'system' | 'user' | 'assistant'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: string | null; readonly tool_calls: readonly NativeToolCall[] }
  | { readonly role: 'tool'; readonly tool_call_id: string; readonly content: string }

/** DeepSeek's non-streaming Chat Completions request body. */
export interface ChatCompletionRequest {
  readonly model: string
  readonly messages: readonly ChatCompletionMessage[]
  readonly max_tokens?: number
  readonly temperature: number
  readonly stream: false
  readonly thinking?: { readonly type: 'disabled' }
  readonly tools?: readonly {
    readonly type: 'function'
    readonly function: LLMToolDefinition
  }[]
}

export function buildChatCompletionRequest(
  selection: DeepSeekSelection, messages: readonly LLMMessage[], tools?: readonly LLMToolDefinition[],
): ChatCompletionRequest {
  if (!messages.length) throw new LLMFailure('unsupported-request')
  const native = messages.map((message): ChatCompletionMessage => {
    // Chat Completions documents no developer role. Do not silently downgrade its priority.
    if (message.role === 'developer') throw new LLMFailure('unsupported-request')
    if (message.role === 'tool') {
      if (!message.toolCallId || typeof message.content !== 'string') throw new LLMFailure('unsupported-request')
      return Object.freeze({ role: 'tool', tool_call_id: message.toolCallId, content: message.content })
    }
    if ('toolCalls' in message) {
      if (message.role !== 'assistant' || !Array.isArray(message.toolCalls) || !message.toolCalls.length) {
        throw new LLMFailure('unsupported-request')
      }
      return Object.freeze({
        role: 'assistant', content: message.content,
        tool_calls: Object.freeze(message.toolCalls.map(call => Object.freeze({
          id: call.id, type: 'function' as const,
          function: Object.freeze({ name: call.name, arguments: JSON.stringify(call.arguments) }),
        }))),
      })
    }
    return Object.freeze({ role: message.role, content: message.content })
  })
  if (tools && (tools.some(tool => !tool || typeof tool.name !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(tool.name) || typeof tool.description !== 'string' ||
    !tool.parameters || typeof tool.parameters !== 'object') ||
    new Set(tools.map(tool => tool.name)).size !== tools.length)) {
    throw new LLMFailure('unsupported-request')
  }
  return Object.freeze({
    model: selection.model,
    messages: Object.freeze(native),
    ...(selection.maxOutputTokens === undefined ? {} : { max_tokens: selection.maxOutputTokens }),
    temperature: selection.temperature,
    stream: false as const,
    ...(tools?.length ? { thinking: Object.freeze({ type: 'disabled' as const }) } : {}),
    ...(tools?.length ? { tools: Object.freeze(tools.map(tool => Object.freeze({
      type: 'function' as const,
      function: Object.freeze({ name: tool.name, description: tool.description, parameters: tool.parameters }),
    }))) } : {}),
  })
}

/** Decode the native choice into the project-owned final/tool-call result. */
export function parseChatCompletion(body: unknown, toolsOffered = false): ModelReply {
  if (!body || typeof body !== 'object' || !('choices' in body) || !Array.isArray(body.choices)) {
    throw new LLMFailure('invalid-response')
  }
  const choice: unknown = body.choices[0]
  if (!choice || typeof choice !== 'object' || !('finish_reason' in choice) ||
    !('message' in choice) || !choice.message || typeof choice.message !== 'object' ||
    !('role' in choice.message) || choice.message.role !== 'assistant') {
    throw new LLMFailure('invalid-response')
  }
  const message = choice.message
  if (choice.finish_reason === 'stop') {
    if (!('content' in message) || typeof message.content !== 'string' ||
      ('tool_calls' in message && Array.isArray(message.tool_calls) && message.tool_calls.length > 0)) {
      throw new LLMFailure('invalid-response')
    }
    return Object.freeze({ kind: 'final', text: message.content })
  }
  if (choice.finish_reason !== 'tool_calls' || !toolsOffered ||
    !('tool_calls' in message) || !Array.isArray(message.tool_calls) || !message.tool_calls.length ||
    !('content' in message) || (message.content !== null && typeof message.content !== 'string') ||
    ('reasoning_content' in message && message.reasoning_content !== null &&
      message.reasoning_content !== undefined && message.reasoning_content !== '')) {
    throw new LLMFailure('invalid-response')
  }
  const calls: ToolRequest[] = message.tool_calls.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object' || !('id' in raw) || typeof raw.id !== 'string' ||
      !('type' in raw) || raw.type !== 'function' ||
      !('function' in raw) || !raw.function || typeof raw.function !== 'object' ||
      !('name' in raw.function) || typeof raw.function.name !== 'string' ||
      !('arguments' in raw.function) || typeof raw.function.arguments !== 'string') {
      throw new LLMFailure('invalid-response')
    }
    let args: unknown
    try { args = JSON.parse(raw.function.arguments) } catch { args = undefined }
    return Object.freeze({ id: raw.id, name: raw.function.name, arguments: args })
  })
  return Object.freeze({ kind: 'tool-calls', content: message.content, calls: Object.freeze(calls) })
}
