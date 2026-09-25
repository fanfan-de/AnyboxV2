/** Pure DeepSeek Chat Completions functions. Native request and response shapes never leave this directory. */
import { nonEmpty } from '../../validation.js'
import { LLMFailure } from '../port.js'
import type { LLMMessage } from '../port.js'

export interface DeepSeekProfile {
  readonly id: string
  readonly model: string
  readonly maxOutputTokens: number
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
    if (!Number.isSafeInteger(raw.maxOutputTokens) || raw.maxOutputTokens <= 0) {
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
      maxOutputTokens: raw.maxOutputTokens, temperature: raw.temperature, timeoutMs: raw.timeoutMs,
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

interface ChatCompletionMessage {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string
}

/** DeepSeek's non-streaming Chat Completions request body. */
export interface ChatCompletionRequest {
  readonly model: string
  readonly messages: readonly ChatCompletionMessage[]
  readonly max_tokens: number
  readonly temperature: number
  readonly stream: false
}

export function buildChatCompletionRequest(
  selection: DeepSeekSelection, messages: readonly LLMMessage[],
): ChatCompletionRequest {
  if (!messages.length) throw new LLMFailure('unsupported-request')
  const native = messages.map((message): ChatCompletionMessage => {
    // Chat Completions documents no developer role. Do not silently downgrade its priority.
    if (message.role === 'developer') throw new LLMFailure('unsupported-request')
    return Object.freeze({ role: message.role, content: message.content })
  })
  return Object.freeze({
    model: selection.model,
    messages: Object.freeze(native),
    max_tokens: selection.maxOutputTokens,
    temperature: selection.temperature,
    stream: false as const,
  })
}

/** Accepts only a complete text answer. Truncated output and tool calls are not supported yet. */
export function parseChatCompletion(body: unknown): string {
  if (!body || typeof body !== 'object' || !('choices' in body) || !Array.isArray(body.choices)) {
    throw new LLMFailure('invalid-response')
  }
  const choice: unknown = body.choices[0]
  if (!choice || typeof choice !== 'object' || !('finish_reason' in choice) || choice.finish_reason !== 'stop' ||
    !('message' in choice) || !choice.message || typeof choice.message !== 'object' ||
    !('content' in choice.message) || typeof choice.message.content !== 'string') {
    throw new LLMFailure('invalid-response')
  }
  return choice.message.content
}
