import { isAbsolute, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Component } from '@nya/core'
import type { JsonValue } from '@anybox/tool-api'
import type { OwnedCall } from '@anybox/tool-api'
import { spawnManagedProcess, type ManagedProcess } from '@anybox/computer-tools/platform/process-runtime'
import { prepareShellCommand, type ShellRuntimeOptions } from './platform/shell.js'

export interface ProcessExecuteInput {
  readonly command: string
  readonly workdir?: string
  readonly shell?: string
  readonly login?: boolean
  readonly yieldTimeMs?: number
  readonly maxOutputTokens?: number
}
export interface ProcessWriteInput {
  readonly sessionId: number
  readonly chars?: string
  readonly yieldTimeMs?: number
  readonly maxOutputTokens?: number
}
function boundedInteger(value: unknown, minimum: number, maximum: number): boolean { return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum }
function validateOutputOptions(value: { readonly yieldTimeMs?: number; readonly maxOutputTokens?: number }): void {
  if (value.yieldTimeMs !== undefined && !boundedInteger(value.yieldTimeMs, 0, 30_000) || value.maxOutputTokens !== undefined && !boundedInteger(value.maxOutputTokens, 1, 32_768)) throw new ProcessFailure('invalid-request')
}
function validateExecuteInput(value: ProcessExecuteInput): void {
  if (!value || typeof value.command !== 'string' || !value.command.trim() || value.command.includes('\0') || [value.workdir, value.shell].some(value => value !== undefined && (typeof value !== 'string' || !value.trim() || value.includes('\0'))) || value.login !== undefined && typeof value.login !== 'boolean') throw new ProcessFailure('invalid-request')
  validateOutputOptions(value)
}
function validateWriteInput(value: ProcessWriteInput): void {
  if (!value || !boundedInteger(value.sessionId, 1, Number.MAX_SAFE_INTEGER) || value.chars !== undefined && (typeof value.chars !== 'string' || value.chars.includes('\0'))) throw new ProcessFailure('invalid-request')
  validateOutputOptions(value)
}
export const processToolsServiceKey = 'tools.processes'
export interface ProcessScope {
  execute(input: ProcessExecuteInput): OwnedCall<JsonValue>
  write(input: ProcessWriteInput): OwnedCall<JsonValue>
  foreground(input: { readonly command: string; readonly timeoutMs?: number; readonly maxOutputTokens?: number; readonly workdir?: string }): OwnedCall<JsonValue>
  /** Stop admission, terminate process groups and join all operation/process resources. */
  close(): OwnedCall<JsonValue>
}
export interface ProcessToolsPort {
  /** Acquires ownership synchronously; a trusted workspacePath fixes the base for every process in this scope. */
  openScope(input: { readonly scopeId: string; readonly workspacePath: string }): ProcessScope
}
export interface ProcessOptions {
  readonly shell?: ShellRuntimeOptions
  readonly timeoutMs?: number
  readonly maxBufferedOutputBytes?: number
  readonly terminationGraceMs?: number
  readonly maxProcessesPerScope?: number
}
export type ProcessFailureCategory = 'invalid-request' | 'unavailable' | 'cancelled' | 'cleanup-failure'
export class ProcessFailure extends Error {
  constructor(readonly category: ProcessFailureCategory, cause?: unknown) { super(`process ${category}`, cause === undefined ? undefined : { cause }); this.name = 'ProcessFailure' }
}
interface ProcessEntry {
  readonly id: number
  readonly child: ManagedProcess
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
  cleanupFailure?: unknown
  writing: Promise<void>
  terminate(): void
}
function positive(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > 2_147_483_647) throw new TypeError('invalid process option')
  return selected
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

/** Owns pipe process groups per caller scope. Operation done and process done are separate barriers. */
export function createProcessToolsComponent(options: ProcessOptions = {}): Component.Object<void> {
  const timeoutMs = positive(options.timeoutMs, 120_000)
  const maxBufferedOutputBytes = positive(options.maxBufferedOutputBytes, 131_072)
  const terminationGraceMs = positive(options.terminationGraceMs, 5_000)
  const maxProcessesPerScope = positive(options.maxProcessesPerScope, 32)
  return { name: 'process-tools', apply(ctx) {
    const scopes = new Map<string, ProcessScope>()
    const failures = new Set<unknown>()
    let accepting = true, nextSessionId = 1
    ctx.effect(() => async () => {
      accepting = false
      const pending = [...scopes.values()].map(scope => scope.close())
      await Promise.allSettled(pending.map(call => call.result))
      for (const outcome of await Promise.allSettled(pending.map(call => call.done))) if (outcome.status === 'rejected') failures.add(outcome.reason)
      if (failures.size) throw new AggregateError([...failures], 'process tool cleanup failed')
    }, 'cancel and join process scopes')
    const service: ProcessToolsPort = {
      openScope({ scopeId, workspacePath }) {
        if (!accepting) throw new ProcessFailure('unavailable')
        if (typeof scopeId !== 'string' || !scopeId.trim() || scopes.has(scopeId) ||
          typeof workspacePath !== 'string' || !isAbsolute(workspacePath) || workspacePath.includes('\0')) throw new ProcessFailure('invalid-request')
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
            if (processEntry?.cleanupFailed) throw new ProcessFailure('cleanup-failure', processEntry.cleanupFailure)
          })
          const call: OwnedCall<JsonValue> = { result, done: done.finally(() => { calls.delete(call) }), cancel() { controller.abort(); processEntry?.terminate() } }
          calls.add(call); void call.result.catch(() => {}); void call.done.catch(error => { failures.add(error) })
          return call
        }
        const start = async (input: { command: string; workdir?: string; shell?: string; login?: boolean; timeout?: number; foreground?: boolean }, signal: AbortSignal): Promise<ProcessEntry> => {
          if (signal.aborted || !open || !accepting) throw new ProcessFailure('cancelled')
          if ([...processes.values()].filter(entry => !entry.exited).length >= maxProcessesPerScope) throw new ProcessFailure('unavailable')
          const basePath = workspacePath
          if (signal.aborted || !open || !accepting) throw new ProcessFailure('cancelled')
          // Admission is rechecked immediately before acquiring a process.
          if ([...processes.values()].filter(entry => !entry.exited).length >= maxProcessesPerScope) throw new ProcessFailure('unavailable')
          const cwd = input.workdir ? isAbsolute(input.workdir) ? input.workdir : resolve(basePath, input.workdir) : basePath
          let child: ManagedProcess
          try { child = spawnManagedProcess({ ...prepareShellCommand({ ...input, bash: input.foreground }, options.shell), cwd, terminationGraceMs }) }
          catch { throw new ProcessFailure('unavailable') }
          let finish!: () => void, timer: NodeJS.Timeout | undefined
          const entry: ProcessEntry = {
            id: nextSessionId++, child, done: new Promise<void>(yes => { finish = yes }), changed: new Set(), pending: '', truncated: false, pendingTruncated: false,
            exited: false, spawnFailed: false, exitCode: null, signal: null, terminated: false, timedOut: false, cleanupFailed: false, writing: Promise.resolve(),
            terminate() {
              if (entry.exited || entry.terminated) return
              entry.terminated = true
              child.terminate()
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
          const observedExit = child.exited.then(({ exitCode, signal }) => {
            entry.exitCode = exitCode; entry.signal = signal
          }, () => { entry.spawnFailed = true })
          // The platform owner joins the whole process tree and both output pipes.
          // A shell exit alone is never a completed process session.
          void Promise.all([observedExit, child.done.catch(error => { entry.cleanupFailed = true; entry.cleanupFailure = error instanceof Error ? error.cause ?? error : error })]).then(() => {
            collect(stdout.end()); collect(stderr.end())
            if (child.outputTruncated) { entry.truncated = true; entry.pendingTruncated = true }
            if (timer) clearTimeout(timer)
            entry.exited = true
            changed(entry); finish()
          })
          timer = setTimeout(() => { entry.timedOut = true; entry.terminate() }, input.timeout ?? timeoutMs)
          if (input.foreground) child.stdin.end()
          return entry
        }
        const scope: ProcessScope = {
          execute(args) {
            validateExecuteInput(args)
            return owned(async (signal, own) => {
              const began = Date.now()
              const entry = await start({ command: args.command, workdir: args.workdir, shell: args.shell, login: args.login }, signal)
              own(entry)
              await wait(entry, args.yieldTimeMs ?? 10_000, signal, false)
              return drain(entry, args.maxOutputTokens ?? 4_096, began)
            })
          },
          write(args) {
            validateWriteInput(args)
            return owned(async (signal, own) => {
              const began = Date.now(), entry = processes.get(args.sessionId)
              if (!entry) return { error: 'session-unavailable', output: '', exit_code: null, truncated: false }
              own(entry)
              const chars = args.chars ?? ''
              const writing = entry.writing.then(async () => {
                if (signal.aborted) throw new ProcessFailure('cancelled')
                if (chars && !entry.exited) await new Promise<void>((yes, no) => childWrite(entry, chars, error => error ? no(error) : yes()))
              })
              entry.writing = writing.catch(() => {})
              try { await writing }
              catch (error) {
                if (signal.aborted) throw new ProcessFailure('cancelled')
                return { ...drain(entry, args.maxOutputTokens ?? 4_096, began) as Record<string, JsonValue>, error: 'stdin-unavailable' }
              }
              await wait(entry, args.yieldTimeMs ?? 1_000, signal, true)
              return drain(entry, args.maxOutputTokens ?? 4_096, began)
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
              if ((value as Record<string, JsonValue>).cleanup === 'failed') throw new ProcessFailure('cleanup-failure', [...processes.values()].find(entry => entry.cleanupFailed)?.cleanupFailure)
            }).finally(() => { scopes.delete(scopeId); processes.clear() })
            closing = { result, done, cancel() { for (const entry of processes.values()) entry.terminate() } }
            void result.catch(() => {}); void done.catch(error => { failures.add(error) })
            return closing
          },
        }
        scopes.set(scopeId, scope)
        return scope
      },
    }
    ctx.provide(processToolsServiceKey, service)
  } }
}
function childWrite(entry: ProcessEntry, chars: string, callback: (error?: Error | null) => void): void {
  try { entry.child.stdin.write(chars, callback) } catch (error) { callback(error instanceof Error ? error : new Error('stdin-unavailable')) }
}
