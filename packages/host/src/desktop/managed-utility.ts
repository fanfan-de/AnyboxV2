import { EventEmitter } from 'node:events'
import { finished } from 'node:stream/promises'
import type { ManagedRoleChild } from '../package-management/managed-process.js'
import type { RpcMessage } from './rpc.js'
interface Utility {
  readonly stdout: NodeJS.ReadableStream | null
  readonly stderr: NodeJS.ReadableStream | null
  postMessage(message: unknown): void
  on(event: string, handler: (...args: any[]) => void): unknown
  once(event: string, handler: (...args: any[]) => void): unknown
}
/** Adapts only an already-created fixed utility process, never a package-selected entry. */
export function adaptManagedDesktopUtility(utility: Utility): ManagedRoleChild {
  const events = new EventEmitter()
  let connected = true
  Object.defineProperty(events, 'connected', { get: () => connected })
  Object.assign(events, { stdout: utility.stdout, stderr: utility.stderr,
    send(message: RpcMessage, callback?: (error: Error | null) => void) {
      if (!connected) { queueMicrotask(() => callback?.(new Error('worker-unavailable'))); return false }
      try { utility.postMessage(message); queueMicrotask(() => callback?.(null)); return true }
      catch { queueMicrotask(() => callback?.(new Error('worker-unavailable'))); return false }
    },
  })
  utility.on('message', message => events.emit('message', message))
  // Electron may attach an unredacted native report; do not relay its arguments.
  utility.on('error', () => events.emit('error', new Error('managed-role-start-failed')))
  utility.once('exit', (code: number) => {
    connected = false
    events.emit('exit', code, null)
    events.emit('disconnect')
    // The process has actually exited. Its stdio streams must also finish before
    // the supervisor receives the equivalent of ChildProcess.close.
    void Promise.allSettled([utility.stdout, utility.stderr].flatMap(stream => stream ? [finished(stream, { cleanup: true })] : [])).then(() => events.emit('close', code, null))
  })
  return events as unknown as ManagedRoleChild
}
