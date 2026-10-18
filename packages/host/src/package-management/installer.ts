import { randomBytes, randomUUID, createHash, createPublicKey } from 'node:crypto'
import { resolve, join } from 'node:path'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import type { Component } from '@nya/core'
import { defaultApplicationArchiveLimits, verifyApplicationPackage, isApplicationDirectorySnapshot, type VerifyApplicationArchiveOptions, type VerifiedApplicationArchive } from './archive.js'
import { prepareApplicationArchive, type ApplicationPreparationOptions, type PreparedApplicationArchive } from './preparation.js'
import { captureCommand, identifier, identityKey } from './domain.js'
import { createInstallationFiles, installerFailure, type InstallationFiles } from './installer-files.js'
import { acquirePackageUsageLock, prepareUsageLock, tryAcquirePackageUsageExitLock, type PackageUsageLock } from './usage-locks.js'
import { packageRegistryServiceKey, type PackageFileInstall, type PackageFileInstallIntent, type PackageReceiptValue, type PackageRegistryPort } from './port.js'
import { packageSourceFilename } from './package-source.js'

export const packageInstallerServiceKey = 'host.package-installer'
export type PackageInstallerBoundary = 'accepted' | 'receiving' | 'received' | 'verified' | 'prepared' | 'materialized' | 'before-rename' | 'after-rename' | 'before-ledger' | 'after-ledger'
/** cancel must stop the producer; done confirms its resource exit, including an outstanding next(). */
export interface PackageInstallSource { readonly chunks: AsyncIterable<Uint8Array>; readonly cancel: (reason?: unknown) => void; readonly done: Promise<void> }
export interface PackageInstallerPort {
  accept(input: PackageFileInstallIntent): Promise<PackageFileInstall>
  receive(installId: string, source: Readable | PackageInstallSource, options?: { signal?: AbortSignal }): Promise<PackageFileInstall>
  get(installId: string): Promise<PackageFileInstall | undefined>
  list(): Promise<readonly PackageFileInstall[]>
  cancel(installId: string): Promise<PackageFileInstall>
  recover(installId: string, input?: { action: 'inspect' | 'resume' | 'discard' }): Promise<PackageFileInstall>
  inspectOrphans(): Promise<readonly string[]>
  closeAdmission(): void
  awaitIdle(): Promise<void>
}
export interface PackageInstallerConfig {
  readonly directory: string
  readonly verification: Omit<VerifyApplicationArchiveOptions, 'signal'>
  readonly preparation?: Omit<ApplicationPreparationOptions, 'signal' | 'lifetime' | 'temporaryRoot'>
  /** Trusted fault-injection/observability hook. No environment variable can enable it. */
  readonly onBoundary?: (boundary: PackageInstallerBoundary, install: PackageFileInstall) => Promise<void> | void
}
interface Guard { id: string; digest: string }
interface Attempt { controller: AbortController; done: Promise<PackageFileInstall> }
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function fail(code: string): never { throw installerFailure(code) }
const terminal = (phase: PackageFileInstall['phase']) => phase === 'installed' || phase === 'failed' || phase === 'cancelled'
const frozen = <T>(value: T): T => { if (value && typeof value === 'object') { for (const item of Object.values(value)) frozen(item); Object.freeze(value) } return value }
const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(error.code) ? error.code : 'installation-failed'
const receiptObject = (job: PackageFileInstall): Record<string, PackageReceiptValue> => job.receipt && typeof job.receipt === 'object' && !Array.isArray(job.receipt) ? { ...job.receipt as Record<string, PackageReceiptValue> } : {}
function guardsFor(job: PackageFileInstall): readonly { id: string }[] {
  if (!Array.isArray(job.workGuardIds) || job.workGuardIds.some(id => typeof id !== 'string' || !/^install-[a-zA-Z0-9_-]{1,120}$/.test(id))) fail('installation-guard-corrupt')
  return job.workGuardIds.map(id => ({ id }))
}
function captureVerification(input: PackageInstallerConfig['verification']): PackageInstallerConfig['verification'] {
  return frozen({ ...structuredClone({ ...input, trustedPublishers: [] }), trustedPublishers: input.trustedPublishers.map(item => ({ ...item, appIds: [...item.appIds], publicKey: (typeof item.publicKey === 'string' ? createPublicKey(item.publicKey) : item.publicKey).export({ type: 'spki', format: 'pem' }).toString() })) })
}
function capturePreparation(input: PackageInstallerConfig['preparation']): PackageInstallerConfig['preparation'] {
  if (!input) return {}
  const { existingApplications, ...plain } = input
  return frozen({ ...structuredClone(plain), ...(existingApplications ? { existingApplications: existingApplications.map(application => ({ ...structuredClone({ ...application, createRuntime: undefined }), ...(application.createRuntime ? { createRuntime: application.createRuntime } : {}) })) } : {}) })
}
function sourceFor(input: Readable | PackageInstallSource): PackageInstallSource {
  if (input instanceof Readable) {
    const done = finished(input, { cleanup: true }).then(() => {})
    // A rejection may happen before the receive task is scheduled; retain the actual exit promise.
    void done.catch(() => {})
    return { chunks: input, cancel: reason => { if (!input.destroyed) input.destroy(reason instanceof Error ? reason : installerFailure('installation-cancelled')) }, done }
  }
  if (!input || typeof input !== 'object' || typeof input.cancel !== 'function' || !(input.done instanceof Promise) || !input.chunks || typeof input.chunks[Symbol.asyncIterator] !== 'function') fail('installation-source-invalid')
  void input.done.catch(() => {})
  return { chunks: input.chunks, cancel: input.cancel.bind(input), done: input.done }
}

/** Files, signatures and lifecycle receipts only. This component never starts an application runtime. */
export function createPackageInstallerComponent(config: PackageInstallerConfig): Component.Object<void, { [packageRegistryServiceKey]: PackageRegistryPort }> {
  if (typeof config.directory !== 'string' || !config.directory.trim() || config.directory.includes('\0')) fail('installation-config-invalid')
  const directoryInput = resolve(config.directory), verification = captureVerification(config.verification), preparation = capturePreparation(config.preparation), onBoundary = config.onBoundary
  if (onBoundary !== undefined && typeof onBoundary !== 'function') fail('installation-config-invalid')
  const maximum = verification.limits?.archiveBytes ?? defaultApplicationArchiveLimits.archiveBytes
  return { name: 'host-package-installer', inject: [packageRegistryServiceKey], async apply(ctx, _config, deps) {
    const registry = deps[packageRegistryServiceKey], files = await createInstallationFiles(directoryInput)
    let accepting = true
    const pending = new Set<Promise<unknown>>(), active = new Map<string, Attempt>(), cleanupErrors = new Set<unknown>()
    const fence = (error: unknown) => { cleanupErrors.add(error); accepting = false; for (const attempt of active.values()) attempt.controller.abort(error) }
    const track = <T>(work: () => Promise<T>): Promise<T> => {
      if (!accepting) return Promise.reject(installerFailure('service-closing'))
      const promise = Promise.resolve().then(work); pending.add(promise)
      void promise.finally(() => pending.delete(promise)).catch(() => {})
      return promise
    }
    const get = async (id: string): Promise<PackageFileInstall> => { const job = await registry.getFileInstall(identifier(id)); if (!job) fail('not-found'); return job }
    const update = async (job: PackageFileInstall, phase: PackageFileInstall['phase'], extra: Record<string, PackageReceiptValue> = {}, code?: string): Promise<PackageFileInstall> => registry.advanceFileInstall({ installId: job.id, expectedRevision: job.revision, phase, receipt: { ...receiptObject(job), ...extra }, ...(code ? { errorCode: code } : {}) })
    const boundary = async (name: PackageInstallerBoundary, job: PackageFileInstall, signal?: AbortSignal) => { await onBoundary?.(name, job); signal?.throwIfAborted() }
    async function proveGuards(job: PackageFileInstall): Promise<void> {
      await files.assertRoot()
      for (const guard of guardsFor(job)) {
        const lock = tryAcquirePackageUsageExitLock(files.directory, guard.id)
        if (!lock) fail('installation-work-exit-unconfirmed')
        try { lock.revoke() } finally { await lock.release() }
      }
    }
    async function markRecovery(job: PackageFileInstall, error: unknown): Promise<PackageFileInstall> {
      const code = errorCode(error)
      try {
        const current = await get(job.id)
        if (current.phase === 'installed') return current
        if (current.phase === 'recovery-required') return await update(current, 'recovery-required', { failure: code }, code)
        return await update(current, 'recovery-required', { failure: code }, code)
      } catch (receiptError) { fence(receiptError); throw receiptError }
    }
    async function guardAttempt(job: PackageFileInstall) {
      const secret = randomBytes(32).toString('base64url'), guard: Guard = { id: `install-${randomUUID()}`, digest: hash(Buffer.from(secret)) }
      const updated = await registry.advanceFileInstall({ installId: job.id, expectedRevision: job.revision, phase: job.phase, workGuardId: guard.id, receipt: receiptObject(job) })
      prepareUsageLock(files.directory, guard.id, guard.digest)
      const lock = acquirePackageUsageLock(files.directory, { usageId: guard.id, secret })
      return { job: updated, lock, lifetime: { directory: files.directory, usageId: guard.id, secret } }
    }
    async function readArchive(job: PackageFileInstall, signal: AbortSignal): Promise<{ bytes: Buffer; archive: VerifiedApplicationArchive }> {
      signal.throwIfAborted()
      const sourceName = packageSourceFilename(job), staged = join(files.stage(job), sourceName)
      const path = await files.exists(staged) ? staged : job.identity ? join(files.final(job.identity), sourceName) : staged
      const bytes = await files.read(path, job.archiveSize)
      if (bytes.length !== job.archiveSize || hash(bytes) !== job.archiveDigest) fail('installation-archive-changed')
      if (isApplicationDirectorySnapshot(bytes) !== (job.sourceFormat === 'directory')) fail('installation-source-format-mismatch')
      const archive = verifyApplicationPackage(bytes, { ...verification, signal, allowUnsignedLocal: job.sourceFormat === 'directory' && job.localTrust === true })
      return { bytes, archive }
    }
    function requirePreparation(archive: VerifiedApplicationArchive, prepared: PreparedApplicationArchive) {
      for (const role of ['client', 'execution'] as const) if (archive.manifest.entries?.[role] && archive.roleCompatibility[role]?.compatible && prepared.roles[role]?.status !== 'prepared') fail('installation-preparation-unavailable')
    }
    const preparationReceipt = (prepared: PreparedApplicationArchive): PackageReceiptValue => Object.fromEntries(Object.entries(prepared.roles).map(([key, value]) => [key, { status: value!.status, reasons: [...value!.reasons] }]))
    async function processArchive(job: PackageFileInstall, signal: AbortSignal, lifetime: { directory: string; usageId: string; secret: string }, releaseAndProve: () => Promise<void>): Promise<PackageFileInstall> {
      const { bytes, archive } = await readArchive(job, signal)
      if (!job.identity) job = await registry.bindFileInstall({ installId: job.id, expectedRevision: job.revision, identity: archive.identity })
      else if (identityKey(job.identity) !== identityKey(archive.identity)) fail('installation-identity-conflict')
      await boundary('verified', job, signal)
      const temporaryRoot = join(files.stage(job), 'preparation')
      await files.ensureDirectory(temporaryRoot)
      const prepared = await prepareApplicationArchive(archive, { ...preparation, signal, lifetime, temporaryRoot })
      requirePreparation(archive, prepared)
      job = await update(job, 'prepared', { stage: 'prepared', preparation: preparationReceipt(prepared) })
      await boundary('prepared', job, signal)
      if (job.existingInstallation) {
        await files.verifyContainer(files.final(archive.identity), job, { ...verification, signal })
        await releaseAndProve(); signal.throwIfAborted()
        // Keep this input until its own receipt is durable. The already installed
        // identity may have arrived via another transport with different bytes.
        await boundary('before-ledger', job, signal)
        const installed = await update(job, 'installed', { stage: 'installed', reused: true })
        await boundary('after-ledger', installed)
        try { await files.discard(installed) } catch (error) { fence(error); throw error }
        return installed
      }
      let candidate: string
      if (await files.exists(files.final(archive.identity))) {
        await files.verifyContainer(files.final(archive.identity), job, { ...verification, signal })
        candidate = join(files.stage(job), 'candidate')
      } else {
        candidate = await files.candidate(job, archive, bytes, signal)
        await boundary('materialized', job, signal)
      }
      await releaseAndProve(); signal.throwIfAborted()
      job = await update(job, 'committing', { stage: 'committing' })
      await boundary('before-rename', job, signal)
      await files.commit(candidate, job, archive, { ...verification, signal })
      await boundary('after-rename', job, signal)
      // Reverify the immutable container before making any installed fact durable.
      await files.verifyContainer(files.final(archive.identity), job, { ...verification, signal })
      await files.discard(job)
      await boundary('before-ledger', job, signal)
      const view = await registry.inspect(), operation = job.operationId ? await registry.getOperation(job.operationId) : undefined
      if (!operation) fail('installation-operation-missing')
      const facts = view.applications.find(item => item.appId === archive.identity.appId)
      await registry.recordInstalled({ operationId: operation.id, expectedRevision: operation.revision, expectedAppRevision: facts?.revision ?? 0, source: { kind: job.sourceFormat === 'directory' ? 'directory' : 'file', reference: job.filename, publisher: archive.manifest.publisher } })
      job = await get(job.id)
      await boundary('after-ledger', job)
      return job
    }
    async function execute(id: string, controller: AbortController, work: (job: PackageFileInstall, signal: AbortSignal, lifetime: { directory: string; usageId: string; secret: string }, releaseAndProve: () => Promise<void>) => Promise<PackageFileInstall>): Promise<PackageFileInstall> {
      let job = await get(id), lock: PackageUsageLock | undefined
      let workError: unknown, result: PackageFileInstall | undefined
      const releaseAndProve = async () => { if (lock) { const owned = lock; lock = undefined; await owned.release() }; job = await get(id); await proveGuards(job) }
      try {
        const guarded = await guardAttempt(job); job = guarded.job; lock = guarded.lock
        result = await work(job, controller.signal, guarded.lifetime, releaseAndProve)
      } catch (error) { workError = error }
      try { await releaseAndProve() } catch (error) { workError = error; fence(error) }
      if (workError) {
        try { job = await get(id) } catch (error) { fence(error); throw error }
        if (job.phase === 'installed') return job
        // A possible rename, unknown child exit or cleanup error remains explicitly recoverable.
        let committed = false
        if (job.identity) try { committed = await files.exists(files.final(job.identity)) } catch { committed = true }
        if (committed || job.phase === 'committing' || errorCode(workError).includes('cleanup') || errorCode(workError).includes('exit-unconfirmed') || !accepting && cleanupErrors.size) return markRecovery(job, workError)
        try {
          await files.discard(job)
          return await update(job, controller.signal.aborted ? 'cancelled' : 'failed', { failure: errorCode(workError), stage: 'settled' }, errorCode(workError))
        } catch (cleanupError) { fence(cleanupError); return markRecovery(job, cleanupError) }
      }
      if (!result) fail('installation-result-missing')
      // Only job-private staging is reclaimed; committed version directories are never removed here.
      if (result.phase !== 'installed') try { await files.discard(result) } catch (error) { fence(error); return markRecovery(result, error) }
      return result
    }
    const start = (id: string, work: (controller: AbortController) => Promise<PackageFileInstall>, signal?: AbortSignal) => {
      id = identifier(id)
      if (!accepting) return Promise.reject(installerFailure('service-closing'))
      if (active.has(id)) return Promise.reject(installerFailure('installation-busy'))
      const controller = new AbortController(), abort = () => controller.abort(signal?.reason)
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
      const done = track(() => work(controller))
      active.set(id, { controller, done })
      void done.finally(() => { active.delete(id); signal?.removeEventListener('abort', abort) }).catch(() => {})
      return done
    }
    const service: PackageInstallerPort = {
      accept: input => {
        let captured: PackageFileInstallIntent
        try { captured = captureCommand(input) } catch { return Promise.reject(installerFailure('invalid-input')) }
        return track(async () => {
          if (captured.archiveSize > maximum) fail('archive-size-limit')
          const job = await registry.acceptFileInstall(captured)
          await boundary('accepted', job)
          return job
        })
      },
      receive(id, input, options = {}) {
        const source = sourceFor(input)
        let sourceCancelled = false
        const cancelSource = (reason?: unknown) => { if (sourceCancelled) return; sourceCancelled = true; try { source.cancel(reason) } catch (error) { fence(error) } }
        return start(id, async controller => {
          let sourceFinished = false
          const abort = () => cancelSource(controller.signal.reason)
          controller.signal.addEventListener('abort', abort, { once: true })
          try {
            const current = await get(id)
            if (current.phase !== 'accepted') { cancelSource(); await source.done.catch(() => {}); if (terminal(current.phase)) return current; fail('installation-recovery-required') }
            return await execute(id, controller, async (job, signal, lifetime, releaseAndProve) => {
              try {
              signal.throwIfAborted(); job = await update(job, 'receiving', { stage: 'receiving' })
              await files.ensureDirectory(files.stage(job)); await boundary('receiving', job, signal)
              const handle = await files.openNew(join(files.stage(job), packageSourceFilename(job))), digest = createHash('sha256')
              let size = 0
              try {
                for await (const chunk of source.chunks) {
                  signal.throwIfAborted()
                  if (!(chunk instanceof Uint8Array) || chunk.length > job.archiveSize - size) fail('installation-upload-size-mismatch')
                  const bytes = Buffer.from(chunk); size += bytes.length; digest.update(bytes); await handle.writeFile(bytes)
                }
                await source.done; sourceFinished = true
                signal.throwIfAborted()
                if (size !== job.archiveSize || digest.digest('hex') !== job.archiveDigest) fail('installation-upload-integrity-mismatch')
                await handle.sync()
              } finally {
                await handle.close()
                if (!sourceFinished) { cancelSource(); await source.done.catch(() => {}); sourceFinished = true }
              }
              await files.writeNew(join(files.stage(job), 'receive.json'), Buffer.from(JSON.stringify({ schemaVersion: 1, installId: job.id, archiveDigest: job.archiveDigest, archiveSize: job.archiveSize, complete: true })))
              await files.syncDirectory(files.stage(job)); await boundary('received', job, signal)
              job = await update(job, 'verifying', { stage: 'verifying', archiveComplete: true })
              return await processArchive(job, signal, lifetime, releaseAndProve)
              } finally { if (!sourceFinished) { cancelSource(); await source.done.catch(() => {}); sourceFinished = true } }
            })
          } finally {
            controller.signal.removeEventListener('abort', abort)
            if (!sourceFinished) { cancelSource(); await source.done.catch(() => {}) }
          }
        }, options.signal).catch(async error => { cancelSource(error); await source.done.catch(() => {}); throw error })
      },
      get: id => track(() => registry.getFileInstall(identifier(id))),
      list: () => track(() => registry.listFileInstalls()),
      cancel(id) {
        const attempt = active.get(identifier(id))
        if (attempt) { attempt.controller.abort(installerFailure('installation-cancelled')); return attempt.done }
        return start(id, async controller => {
          const job = await get(id)
          if (terminal(job.phase)) return job
          if (job.phase !== 'accepted') return markRecovery(job, installerFailure('installation-recovery-required'))
          controller.abort(installerFailure('installation-cancelled'))
          await proveGuards(job)
          try { await files.discard(job); return update(job, 'cancelled', { stage: 'settled' }, 'installation-cancelled') }
          catch (error) { fence(error); return markRecovery(job, error) }
        })
      },
      recover(id, input = { action: 'inspect' }) {
        const action = input.action
        if (!['inspect', 'resume', 'discard'].includes(action)) return Promise.reject(installerFailure('invalid-input'))
        if (action === 'inspect') return track(() => get(id))
        return start(id, async controller => {
          let job = await get(id)
          if (job.phase === 'installed') {
            if (action === 'resume') {
              await files.verifyContainer(files.final(job.identity!), job, verification)
              await proveGuards(job)
              try { await files.discard(job) } catch (error) { fence(error); throw error }
            }
            return job
          }
          if (job.phase !== 'recovery-required') fail('installation-recovery-not-required')
          try { await proveGuards(job) } catch (error) { return markRecovery(job, error) }
          const finalExists = job.identity ? await files.exists(files.final(job.identity)) : false
          if (action === 'discard') {
            if (finalExists) return markRecovery(job, installerFailure('installation-committed-retained'))
            try { await files.discard(job); return await registry.reconcileFileInstall({ installId: job.id, expectedRevision: job.revision, phase: 'cancelled', receipt: { ...receiptObject(job), stage: 'settled' }, errorCode: 'installation-cancelled' }) }
            catch (error) { fence(error); return markRecovery(job, error) }
          }
          try {
            // Explicit resume accepts only a complete original archive, never an abandoned partial stream.
            await readArchive(job, controller.signal)
            job = await registry.reconcileFileInstall({ installId: job.id, expectedRevision: job.revision, phase: 'verifying', receipt: { ...receiptObject(job), stage: 'verifying', archiveComplete: true } })
          } catch (error) { return markRecovery(job, error) }
          return execute(id, controller, async (current, signal, lifetime, releaseAndProve) => {
            // Old attempts are gone and their guards revoked; preserve the admitted original archive.
            await files.discardWork(current)
            return processArchive(current, signal, lifetime, releaseAndProve)
          })
        })
      },
      inspectOrphans: () => track(async () => files.listOrphans(await registry.listFileInstalls())),
      closeAdmission() { accepting = false; for (const attempt of active.values()) attempt.controller.abort(installerFailure('service-closing')) },
      async awaitIdle() { while (pending.size) await Promise.allSettled([...pending]) },
    }
    ctx.effect(() => async () => { service.closeAdmission(); await service.awaitIdle(); if (cleanupErrors.size) throw new AggregateError([...cleanupErrors], 'package installer cleanup unconfirmed') })
    ctx.provide(packageInstallerServiceKey, service)
  } }
}
