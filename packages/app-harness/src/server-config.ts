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
/** harness server configuration is validated before resources are installed. Existing model edits stay in Models storage. */
export function parseHarnessServerConfig(env: Environment): HarnessServerConfig {
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
  for (const name of ['ANYBOX_COMPUTER_UNIT', 'ANYBOX_COMPUTER_ATTACHMENT']) {
    if (env[name] !== undefined && env[name]!.trim()) throw new TypeError(`${name} is no longer supported; remove it and select the Computer environment per project. The default is this harness server's local environment.`)
  }
  return Object.freeze({
    port, harnessDatabasePath, imageAssetsDirectory, modelsDatabasePath, modelsConfigPath, modelsCatalogDatabasePath, credentialNamespace,
  })
}
