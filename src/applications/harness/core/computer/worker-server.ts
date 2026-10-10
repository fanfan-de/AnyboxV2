import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile, unlink, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../../../../storage/sqlite.js'
import { projectServiceKey, type ProjectPort } from '../project/component.js'
import { createBashComponent } from '../tool/bash-component.js'
import { createApplyPatchComponent } from '../tool/apply-patch-component.js'
import { createProcessToolsComponent } from '../tool/process-component.js'
import { createFileToolsComponent } from '../tool/files-component.js'
import { createImageAssetsComponent } from '../image/component.js'
import { createComputerWorkerExecutorComponent } from './worker-component.js'
import { computerWorkerServiceKey, workerError } from './worker-port.js'
import type { ComputerWorkerPort, WorkerAuthorization, WorkerSubmission } from './worker-port.js'

export interface WorkerEndpoint { readonly url: string; readonly token: string; readonly pid: number; readonly workerId: string; readonly bootId: string }
const missing = async (): Promise<never> => { throw workerError('worker-fixed-binding-required') }
/** Tools get a root service for their compatibility dependency, but worker requests must carry a fixed path. */
function trustedProjectBindings(): ProjectPort {
  return { directoryBrowsingSupported: false, directoryCreationSupported: false, getIn: () => undefined,
    openDirectoryBrowse: () => { throw workerError('worker-fixed-binding-required') }, readDirectoryPage: () => { throw workerError('worker-fixed-binding-required') },
    createDirectory: () => { throw workerError('worker-fixed-binding-required') }, closeDirectoryBrowse: missing,
    onDirectoryBrowseRetired: () => () => {}, openProject: missing, listProjects: missing, getProject: missing, requireAvailable: missing }
}
function authentic(given: string | undefined, token: string): boolean {
  if (!given) return false
  const a = Buffer.from(given), b = Buffer.from(`Bearer ${token}`)
  return a.length === b.length && timingSafeEqual(a, b)
}
export async function openComputerWorker(directory: string): Promise<{ readonly endpoint: WorkerEndpoint; close(): Promise<void> }> {
  const path = resolve(directory)
  await mkdir(path, { recursive: true, mode: 0o700 })
  // A failed process leaves no application-owned lock: the SQLite OS lock proves exclusive ownership.
  const root = new Context()
  let server: ReturnType<typeof createServer> | undefined
  let endpoint: WorkerEndpoint | undefined
  let closing: Promise<void> | undefined
  const close = () => closing ??= (async () => {
    if (server) {
      const stopped = new Promise<void>((yes, no) => server!.close(error => error ? no(error) : yes()))
      server.closeAllConnections()
      await stopped
    }
    let cleanupFailure: unknown
    try { await root.fiber.dispose() } catch (error) { cleanupFailure = error }
    finally {
      if (endpoint) {
        const receipt = await open(join(path, 'shutdown.json'), 'w', 0o600)
        try { await receipt.writeFile(JSON.stringify({ bootId: endpoint.bootId, ...(cleanupFailure ? { error: 'worker-cleanup-failed' } : {}) })); await receipt.sync() }
        finally { await receipt.close() }
        try {
          const current = JSON.parse(await readFile(join(path, 'endpoint.json'), 'utf8')) as WorkerEndpoint
          if (current.bootId === endpoint.bootId) await unlink(join(path, 'endpoint.json'))
        } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
      }
    }
    if (cleanupFailure) throw cleanupFailure
  })()
  try {
    await root.installComponent(createLocalSqliteComponent(join(path, 'worker.sqlite')))
    let workerId: string
    try { workerId = (await readFile(join(path, 'worker-id'), 'utf8')).trim(); if (!/^[0-9a-f-]{36}$/.test(workerId)) throw workerError('worker-invalid-identity') }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      workerId = randomUUID(); await writeFile(join(path, 'worker-id'), workerId, { flag: 'wx', mode: 0o600 })
    }
    const bootId = randomUUID()
    await root.installComponent({ name: 'computer-worker-project-bindings', apply(ctx) { ctx.provide(projectServiceKey, trustedProjectBindings()) } })
    await root.installComponent(createImageAssetsComponent({ directory: join(path, 'images') }))
    await root.installComponent(createBashComponent())
    await root.installComponent(createApplyPatchComponent())
    await root.installComponent(createProcessToolsComponent())
    await root.installComponent(createFileToolsComponent())
    await root.installComponent(createComputerWorkerExecutorComponent({ workerId, bootId }))
    const token = randomUUID() + randomUUID()
    server = createServer(async (request, response) => {
      if (!authentic(request.headers.authorization, token) || request.socket.remoteAddress !== '127.0.0.1') {
        response.writeHead(401).end(); return
      }
      try {
        if (request.method !== 'POST') throw workerError('worker-invalid')
        let size = 0
        const chunks: Buffer[] = []
        for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 40 * 1024 * 1024) throw workerError('worker-invalid'); chunks.push(bytes) }
        const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const worker = root.get<ComputerWorkerPort>(computerWorkerServiceKey)!
        let output: unknown
        switch (request.url) {
          case '/info': output = await worker.info(); break
          case '/claim': output = await worker.claimRun(input as WorkerAuthorization); break
          case '/submit': output = await worker.submit(input as WorkerSubmission); break
          case '/get': output = await worker.get(input as WorkerAuthorization & { operationId: string }); break
          case '/shutdown':
            await worker.shutdown(); output = null
            response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ value: null }))
            setImmediate(() => { void close().catch(() => { process.exitCode = 1 }) }); return
          default: throw workerError('worker-invalid')
        }
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ value: output ?? null }))
      } catch (error) {
        const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'worker-request-failed'
        response.writeHead(code === 'worker-owner-rejected' ? 409 : 400, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ error: code }))
      }
    })
    await new Promise<void>((yes, no) => { server!.once('error', no); server!.listen(0, '127.0.0.1', () => { server!.removeListener('error', no); yes() }) })
    endpoint = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token, pid: process.pid, workerId, bootId }
    const temp = join(path, `endpoint.${bootId}.tmp`)
    await writeFile(temp, JSON.stringify(endpoint), { flag: 'wx', mode: 0o600 })
    await rename(temp, join(path, 'endpoint.json'))
    return { endpoint, close }
  } catch (error) { await close(); throw error }
}
