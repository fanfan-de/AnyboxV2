import { packageFileModeMatches } from './filesystem-platform.js'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { PackageIdentity } from './port.js'
import type { VerifiedApplicationArchive } from './archive.js'
import { identityKey } from './domain.js'
import { installedPackageError, loaderFailure } from './loader-files.js'

interface Graph { readonly directory: string; readonly root: { readonly dev: number; readonly ino: number }; readonly identity: string; readonly packageIdentity: PackageIdentity; readonly files: ReadonlyMap<string, { readonly sha256: string; readonly mode: number; readonly size: number }> }
const graphs = new Map<string, Graph>()
const appIdentities = new Map<string, string>()
const sharedNames = ['@nya/core', '@anybox/application-api', '@anybox/storage-sqlite']
const shared = (specifier: string) => sharedNames.some(name => specifier === name || specifier.startsWith(name + '/'))
const trustedHostModules = new Set<string>([import.meta.url])
let hooksInstalled = false
const within = (root: string, path: string) => { const name = relative(root, path); return name !== '..' && !name.startsWith('..' + sep) && !isAbsolute(name) }
const graphFor = (url: string | undefined): Graph | undefined => {
  if (!url?.startsWith('file:')) return undefined
  const file = fileURLToPath(url)
  return [...graphs.values()].find(graph => within(graph.directory, file))
}
const privateShared = (graph: Graph, path: string) => /(?:^|\/)node_modules\/(?:@nya\/core|@anybox\/application-api|@anybox\/storage-sqlite)(?:\/|$)/.test(relative(graph.directory, path).split('\\').join('/'))
function verify(graph: Graph, path: string, source?: string | ArrayBuffer | ArrayBufferView | null): void {
  try { verifyFile(graph, path, source) } catch (error) {
    const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined
    const normalized = code === 'ENOENT' ? loaderFailure('package-loader-content-missing') : code === 'ENOTDIR' || code === 'ELOOP' ? loaderFailure('package-loader-path-unsafe') : error
    throw installedPackageError(normalized, graph.packageIdentity)
  }
}
function verifyFile(graph: Graph, path: string, source?: string | ArrayBuffer | ArrayBufferView | null): void {
  const root = lstatSync(graph.directory)
  if (!root.isDirectory() || root.isSymbolicLink() || root.dev !== graph.root.dev || root.ino !== graph.root.ino || realpathSync(graph.directory) !== graph.directory) throw loaderFailure('package-loader-directory-changed')
  const item = graph.files.get(path)
  if (privateShared(graph, path)) throw loaderFailure('package-loader-private-shared-runtime')
  if (!item || realpathSync(path) !== path) throw loaderFailure('package-loader-module-not-indexed')
  let directory = dirname(path)
  while (within(graph.directory, directory)) {
    const info = lstatSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw loaderFailure('package-loader-path-unsafe')
    if (directory === graph.directory) break
    directory = dirname(directory)
  }
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== item.size || !packageFileModeMatches(info.mode, item.mode)) throw loaderFailure('package-loader-module-changed')
  const bytes = typeof source === 'string' ? Buffer.from(source) : source instanceof ArrayBuffer ? Buffer.from(source) : source && ArrayBuffer.isView(source) ? Buffer.from(source.buffer, source.byteOffset, source.byteLength) : readFileSync(path)
  if (createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw loaderFailure('package-loader-module-changed')
}
function installHooks(): void {
  if (hooksInstalled) return
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || major === 22 && minor < 15 || typeof registerHooks !== 'function') throw loaderFailure('package-loader-runtime-unavailable')
  registerHooks({
    resolve(specifier, context, next) {
      const from = graphFor(context.parentURL)
      if (from && shared(specifier)) {
        const url = import.meta.resolve(specifier)
        trustedHostModules.add(url)
        return { url, shortCircuit: true }
      }
      const result = next(specifier, context)
      if (result.url.startsWith('file:')) {
        const target = graphFor(result.url), path = fileURLToPath(result.url)
        if (from && (!target || target !== from)) throw loaderFailure('package-loader-module-outside-payload')
        if (target) verify(target, path)
        else if (trustedHostModules.has(context.parentURL ?? '')) trustedHostModules.add(result.url)
      } else if (from && !result.url.startsWith('node:')) throw loaderFailure('package-loader-module-not-indexed')
      return result
    },
    load(url, context, next) {
      const graph = graphFor(url)
      if (graph) verify(graph, fileURLToPath(url))
      const result = next(url, context)
      if (graph) verify(graph, fileURLToPath(url), result.source)
      return result
    },
  })
  hooksInstalled = true
}

/** The fixed resolver remains installed for lazy imports through this process's real lifetime. */
export function registerInstalledApplicationModules(directory: string, archive: VerifiedApplicationArchive): { importEntry(path: string): Promise<Record<string, unknown>> } {
  installHooks()
  directory = resolve(directory)
  if (realpathSync(directory) !== directory) throw loaderFailure('package-loader-directory-unsafe')
  const identity = identityKey(archive.identity), previous = appIdentities.get(archive.identity.appId)
  if (previous && previous !== identity) throw loaderFailure('package-loader-process-restart-required')
  const existing = graphs.get(directory)
  if (existing && existing.identity !== identity) throw loaderFailure('package-loader-process-restart-required')
  if (!existing) {
    const info = lstatSync(directory)
    const graph: Graph = Object.freeze({ directory, root: { dev: info.dev, ino: info.ino }, identity, packageIdentity: archive.identity, files: new Map(archive.files.map(file => [resolve(directory, file.path), { sha256: file.sha256, mode: file.mode, size: file.size }])) })
    graphs.set(directory, graph); appIdentities.set(archive.identity.appId, identity)
  }
  return Object.freeze({ async importEntry(path: string) {
    const file = resolve(directory, path), graph = graphs.get(directory)!
    if (!within(directory, file)) throw loaderFailure('package-loader-module-outside-payload')
    verify(graph, file)
    return await import(pathToFileURL(file).href) as Record<string, unknown>
  } })
}
