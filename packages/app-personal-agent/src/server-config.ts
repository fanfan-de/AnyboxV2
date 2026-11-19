import { dirname, join, resolve } from 'node:path'

export interface HarnessServerConfig {
  readonly port: number
  readonly harnessDatabasePath: string
  readonly imageAssetsDirectory: string
  readonly modelsDatabasePath: string
  readonly modelsConfigPath: string
  readonly modelsCatalogDatabasePath: string
  readonly credentialNamespace: string
}
type Environment = Readonly<Record<string, string | undefined>>

function optionalValue(env: Environment, name: string): string | undefined {
  const value = env[name]
  if (value === undefined) return undefined
  if (!value.trim() || value.includes('\0')) throw new TypeError(`${name} must not be empty or contain NUL`)
  return value.trim()
}

/** The existing Personal Agent Models JSON and Vault remain valid in the new execution role. */
export function parsePersonalAgentServerConfig(env: Environment, clientDatabasePath = env.ANYBOX_CLIENT_DATABASE ?? './data/client.sqlite'): HarnessServerConfig {
  const port = Number(optionalValue(env, 'ANYBOX_PERSONAL_AGENT_EXECUTION_PORT') ?? 0)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('ANYBOX_PERSONAL_AGENT_EXECUTION_PORT must be a TCP port')
  const data = dirname(resolve(clientDatabasePath))
  const harnessDatabasePath = optionalValue(env, 'ANYBOX_PERSONAL_AGENT_EXECUTION_DATABASE') ?? join(data, 'personal-agent-execution.sqlite')
  const imageAssetsDirectory = optionalValue(env, 'ANYBOX_PERSONAL_AGENT_IMAGE_ASSETS_DIRECTORY') ?? `${harnessDatabasePath}.images`
  const modelsDatabasePath = optionalValue(env, 'ANYBOX_PERSONAL_AGENT_MODELS_DATABASE') ?? join(data, 'personal-agent-models.sqlite')
  const modelsConfigPath = optionalValue(env, 'ANYBOX_PERSONAL_AGENT_MODELS_CONFIG') ?? join(data, 'personal-agent-models.json')
  const modelsCatalogDatabasePath = optionalValue(env, 'ANYBOX_PERSONAL_AGENT_MODELS_CATALOG_DATABASE') ?? join(data, 'personal-agent-models-catalog.sqlite')
  const paths = [clientDatabasePath, harnessDatabasePath, modelsDatabasePath, modelsConfigPath, modelsCatalogDatabasePath, imageAssetsDirectory]
  if (new Set(paths.map(path => resolve(path))).size !== paths.length) throw new TypeError('Personal Agent data paths must be distinct')
  const credentialNamespace = optionalValue(env, 'ANYBOX_PERSONAL_AGENT_MODELS_NAMESPACE') ?? 'anybox.personal-agent.models'
  return Object.freeze({ port, harnessDatabasePath, imageAssetsDirectory, modelsDatabasePath, modelsConfigPath, modelsCatalogDatabasePath, credentialNamespace })
}
