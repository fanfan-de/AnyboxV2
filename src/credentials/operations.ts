/** Admission and exit tracking shared by the credential components: refuse new work, abort accepted work, then join it. */
import { CredentialFailure } from './port.js'
import type { CredentialFailureCategory } from './port.js'

export interface OperationTracker {
  /** Runs one store operation. Rejects with `closed` once closing began; an aborted operation rejects with `cancelled`. */
  run<Result>(work: (signal: AbortSignal) => Promise<Result>, signal?: AbortSignal): Promise<Result>
  /** Stops accepting, aborts accepted operations and settles once every one of them has exited. */
  close(): Promise<void>
}

/** Errors other than CredentialFailure are replaced by the fallback category so nothing native escapes. */
export function createOperationTracker(fallback: CredentialFailureCategory): OperationTracker {
  const active = new Map<AbortController, Promise<void>>()
  let accepting = true
  return {
    async run(work, signal) {
      if (!accepting) throw new CredentialFailure('closed')
      const controller = new AbortController()
      const abort = () => controller.abort(signal?.reason)
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
      const operation = (async () => {
        if (controller.signal.aborted) throw new CredentialFailure('cancelled')
        return work(controller.signal)
      })()
      active.set(controller, operation.then(() => {}, () => {}))
      try {
        const value = await operation
        if (controller.signal.aborted) throw new CredentialFailure('cancelled')
        return value
      } catch (error) {
        if (error instanceof CredentialFailure) throw error
        throw new CredentialFailure(controller.signal.aborted ? 'cancelled' : fallback)
      } finally {
        signal?.removeEventListener('abort', abort)
        active.delete(controller)
      }
    },
    async close() {
      accepting = false
      const pending = [...active]
      for (const [controller] of pending) controller.abort('credentials-disposed')
      await Promise.all(pending.map(([, exited]) => exited))
    },
  }
}
