import { spawn } from 'node:child_process'
import { mkdir, readFile, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Component } from '@nya/core'
import { computerWorkerServiceKey, workerError } from './worker-port.js'
import type { ComputerWorkerOptions, ComputerWorkerPort, WorkerOperation } from './worker-port.js'
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
export function connectLocalComputerWorker(options: ComputerWorkerOptions): ComputerWorkerPort & { closeObserver(): Promise<void> } {
  const directory = resolve(options.directory)
  let accepting = true
  let connecting: Promise<WorkerEndpoint> | undefined
  const observing = new Set<AbortController>()
  const pending = new Set<Promise<unknown>>()
  const tracked = <T>(promise: Promise<T>) => { pending.add(promise); void promise.finally(() => pending.delete(promise)).catch(() => {}); return promise }
  const send = async <T>(target: WorkerEndpoint, path: string, input: unknown): Promise<T> => {
    const abort = new AbortController()
    observing.add(abort)
    const timeout = setTimeout(() => abort.abort('worker-request-timeout'), options.requestTimeoutMs ?? 30_000)
    try {
      const response = await fetch(new URL(path, target.url), { method: 'POST', headers: { authorization: `Bearer ${target.token}`, 'content-type': 'application/json' }, body: JSON.stringify(input), signal: abort.signal })
      const output = await response.json() as { value?: T; error?: string }
      if (!response.ok || output.error) throw workerError(output.error ?? 'worker-request-failed')
      return output.value as T
    } finally { clearTimeout(timeout); observing.delete(abort) }
  }
  const ensure = () => connecting ??= (async () => {
    if (!accepting) throw workerError('worker-observer-closed')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const previous = await endpoint(directory)
    if (previous && live(previous.pid)) { await send(previous, '/info', {}); return previous }
    // One Authority owns this deployment directory. The detached child has no stdio/process-group link to Runtime.
    const errorLog = await open(join(directory, 'worker.log'), 'a', 0o600)
    const child = spawn(options.executable ?? process.execPath, [fileURLToPath(new URL('../../../../entrypoints/computer-worker-main.js', import.meta.url)), directory],
      { detached: true, stdio: ['ignore', 'ignore', errorLog.fd], windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    let spawnFailure: unknown
    child.once('error', error => { spawnFailure = error })
    child.unref()
    await errorLog.close()
    const until = Date.now() + (options.startupTimeoutMs ?? 15_000)
    while (Date.now() < until) {
      if (!accepting) throw workerError('worker-observer-closed')
      if (spawnFailure || child.exitCode !== null) throw workerError('worker-startup-failed')
      const current = await endpoint(directory)
      if (current && current.pid === child.pid) { await send(current, '/info', {}); return current }
      await wait(25)
    }
    throw workerError('worker-startup-timeout')
  })().catch(error => { connecting = undefined; throw error })
  const request = <T>(path: string, input: unknown) => tracked((async () => {
    if (!accepting) throw workerError('worker-observer-closed')
    const target = await ensure()
    try { return await send<T>(target, path, input) }
    catch (error) { if (!live(target.pid)) connecting = undefined; throw error }
  })())
  return {
    info: () => request('/info', {}), claimRun: input => request('/claim', input), submit: input => request<WorkerOperation>('/submit', input),
    get: async input => (await request<WorkerOperation | null>('/get', input)) ?? undefined,
    shutdown: async () => {
      const current = await endpoint(directory)
      if (!current || !live(current.pid)) return
      await request('/shutdown', {})
      const until = Date.now() + 120_000
      while (Date.now() < until) {
        const remaining = await endpoint(directory)
        if (!remaining || remaining.bootId !== current.bootId || !live(current.pid)) {
          connecting = undefined
          const receipt = JSON.parse(await readFile(join(directory, 'shutdown.json'), 'utf8')) as { bootId?: string; error?: string }
          if (receipt.bootId !== current.bootId) throw workerError('worker-shutdown-unknown')
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
    ctx.provide(computerWorkerServiceKey, client)
  } }
}
