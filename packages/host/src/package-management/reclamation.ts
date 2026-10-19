import { syncPackageDirectory } from './filesystem-platform.js'
import { constants, fstatSync, lstatSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs'
import { open, readdir, realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { join, resolve } from 'node:path'
import { identity, identityKey, identifier } from './domain.js'
import { packageRegistryFailure } from './port.js'
import type { PackageActivation, PackageIdentity, PackageRegistryPort } from './port.js'

type ReclamationRegistry = Pick<PackageRegistryPort, 'getActivation' | 'getOperation' | 'inspect' | 'withReclamation' | 'completeRemoval'>
export interface RemovedApplicationReclamationOptions {
  readonly registry: ReclamationRegistry
  readonly directory: string
  readonly activationId: string
}
interface Directory { readonly path: string; readonly handle: FileHandle; readonly identity: Stats }
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino
const failure = (code: string, cause?: unknown) => Object.assign(new Error(`Package reclamation: ${code}`, cause === undefined ? undefined : { cause }), { code })
const missing = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
function fsFailure(error: unknown): never {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && error.code.startsWith('package-reclamation-')) throw error
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  throw failure(code === 'ENOENT' ? 'package-reclamation-directory-changed' : code === 'ENOTDIR' || code === 'ELOOP' ? 'package-reclamation-path-unsafe' : 'package-reclamation-failed', error)
}
function assertDirectories(chain: readonly Directory[], signal?: AbortSignal): void {
  if (signal?.aborted) throw failure('package-reclamation-interrupted')
  for (const item of chain) {
    const current = lstatSync(item.path), held = fstatSync(item.handle.fd)
    if (!current.isDirectory() || current.isSymbolicLink() || !same(current, item.identity) || !same(held, item.identity) || realpathSync(item.path) !== item.path) throw failure('package-reclamation-directory-changed')
  }
}
async function openDirectory(path: string, parents: readonly Directory[]): Promise<Directory> {
  assertDirectories(parents)
  const before = lstatSync(path)
  if (!before.isDirectory() || before.isSymbolicLink() || parents.length && before.dev !== parents[0]!.identity.dev || realpathSync(path) !== path) throw failure('package-reclamation-path-unsafe')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY)
  try {
    const item = { path, handle, identity: before }
    assertDirectories([...parents, item])
    return item
  } catch (error) { await handle.close(); throw error }
}
async function removeDirectory(item: Directory, parents: readonly Directory[], signal: AbortSignal): Promise<void> {
  const chain = [...parents, item]
  assertDirectories(chain, signal)
  const names = await readdir(item.path)
  assertDirectories(chain, signal)
  for (const name of names) {
    const path = join(item.path, name)
    assertDirectories(chain, signal)
    const entry = lstatSync(path)
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const child = await openDirectory(path, chain)
      try { await removeDirectory(child, chain, signal) } finally { await child.handle.close() }
    } else {
      // unlink removes only this owned directory entry. It never opens a link's target.
      if (!entry.isFile() && !entry.isSymbolicLink()) throw failure('package-reclamation-content-unsafe')
      assertDirectories(chain, signal)
      if (!same(entry, lstatSync(path))) throw failure('package-reclamation-directory-changed')
      unlinkSync(path)
    }
  }
  assertDirectories(chain, signal)
  await syncPackageDirectory(item.handle)
  // The last identity check and namespace mutation share one synchronous turn.
  assertDirectories(chain, signal)
  rmdirSync(item.path)
  const parent = parents[parents.length - 1]!
  assertDirectories(parents, signal)
  await syncPackageDirectory(parent.handle)
  assertDirectories(parents, signal)
}

/** Captures the exact physical namespace before entering the registry's destructive callback. */
async function captureContainer(root: Directory, value: PackageIdentity): Promise<{ remove(signal: AbortSignal): Promise<void>; close(): Promise<void> }> {
  const item = identity(value), chain = [root]
  let absent: string | undefined
  try {
    for (const part of ['packages', item.appId, item.version, item.digest]) {
      const path = join(chain[chain.length - 1]!.path, part)
      try { chain.push(await openDirectory(path, chain)) } catch (error) { if (!missing(error)) throw error; absent = path; break }
    }
  } catch (error) { await Promise.allSettled(chain.slice(1).reverse().map(item => item.handle.close())); fsFailure(error) }
  return {
    async remove(signal) {
      try {
        assertDirectories(chain, signal)
        if (absent) {
          // An earlier attempt may have deleted this exact container before its ledger commit.
          try { lstatSync(absent); throw failure('package-reclamation-directory-changed') } catch (error) { if (!missing(error)) throw error }
          await syncPackageDirectory(chain[chain.length - 1]!.handle)
          assertDirectories(chain, signal)
          try { lstatSync(absent); throw failure('package-reclamation-directory-changed') } catch (error) { if (!missing(error)) throw error }
        } else await removeDirectory(chain[chain.length - 1]!, chain.slice(0, -1), signal)
      } catch (error) { fsFailure(error) }
    },
    async close() { const results = await Promise.allSettled(chain.slice(1).reverse().map(item => item.handle.close())); const failed = results.find(result => result.status === 'rejected'); if (failed?.status === 'rejected') fsFailure(failed.reason) },
  }
}

/** Deletes only recorded immutable code containers, under the registry's real usage-exit proof. */
export async function reclaimRemovedApplicationPackages(options: RemovedApplicationReclamationOptions): Promise<PackageActivation> {
  const { registry } = options, activationId = identifier(options.activationId)
  const batch = await registry.getActivation(activationId)
  if (!batch) throw packageRegistryFailure('not-found')
  if (batch.kind !== 'remove' || batch.phase !== 'reclaiming') throw packageRegistryFailure('transition-invalid')
  let root: Directory
  try { root = await openDirectory(await realpath(resolve(options.directory)), []) } catch (error) { fsFailure(error) }
  try {
    const seen = new Set<string>()
    for (const target of batch.targets) {
      const key = identityKey(target.identity)
      if (seen.has(key)) throw packageRegistryFailure('registry-corrupt')
      seen.add(key)
      const operation = await registry.getOperation(target.operationId), facts = (await registry.inspect()).applications.find(item => item.appId === target.identity.appId)
      if (!operation || operation.kind !== 'remove' || identityKey(operation.identity) !== key || !facts) throw packageRegistryFailure('registry-corrupt')
      const installation = facts.installed.find(item => identityKey(item.identity) === key)
      if (operation.phase === 'completed' && installation?.state === 'removed') continue
      if (!installation || installation.state === 'removed') throw packageRegistryFailure('registry-corrupt')
      const container = await captureContainer(root, target.identity)
      try {
        await registry.withReclamation({ operationId: operation.id, expectedRevision: operation.revision, expectedAppRevision: facts.revision }, async (selected, signal, anchor) => {
          if (identityKey(selected) !== key) throw packageRegistryFailure('registry-corrupt')
          // The registry owns this anchor from its original initialization. A
          // fresh realpath of a replaced input must never authorize a new root.
          if (!anchor || anchor.directory !== root.path || anchor.device !== root.identity.dev || anchor.inode !== root.identity.ino) throw failure('package-reclamation-directory-changed')
          assertDirectories([root], signal)
          await container.remove(signal)
        })
      } finally { await container.close() }
    }
    const current = await registry.getActivation(activationId)
    if (!current || current.kind !== 'remove' || current.phase !== 'reclaiming') throw packageRegistryFailure('transition-invalid')
    return await registry.completeRemoval({ activationId, expectedRevision: current.revision })
  } finally { try { await root.handle.close() } catch (error) { fsFailure(error) } }
}
