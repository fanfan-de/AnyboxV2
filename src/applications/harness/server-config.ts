import { dirname, join, resolve } from 'node:path'
import type { NativeParameters, ProviderConnectionInput } from '@anybox/models'

export interface LegacyModelImport {
  readonly provider: Omit<ProviderConnectionInput, 'providerDefinitionId'>
  readonly remoteModelId: string
  readonly parameters: NativeParameters
  readonly credentialId: string
}
export interface HarnessServerConfig {
  readonly port: number
  readonly harnessDatabasePath: string
  readonly imageAssetsDirectory: string
  readonly modelsDatabasePath: string
  readonly modelsConfigPath: string
  readonly modelsCatalogDatabasePath: string
  readonly credentialNamespace: string
  /** Used only when the new Models database has not yet been configured. */
  readonly legacy: LegacyModelImport
}
type Environment = Readonly<Record<string, string | undefined>>
/** The former database location remains the one-time migration source. */
export function defaultModelsConfigPath(legacyDatabasePath: string): string {
  return /\.(?:sqlite3?|db)$/i.test(legacyDatabasePath) ? legacyDatabasePath.replace(/\.(?:sqlite3?|db)$/i, '.json') : `${legacyDatabasePath}.json`
}
function optionalValue(env: Environment, name: string): string | undefined {
  const value = env[name]
  if (value === undefined) return undefined
  if (!value.trim() || value.includes('\0')) throw new TypeError(`${name} must not be empty or contain NUL`)
  return value.trim()
}
function positiveInteger(env: Environment, name: string, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  const value = optionalValue(env, name)
  if (value === undefined) return undefined
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0 || number > maximum) throw new TypeError(`${name} must be a positive integer no greater than ${maximum}`)
  return number
}

/** harness server configuration is validated before resources are installed. Existing model edits stay in Models storage. */
export function parseHarnessServerConfig(env: Environment): HarnessServerConfig {
  const api = optionalValue(env, 'ANYBOX_LLM_API') ?? 'chat-completions'
  if (!['chat-completions', 'openai-responses'].includes(api)) throw new TypeError('ANYBOX_LLM_API must be chat-completions or openai-responses for the initial import')
  const configuredModel = optionalValue(env, 'ANYBOX_LLM_MODEL')
  if (api === 'openai-responses' && !configuredModel) throw new TypeError('ANYBOX_LLM_MODEL is required for the initial Responses import')
  const baseUrl = optionalValue(env, 'ANYBOX_LLM_BASE_URL') ?? (api === 'openai-responses' ? 'https://api.openai.com/v1' : 'https://api.deepseek.com')
  try {
    const url = new URL(baseUrl)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
  } catch { throw new TypeError('ANYBOX_LLM_BASE_URL must be an HTTP or HTTPS API base URL without credentials, query or fragment') }
  const timeoutMs = positiveInteger(env, 'ANYBOX_LLM_TIMEOUT_MS', 2_147_483_647) ?? 30_000
  const maxOutputTokens = positiveInteger(env, 'ANYBOX_LLM_MAX_OUTPUT_TOKENS')
  const rawTemperature = optionalValue(env, 'ANYBOX_LLM_TEMPERATURE')
  const temperature = rawTemperature === undefined ? undefined : Number(rawTemperature)
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) throw new TypeError('ANYBOX_LLM_TEMPERATURE must be between 0 and 2')
  const portName = env.ANYBOX_HARNESS_PORT === undefined ? 'ANYBOX_WEB_PORT' : 'ANYBOX_HARNESS_PORT'
  const rawPort = optionalValue(env, portName)
  const port = rawPort === undefined ? 0 : Number(rawPort)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError(`${portName} must be a TCP port`)
  const harnessDatabasePath = optionalValue(env, 'ANYBOX_HARNESS_DATABASE') ?? './data/harness.sqlite'
  const imageAssetsDirectory = optionalValue(env, 'ANYBOX_IMAGE_ASSETS_DIRECTORY') ?? `${harnessDatabasePath}.images`
  const modelsDatabasePath = optionalValue(env, 'ANYBOX_MODELS_DATABASE') ?? './data/models.sqlite'
  if (resolve(harnessDatabasePath) === resolve(modelsDatabasePath)) throw new TypeError('ANYBOX_MODELS_DATABASE and ANYBOX_HARNESS_DATABASE must be different files')
  const modelsConfigPath = optionalValue(env, 'ANYBOX_MODELS_CONFIG') ?? defaultModelsConfigPath(modelsDatabasePath)
  if ([harnessDatabasePath, modelsDatabasePath].some(path => resolve(path) === resolve(modelsConfigPath))) {
    throw new TypeError('ANYBOX_MODELS_CONFIG must be different from business and legacy Models databases')
  }
  const modelsCatalogDatabasePath = optionalValue(env, 'ANYBOX_MODELS_CATALOG_DATABASE') ?? join(dirname(modelsDatabasePath), 'models-catalog.sqlite')
  if ([harnessDatabasePath, modelsDatabasePath, modelsConfigPath].some(path => resolve(path) === resolve(modelsCatalogDatabasePath))) {
    throw new TypeError('ANYBOX_MODELS_CATALOG_DATABASE must be different from Models and harness server databases')
  }
  const credentialNamespace = optionalValue(env, 'ANYBOX_MODELS_NAMESPACE') ?? 'anybox.models'
  return Object.freeze({
    port, harnessDatabasePath, imageAssetsDirectory, modelsDatabasePath, modelsConfigPath, modelsCatalogDatabasePath, credentialNamespace,
    legacy: Object.freeze({
      provider: Object.freeze({ name: api === 'openai-responses' ? 'OpenAI（迁入）' : 'DeepSeek（迁入）', enabled: true,
        protocolId: api === 'openai-responses' ? 'responses' : 'chat-completions', baseUrl, auth: 'api-key' as const, timeoutMs }),
      remoteModelId: configuredModel ?? 'deepseek-flash',
      parameters: Object.freeze({ protocolId: api === 'openai-responses' ? 'responses' : 'chat-completions', formatVersion: 1 as const, value: Object.freeze({ ...(temperature === undefined ? {} : { temperature }), ...(maxOutputTokens === undefined ? {} : { [api === 'openai-responses' ? 'max_output_tokens' : 'max_completion_tokens']: maxOutputTokens }) }) }),
      credentialId: api === 'openai-responses' ? 'llm/openai-responses/default' : 'llm/chat-completions/default',
    }),
  })
}
