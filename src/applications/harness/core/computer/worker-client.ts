import { spawn } from 'node:child_process'
import { mkdir, readFile, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  const send = async <T>(target: WorkerEndpoint, path: string, input: unknown, signal?: AbortSignal): Promise<T> => {
    if (!accepting) throw workerError('worker-observer-closed')
    signal?.throwIfAborted()
    const abort = new AbortController()
    const forward = () => abort.abort(signal?.reason)
    signal?.addEventListener('abort', forward, { once: true })
    observing.add(abort)
    const timeoutMs = options.requestTimeoutMs ?? 30_000
    const timeout = setTimeout(() => abort.abort('worker-request-timeout'), path === '/info' || path === '/attachments/list' ? Math.min(timeoutMs, 5_000) : timeoutMs)
    try {
      const response = await fetch(new URL(path, target.url), { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${target.token}`, 'content-type': 'application/json' }, body: JSON.stringify(input), signal: abort.signal })
      const output = await response.json() as { value?: T; error?: string }
      if (!response.ok || output.error) throw workerError(output.error ?? 'worker-request-failed')
      return output.value as T
    } finally { clearTimeout(timeout); observing.delete(abort); signal?.removeEventListener('abort', forward) }
  }
  let current: WorkerEndpoint | undefined
  const connect = async (start: boolean): Promise<WorkerEndpoint> => {
    if (!accepting) throw workerError('worker-observer-closed')
    const previous = await endpoint(directory)
    if (!accepting) throw workerError('worker-observer-closed')
    if (previous && live(previous.pid)) { await send(previous, '/info', {}); return previous }
    if (!start) throw workerError('worker-not-running')
    if (process.platform === 'win32') throw workerError('worker-platform-unsupported')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    // The worker exclusively owns this directory; local managers only share its private endpoint.
    const errorLog = await open(join(directory, 'worker.log'), 'a', 0o600)
    let child: ReturnType<typeof spawn>
    let spawnFailure: unknown
    try {
      if (!accepting) throw workerError('worker-observer-closed')
      child = spawn(options.executable ?? process.execPath, [fileURLToPath(new URL('../../../../entrypoints/computer-worker-main.js', import.meta.url)), directory],
        { detached: true, stdio: ['ignore', 'ignore', errorLog.fd], windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
      child.once('error', error => { spawnFailure = error })
      child.unref()
    } finally { await errorLog.close() }
    const until = Date.now() + (options.startupTimeoutMs ?? 15_000)
    while (Date.now() < until) {
      if (!accepting) throw workerError('worker-observer-closed')
      const current = await endpoint(directory)
      // Concurrent explicit starters can race; the SQLite lock elects one owner, and both observers reuse it.
      if (current && live(current.pid)) { await send(current, '/info', {}); return current }
      if (spawnFailure || child.exitCode !== null) throw workerError('worker-startup-failed')
      await wait(25)
    }
    throw workerError('worker-startup-timeout')
  }
  // A worker that died since the last call is replaced on this call instead of failing it first; nothing here supervises an idle worker.
  const ensure = () => {
    if (current && !live(current.pid)) { connecting = undefined; current = undefined }
    return connecting ??= connect(options.autoStart !== false).then(found => { current = found; return found }, error => { connecting = undefined; throw error })
  }
  const request = <T>(path: string, input: unknown, signal?: AbortSignal) => tracked((async () => {
    if (!accepting) throw workerError('worker-observer-closed')
    signal?.throwIfAborted()
    const target = await ensure()
    try { return await send<T>(target, path, input, signal) }
    catch (error) { if (!live(target.pid)) connecting = undefined; throw error }
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
    start: () => tracked((async () => {
      if (!accepting) throw workerError('worker-observer-closed')
      if (current && !live(current.pid)) { current = undefined; connecting = undefined }
      await (connecting ??= connect(true).then(found => { current = found; return found }, error => { connecting = undefined; throw error }))
    })()),
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
    query: input => request('/query', input),
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
