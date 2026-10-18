import type { Api } from './client-types.js'

export interface MountedPage {
  setActive?(active: boolean): void
  canLeave(): boolean
  dispose(): Promise<void>
}

/** A page owns its reads and waits for submitted writes without cancelling server work. */
export function createPageRequests(source: Api) {
  let disposed = false
  const reads = new Set<AbortController>(), writes = new Set<Promise<unknown>>(), pending = new Set<Promise<unknown>>()
  const api: Api = <T>(path: string, body?: object, signal?: AbortSignal): Promise<T> => {
    if (disposed) return Promise.reject(new DOMException('Page closed', 'AbortError'))
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    if (body === undefined) reads.add(controller)
    const task = Promise.resolve().then(() => source<T>(path, body, controller.signal))
      .then(value => {
        if (disposed) throw new DOMException('Page closed', 'AbortError')
        return value
      }).finally(() => { pending.delete(task); writes.delete(task); reads.delete(controller); signal?.removeEventListener('abort', abort) })
    pending.add(task)
    if (body !== undefined) writes.add(task)
    return task
  }
  return {
    api,
    get busy() { return pending.size > 0 },
    get writing() { return writes.size > 0 },
    async dispose() {
      disposed = true
      for (const controller of reads) controller.abort()
      await Promise.allSettled([...pending])
    },
  }
}
