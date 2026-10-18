import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Component } from '@nya/core'
import type { JsonValue } from '@anybox/models'
import type { OwnedCall } from '../contracts.js'
import { projectServiceKey } from '../project/component.js'
import type { ProjectPort } from '../project/component.js'
import { validateLibraryArguments } from './catalog.js'

export const processToolsServiceKey = 'tools.processes'
export interface ProcessRunScope {
  execute(name: 'codex_exec_command' | 'codex_write_stdin', args: Readonly<Record<string, JsonValue>>): OwnedCall<JsonValue>
  foreground(input: { readonly command: string; readonly timeoutMs?: number; readonly maxOutputTokens?: number; readonly workdir?: string }): OwnedCall<JsonValue>
  /** Stop admission, terminate process groups and join all operation/process resources. */
  close(): OwnedCall<JsonValue>
}
export interface ProcessToolsPort {
  /** Acquires ownership synchronously; a trusted workspacePath fixes the base for every process in this scope. */
  openRun(input: { readonly runId: string; readonly projectId: string; readonly workspacePath?: string }): ProcessRunScope
}
export interface ProcessOptions {
  readonly timeoutMs?: number
  readonly maxBufferedOutputBytes?: number
  readonly terminationGraceMs?: number
  readonly maxProcessesPerRun?: number
}
export type ProcessFailureCategory = 'invalid-request' | 'unavailable' | 'cancelled' | 'cleanup-failure'
export class ProcessFailure extends Error {
  constructor(readonly category: ProcessFailureCategory) { super(`process ${category}`); this.name = 'ProcessFailure' }
}
interface ProcessEntry {
  readonly id: number
  readonly child: ChildProcessWithoutNullStreams
  readonly done: Promise<void>
  readonly changed: Set<() => void>
  pending: string
  truncated: boolean
  pendingTruncated: boolean
  exited: boolean
  spawnFailed: boolean
  exitCode: number | null
  signal: NodeJS.Signals | null
  terminated: boolean
  timedOut: boolean
  cleanupFailed: boolean
  writing: Promise<void>
  terminate(): void
}
function positive(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > 2_147_483_647) throw new TypeError('invalid process option')
  return selected
}
function environment(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', TMPDIR: process.env.TMPDIR ?? '/tmp', LANG: process.env.LANG ?? 'C' }
}
function signalGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): boolean {
  if (child.pid === undefined) return true
  try { process.kill(-child.pid, signal); return true }
  catch (error) { return error instanceof Error && 'code' in error && error.code === 'ESRCH' }
}
function groupAlive(child: ChildProcessWithoutNullStreams): boolean {
  if (child.pid === undefined) return false
  try { process.kill(-child.pid, 0); return true }
  catch (error) { return !(error instanceof Error && 'code' in error && error.code === 'ESRCH') }
}
/** Split a string on a valid UTF-8 boundary; byte limits never corrupt persisted text. */
function prefix(text: string, byteLimit: number): { head: string; tail: string } {
  const bytes = Buffer.from(text)
  if (bytes.length <= byteLimit) return { head: text, tail: '' }
  let boundary = byteLimit
  while (boundary > 0 && (bytes[boundary] & 0xc0) === 0x80) boundary--
  return { head: bytes.subarray(0, boundary).toString('utf8'), tail: bytes.subarray(boundary).toString('utf8') }
}
function changed(entry: ProcessEntry): void { for (const listener of [...entry.changed]) listener() }
function wait(entry: ProcessEntry, duration: number, signal: AbortSignal, output: boolean): Promise<void> {
  if (signal.aborted) return Promise.reject(new ProcessFailure('cancelled'))
  if (entry.exited || output && entry.pending.length || duration === 0) return Promise.resolve()
  return new Promise((yes, no) => {
    const finish = () => { clearTimeout(timer); entry.changed.delete(onChange); signal.removeEventListener('abort', onAbort); yes() }
    const onChange = () => { if (entry.exited || output && entry.pending.length) finish() }
    const onAbort = () => { clearTimeout(timer); entry.changed.delete(onChange); signal.removeEventListener('abort', onAbort); no(new ProcessFailure('cancelled')) }
    const timer = setTimeout(finish, duration)
    entry.changed.add(onChange); signal.addEventListener('abort', onAbort, { once: true })
    onChange()
  })
}
function drain(entry: ProcessEntry, tokens: number, started: number): JsonValue {
  const captured = prefix(entry.pending, Math.min(tokens * 4, 131_072))
  const truncated = entry.pendingTruncated || captured.tail.length > 0
  entry.pending = captured.tail; entry.pendingTruncated = false
  return { output: captured.head, exit_code: entry.exitCode, signal: entry.signal, wall_time_seconds: (Date.now() - started) / 1_000,
    truncated, ...(!entry.exited || entry.pending.length ? { session_id: entry.id } : {}),
    ...(entry.timedOut ? { timed_out: true } : {}), ...(entry.spawnFailed ? { error: 'process-unavailable' } : {}) }
}

/** Owns pipe process groups per Run. Operation done and process done are separate barriers. */
export function createProcessToolsComponent(options: ProcessOptions = {}): Component.Object<void, { [projectServiceKey]: ProjectPort }> {
  if (process.platform === 'win32') throw new TypeError('process component requires a Unix host')
  const timeoutMs = positive(options.timeoutMs, 120_000)
  const maxBufferedOutputBytes = positive(options.maxBufferedOutputBytes, 131_072)
  const terminationGraceMs = positive(options.terminationGraceMs, 5_000)
  const maxProcessesPerRun = positive(options.maxProcessesPerRun, 32)
  return { name: 'process-tools', inject: [projectServiceKey], apply(ctx, _config, deps) {
    const scopes = new Map<string, ProcessRunScope>()
    const failures = new Set<unknown>()
    let accepting = true, nextSessionId = 1
    ctx.effect(() => async () => {
      accepting = false
      const pending = [...scopes.values()].map(scope => scope.close())
      await Promise.allSettled(pending.map(call => call.result))
      for (const outcome of await Promise.allSettled(pending.map(call => call.done))) if (outcome.status === 'rejected') failures.add(outcome.reason)
      if (failures.size) throw new AggregateError([...failures], 'process tool cleanup failed')
    }, 'cancel and join Run process scopes')
    const service: ProcessToolsPort = {
      openRun({ runId, projectId, workspacePath }) {
        if (!accepting) throw new ProcessFailure('unavailable')
        if (typeof runId !== 'string' || !runId.trim() || typeof projectId !== 'string' || !projectId.trim() || scopes.has(runId) ||
          workspacePath !== undefined && (typeof workspacePath !== 'string' || !isAbsolute(workspacePath) || workspacePath.includes('\0'))) throw new ProcessFailure('invalid-request')
        const processes = new Map<number, ProcessEntry>()
        const calls = new Set<OwnedCall<JsonValue>>()
        let open = true, closing: OwnedCall<JsonValue> | undefined
        const owned = (work: (signal: AbortSignal, own: (entry: ProcessEntry) => void) => Promise<JsonValue>): OwnedCall<JsonValue> => {
          if (!open || !accepting) throw new ProcessFailure('unavailable')
          const controller = new AbortController()
          let processEntry: ProcessEntry | undefined
          const result = Promise.resolve().then(() => work(controller.signal, entry => { processEntry = entry; if (controller.signal.aborted) entry.terminate() }))
          const done = result.then(() => {}, () => {}).then(async () => {
            if (controller.signal.aborted && processEntry) await processEntry.done
            if (processEntry?.cleanupFailed) throw new ProcessFailure('cleanup-failure')
          })
          const call: OwnedCall<JsonValue> = { result, done: done.finally(() => { calls.delete(call) }), cancel() { controller.abort(); processEntry?.terminate() } }
          calls.add(call); void call.result.catch(() => {}); void call.done.catch(error => { failures.add(error) })
          return call
        }
        const start = async (input: { command: string; workdir?: string; shell?: string; login?: boolean; timeout?: number; foreground?: boolean }, signal: AbortSignal): Promise<ProcessEntry> => {
          if (signal.aborted || !open || !accepting) throw new ProcessFailure('cancelled')
          if ([...processes.values()].filter(entry => !entry.exited).length >= maxProcessesPerRun) throw new ProcessFailure('unavailable')
          let projectPath: string
          try { projectPath = workspacePath ?? (await deps[projectServiceKey].requireAvailable(projectId)).path }
          catch { throw new ProcessFailure('unavailable') }
          if (signal.aborted || !open || !accepting) throw new ProcessFailure('cancelled')
          const cwd = input.workdir ? isAbsolute(input.workdir) ? input.workdir : resolve(projectPath, input.workdir) : projectPath
          let child: ChildProcessWithoutNullStreams
          try { child = spawn(input.shell ?? '/bin/bash', [input.login === false ? '-c' : '-lc', input.command], { cwd, env: environment(), detached: true, stdio: ['pipe', 'pipe', 'pipe'] }) }
          catch { throw new ProcessFailure('unavailable') }
          let finish!: () => void, timer: NodeJS.Timeout | undefined, killTimer: NodeJS.Timeout | undefined
          let forceAt = 0
          const entry: ProcessEntry = {
            id: nextSessionId++, child, done: new Promise<void>(yes => { finish = yes }), changed: new Set(), pending: '', truncated: false, pendingTruncated: false,
            exited: false, spawnFailed: false, exitCode: null, signal: null, terminated: false, timedOut: false, cleanupFailed: false, writing: Promise.resolve(),
            terminate() {
              if (entry.exited || entry.terminated) return
              entry.terminated = true
              signalGroup(child, 'SIGTERM')
              forceAt = Date.now() + terminationGraceMs
              killTimer = setTimeout(() => { signalGroup(child, 'SIGKILL') }, terminationGraceMs)
            },
          }
          processes.set(entry.id, entry)
          const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8')
          const collect = (text: string) => {
            const space = Math.max(0, maxBufferedOutputBytes - Buffer.byteLength(entry.pending))
            const captured = prefix(text, space)
            entry.pending += captured.head
            if (captured.tail) { entry.truncated = true; entry.pendingTruncated = true }
            changed(entry)
          }
          child.stdout.on('data', (chunk: Buffer) => collect(stdout.write(chunk)))
          child.stderr.on('data', (chunk: Buffer) => collect(stderr.write(chunk)))
          child.stdin.on('error', () => { /* Write callbacks report pipe closure; never emit an uncaught stream error. */ })
          child.once('error', () => { entry.spawnFailed = true })
          // The shell can exit while a child still owns its pipes or runs with redirected
          // output. Independent background jobs are outside this contract: clean its group.
          child.once('exit', (exitCode, signal) => {
            entry.exitCode = exitCode; entry.signal = signal
            if (groupAlive(child)) entry.terminate()
          })
          child.once('close', (exitCode, signal) => {
            collect(stdout.end()); collect(stderr.end())
            entry.exitCode = exitCode; entry.signal = signal
            if (timer) clearTimeout(timer)
            const settle = () => {
              entry.exited = true
              if (killTimer) clearTimeout(killTimer)
              changed(entry); finish()
            }
            const joinGroup = () => {
              if (!groupAlive(child)) { settle(); return }
              entry.terminate()
              if (Date.now() >= forceAt + terminationGraceMs) {
                entry.cleanupFailed = true; settle(); return
              }
              setTimeout(joinGroup, 10)
            }
            joinGroup()
          })
          timer = setTimeout(() => { entry.timedOut = true; entry.terminate() }, input.timeout ?? timeoutMs)
          if (input.foreground) child.stdin.end()
          return entry
        }
        const scope: ProcessRunScope = {
          execute(name, raw) {
            const args = validateLibraryArguments(name, raw)
            if (name === 'codex_exec_command') return owned(async (signal, own) => {
              const began = Date.now()
              const entry = await start({ command: args.cmd as string, workdir: args.workdir as string | undefined, shell: args.shell as string | undefined, login: args.login as boolean | undefined }, signal)
              own(entry)
              await wait(entry, Number(args.yield_time_ms ?? 10_000), signal, false)
              return drain(entry, Number(args.max_output_tokens ?? 4_096), began)
            })
            if (name !== 'codex_write_stdin') throw new ProcessFailure('invalid-request')
            return owned(async (signal, own) => {
              const began = Date.now(), entry = processes.get(args.session_id as number)
              if (!entry) return { error: 'session-unavailable', output: '', exit_code: null, truncated: false }
              own(entry)
              const chars = String(args.chars ?? '')
              const writing = entry.writing.then(async () => {
                if (signal.aborted) throw new ProcessFailure('cancelled')
                if (chars && !entry.exited) await new Promise<void>((yes, no) => childWrite(entry, chars, error => error ? no(error) : yes()))
              })
              entry.writing = writing.catch(() => {})
              try { await writing }
              catch (error) {
                if (signal.aborted) throw new ProcessFailure('cancelled')
                return { ...drain(entry, Number(args.max_output_tokens ?? 4_096), began) as Record<string, JsonValue>, error: 'stdin-unavailable' }
              }
              await wait(entry, Number(args.yield_time_ms ?? 1_000), signal, true)
              return drain(entry, Number(args.max_output_tokens ?? 4_096), began)
            })
          },
          foreground(input) {
            if (!input || typeof input.command !== 'string' || !input.command.trim() || input.command.includes('\0') || input.workdir !== undefined && (typeof input.workdir !== 'string' || !input.workdir.trim() || input.workdir.includes('\0'))) throw new ProcessFailure('invalid-request')
            const timeout = positive(input.timeoutMs, timeoutMs), tokens = positive(input.maxOutputTokens, 16_384)
            return owned(async (signal, own) => {
              const began = Date.now(), entry = await start({ command: input.command, workdir: input.workdir, login: false, timeout, foreground: true }, signal)
              own(entry)
              if (signal.aborted) throw new ProcessFailure('cancelled')
              await entry.done
              if (signal.aborted) throw new ProcessFailure('cancelled')
              return drain(entry, tokens, began)
            })
          },
          close() {
            if (closing) return closing
            open = false
            const operations = [...calls]
            for (const operation of operations) operation.cancel('owner-disposed')
            for (const entry of processes.values()) entry.terminate()
            const result: Promise<JsonValue> = Promise.resolve().then(async () => {
              await Promise.allSettled(operations.map(call => call.done))
              await Promise.all([...processes.values()].map(entry => entry.done))
              const summaries = [...processes.values()].map(entry => ({ session_id: entry.id, exit_code: entry.exitCode, signal: entry.signal,
                output: entry.pending, truncated: entry.truncated, terminated: entry.terminated, timed_out: entry.timedOut, ...(entry.spawnFailed ? { error: 'process-unavailable' } : {}) }))
              return { processes: summaries, cleanup: [...processes.values()].some(entry => entry.cleanupFailed) ? 'failed' : 'completed' }
            })
            const done = result.then(value => {
              if ((value as Record<string, JsonValue>).cleanup === 'failed') throw new ProcessFailure('cleanup-failure')
            }).finally(() => { scopes.delete(runId); processes.clear() })
            closing = { result, done, cancel() { for (const entry of processes.values()) entry.terminate() } }
            void result.catch(() => {}); void done.catch(error => { failures.add(error) })
            return closing
          },
        }
        scopes.set(runId, scope)
        return scope
      },
    }
    ctx.provide(processToolsServiceKey, service)
  } }
}
function childWrite(entry: ProcessEntry, chars: string, callback: (error?: Error | null) => void): void {
  try { entry.child.stdin.write(chars, callback) } catch (error) { callback(error instanceof Error ? error : new Error('stdin-unavailable')) }
}
