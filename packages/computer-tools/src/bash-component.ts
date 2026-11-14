import { isAbsolute } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Component } from '@nya/core'
import type { OwnedCall } from '@anybox/tool-api'
import type { ToolDefinition } from '@anybox/tool-api'
import { bashToolDefinition } from './contracts/legacy.js'
export { bashToolDefinition } from './contracts/legacy.js'
import { spawnManagedProcess, type ManagedProcess } from '@anybox/computer-tools/platform/process-runtime'
import { prepareShellCommand, type ShellRuntimeOptions } from './platform/shell.js'

export const bashServiceKey = 'tools.bash'

export interface BashResult {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
}

export interface BashPort {
  readonly definition: ToolDefinition
  /** A trusted workspacePath fixes cwd; the caller resolves its workspace before tool admission. */
  execute(input: { readonly command: string; readonly workspacePath: string }): OwnedCall<BashResult>
}

export type BashFailureCategory = 'invalid-request' | 'unavailable' | 'timeout' | 'cancelled' | 'cleanup-failure'

export class BashFailure extends Error {
  constructor(readonly category: BashFailureCategory) {
    super({
      'invalid-request': 'bash request is invalid',
      unavailable: 'bash is unavailable',
      timeout: 'bash command timed out',
      cancelled: 'bash command was cancelled',
      'cleanup-failure': 'bash command cleanup failed',
    }[category])
    this.name = 'BashFailure'
  }
}

export interface BashOptions {
  readonly shell?: ShellRuntimeOptions
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly terminationGraceMs?: number
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const chosen = value ?? fallback
  if (!Number.isSafeInteger(chosen) || chosen <= 0 || chosen > 2_147_483_647) {
    throw new TypeError(`${name} must be a positive integer no greater than 2147483647`)
  }
  return chosen
}

function validateInput(input: { readonly command: string; readonly workspacePath: string }): void {
  if (!input || typeof input.command !== 'string' || !input.command.trim() ||
    input.command.includes('\0') || typeof input.workspacePath !== 'string' || !isAbsolute(input.workspacePath) || input.workspacePath.includes('\0')) {
    throw new BashFailure('invalid-request')
  }
}

/** Owns one local Bash process per call. The trusted cwd is a relative-path base, not a filesystem sandbox. */
export function createBashComponent(options: BashOptions = {}): Component.Object<void> {
  const timeoutMs = positiveInteger(options.timeoutMs, 120_000, 'timeoutMs')
  const maxOutputBytes = positiveInteger(options.maxOutputBytes, 65_536, 'maxOutputBytes')
  const terminationGraceMs = positiveInteger(options.terminationGraceMs, 5_000, 'terminationGraceMs')
  return {
    name: 'bash-tool',
    apply(ctx) {
      const active = new Set<OwnedCall<BashResult>>()
      const failures = new Set<unknown>()
      let accepting = true

      ctx.effect(() => async () => {
        accepting = false
        const pending = [...active]
        for (const call of pending) call.cancel('owner-disposed')
        for (const result of await Promise.allSettled(pending.map(call => call.done))) {
          if (result.status === 'rejected') failures.add(result.reason)
        }
        if (failures.size === 1) throw [...failures][0]
        if (failures.size > 1) throw new AggregateError([...failures], 'bash cleanup failed')
      }, 'cancel and join Bash commands')

      const service: BashPort = {
        definition: bashToolDefinition,
        execute(input) {
          if (!accepting) throw new BashFailure('unavailable')
          validateInput(input)
          const workspacePath = input.workspacePath
          let child: ManagedProcess | undefined
          let timer: NodeJS.Timeout | undefined
          let interrupted: BashFailure | undefined
          let exited = false
          let rejectInterruption!: (error: BashFailure) => void
          let cleanupFailed = false
          const interruption = new Promise<never>((_, reject) => { rejectInterruption = reject })
          void interruption.catch(() => {})

          const terminate = (failure: BashFailure) => {
            if (interrupted || exited) return
            interrupted = failure
            rejectInterruption(failure)
            if (!child) return
            child.terminate()
          }

          const operation = (async (): Promise<BashResult> => {
            const path = workspacePath
            if (interrupted) throw interrupted
            try {
              child = spawnManagedProcess({ ...prepareShellCommand({ command: input.command, bash: true, login: false }, options.shell), cwd: path, stdin: 'ignore', terminationGraceMs })
            } catch { throw new BashFailure('unavailable') }
            const stdout: string[] = [], stderr: string[] = []
            const outputDecoder = new StringDecoder('utf8'), errorDecoder = new StringDecoder('utf8')
            let kept = 0, truncated = false
            const collect = (target: string[], text: string) => {
              const chunk = Buffer.from(text)
              let take = Math.min(chunk.length, maxOutputBytes - kept)
              while (take > 0 && take < chunk.length && (chunk[take] & 0xc0) === 0x80) take--
              if (take) { target.push(chunk.subarray(0, take).toString('utf8')); kept += take }
              if (take < chunk.length) truncated = true
            }
            child.stdout.on('data', (chunk: Buffer) => collect(stdout, outputDecoder.write(chunk)))
            child.stderr.on('data', (chunk: Buffer) => collect(stderr, errorDecoder.write(chunk)))
            timer = setTimeout(() => terminate(new BashFailure('timeout')), timeoutMs)
            try {
              const { exitCode, signal } = await child.exited
              await child.done.catch(error => { cleanupFailed = true; throw error })
              collect(stdout, outputDecoder.end()); collect(stderr, errorDecoder.end())
              return Object.freeze({ exitCode, signal, stdout: stdout.join(''), stderr: stderr.join(''), truncated: truncated || child.outputTruncated })
            } catch { throw new BashFailure(cleanupFailed ? 'cleanup-failure' : 'unavailable') }
            finally {
              await child.done.catch(() => { cleanupFailed = true })
              exited = true
            }
          })()

          const done = operation.then(() => {}, () => {}).then(() => {
            if (timer) clearTimeout(timer)
            if (cleanupFailed) throw new BashFailure('cleanup-failure')
          })
          const call: OwnedCall<BashResult> = {
            result: Promise.race([operation, interruption]),
            done: done.finally(() => { active.delete(call) }),
            cancel() { terminate(new BashFailure('cancelled')) },
          }
          active.add(call)
          void call.result.catch(() => {})
          void call.done.catch(error => { failures.add(error) })
          return call
        },
      }
      ctx.provide(bashServiceKey, service)
    },
  }
}
