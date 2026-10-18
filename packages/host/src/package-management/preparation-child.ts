/** Fixed host preparation runner. It never creates a Context, runtime or business service. */
import { readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isAbsolute, relative, resolve } from 'node:path'
import { createApplicationCatalog } from '../applications/registration.js'
import type { ApplicationRegistration } from '@anybox/application-api/node'
import { acquirePackageUsageLock } from './usage-locks.js'
import type { PackageUsageLock } from './usage-locks.js'

interface Request {
  readonly directory: string
  readonly entry: string
  readonly appId: string
  readonly role: 'client' | 'execution'
  readonly files: readonly { path: string; sha256: string }[]
  readonly lifetime?: { readonly directory: string; readonly usageId: string }
}
const code = (value: string) => Object.assign(new Error(value), { code: value })
const request: Request = JSON.parse(readFileSync(process.argv[2], 'utf8'))
let lifetimeLock: PackageUsageLock | undefined
// Retain the lock object through actual process exit, including async factory work.
process.once('exit', () => { void lifetimeLock?.release() })
if (request.lifetime) {
  const parentExited = () => {
    // This runner is a dedicated Unix process-group leader. A dead manager does
    // not leave its pure preparation process and descendants running indefinitely.
    try { process.kill(-process.pid, 'SIGKILL') } catch { process.exit(1) }
  }
  process.once('disconnect', parentExited)
  if (!process.connected) parentExited()
}
const directory = realpathSync(request.directory)
const expected = new Map(request.files.map(file => [resolve(directory, file.path), file.sha256]))
const inside = (file: string) => { const path = relative(directory, file); return path !== '..' && !path.startsWith('../') && !isAbsolute(path) }
const verify = (file: string, bytes = readFileSync(file)) => {
  const actual = realpathSync(file)
  if (actual !== file || !inside(actual) || createHash('sha256').update(bytes).digest('hex') !== expected.get(file)) throw code('package-preparation-file-changed')
}
const trustedHostModules = new Set([import.meta.url])
const privateSharedPath = (file: string) => /(?:^|\/)node_modules\/(?:@nya\/core|@anybox\/application-api|@anybox\/storage-sqlite)(?:\/|$)/.test(relative(directory, file).split('\\').join('/'))
const shared = (specifier: string) => ['@nya/core', '@anybox/application-api', '@anybox/storage-sqlite'].some(name => specifier === name || specifier.startsWith(name + '/'))
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith('file:') && inside(fileURLToPath(context.parentURL)) && shared(specifier)) {
      // Only fixed public package names are shared. The archive cannot supply a resolver map.
      const url = import.meta.resolve(specifier)
      trustedHostModules.add(url)
      return { url, shortCircuit: true }
    }
    const fromPayload = !!context.parentURL?.startsWith('file:') && inside(fileURLToPath(context.parentURL))
    const result = next(specifier, context)
    if (result.url.startsWith('file:')) {
      const file = fileURLToPath(result.url)
      if (fromPayload && !inside(file)) throw code('package-preparation-module-outside-payload')
      if (!inside(file) && !trustedHostModules.has(context.parentURL ?? '')) throw code('package-preparation-module-not-indexed')
      if (inside(file)) {
        if (privateSharedPath(file)) throw code('package-preparation-private-shared-runtime')
        verify(file)
      } else trustedHostModules.add(result.url)
    } else if (fromPayload && !result.url.startsWith('node:')) throw code('package-preparation-module-not-indexed')
    return result
  },
  load(url, context, next) {
    const result = next(url, context)
    if (url.startsWith('file:')) {
      const file = fileURLToPath(url)
      if (inside(file)) {
        const source = result.source
        verify(file, typeof source === 'string' ? Buffer.from(source) : source instanceof Uint8Array ? Buffer.from(source) : readFileSync(file))
      }
    }
    return result
  },
})
function noAccessors(value: unknown, depth = 0, seen = new Set<object>()): void {
  if (depth > 32) throw code('package-registration-invalid')
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  if (Object.getOwnPropertySymbols(value).length) throw code('package-registration-invalid')
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor)) throw code('package-registration-accessor')
    if (typeof descriptor.value !== 'function') noAccessors(descriptor.value, depth + 1, seen)
  }
}
async function main() {
  if (request.lifetime) {
    const secret = await new Promise<string>((resolveSecret, reject) => {
      process.once('message', message => {
        if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'preparation-lifetime' || !('secret' in message) || typeof message.secret !== 'string') { reject(code('package-preparation-lifetime-invalid')); return }
        resolveSecret(message.secret)
      })
      process.send?.({ type: 'preparation-lifetime-ready' })
    })
    lifetimeLock = acquirePackageUsageLock(request.lifetime.directory, { usageId: request.lifetime.usageId, secret })
  }
  // Keep the actual read lock through process exit, including result IPC. It must
  // not be released while descendants or native cleanup can still use the files.
  const module = await import(pathToFileURL(resolve(directory, request.entry)).href)
  if (typeof module.createRegistration !== 'function') throw code('package-registration-factory-missing')
  const registration: ApplicationRegistration = await module.createRegistration(Object.freeze({ phase: 'prepare', role: request.role, appId: request.appId }))
  noAccessors(registration)
  const catalog = createApplicationCatalog([registration])
  const checked = catalog.applications[0]
  if (checked.definition.id !== request.appId) throw code('package-registration-id-mismatch')
  const assets = (checked.assets ?? []).map(asset => {
    if (typeof asset.file !== 'string' || !isAbsolute(asset.file)) throw code('package-registration-asset-invalid')
    const file = realpathSync(asset.file)
    verify(file)
    return { path: asset.path, file: relative(directory, file).split('\\').join('/'), type: asset.type }
  })
  return { definition: checked.definition, capabilityRequirements: checked.capabilityRequirements,
    hasRuntime: typeof checked.createRuntime === 'function', ...(checked.channel ? { hasChannel: true } : {}), http: checked.http, assets }
}
void main().then(
  registration => process.send?.({ ok: true, registration }, () => process.exit(0)),
  error => process.send?.({ ok: false, code: typeof error?.code === 'string' && /^[a-z0-9-]{1,100}$/.test(error.code) ? error.code : 'package-registration-invalid' }, () => process.exit(1)),
)
