import { createExternalCredentialSourceComponent } from '../../dist/credentials/external-source.js'
import { deferred } from './controlled-llm.mjs'

/**
 * The fake credential component used by behaviour tests: the external source component fed by an in-memory map.
 * Tests change the map, make reads fail, or hold a read open to observe cancellation and cleanup waiting.
 */
export function memoryCredentials(initial = {}) {
  const secrets = new Map(Object.entries(initial))
  const reads = []
  const api = {
    secrets, reads,
    failure: undefined,
    holding: false,
    component: () => createExternalCredentialSourceComponent({
      async read(id, signal) {
        const entry = { id, aborted: deferred(), released: deferred() }
        signal.addEventListener('abort', () => entry.aborted.resolve(signal.reason))
        reads.push(entry)
        // Like a native store call, a held read only exits when released; an abort is reported after that.
        if (api.holding) await entry.released.promise
        if (signal.aborted) throw new Error('source read aborted')
        if (api.failure) throw api.failure
        return secrets.get(id)
      },
    }),
    release() { for (const read of reads) read.released.resolve() },
  }
  return api
}
