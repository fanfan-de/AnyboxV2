/** Pure OpenAI Responses functions. Native shapes stay inside this API component. */
import { nonEmpty } from '../../validation.js'
import { LLMFailure } from '../port.js'
import type { LLMMessage } from '../port.js'

export interface OpenAIResponsesProfile {
  readonly id: string
  readonly model: string
  readonly maxOutputTokens: number
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
    if (!Number.isSafeInteger(raw.maxOutputTokens) || raw.maxOutputTokens <= 0) {
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
      id, model, configVersion: version, maxOutputTokens: raw.maxOutputTokens, timeoutMs: raw.timeoutMs,
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

interface ResponsesInputMessage {
  readonly role: LLMMessage['role']
  readonly content: string
}

export interface ResponsesRequest {
  readonly model: string
  readonly input: readonly ResponsesInputMessage[]
  readonly max_output_tokens: number
  readonly stream: false
  readonly store: false
  readonly temperature?: number
}

/** Send the complete local transcript without creating server-side conversation state. */
export function buildResponsesRequest(
  selection: OpenAIResponsesSelection, messages: readonly LLMMessage[],
): ResponsesRequest {
  if (!messages.length) throw new LLMFailure('unsupported-request')
  return Object.freeze({
    model: selection.model,
    input: Object.freeze(messages.map(message => Object.freeze({ role: message.role, content: message.content }))),
    max_output_tokens: selection.maxOutputTokens,
    stream: false as const,
    store: false as const,
    ...(selection.temperature === undefined ? {} : { temperature: selection.temperature }),
  })
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Collect final assistant text while rejecting incomplete, refused, or tool output. */
export function parseResponsesOutput(body: unknown): string {
  if (!record(body) || body.object !== 'response' || body.status !== 'completed' || !Array.isArray(body.output)) {
    throw new LLMFailure('invalid-response')
  }
  const messages: string[] = []
  for (const item of body.output) {
    if (!record(item)) throw new LLMFailure('invalid-response')
    if (item.type === 'reasoning') continue
    if (item.type !== 'message' || item.role !== 'assistant' || item.status !== 'completed' ||
      !Array.isArray(item.content)) throw new LLMFailure('invalid-response')
    if (item.phase === 'commentary') continue
    if (item.phase !== undefined && item.phase !== 'final') throw new LLMFailure('invalid-response')
    const parts: string[] = []
    for (const content of item.content) {
      if (!record(content) || content.type !== 'output_text' || typeof content.text !== 'string') {
        throw new LLMFailure('invalid-response')
      }
      parts.push(content.text)
    }
    if (parts.length) messages.push(parts.join(''))
  }
  if (!messages.length) throw new LLMFailure('invalid-response')
  return messages.join('\n')
}
