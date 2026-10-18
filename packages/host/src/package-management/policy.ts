import { createPublicKey } from 'node:crypto'
import { isBuiltin } from 'node:module'
import { parseApplicationArchiveJson } from './archive.js'
import type { ApplicationArchivePublisher, ApplicationArchiveRuntimeProfile } from './archive.js'
import type { ApplicationPreparationOptions } from './preparation.js'
import { readApplicationPackageFile } from './archive-file.js'

/** Administrative trust comes from the host launcher, never an uploaded archive or HTTP request. */
export interface ApplicationTrustPolicy {
  readonly trustedPublishers: readonly ApplicationArchivePublisher[]
  readonly trustedAliases?: ApplicationPreparationOptions['trustedAliases']
}
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const invalid = (): never => { throw new Error('Invalid publisher trust policy') }
export function parseApplicationTrustPolicy(value: unknown): ApplicationTrustPolicy {
  if (!plain(value) || value.schemaVersion !== 1 || Object.keys(value).some(key => !['schemaVersion', 'publishers', 'applications'].includes(key)) || !Array.isArray(value.publishers) || value.publishers.length > 1024) return invalid()
  const seen = new Set<string>()
  const trustedPublishers = value.publishers.map(item => {
    if (!plain(item) || Object.keys(item).some(key => !['publisher', 'keyId', 'publicKey', 'appIds'].includes(key)) ||
      typeof item.publisher !== 'string' || !item.publisher.trim() || item.publisher.length > 200 ||
      typeof item.keyId !== 'string' || !item.keyId.trim() || item.keyId.length > 200 || typeof item.publicKey !== 'string' ||
      !Array.isArray(item.appIds) || !item.appIds.length || item.appIds.length > 1024 || item.appIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id))) return invalid()
    const key = createPublicKey(item.publicKey)
    if (key.asymmetricKeyType !== 'ed25519') return invalid()
    const identity = JSON.stringify([item.publisher, item.keyId])
    if (seen.has(identity)) return invalid()
    seen.add(identity)
    return Object.freeze({ publisher: item.publisher, keyId: item.keyId, publicKey: key.export({ format: 'pem', type: 'spki' }).toString(), appIds: Object.freeze([...item.appIds]) as readonly string[] })
  })
  let trustedAliases: ApplicationPreparationOptions['trustedAliases']
  if (value.applications !== undefined) {
    if (!plain(value.applications)) return invalid()
    const entries: [string, NonNullable<ApplicationPreparationOptions['trustedAliases']>[string]][] = []
    for (const [id, aliases] of Object.entries(value.applications)) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id) || !plain(aliases) || Object.keys(aliases).some(key => !['assetPrefixes', 'routePrefixes', 'webLegacyRoutes'].includes(key))) return invalid()
      const copy: Record<string, readonly string[]> = {}
      for (const [name, list] of Object.entries(aliases)) {
        if (!Array.isArray(list) || list.some(prefix => typeof prefix !== 'string' || prefix.length > 2048 || /[\\\0?]/.test(prefix) ||
          (name === 'webLegacyRoutes' ? !prefix.startsWith('#/') || prefix.slice(1).includes('#') : !prefix.startsWith('/') || prefix.includes('#')))) return invalid()
        copy[name] = Object.freeze([...list]) as readonly string[]
      }
      entries.push([id, Object.freeze(copy)])
    }
    trustedAliases = Object.freeze(Object.fromEntries(entries))
  }
  return Object.freeze({ trustedPublishers: Object.freeze(trustedPublishers), ...(trustedAliases ? { trustedAliases } : {}) })
}
export async function readApplicationTrustPolicy(path: string, signal?: AbortSignal): Promise<ApplicationTrustPolicy> {
  return parseApplicationTrustPolicy(parseApplicationArchiveJson(await readApplicationPackageFile(path, 1024 * 1024, signal)))
}

/** These profiles describe this process, rather than accepting a package's runtime assertions. */
export function currentApplicationRuntimeProfile(): ApplicationArchiveRuntimeProfile {
  const header = process.platform === 'linux' ? process.report.getReport() as { header?: { glibcVersionRuntime?: string } } : undefined
  return { profile: 'anybox-node-runtime-1', sharedRuntime: 'nya-runtime-1', platform: process.platform, node: process.versions.node,
    nodeApi: Number(process.versions.napi), modules: process.versions.modules, sqlite: isBuiltin('node:sqlite'),
    ...(process.platform === 'linux' ? { libc: header?.header?.glibcVersionRuntime ? 'glibc' as const : 'musl' as const } : {}) }
}

