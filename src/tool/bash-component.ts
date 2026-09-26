import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { Component } from '@nya/core'
import type { OwnedCall } from '../contracts.js'
import type { LLMToolDefinition } from '../llm/port.js'
import { projectServiceKey } from '../project/component.js'
import type { ProjectPort } from '../project/component.js'

export const bashServiceKey = 'tools.bash'

export interface BashResult {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
}

export interface BashPort {
  readonly definition: LLMToolDefinition
  execute(input: { readonly projectId: string; readonly command: string }): OwnedCall<BashResult>
}

export const bashToolDefinition: LLMToolDefinition = Object.freeze({
  name: 'bash',
  description: 'Run a Bash command in the current project directory. The command has the application user\'s filesystem and network access.',
  parameters: Object.freeze({
    type: 'object',
    properties: Object.freeze({ command: Object.freeze({ type: 'string', description: 'Bash command to execute' }) }),
    required: Object.freeze(['command']),
    additionalProperties: false,
  }),
})

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

function validateInput(input: { readonly projectId: string; readonly command: string }): void {
  if (!input || typeof input.projectId !== 'string' || !input.projectId.trim() ||
    typeof input.command !== 'string' || !input.command.trim() ||
    input.command.includes('\0')) {
    throw new BashFailure('invalid-request')
  }
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: process.env.LANG ?? 'C',
  }
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (child.pid === undefined) return true
  try {
    process.kill(-child.pid, signal)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return true
    return false
  }
}

/** Owns one local Bash process per call. Its cwd is a project identity, not a filesystem sandbox. */
export function createBashComponent(options: BashOptions = {}): Component.Object<void, {
  [projectServiceKey]: ProjectPort
}> {
  if (process.platform === 'win32') throw new TypeError('Bash component requires a Unix host')
  const timeoutMs = positiveInteger(options.timeoutMs, 120_000, 'timeoutMs')
  const maxOutputBytes = positiveInteger(options.maxOutputBytes, 65_536, 'maxOutputBytes')
  const terminationGraceMs = positiveInteger(options.terminationGraceMs, 5_000, 'terminationGraceMs')
  return {
    name: 'bash-tool',
    inject: [projectServiceKey],
    apply(ctx, _config, deps) {
      const projects = deps[projectServiceKey]
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
          let child: ChildProcess | undefined
          let timer: NodeJS.Timeout | undefined
          let killTimer: NodeJS.Timeout | undefined
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
            if (!signalProcessGroup(child, 'SIGTERM')) cleanupFailed = true
            killTimer = setTimeout(() => {
              if (!signalProcessGroup(child!, 'SIGKILL')) cleanupFailed = true
            }, terminationGraceMs)
          }

          const operation = (async (): Promise<BashResult> => {
            let path: string
            try { path = (await projects.requireAvailable(input.projectId)).path }
            catch { throw new BashFailure('unavailable') }
            if (interrupted) throw interrupted
            try {
              child = spawn('/bin/bash', ['-c', input.command], {
                cwd: path, env: minimalEnvironment(), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
              })
            } catch { throw new BashFailure('unavailable') }

            return new Promise<BashResult>((resolve, reject) => {
              const stdout: Buffer[] = []
              const stderr: Buffer[] = []
              let kept = 0
              let truncated = false
              let spawnFailed = false
              const collect = (target: Buffer[], chunk: Buffer) => {
                const take = Math.min(chunk.length, maxOutputBytes - kept)
                if (take) { target.push(chunk.subarray(0, take)); kept += take }
                if (take < chunk.length) truncated = true
              }
              child!.stdout!.on('data', (chunk: Buffer) => collect(stdout, chunk))
              child!.stderr!.on('data', (chunk: Buffer) => collect(stderr, chunk))
              child!.once('error', () => { spawnFailed = true })
              child!.once('close', (exitCode, signal) => {
                exited = true
                if (spawnFailed) { reject(new BashFailure('unavailable')); return }
                resolve(Object.freeze({
                  exitCode, signal, stdout: Buffer.concat(stdout).toString('utf8'),
                  stderr: Buffer.concat(stderr).toString('utf8'), truncated,
                }))
              })
              timer = setTimeout(() => terminate(new BashFailure('timeout')), timeoutMs)
            })
          })()

          const done = operation.then(() => {}, () => {}).then(() => {
            if (timer) clearTimeout(timer)
            if (killTimer) clearTimeout(killTimer)
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
