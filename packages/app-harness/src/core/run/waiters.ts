/** Detachable observers of shared execution promises. Aborting a waiter never cancels execution. */
export function createWaiters<Value>(): (work: Promise<Value>, signal?: AbortSignal) => Promise<Value> {
  type Subscriber = { resolve(value: Value): void; reject(error: unknown): void }
  const groups = new WeakMap<Promise<Value>, Set<Subscriber>>()
  return (work, signal) => {
    if (!signal) return work
    if (signal.aborted) return Promise.reject(signal.reason)
    let subscribers = groups.get(work)
    if (!subscribers) {
      subscribers = new Set()
      groups.set(work, subscribers)
      const group = subscribers
      void work.then(value => {
        groups.delete(work)
        for (const subscriber of group) subscriber.resolve(value)
        group.clear()
      }, error => {
        groups.delete(work)
        for (const subscriber of group) subscriber.reject(error)
        group.clear()
      })
    }
    const group = subscribers
    return new Promise<Value>((resolve, reject) => {
      const cleanup = () => { group.delete(subscriber); signal.removeEventListener('abort', abort) }
      const subscriber: Subscriber = {
        resolve(value) { cleanup(); resolve(value) },
        reject(error) { cleanup(); reject(error) },
      }
      const abort = () => subscriber.reject(signal.reason)
      group.add(subscriber)
      signal.addEventListener('abort', abort, { once: true })
    })
  }
}
