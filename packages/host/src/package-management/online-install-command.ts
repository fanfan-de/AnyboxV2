import { constants, type BigIntStats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { defaultApplicationArchiveLimits } from './directory-format.js'
import { readApplicationDirectory } from './directory.js'

export interface OnlinePackageInstallCommandIo {
  readonly fetch?: typeof globalThis.fetch
  readonly stdout?: (text: string) => void
  readonly stderr?: (text: string) => void
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  readonly timeoutMs?: number
  readonly pollIntervalMs?: number
}
interface InstallView {
  readonly id: string
  readonly requestId: string
  readonly filename: string
  readonly sourceFormat: 'archive' | 'directory'
  readonly localTrust: boolean
  readonly archiveDigest: string
  readonly archiveSize: number
  readonly phase: string
  readonly [key: string]: unknown
}
const base = '/api/client/v1/app-packages'
const phases = ['accepted', 'receiving', 'verifying', 'prepared', 'committing', 'installed', 'failed', 'cancelled', 'recovery-required']
const terminal = (job: InstallView) => ['installed', 'failed', 'cancelled', 'recovery-required'].includes(job.phase)
const usage = 'Usage: anybox-host install <application-folder|application.anybox-app> --endpoint http://127.0.0.1:<port> --request-id <id> [--trust-local]'
const error = (code: string) => Object.assign(new Error(code), { code })
function identifier(value: unknown): string { if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) throw error('invalid-input'); return value }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('invalid-response'); return value as Record<string, unknown> }
function text(value: unknown): string { if (typeof value !== 'string' || value.length > 2048) throw error('invalid-response'); return value }
function integer(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw error('invalid-response'); return value }
function safeCode(value: unknown): string { return value && typeof value === 'object' && 'code' in value && typeof value.code === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(value.code) ? value.code : 'installation-command-failed' }
function view(value: unknown): InstallView {
  const item = object(value), sourceFormat = item.sourceFormat ?? 'archive', localTrust = item.localTrust ?? false
  if (!phases.includes(item.phase as string) || sourceFormat !== 'archive' && sourceFormat !== 'directory' || typeof localTrust !== 'boolean' || localTrust && sourceFormat !== 'directory' || typeof item.archiveDigest !== 'string' || !/^[a-f0-9]{64}$/.test(item.archiveDigest)) throw error('invalid-response')
  const failure = item.error === null || item.error === undefined ? null : object(item.error), recovery = item.recovery === null || item.recovery === undefined ? null : object(item.recovery)
  if (failure && (typeof failure.code !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(failure.code)) || recovery && (!phases.includes(recovery.from as string) || !['owner-restarted', 'outcome-unconfirmed'].includes(recovery.reason as string))) throw error('invalid-response')
  let identity: unknown = null
  if (item.identity !== null && item.identity !== undefined) { const source = object(item.identity), target = object(source.target); identity = { appId: text(source.appId), version: text(source.version), digest: text(source.digest), target: { os: text(target.os), arch: text(target.arch) } } }
  const filename = text(item.filename)
  if (!filename || filename.length > 255 || /[\\/\0]/.test(filename) || filename === '.' || filename === '..') throw error('invalid-response')
  return { id: identifier(item.id), requestId: identifier(item.requestId), filename, sourceFormat, localTrust, archiveDigest: item.archiveDigest, archiveSize: integer(item.archiveSize), phase: item.phase as string,
    revision: integer(item.revision), identity, operationId: item.operationId === null || item.operationId === undefined ? null : identifier(item.operationId), existingInstallation: item.existingInstallation === true,
    error: failure ? { code: failure.code } : null, recovery: recovery ? { from: recovery.from, reason: recovery.reason } : null, createdAt: text(item.createdAt), updatedAt: text(item.updatedAt) }
}
function parse(args: readonly string[]) {
  if (args[0] !== 'install' || !args[1] || args[1].startsWith('--')) throw error('invalid-input')
  const options: Record<string, string> = {}
  for (let index = 2; index < args.length; index++) {
    const name = args[index]
    if (!['--endpoint', '--request-id', '--trust-local'].includes(name) || options[name] !== undefined) throw error('invalid-input')
    if (name === '--trust-local') { options[name] = 'true'; continue }
    const value = args[++index]
    if (!value || value.startsWith('--')) throw error('invalid-input')
    options[name] = value
  }
  if (!options['--endpoint'] || !options['--request-id']) throw error('invalid-input')
  const raw = options['--endpoint'], match = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})\/?$/.exec(raw)
  if (!match || Number(match[1]) > 65535) throw error('invalid-endpoint')
  let endpoint: URL
  try { endpoint = new URL(raw) } catch { throw error('invalid-endpoint') }
  return { path: resolve(args[1]), endpoint: endpoint.origin, requestId: identifier(options['--request-id']), localTrust: options['--trust-local'] === 'true' }
}
const sameFile = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
/** A single immutable upload snapshot, with no symlink/hard-link or changed-path admission. */
async function readArchive(path: string, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted()
  const before = await lstat(path, { bigint: true })
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) throw error('unsafe-file-kind')
  if (before.size < 1n || before.size > BigInt(defaultApplicationArchiveLimits.archiveBytes)) throw error('archive-size-limit')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!sameFile(before, await handle.stat({ bigint: true }))) throw error('archive-file-changed')
    const bytes = Buffer.alloc(Number(before.size))
    let offset = 0
    while (offset < bytes.length) {
      signal.throwIfAborted()
      const result = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset)
      if (!result.bytesRead) throw error('archive-file-changed')
      offset += result.bytesRead
    }
    signal.throwIfAborted()
    if (!sameFile(before, await handle.stat({ bigint: true })) || !sameFile(before, await lstat(path, { bigint: true }))) throw error('archive-file-changed')
    return bytes
  } finally { await handle.close() }
}

/** Online content upload only. No Context, registry owner or application code is created here. */
export async function runOnlinePackageInstallCommand(args: readonly string[], io: OnlinePackageInstallCommandIo = {}): Promise<number> {
  const output = io.stdout ?? (value => { process.stdout.write(value) }), report = io.stderr ?? (value => { process.stderr.write(value) }), fetcher = io.fetch ?? globalThis.fetch, now = io.now ?? Date.now, sleep = io.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const timeoutMs = io.timeoutMs ?? 120_000, interval = io.pollIntervalMs ?? 300
  const controller = new AbortController(), abort = () => controller.abort()
  process.once('SIGINT', abort); process.once('SIGTERM', abort)
  let last: InstallView | undefined
  try {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000 || !Number.isFinite(interval) || interval < 1 || interval > 5_000) throw error('invalid-input')
    const input = parse([...args]), deadline = now() + timeoutMs
    const remaining = () => { if (controller.signal.aborted) throw error('installation-observation-cancelled'); const value = deadline - now(); if (value <= 0) throw error('installation-observation-timeout'); return value }
    remaining()
    const isDirectory = (await lstat(input.path)).isDirectory()
    if (input.localTrust && !isDirectory) throw error('invalid-input')
    if (!isDirectory && !/\.anybox-app$/i.test(basename(input.path))) throw error('invalid-input')
    const bytes = isDirectory ? await readApplicationDirectory(input.path, { signal: controller.signal }) : await readArchive(input.path, controller.signal)
    remaining()
    const intent = { requestId: input.requestId, filename: basename(input.path), sourceFormat: isDirectory ? 'directory' as const : 'archive' as const, localTrust: input.localTrust, archiveDigest: createHash('sha256').update(bytes).digest('hex'), archiveSize: bytes.length }
    const matches = (job: InstallView, conflict: boolean) => { if (job.requestId !== intent.requestId || job.filename !== intent.filename || job.sourceFormat !== intent.sourceFormat || job.localTrust !== intent.localTrust || job.archiveDigest !== intent.archiveDigest || job.archiveSize !== intent.archiveSize) throw error(conflict ? 'request-conflict' : 'invalid-response'); return job }
    const request = async (path: string, method: 'GET' | 'POST' | 'PUT' = 'GET', body?: unknown): Promise<unknown> => {
      const requestController = new AbortController(), forward = () => requestController.abort()
      controller.signal.addEventListener('abort', forward, { once: true })
      const timer = setTimeout(forward, Math.min(remaining(), 5_000))
      try {
        let response: Response
        try { response = await fetcher(input.endpoint + path, { method, redirect: 'error', headers: { Origin: input.endpoint, ...(method === 'GET' ? {} : { 'Content-Type': method === 'PUT' ? 'application/octet-stream' : 'application/json' }) }, ...(method === 'GET' ? {} : { body: method === 'PUT' ? new Uint8Array(bytes).buffer : JSON.stringify(body) }), signal: requestController.signal }) }
        catch { remaining(); throw error('installation-observation-failed') }
        let value: unknown
        try { value = await response.json() } catch { throw error(response.ok ? 'invalid-response' : `http-${response.status}`) }
        if (!response.ok) { const failure = value && typeof value === 'object' && 'error' in value ? (value as { error?: unknown }).error : undefined; throw error(failure ? safeCode(failure) : `http-${response.status}`) }
        return value
      } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', forward) }
    }
    const find = async () => {
      const status = object(await request(`${base}?requestId=${encodeURIComponent(input.requestId)}`))
      if (!Array.isArray(status.operations) || status.operations.length > 10_000) throw error('invalid-response')
      const jobs = status.operations.map(view).filter(job => job.requestId === input.requestId)
      if (jobs.length > 1) throw error('invalid-response')
      return jobs[0] ? matches(jobs[0], true) : undefined
    }
    const inspect = async (id: string) => { const result = matches(view(await request(`${base}/operations/${encodeURIComponent(id)}`)), true); if (result.id !== id) throw error('invalid-response'); last = result; return result }
    const ambiguous = (failure: unknown) => ['installation-observation-failed', 'invalid-response'].includes(safeCode(failure))
    const findAccepted = async (): Promise<InstallView> => {
      for (;;) {
        remaining()
        try { const job = await find(); if (job) { last = job; return job } } catch (failure) { if (!ambiguous(failure)) throw failure }
        await sleep(Math.min(interval, remaining()))
      }
    }
    const poll = async (id: string): Promise<InstallView> => {
      for (;;) {
        remaining()
        try { const job = await inspect(id); if (terminal(job)) return job; if (job.phase === 'accepted') throw error('installation-upload-required') }
        catch (failure) { if (!ambiguous(failure)) throw failure }
        await sleep(Math.min(interval, remaining()))
      }
    }
    const prior = await find()
    let acceptedHere = false
    if (prior) last = prior
    else {
      try { last = matches(view(await request(`${base}/operations`, 'POST', intent)), false); acceptedHere = true }
      catch (failure) { if (!ambiguous(failure)) throw failure; last = await findAccepted() }
    }
    if (acceptedHere && last.phase === 'accepted') {
      const id = last.id
      try { const result = matches(view(await request(`${base}/operations/${encodeURIComponent(id)}/archive`, 'PUT', bytes)), false); if (result.id !== id) throw error('invalid-response'); last = result }
      catch (failure) { if (!ambiguous(failure)) throw failure; last = await poll(id) }
    }
    if (last.phase === 'accepted') throw error('installation-upload-required')
    if (!terminal(last)) last = await poll(last.id)
    output(JSON.stringify(last) + '\n')
    return last.phase === 'installed' ? 0 : 1
  } catch (failure) {
    if (last) output(JSON.stringify(last) + '\n')
    const code = controller.signal.aborted ? 'installation-observation-cancelled' : safeCode(failure)
    report(JSON.stringify({ error: { code, ...(code === 'invalid-input' ? { message: usage } : {}) } }) + '\n')
    return controller.signal.aborted ? 130 : 1
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort) }
}
