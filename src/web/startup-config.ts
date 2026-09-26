import type { ManagedCredentialDefinition } from '../credentials/settings.js'
import { createDeepSeekChatCompletionsComponent, deepSeekCredentialId } from '../llm/deepseek-chat-completions/component.js'
import type { DeepSeekProfile } from '../llm/deepseek-chat-completions/domain.js'
import { createOpenAIResponsesComponent, openAIResponsesCredentialId } from '../llm/openai-responses/component.js'
import type { OpenAIResponsesProfile } from '../llm/openai-responses/domain.js'

export type WebLLMStartupConfig = {
  readonly credential: ManagedCredentialDefinition
  readonly baseUrl?: string
} & (
  | { readonly api: 'deepseek-chat-completions'; readonly profile: DeepSeekProfile }
  | { readonly api: 'openai-responses'; readonly profile: OpenAIResponsesProfile }
)

export interface WebStartupConfig {
  readonly port: number
  readonly llm: WebLLMStartupConfig
}

type Environment = Readonly<Record<string, string | undefined>>
const maxTimeoutMs = 2_147_483_647

function optionalValue(env: Environment, name: string): string | undefined {
  const value = env[name]
  if (value === undefined) return undefined
  if (!value.trim()) throw new TypeError(`${name} must not be empty`)
  return value.trim()
}

function positiveInteger(env: Environment, name: string, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  const value = optionalValue(env, name)
  if (value === undefined) return undefined
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0 || number > maximum) {
    throw new TypeError(`${name} must be a positive integer no greater than ${maximum}`)
  }
  return number
}

/** Parse all host configuration before installing components or opening resources. */
export function parseWebStartupConfig(env: Environment): WebStartupConfig {
  const api = optionalValue(env, 'ANYBOX_LLM_API') ?? 'deepseek-chat-completions'
  if (api !== 'deepseek-chat-completions' && api !== 'openai-responses') {
    throw new TypeError('ANYBOX_LLM_API must be deepseek-chat-completions or openai-responses')
  }
  const configuredModel = optionalValue(env, 'ANYBOX_LLM_MODEL')
  if (api === 'openai-responses' && configuredModel === undefined) {
    throw new TypeError('ANYBOX_LLM_MODEL is required for openai-responses')
  }
  const baseUrl = optionalValue(env, 'ANYBOX_LLM_BASE_URL')
  if (baseUrl !== undefined) {
    let url: URL
    try { url = new URL(baseUrl) } catch { throw new TypeError('ANYBOX_LLM_BASE_URL must be an HTTP or HTTPS API base URL') }
    if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash || url.username || url.password) {
      throw new TypeError('ANYBOX_LLM_BASE_URL must be an HTTP or HTTPS API base URL without credentials, query or fragment')
    }
  }
  const timeoutMs = positiveInteger(env, 'ANYBOX_LLM_TIMEOUT_MS', maxTimeoutMs) ?? 30_000
  const maxOutputTokens = positiveInteger(env, 'ANYBOX_LLM_MAX_OUTPUT_TOKENS')
  const rawTemperature = optionalValue(env, 'ANYBOX_LLM_TEMPERATURE')
  const temperature = rawTemperature === undefined ? undefined : Number(rawTemperature)
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    throw new TypeError('ANYBOX_LLM_TEMPERATURE must be between 0 and 2')
  }
  const rawPort = optionalValue(env, 'ANYBOX_WEB_PORT')
  const port = rawPort === undefined ? 0 : Number(rawPort)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('ANYBOX_WEB_PORT must be a TCP port')

  const profile = {
    id: 'default', model: configuredModel ?? 'deepseek-flash', timeoutMs,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  }
  const transport = baseUrl === undefined ? {} : { baseUrl }
  const llm: WebLLMStartupConfig = api === 'deepseek-chat-completions'
    ? Object.freeze({
      api, ...transport,
      profile: Object.freeze({ ...profile, temperature: temperature ?? 0.7 }),
      credential: Object.freeze({ id: deepSeekCredentialId, label: 'DeepSeek Chat', category: '大语言模型' }),
    })
    : Object.freeze({
      api, ...transport,
      profile: Object.freeze({ ...profile, ...(temperature === undefined ? {} : { temperature }) }),
      credential: Object.freeze({ id: openAIResponsesCredentialId, label: 'OpenAI Responses', category: '大语言模型' }),
    })
  return Object.freeze({ port, llm })
}

/** Construct exactly the selected API component; Nya owns its installation and lifecycle. */
export function createWebLLMComponent(config: WebLLMStartupConfig) {
  const transport = config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }
  return config.api === 'deepseek-chat-completions'
    ? createDeepSeekChatCompletionsComponent({ version: 'web-v4', profiles: [config.profile] }, transport)
    : createOpenAIResponsesComponent({ version: 'web-v4', profiles: [config.profile] }, transport)
}
