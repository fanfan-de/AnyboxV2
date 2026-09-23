import type { KernelError } from '@anybox/agent-contracts'
import type { ModelCallHandle, ModelOutput, ModelRequest, ModelService, Owned } from '@anybox/agent-contracts/spi'
import { fault, throwCollected } from '../../shared/errors.js'
import { deferred } from '../../shared/utils.js'

export interface MockExecution {
  readonly signal: AbortSignal
  onCleanup(cleanup: () => void | Promise<void>): void
}
export type MockExecutor = (request: ModelRequest, execution: MockExecution) => ModelOutput | Promise<ModelOutput>

export function createMockModel(execute: MockExecutor = request => ({
  content: [{ type: 'text', text: `Mock: ${request.input.map(part => part.text).join('')}` }],
})): Owned<ModelService> {
  const calls = new Set<ModelCallHandle>()
  const cleanupErrors: unknown[] = []
  let closed = false
  let closing: Promise<void> | undefined
  const service: ModelService = {
    call(request) {
      if (closed) throw fault('CLOSED', 'model service is closed')
      if (request.model.protocolId !== 'mock') throw fault('CAPABILITY_UNAVAILABLE', 'mock model only supports the mock protocol')
      const input = structuredClone(request)
      const controller = new AbortController()
      const cleanups: (() => void | Promise<void>)[] = []
      const completion = deferred<void>()
      let acceptingCleanup = true
      const result = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw fault('CANCELLED', 'model call cancelled')
        return execute(input, { signal: controller.signal, onCleanup(cleanup) {
          if (!acceptingCleanup) throw fault('CLOSED', 'model cleanup registration is closed')
          cleanups.push(cleanup)
        } })
      }).then(output => structuredClone(output))
      const handle: ModelCallHandle = {
        result, done: completion.promise,
        cancel(reason?: KernelError) { controller.abort(reason ?? { code: 'CANCELLED', message: 'model call cancelled' }) },
      }
      calls.add(handle)
      const finish = async () => {
        acceptingCleanup = false
        const errors: unknown[] = []
        for (const cleanup of cleanups.reverse()) {
          try { await cleanup() } catch (error) { errors.push(error) }
        }
        calls.delete(handle)
        cleanupErrors.push(...errors)
        try { throwCollected(errors, 'model call cleanup failed'); completion.resolve() }
        catch (error) { completion.reject(error) }
      }
      // 两条分支都等待 executor 真正退出；取消不会通过竞争 Promise 假装完成。
      void result.then(finish, finish).catch(completion.reject)
      return handle
    },
  }
  return { service, close() {
    if (closing) return closing
    closed = true
    const active = [...calls]
    closing = Promise.resolve().then(async () => {
      for (const call of active) call.cancel()
      await Promise.allSettled(active.map(call => call.done))
      throwCollected(cleanupErrors, 'model cleanup failed')
    })
    return closing
  } }
}
