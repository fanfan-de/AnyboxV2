import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import type { Component } from '@nya/core'

export const directoryPickerServiceKey = 'host.directory-picker'

export type DirectoryPickerFailureCode = 'busy' | 'unavailable' | 'unsupported' | 'cancelled'

export class DirectoryPickerFailure extends Error {
  readonly code: DirectoryPickerFailureCode

  constructor(code: DirectoryPickerFailureCode) {
    super(`directory picker ${code}`)
    this.name = 'DirectoryPickerFailure'
    this.code = code
  }
}

export interface DirectoryPickerPort {
  readonly supported: boolean
  pick(signal?: AbortSignal): Promise<string | undefined>
}

const script = [
  'try',
  '  set pickedFolder to choose folder with prompt "选择项目目录"',
  '  return "SELECTED:" & (POSIX path of pickedFolder)',
  'on error errMsg number errNum',
  '  if errNum is -128 then return "CANCELLED"',
  '  error errMsg number errNum',
  'end try',
]

/** Only the host sees the native process and its errors. The script never includes request data. */
export function runMacOSDirectoryDialog(signal: AbortSignal): Promise<string | undefined> {
  if (signal.aborted) return Promise.reject(new DirectoryPickerFailure('cancelled'))
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', script.flatMap(line => ['-e', line]), {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let failed = false
    let exited = false
    const abort = () => { if (!exited) child.kill() }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
      if (output.length > 65_536) { failed = true; child.kill() }
    })
    child.stderr.resume()
    child.on('error', () => { failed = true })
    child.on('close', code => {
      exited = true
      signal.removeEventListener('abort', abort)
      if (signal.aborted) { reject(new DirectoryPickerFailure('cancelled')); return }
      if (failed || code !== 0) { reject(new DirectoryPickerFailure('unavailable')); return }
      const result = output.endsWith('\r\n') ? output.slice(0, -2) : output.endsWith('\n') ? output.slice(0, -1) : output
      if (result === 'CANCELLED') { resolve(undefined); return }
      if (!result.startsWith('SELECTED:') || !isAbsolute(result.slice('SELECTED:'.length))) {
        reject(new DirectoryPickerFailure('unavailable'))
        return
      }
      resolve(result.slice('SELECTED:'.length))
    })
  })
}

export interface DirectoryPickerOptions {
  /** Useful to exercise host lifecycle without showing a system dialog. */
  readonly platform?: NodeJS.Platform
  readonly runDialog?: (signal: AbortSignal) => Promise<string | undefined>
}

/** Owns the one native dialog and waits for its process to exit during cleanup. */
export function createDirectoryPickerComponent(options: DirectoryPickerOptions = {}): Component.Object<void> {
  return {
    name: 'host-directory-picker',
    apply(ctx) {
      const supported = (options.platform ?? process.platform) === 'darwin'
      const runDialog = options.runDialog ?? runMacOSDirectoryDialog
      let accepting = true
      let active: { readonly controller: AbortController; readonly done: Promise<unknown> } | undefined
      ctx.effect(() => async () => {
        accepting = false
        active?.controller.abort()
        if (active) await Promise.allSettled([active.done])
      }, 'cancel and join directory picker')
      const service: DirectoryPickerPort = {
        supported,
        pick(signal) {
          if (!accepting) return Promise.reject(new DirectoryPickerFailure('unavailable'))
          if (!supported) return Promise.reject(new DirectoryPickerFailure('unsupported'))
          if (active) return Promise.reject(new DirectoryPickerFailure('busy'))
          if (signal?.aborted) return Promise.reject(new DirectoryPickerFailure('cancelled'))
          const controller = new AbortController()
          const abort = () => controller.abort()
          signal?.addEventListener('abort', abort, { once: true })
          if (signal?.aborted) controller.abort()
          const done = Promise.resolve().then(() => {
            if (controller.signal.aborted) throw new DirectoryPickerFailure('cancelled')
            return runDialog(controller.signal)
          }).then(path => {
            if (controller.signal.aborted) throw new DirectoryPickerFailure('cancelled')
            if (path !== undefined && (typeof path !== 'string' || !isAbsolute(path))) {
              throw new DirectoryPickerFailure('unavailable')
            }
            return path
          }).catch(error => {
            if (controller.signal.aborted) throw new DirectoryPickerFailure('cancelled')
            if (error instanceof DirectoryPickerFailure) throw error
            throw new DirectoryPickerFailure('unavailable')
          }).finally(() => {
            signal?.removeEventListener('abort', abort)
            if (active?.done === done) active = undefined
          })
          active = { controller, done }
          return done
        },
      }
      ctx.provide(directoryPickerServiceKey, service)
    },
  }
}
