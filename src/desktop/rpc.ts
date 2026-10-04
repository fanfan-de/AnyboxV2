/** Private, bidirectional main/utility transport. No renderer can access this port. */
export interface RpcMessage {
  readonly type: 'request' | 'response' | 'cancel'
  readonly id: number
  readonly method?: string
  readonly value?: unknown
  readonly error?: string
}
export type RpcHandler = (value: unknown, signal: AbortSignal) => unknown | Promise<unknown>
export function rpcFailure(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code })
}
export function createPrivateRpc(send: (message: RpcMessage) => void) {
  let next = 0, closed = false
  const handlers = new Map<string, RpcHandler>()
  const calls = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void; cleanup(): void }>()
  const operations = new Map<number, AbortController>()
  const pending = new Set<Promise<void>>()
  const receive = (input: unknown) => {
    if (!input || typeof input !== 'object' || closed) return
    const message = input as RpcMessage
    if (!Number.isSafeInteger(message.id)) return
    if (message.type === 'response') {
      const call = calls.get(message.id)
      if (!call) return
      calls.delete(message.id); call.cleanup()
      if (message.error) call.reject(rpcFailure(message.error)); else call.resolve(message.value)
    } else if (message.type === 'cancel') {
      operations.get(message.id)?.abort()
    } else if (message.type === 'request') {
      if (operations.has(message.id)) return
      const controller = new AbortController()
      operations.set(message.id, controller)
      const done = Promise.resolve().then(() => {
        const handler = handlers.get(message.method ?? '')
        if (!handler) throw rpcFailure('unsupported-operation')
        return handler(message.value, controller.signal)
      }).then(value => {
        if (!closed) send({ type: 'response', id: message.id, value })
      }, error => {
        // Never serialize stack traces, arguments, credentials, or native errors.
        const candidate = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'operation-failed'
        const code = /^[a-z][a-z0-9-]{0,79}$/.test(candidate) ? candidate : 'operation-failed'
        if (!closed) send({ type: 'response', id: message.id, error: code })
      }).catch(() => {
        // A lost transport must not turn completion into an unhandled rejection.
        closed = true
        for (const call of calls.values()) { call.cleanup(); call.reject(rpcFailure('worker-unavailable')) }
        calls.clear()
        for (const operation of operations.values()) operation.abort()
      }).finally(() => { operations.delete(message.id); pending.delete(done) })
      pending.add(done)
    }
  }
  return {
    receive,
    handle(method: string, handler: RpcHandler) { handlers.set(method, handler) },
    call<T = unknown>(method: string, value?: unknown, signal?: AbortSignal): Promise<T> {
      if (closed) return Promise.reject(rpcFailure('worker-unavailable'))
      if (signal?.aborted) return Promise.reject(rpcFailure('cancelled'))
      const id = ++next
      return new Promise<T>((resolve, reject) => {
        let aborted = false
        const abort = () => {
          aborted = true
          try { send({ type: 'cancel', id }) } catch { /* exit handles rejection */ }
        }
        signal?.addEventListener('abort', abort, { once: true })
        calls.set(id, { resolve: value => aborted ? reject(rpcFailure('cancelled')) : resolve(value as T), reject,
          cleanup: () => signal?.removeEventListener('abort', abort) })
        try { send({ type: 'request', id, method, value }) }
        catch { calls.delete(id); signal?.removeEventListener('abort', abort); reject(rpcFailure('worker-unavailable')) }
        if (signal?.aborted) abort()
      })
    },
    disconnect() {
      closed = true
      for (const call of calls.values()) { call.cleanup(); call.reject(rpcFailure('worker-unavailable')) }
      calls.clear()
      for (const controller of operations.values()) controller.abort()
      handlers.clear()
    },
    async drain() { await Promise.allSettled([...pending]) },
  }
}
