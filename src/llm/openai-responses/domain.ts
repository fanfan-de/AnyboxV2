/** Pure OpenAI Responses functions. Native shapes stay inside this API component. */
import { nonEmpty } from '../../validation.js'
import { isDeepStrictEqual } from 'node:util'
import { LLMFailure } from '../port.js'
import type { LLMMessage, LLMToolDefinition, ModelReply, ToolRequest } from '../port.js'

export interface OpenAIResponsesProfile {
  readonly id: string
  readonly model: string
  /** Omit to use the model API's default output budget. */
  readonly maxOutputTokens?: number
  readonly timeoutMs: number
  /** Optional because some OpenAI models do not accept temperature. */
  readonly temperature?: number
}

export interface OpenAIResponsesConfiguration {
  readonly version: string
  readonly profiles: readonly OpenAIResponsesProfile[]
}

export interface OpenAIResponsesSelection extends OpenAIResponsesProfile {
  readonly configVersion: string
}

const profileFields: readonly string[] = ['id', 'model', 'maxOutputTokens', 'timeoutMs', 'temperature']
const maxTimeoutMs = 2_147_483_647

export function validateOpenAIResponsesConfiguration(
  config: OpenAIResponsesConfiguration,
): ReadonlyMap<string, OpenAIResponsesSelection> {
  const version = nonEmpty(config?.version, 'OpenAI Responses configuration version')
  for (const key of Object.keys(config)) {
    if (!['version', 'profiles'].includes(key)) throw new TypeError(`unsupported OpenAI Responses configuration field ${key}`)
  }
  if (!Array.isArray(config.profiles) || config.profiles.length === 0) {
    throw new TypeError('OpenAI Responses profiles must be a non-empty array')
  }
  const selections = new Map<string, OpenAIResponsesSelection>()
  for (const raw of config.profiles) {
    const id = nonEmpty(raw?.id, 'OpenAI Responses profile id')
    const model = nonEmpty(raw?.model, 'OpenAI Responses model name')
    if (selections.has(id)) throw new TypeError(`duplicate OpenAI Responses profile ${id}`)
    for (const key of Object.keys(raw)) {
      if (!profileFields.includes(key)) throw new TypeError(`unsupported OpenAI Responses profile parameter ${key}`)
    }
    if (raw.maxOutputTokens !== undefined &&
      (!Number.isSafeInteger(raw.maxOutputTokens) || raw.maxOutputTokens <= 0)) {
      throw new TypeError('maxOutputTokens must be a positive integer')
    }
    if (!Number.isSafeInteger(raw.timeoutMs) || raw.timeoutMs <= 0 || raw.timeoutMs > maxTimeoutMs) {
      throw new TypeError(`timeoutMs must be a positive integer no greater than ${maxTimeoutMs}`)
    }
    if (raw.temperature !== undefined &&
      (!Number.isFinite(raw.temperature) || raw.temperature < 0 || raw.temperature > 2)) {
      throw new TypeError('temperature must be between 0 and 2')
    }
    selections.set(id, Object.freeze({
      id, model, configVersion: version, timeoutMs: raw.timeoutMs,
      ...(raw.maxOutputTokens === undefined ? {} : { maxOutputTokens: raw.maxOutputTokens }),
      ...(raw.temperature === undefined ? {} : { temperature: raw.temperature }),
    }))
  }
  return selections
}

export function responsesEndpoint(baseUrl = 'https://api.openai.com/v1'): URL {
  let base: URL
  try { base = new URL(baseUrl) } catch { throw new TypeError('OpenAI Responses base URL is invalid') }
  if (!['http:', 'https:'].includes(base.protocol)) {
    throw new TypeError('OpenAI Responses base URL must use HTTP or HTTPS')
  }
  return new URL('responses', `${base.href.replace(/\/$/, '')}/`)
}

/** Native items are validated at the boundary, preserving provider fields needed for replay. */
type ResponsesItem = Readonly<Record<string, unknown>>

export interface ResponsesContinuation {
  readonly expectedPrefix: readonly LLMMessage[]
  readonly nativeInput: readonly ResponsesItem[]
}

export interface ParsedResponsesOutput {
  readonly reply: ModelReply
  readonly output: readonly ResponsesItem[]
}

export interface ResponsesRequest {
  readonly model: string
  readonly input: readonly ResponsesItem[]
  readonly max_output_tokens?: number
  readonly stream: false
  readonly store: false
  readonly temperature?: number
  readonly tools?: readonly (LLMToolDefinition & { readonly type: 'function'; readonly strict: false })[]
  readonly include?: readonly ['reasoning.encrypted_content']
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Detach caller-owned history before an asynchronous operation can observe later mutation. */
export function snapshotResponsesMessages(messages: readonly LLMMessage[]): readonly LLMMessage[] {
  if (!Array.isArray(messages) || !messages.length) throw new LLMFailure('unsupported-request')
  try { return structuredClone(messages) }
  catch { throw new LLMFailure('unsupported-request') }
}

function buildResponsesInput(
  messages: readonly LLMMessage[], continuation?: ResponsesContinuation,
): readonly ResponsesItem[] {
  if (!messages.length) throw new LLMFailure('unsupported-request')
  if (!continuation) {
    return Object.freeze(messages.map(message => {
      if (!record(message) || !['system', 'developer', 'user', 'assistant'].includes(message.role) ||
        typeof message.content !== 'string' || 'toolCalls' in message) {
        throw new LLMFailure('unsupported-request')
      }
      return Object.freeze({ role: message.role, content: message.content })
    }))
  }
  const { expectedPrefix, nativeInput } = continuation
  const assistant = expectedPrefix.at(-1)
  if (!assistant || !('toolCalls' in assistant) ||
    !isDeepStrictEqual(messages.slice(0, expectedPrefix.length), expectedPrefix) ||
    messages.length !== expectedPrefix.length + assistant.toolCalls.length) {
    throw new LLMFailure('unsupported-request')
  }
  const observations = messages.slice(expectedPrefix.length).map((message, index) => {
    if (!record(message) || message.role !== 'tool' ||
      message.toolCallId !== assistant.toolCalls[index]!.id || typeof message.content !== 'string') {
      throw new LLMFailure('unsupported-request')
    }
    return Object.freeze({ type: 'function_call_output', call_id: message.toolCallId, output: message.content })
  })
  return Object.freeze([...nativeInput, ...observations])
}

/** Send complete native history without creating server-side conversation state. */
export function buildResponsesRequest(
  selection: OpenAIResponsesSelection, messages: readonly LLMMessage[],
  tools?: readonly LLMToolDefinition[], continuation?: ResponsesContinuation,
): ResponsesRequest {
  const input = buildResponsesInput(messages, continuation)
  if (tools !== undefined && (!Array.isArray(tools) || tools.some(tool => !record(tool) ||
    typeof tool.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) ||
    typeof tool.description !== 'string' || !record(tool.parameters)) ||
    new Set(tools.map(tool => tool.name)).size !== tools.length)) {
    throw new LLMFailure('unsupported-request')
  }
  return Object.freeze({
    model: selection.model, input,
    ...(selection.maxOutputTokens === undefined ? {} : { max_output_tokens: selection.maxOutputTokens }),
    stream: false as const,
    store: false as const,
    ...(selection.temperature === undefined ? {} : { temperature: selection.temperature }),
    ...(tools?.length ? {
      tools: Object.freeze(tools.map(tool => Object.freeze({
        type: 'function' as const, name: tool.name, description: tool.description,
        parameters: tool.parameters, strict: false as const,
      }))),
      include: Object.freeze(['reasoning.encrypted_content'] as const),
    } : {}),
  })
}

/** Decode only supported output kinds; retain native items privately for the next tool round. */
export function parseResponsesOutput(body: unknown, toolsOffered = false): ParsedResponsesOutput {
  if (!record(body) || body.object !== 'response' || body.status !== 'completed' || !Array.isArray(body.output)) {
    throw new LLMFailure('invalid-response')
  }
  const finalMessages: string[] = []
  const allMessages: string[] = []
  const calls: ToolRequest[] = []
  for (const item of body.output) {
    if (!record(item)) throw new LLMFailure('invalid-response')
    if (item.type === 'reasoning') {
      if (!Array.isArray(item.summary) || item.summary.some(part => !record(part) ||
        part.type !== 'summary_text' || typeof part.text !== 'string') ||
        (item.encrypted_content != null && typeof item.encrypted_content !== 'string') ||
        (item.status != null && item.status !== 'completed')) throw new LLMFailure('invalid-response')
      continue
    }
    if (item.type === 'function_call') {
      if (!toolsOffered || typeof item.call_id !== 'string' || typeof item.name !== 'string' ||
        typeof item.arguments !== 'string' || (item.status != null && item.status !== 'completed')) {
        throw new LLMFailure('invalid-response')
      }
      let args: unknown
      // Tool argument errors remain subject to AgentLoop's all-or-nothing batch validation.
      try { args = JSON.parse(item.arguments) } catch { args = undefined }
      calls.push(Object.freeze({ id: item.call_id, name: item.name, arguments: args }))
      continue
    }
    if (item.type !== 'message' || item.role !== 'assistant' || item.status !== 'completed' ||
      !Array.isArray(item.content)) throw new LLMFailure('invalid-response')
    if (item.phase != null && item.phase !== 'commentary' && item.phase !== 'final_answer') {
      throw new LLMFailure('invalid-response')
    }
    const parts: string[] = []
    for (const content of item.content) {
      if (!record(content) || content.type !== 'output_text' || typeof content.text !== 'string') {
        throw new LLMFailure('invalid-response')
      }
      parts.push(content.text)
    }
    if (parts.length) {
      allMessages.push(parts.join(''))
      if (item.phase !== 'commentary') finalMessages.push(parts.join(''))
    }
  }
  if (!calls.length && !finalMessages.length) throw new LLMFailure('invalid-response')
  const reply: ModelReply = calls.length
    ? Object.freeze({ kind: 'tool-calls', content: allMessages.length ? allMessages.join('\n') : null,
      calls: Object.freeze(calls) })
    : Object.freeze({ kind: 'final', text: finalMessages.join('\n') })
  return Object.freeze({ reply, output: structuredClone(body.output) as readonly ResponsesItem[] })
}

/** Create a detached checkpoint; the component commits it only after the owned call exits. */
export function responsesContinuation(
  messages: readonly LLMMessage[], request: ResponsesRequest, parsed: ParsedResponsesOutput,
): ResponsesContinuation | undefined {
  if (parsed.reply.kind === 'final') return undefined
  return Object.freeze({
    expectedPrefix: structuredClone([...messages, {
      role: 'assistant' as const, content: parsed.reply.content ?? null, toolCalls: parsed.reply.calls,
    }]),
    nativeInput: Object.freeze([...request.input, ...parsed.output]),
  })
}
