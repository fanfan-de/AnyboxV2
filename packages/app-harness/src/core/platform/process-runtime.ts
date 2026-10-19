import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Readable, Writable } from 'node:stream'

export interface ManagedProcessExit { readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }
export interface ManagedProcess {
  readonly pid: number | undefined
  readonly stdout: Readable
  readonly stderr: Readable
  readonly stdin: Writable
  /** The initial process exited; descendants and output may still be draining. */
  readonly exited: Promise<ManagedProcessExit>
  /** Every owned process, pipe and native supervisor has actually exited. */
  readonly done: Promise<void>
  readonly outputTruncated: boolean
  terminate(): void
}
export interface ManagedProcessOptions {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly stdin?: 'pipe' | 'ignore'
  readonly terminationGraceMs?: number
  /** Limit unread output retained by each public stream; actively consumed output is not discarded. */
  readonly maxBufferedOutputBytes?: number
  /** The trusted shell adapter has already quoted Windows argument syntax. */
  readonly windowsVerbatimArguments?: boolean
}
const nativePath = (name: string) => fileURLToPath(new URL(`./native/${name}`, import.meta.url)).replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
export function processRuntimeAvailable(): boolean {
  try {
    const metadata = JSON.parse(readFileSync(nativePath('process-host.json'), 'utf8')) as { platform?: string; arch?: string; protocol?: number }
    return metadata.platform === process.platform && metadata.arch === process.arch && metadata.protocol === 1 && existsSync(nativePath(process.platform === 'win32' ? 'anybox-process-host.exe' : 'anybox-process-host'))
  } catch { return false }
}
const failure = () => new Error('managed process runtime unavailable or cleanup failed')
const maximumFrameBytes = 1_048_576
function frame(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(5); header[0] = type.charCodeAt(0); header.writeUInt32LE(data.length, 1)
  return Buffer.concat([header, data])
}
function configuration(options: ManagedProcessOptions): Buffer {
  const parts: Buffer[] = []
  const integer = (n: number) => { const value = Buffer.alloc(4); value.writeUInt32LE(n); parts.push(value) }
  const string = (value: string) => {
    if (typeof value !== 'string' || value.includes('\0')) throw failure()
    const bytes = Buffer.from(value); integer(bytes.length); parts.push(bytes)
  }
  integer(options.terminationGraceMs ?? 5_000)
  string(options.executable); string(options.cwd)
  integer(options.args.length); for (const arg of options.args) string(arg)
  const env = Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  integer(env.length); for (const [key, value] of env) { if (!key || key.includes('=')) throw failure(); string(key); string(value) }
  integer(options.windowsVerbatimArguments === true ? 1 : 0)
  const bytes = Buffer.concat(parts)
  if (bytes.length > maximumFrameBytes) throw failure()
  return bytes
}
/** Synchronously owns the supervisor before any asynchronous work can accept a command. */
export function spawnManagedProcess(options: ManagedProcessOptions): ManagedProcess {
  let pid: number | undefined, truncated = false, settled = false, exitedValue: ManagedProcessExit | undefined
  let failureValue: Error | undefined, nativeDone = false, terminating = false, launchFailed = false
  let resolveExit!: (value: ManagedProcessExit) => void, rejectExit!: (error: Error) => void
  let resolveDone!: () => void, rejectDone!: (error: Error) => void
  const exited = new Promise<ManagedProcessExit>((yes, no) => { resolveExit = yes; rejectExit = no })
  const done = new Promise<void>((yes, no) => { resolveDone = yes; rejectDone = no })
  // Consumers commonly attach observers only after returning from a project lookup.
  void exited.catch(() => {}); void done.catch(() => {})
  const stdout = new Readable({ read() {} }), stderr = new Readable({ read() {} })
  const limit = options.maxBufferedOutputBytes ?? 1_048_576
  let child: ReturnType<typeof spawn> | undefined
  const fail = (error: Error = failure()) => { failureValue ??= error }
  const send = (type: string, bytes?: Buffer, callback?: (error?: Error | null) => void) => {
    if (!child?.stdin || child.stdin.destroyed || settled) { callback?.(failureValue ?? failure()); return }
    try { child.stdin.write(frame(type, bytes), error => { callback?.(error) }) }
    catch { callback?.(failure()) }
  }
  const stdin = new Writable({
    highWaterMark: 65_536,
    write(chunk: Buffer | string, encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
      if (bytes.length > maximumFrameBytes || stdin.writableLength > maximumFrameBytes) { callback(failure()); return }
      send('I', bytes, callback)
    },
    final(callback) { send('C', undefined, callback) },
  })
  stdin.on('error', () => {})
  const terminate = () => { if (terminating || settled) return; terminating = true; send('T') }
  const finish = () => {
    if (settled) return
    settled = true
    stdout.push(null); stderr.push(null)
    if (!stdin.destroyed) stdin.destroy()
    if (!nativeDone || !exitedValue && !launchFailed) fail()
    if (launchFailed && nativeDone && !failureValue) { rejectExit(failure()); resolveDone() }
    else if (failureValue) { rejectExit(failureValue); rejectDone(failureValue) }
    else resolveDone()
  }
  try {
    if (!processRuntimeAvailable() || !Number.isSafeInteger(limit) || limit < 1 || limit > maximumFrameBytes ||
      !Number.isSafeInteger(options.terminationGraceMs ?? 5_000) || (options.terminationGraceMs ?? 5_000) < 0 || (options.terminationGraceMs ?? 5_000) > 60_000) throw failure()
    const config = configuration(options)
    child = spawn(nativePath(process.platform === 'win32' ? 'anybox-process-host.exe' : 'anybox-process-host'), [], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
    })
    child.once('error', () => { launchFailed = true; nativeDone = true; finish() })
    // An input write racing with a completed command may see EPIPE. The native
    // exit/cleanup receipt, rather than the control pipe's write status, proves
    // ownership cleanup; write callbacks still report failure to their caller.
    child.stdin!.on('error', () => {})
    child.stdout!.on('error', () => { fail() })
    // Native diagnostics are never mixed into the command's stderr or leaked to models.
    child.stderr!.on('data', () => {})
    let pending: Buffer = Buffer.alloc(0)
    child.stdout!.on('data', (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      while (pending.length >= 5) {
        const length = pending.readUInt32LE(1)
        if (length > maximumFrameBytes) { fail(); child!.stdin!.destroy(); pending = Buffer.alloc(0); return }
        if (pending.length < 5 + length) return
        const type = String.fromCharCode(pending[0]), bytes = pending.subarray(5, 5 + length)
        pending = pending.subarray(5 + length)
        if (type === 'P' && length === 4 && pid === undefined) pid = bytes.readUInt32LE(0)
        else if (type === 'O' || type === 'E') {
          const output = type === 'O' ? stdout : stderr, keep = Math.min(bytes.length, Math.max(0, limit - output.readableLength))
          if (keep) output.push(Buffer.from(bytes.subarray(0, keep)))
          truncated ||= keep < bytes.length
        } else if (type === 'X' && length === 12 && !exitedValue) {
          const code = bytes.readBigInt64LE(0), signal = bytes.readInt32LE(8)
          const signals: Record<number, NodeJS.Signals> = { 1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 6: 'SIGABRT', 9: 'SIGKILL', 13: 'SIGPIPE', 15: 'SIGTERM' }
          exitedValue = { exitCode: code === -9_223_372_036_854_775_808n ? null : Number(code), signal: signals[signal] ?? null }
          resolveExit(exitedValue)
        } else if (type === 'N' && length === 0 && !exitedValue && !launchFailed) launchFailed = true
        else if (type === 'D' && length === 0 && !nativeDone) nativeDone = true
        else if (type === 'F') fail()
        else { fail(); child!.stdin!.destroy() }
      }
    })
    child.once('close', code => { if (code !== 0 || pending.length) fail(); finish() })
    send('S', config)
    if (options.stdin === 'ignore') stdin.end()
  } catch {
    if (child) fail()
    else { launchFailed = true; nativeDone = true }
    queueMicrotask(finish)
  }
  return { get pid() { return pid }, stdout, stderr, stdin, exited, done, get outputTruncated() { return truncated }, terminate }
}
