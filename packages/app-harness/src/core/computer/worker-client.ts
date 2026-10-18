import { spawn } from 'node:child_process'
import { mkdir, readFile, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import type { Component } from '@nya/core'
import type { JsonValue } from '@anybox/models'
import { localComputerWorkerServiceKey, localComputerWorkerControlServiceKey, workerError } from './worker-port.js'
import type { ComputerWorkerOptions, ComputerWorkerPort, LocalComputerWorkerControl, LocalComputerWorkerStatus, WorkerOperation } from './worker-port.js'
import type { WorkerEndpoint } from './worker-server.js'

const wait = (ms: number) => new Promise<void>(yes => setTimeout(yes, ms))
function live(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return error instanceof Error && 'code' in error && error.code === 'EPERM' }
}
async function endpoint(path: string): Promise<WorkerEndpoint | undefined> {
  try {
    const value = JSON.parse(await readFile(join(path, 'endpoint.json'), 'utf8')) as WorkerEndpoint
    const url = new URL(value.url)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.token !== 'string' || value.token.length < 32) throw workerError('worker-invalid-endpoint')
    return value
  } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error }
}
/** The proxy owns only local HTTP observations. Unloading it never stops the independent worker. */
export function connectLocalComputerWorker(options: ComputerWorkerOptions): ComputerWorkerPort & { readonly control: LocalComputerWorkerControl; status(signal?: AbortSignal): Promise<LocalComputerWorkerStatus>; start(): Promise<void>; closeObserver(): Promise<void> } {
  const directory = resolve(options.directory)
  let accepting = true
  let connecting: Promise<WorkerEndpoint> | undefined
  const observing = new Set<AbortController>()
  const pending = new Set<Promise<unknown>>()
  const tracked = <T>(promise: Promise<T>) => { pending.add(promise); void promise.finally(() => pending.delete(promise)).catch(() => {}); return promise }
  const send = async <T>(target: WorkerEndpoint, path: string, input: unknown, signal?: AbortSignal, startupUntil?: number): Promise<T> => {
    if (!accepting && startupUntil === undefined) throw workerError('worker-observer-closed')
    const abort = new AbortController()
    const forward = () => abort.abort(signal?.reason ?? 'worker-observer-closed')
    signal?.addEventListener('abort', forward, { once: true })
    if (signal?.aborted) forward()
    // Once spawned, startup must finish its handoff even when this observer closes.
    if (startupUntil === undefined) observing.add(abort)
    const timeoutMs = options.requestTimeoutMs ?? 30_000
    const requestTimeout = path === '/info' || path === '/attachments/list' ? Math.min(timeoutMs, 5_000) : timeoutMs
    const timeout = setTimeout(() => abort.abort('worker-request-timeout'), startupUntil === undefined ? requestTimeout : Math.max(1, Math.min(requestTimeout, startupUntil - Date.now())))
    try {
      const response = await fetch(new URL(path, target.url), { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${target.token}`, 'content-type': 'application/json' }, body: JSON.stringify(input), signal: abort.signal })
      const output = await response.json() as { value?: T; error?: string }
      if (!response.ok || output.error) throw workerError(output.error ?? 'worker-request-failed')
      return output.value as T
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', forward); observing.delete(abort) }
  }
  let current: WorkerEndpoint | undefined
  const startupLock = async (until: number): Promise<DatabaseSync> => {
    // This non-secret coordination file is separate from the worker-owned ledger.
    // Keep the file: only the OS-held SQLite transaction denotes ownership.
    const file = await open(join(directory, 'startup.sqlite'), 'a', 0o600)
    try { await file.chmod(0o600) } finally { await file.close() }
    while (Date.now() < until) {
      if (!accepting) throw workerError('worker-observer-closed')
      let db: DatabaseSync | undefined
      try {
        db = new DatabaseSync(join(directory, 'startup.sqlite'))
        db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')
        return db
      } catch (error) {
        db?.close()
        if (!(error instanceof Error && 'errcode' in error && (error.errcode === 5 || error.errcode === 6))) throw workerError('worker-startup-failed')
      }
      await wait(25)
    }
    throw workerError('worker-startup-timeout')
  }
  const connect = async (start: boolean): Promise<WorkerEndpoint> => {
    if (!accepting) throw workerError('worker-observer-closed')
    const previous = await endpoint(directory)
    if (!accepting) throw workerError('worker-observer-closed')
    if (previous && live(previous.pid)) { await send(previous, '/info', {}); return previous }
    if (!start) throw workerError('worker-not-running')
    if (process.platform === 'win32') throw workerError('worker-platform-unsupported')
    const until = Date.now() + (options.startupTimeoutMs ?? 15_000)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const lock = await startupLock(until)
    try {
      // Another process may have finished startup while this manager waited for the lock.
      const previous = await endpoint(directory)
      if (!accepting) throw workerError('worker-observer-closed')
      if (previous && live(previous.pid)) { await send(previous, '/info', {}); return previous }
      let child: ReturnType<typeof spawn> | undefined
      let exited = false, published = false
      let spawnFailure: unknown
      let done: Promise<void> | undefined
      const stopUnpublished = async () => {
        if (child?.pid && !exited) {
          try { process.kill(-child.pid, 'SIGKILL') }
          catch (failure) { if (!(failure instanceof Error && 'code' in failure && failure.code === 'ESRCH')) throw failure }
        }
        await done
      }
      try {
        if (options.launch) {
          if (!accepting) throw workerError('worker-observer-closed')
          // The package owner registers and starts its own signed role. Endpoint
          // discovery, the single startup lock and publication remain app-owned.
          try { await options.launch(directory) } catch (error) { spawnFailure = error }
        } else {
          const errorLog = await open(join(directory, 'worker.log'), 'a', 0o600)
          try {
            if (!accepting) throw workerError('worker-observer-closed')
            child = spawn(options.executable ?? process.execPath, [fileURLToPath(new URL('../../entrypoints/computer-worker-main.js', import.meta.url)), directory],
              { detached: true, stdio: ['ignore', 'ignore', errorLog.fd], windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
            child.once('error', error => { spawnFailure = error })
            done = new Promise<void>(yes => child!.once('close', () => { exited = true; yes() }))
            child.unref()
          } finally { await errorLog.close() }
        }
        while (Date.now() < until) {
          const found = await endpoint(directory)
          if (found && live(found.pid)) {
            published = child ? found.pid === child.pid : !!options.launch
            // A separately served worker may have won outside the manager lock.
            if (!published) await stopUnpublished()
            await send(found, '/info', {}, undefined, until)
            if (!accepting) throw workerError('worker-observer-closed')
            return found
          }
          if (spawnFailure || exited) throw workerError('worker-startup-failed')
          await wait(25)
        }
        throw workerError('worker-startup-timeout')
      } catch (error) {
        // A published endpoint transfers ownership to the independent worker. Before
        // that handoff a failed startup owns its child and joins exit before unlocking.
        if (!published && child?.pid && !exited) {
          // Preserve cleanup even if the endpoint itself caused the startup failure.
          let found: WorkerEndpoint | undefined
          try { found = await endpoint(directory) } catch { /* No valid handoff was published. */ }
          published = found?.pid === child.pid && live(child.pid)
        }
        if (!published) await stopUnpublished()
        throw error
      }
    } finally { lock.close() }
  }
  // A worker that died since the last call is replaced on this call instead of failing it first; nothing here supervises an idle worker.
  const ensure = (start = options.autoStart !== false): Promise<WorkerEndpoint> => {
    if (!accepting) return Promise.reject(workerError('worker-observer-closed'))
    if (current && live(current.pid)) return Promise.resolve(current)
    current = undefined
    // A passive read must not reserve the explicit startup flight with a no-start result.
    if (!start) return connect(false).then(found => { current = found; return found })
    return connecting ??= connect(true).then(found => { current = found; return found }).finally(() => { connecting = undefined })
  }
  const request = <T>(path: string, input: unknown, signal?: AbortSignal) => tracked((async () => {
    if (!accepting || signal?.aborted) throw workerError('worker-observer-closed')
    const target = await ensure()
    if (signal?.aborted) throw workerError('worker-observer-closed')
    try { return await send<T>(target, path, input, signal) }
    catch (error) { if (!live(target.pid) && current === target) current = undefined; throw error }
  })())
  // Execution adapters may start on demand; independent management always uses autoStart: false.
  const control: LocalComputerWorkerControl = {
    listAttachments: signal => request<readonly JsonValue[]>('/attachments/list', {}, signal),
    consumeAttachCode: (input, signal) => request<JsonValue>('/attachments/consume', input, signal),
    revokeAttachment: (attachmentId, signal) => request<JsonValue>('/attachments/revoke', { attachmentId }, signal),
    updatePermissions: (attachmentId, ceiling, signal) => request<JsonValue>('/attachments/permissions', { attachmentId, ceiling }, signal),
  }
  return {
    control,
    start: () => tracked(ensure(true).then(() => {})),
    status: signal => tracked((async () => {
      if (!accepting) throw workerError('worker-observer-closed')
      const supported = process.platform !== 'win32', target = await endpoint(directory)
      if (!target || !live(target.pid)) return { state: 'stopped', supported, attachments: [] }
      try {
        const info = await send<Awaited<ReturnType<ComputerWorkerPort['info']>>>(target, '/info', {}, signal)
        if (info.workerId !== target.workerId || info.bootId !== target.bootId) throw workerError('worker-invalid-endpoint')
        return { state: 'running', supported, ...info, pid: target.pid, attachments: await send<readonly JsonValue[]>(target, '/attachments/list', {}, signal) }
      } catch (error) {
        if (!accepting || signal?.aborted) throw error
        return { state: 'unavailable', supported, attachments: [] }
      }
    })()),
    info: () => request('/info', {}), claimRun: input => request('/claim', input), submit: input => request<WorkerOperation>('/submit', input),
    get: async input => (await request<WorkerOperation | null>('/get', input)) ?? undefined,
    query: (input, signal) => request('/query', input, signal),
    shutdown: async () => {
      const running = await endpoint(directory)
      if (!running || !live(running.pid)) return
      await request('/shutdown', {})
      const until = Date.now() + 120_000
      while (Date.now() < until) {
        const remaining = await endpoint(directory)
        if (!remaining || remaining.bootId !== running.bootId || !live(running.pid)) {
          connecting = undefined; current = undefined
          const receipt = JSON.parse(await readFile(join(directory, 'shutdown.json'), 'utf8')) as { bootId?: string; error?: string }
          if (receipt.bootId !== running.bootId) throw workerError('worker-shutdown-unknown')
          if (receipt.error) throw workerError(receipt.error)
          return
        }
        await wait(25)
      }
      throw workerError('worker-shutdown-timeout')
    },
    async closeObserver() { accepting = false; for (const abort of observing) abort.abort('worker-observer-closed'); await Promise.allSettled([...pending]) },
  }
}
export function createLocalComputerWorkerComponent(options: ComputerWorkerOptions): Component.Object {
  return { name: 'computer-local-worker-client', apply(ctx) {
    const client = connectLocalComputerWorker(options)
    ctx.effect(() => () => client.closeObserver(), 'cancel and join local worker observers')
    ctx.provide(localComputerWorkerServiceKey, client)
    ctx.provide(localComputerWorkerControlServiceKey, client.control)
  } }
}
