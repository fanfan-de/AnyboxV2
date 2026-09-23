import type { Owned, StateData, StateService } from '@anybox/agent-contracts/spi'
import { fault } from '../../shared/errors.js'
import { emptyState } from './codec.js'

export function createMemoryState(): Owned<StateService> {
  let data = emptyState()
  let closed = false
  let tail: Promise<unknown> = Promise.resolve()
  let closing: Promise<void> | undefined
  const enqueue = <T>(work: () => T): Promise<T> => {
    if (closed) return Promise.reject(fault('CLOSED', 'state service is closed'))
    const task = tail.then(work)
    tail = task.catch(() => {})
    return task
  }
  const service: StateService = {
    durability: 'memory',
    readSnapshot: () => enqueue(() => structuredClone(data)),
    transaction: <T>(_label: string, change: (draft: StateData) => T) => enqueue(() => {
      const draft = structuredClone(data)
      const result = change(draft)
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        void Promise.resolve(result).catch(() => {})
        throw fault('INVALID_ARGUMENT', 'state transaction callbacks must be synchronous')
      }
      const returned = structuredClone(result)
      const committed = structuredClone(draft)
      data = committed
      return returned
    }),
  }
  return { service, close() {
    if (closing) return closing
    closed = true
    closing = tail.then(() => { data = emptyState() })
    return closing
  } }
}
