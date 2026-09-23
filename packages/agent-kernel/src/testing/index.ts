/** 手动推进模型执行与清理，用于确定性测试及无网络示例。 */
import type { ModelOutput, ModelRequest } from '@anybox/agent-contracts/spi'
import { createMockModel } from '../components/mock-model/mock.js'
import { deferred } from '../shared/utils.js'
import { fault } from '../shared/errors.js'

export interface ControlledCall {
  readonly request: ModelRequest
  readonly signal: AbortSignal
  readonly cleanupStarted: Promise<void>
  succeed(text: string): void
  respond(output: ModelOutput): void
  fail(error: unknown): void
  /** 在结束调用前设置，以独立控制清理完成时点。 */
  holdCleanup(): { release(): void; fail(error: unknown): void }
}
export function createControlledMock() {
  const pending: ControlledCall[] = []
  const readers: ReturnType<typeof deferred<ControlledCall>>[] = []
  let totalCalls = 0
  let activeCalls = 0
  let closed = false
  const owned = createMockModel((request, execution) => {
    totalCalls++; activeCalls++
    const outcome = deferred<ModelOutput>()
    const cleanupStarted = deferred<void>()
    let cleanupGate: ReturnType<typeof deferred<void>> | undefined
    const abort = () => outcome.reject(fault('CANCELLED', 'controlled call cancelled'))
    execution.signal.addEventListener('abort', abort, { once: true })
    execution.onCleanup(async () => {
      execution.signal.removeEventListener('abort', abort)
      cleanupStarted.resolve()
      try { await cleanupGate?.promise } finally { activeCalls-- }
    })
    const call: ControlledCall = {
      request, signal: execution.signal, cleanupStarted: cleanupStarted.promise,
      succeed: text => outcome.resolve({ content: [{ type: 'text', text }] }),
      respond: output => outcome.resolve(structuredClone(output)),
      fail: outcome.reject,
      holdCleanup() {
        cleanupGate ??= deferred<void>()
        return { release: () => cleanupGate!.resolve(), fail: cleanupGate.reject }
      },
    }
    const reader = readers.shift()
    if (reader) reader.resolve(call)
    else pending.push(call)
    if (execution.signal.aborted) abort()
    return outcome.promise
  })
  return {
    service: owned.service,
    get totalCalls() { return totalCalls },
    get activeCalls() { return activeCalls },
    nextCall(): Promise<ControlledCall> {
      const call = pending.shift()
      if (call) return Promise.resolve(call)
      if (closed) return Promise.reject(fault('CLOSED', 'controlled model is closed'))
      const reader = deferred<ControlledCall>()
      readers.push(reader)
      return reader.promise
    },
    close() {
      closed = true
      for (const reader of readers.splice(0)) reader.reject(fault('CLOSED', 'controlled model is closed'))
      pending.length = 0
      return owned.close()
    },
  }
}
