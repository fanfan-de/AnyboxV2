import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { createPrivateRpc, rpcFailure } from '../desktop/rpc.js'
import { captureCommand } from './domain.js'
import { acquirePackageUsageLock, type PackageUsageLock } from './usage-locks.js'
import type { VerifyApplicationArchiveOptions } from './archive.js'
import type { PackageRegistryPort, PackageUseCredential } from './port.js'

export interface IndependentInstalledRoleOptions {
  readonly directory: string
  readonly credential: PackageUseCredential
  readonly verification: Omit<VerifyApplicationArchiveOptions, 'signal'>
  readonly trustPolicyPath?: string
  readonly args: readonly string[]
  readonly registry: Pick<PackageRegistryPort, 'claim' | 'ready'>
  readonly startupTimeoutMs?: number
}
export interface IndependentInstalledRole {
  readonly pid: number
  readonly usageId: string
  readonly exited: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>
}
const retained = new Set<PackageUsageLock>()
process.once('exit', () => { for (const lock of retained) void lock.release() })
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
function groupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error }
}
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return
  try { process.kill(-child.pid, signal) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
}

/** Fixed bootstrap only. The app retains all endpoint, worker data and business protocols. */
export async function launchIndependentInstalledRole(options: IndependentInstalledRoleOptions): Promise<IndependentInstalledRole> {
  let childCreated = false
  try { return await launchRole(options, () => { childCreated = true }) }
  catch (error) {
    if (childCreated || error && typeof error === 'object' && 'exitConfirmed' in error && error.exitConfirmed === false) throw error
    // The caller may already hold a reservation. Validation, runtime rejection
    // and a synchronous fork failure cannot leave a child using that snapshot.
    throw Object.assign(error instanceof Error ? error : rpcFailure('package-role-startup-failed'), { exitConfirmed: true })
  }
}

async function launchRole(options: IndependentInstalledRoleOptions, created: () => void): Promise<IndependentInstalledRole> {
  if (process.versions.electron || process.platform === 'win32') throw rpcFailure('package-role-runtime-unavailable')
  const credential = captureCommand(options.credential), directory = realpathSync(resolve(options.directory)), args = captureCommand(options.args)
  if (credential.snapshot.role !== 'computer-worker' || credential.snapshot.entries.length !== 1 || credential.snapshot.entries[0].entry !== 'computer-worker' || !Array.isArray(args) || args.length > 1024 || args.some(value => typeof value !== 'string' || value.includes('\0')) || Buffer.byteLength(JSON.stringify(args)) > 65_536) throw rpcFailure('package-role-invalid-input')
  const timeoutMs = options.startupTimeoutMs ?? 30_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 120_000) throw rpcFailure('package-role-invalid-input')
  const verification = { ...captureCommand({ target: options.verification.target, applicationApiVersion: options.verification.applicationApiVersion, runtimeProfiles: options.verification.runtimeProfiles, limits: options.verification.limits }),
    trustedPublishers: options.verification.trustedPublishers.map(publisher => ({ publisher: publisher.publisher, keyId: publisher.keyId, appIds: [...publisher.appIds], publicKey: typeof publisher.publicKey === 'string' ? publisher.publicKey : publisher.publicKey.export({ format: 'pem', type: 'spki' }).toString() })) }
  const parentLock = acquirePackageUsageLock(directory, credential)
  retained.add(parentLock)
  let child: ChildProcess
  try { child = fork(fileURLToPath(new URL('./independent-role-process.js', import.meta.url)), [], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced', execArgv: [] }); created() }
  catch (error) {
    try { await parentLock.release(); retained.delete(parentLock) }
    catch (cleanup) { throw Object.assign(new AggregateError([error, cleanup], 'Independent role startup reservation cleanup is unconfirmed'), { code: 'package-role-exit-unconfirmed', exitConfirmed: false }) }
    throw error
  }
  let outcome: { code: number | null; signal: NodeJS.Signals | null } | undefined
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit => {
    const done = (code: number | null, signal: NodeJS.Signals | null) => { outcome ??= { code, signal }; resolveExit(outcome) }
    // All stdio is ignored and successful handoff explicitly closes IPC. The
    // OS-backed process exit is authoritative; Node can omit `close` after an
    // explicitly disconnected, unref'ed IPC child. Spawn errors still use close.
    child.once('exit', done); child.once('close', done)
  })
  const rpc = createPrivateRpc(message => { if (!child.connected) throw rpcFailure('worker-unavailable'); child.send(message, error => { if (error) rpc.disconnect() }) })
  child.on('message', message => rpc.receive(message)); child.once('disconnect', () => rpc.disconnect()); child.once('error', () => rpc.disconnect()); child.once('exit', () => rpc.disconnect())
  rpc.handle('registry', async value => {
    const input = captureCommand(value) as { method?: string; credential?: { usageId?: string; secret?: string } }
    if (!input || !['claim', 'ready'].includes(input.method ?? '') || input.credential?.usageId !== credential.usageId || input.credential.secret !== credential.secret) throw rpcFailure('package-role-invalid-credential')
    return options.registry[input.method as 'claim' | 'ready']({ usageId: credential.usageId, secret: credential.secret })
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([rpc.call<{ usageId?: string; pid?: number }>('start', { directory, credential, verification, args, trustPolicyPath: options.trustPolicyPath }), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(rpcFailure('package-role-startup-timeout')), timeoutMs) })])
    if (result?.usageId !== credential.usageId || result.pid !== child.pid || !child.pid || outcome) throw rpcFailure('package-role-ready-invalid')
    await rpc.drain()
    await parentLock.release(); retained.delete(parentLock)
    if (child.connected) child.disconnect()
    rpc.disconnect(); child.unref()
    return Object.freeze({ pid: child.pid, usageId: credential.usageId, exited })
  } catch (error) {
    // Before acknowledgment the launcher owns this startup. A failed/unknown
    // process-group exit keeps the parent SHARED anchor instead of inventing proof.
    try {
      signalGroup(child, 'SIGTERM')
      const start = Date.now()
      while (!outcome || child.pid && groupExists(child.pid)) {
        if (Date.now() - start >= 1_000) signalGroup(child, 'SIGKILL')
        if (Date.now() - start > 6_000) throw rpcFailure('package-role-exit-unconfirmed')
        await wait(20)
      }
      await exited; await rpc.drain(); await parentLock.release(); retained.delete(parentLock)
    } catch (cleanup) { throw Object.assign(new AggregateError([error, cleanup], 'Independent role startup exit is unconfirmed'), { code: 'package-role-exit-unconfirmed', exitConfirmed: false }) }
    throw Object.assign(error instanceof Error ? error : rpcFailure('package-role-startup-failed'), { exitConfirmed: true })
  } finally { if (timer) clearTimeout(timer) }
}
