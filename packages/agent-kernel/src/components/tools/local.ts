import type { JsonValue, ToolDefinition, ToolCall, ToolOutcome } from '@anybox/agent-contracts'
import type { Owned, ToolCallHandle, ToolService } from '@anybox/agent-contracts/spi'
import { fault, throwCollected } from '../../shared/errors.js'
import { deferred } from '../../shared/utils.js'
import { toolDefinitions } from '../../domain/content.js'

export interface ToolExecution {
  readonly signal: AbortSignal
  onCleanup(cleanup: () => void | Promise<void>): void
}
export interface LocalTool {
  readonly definition: ToolDefinition
  /** Must return only after its work exits; register resources using onCleanup. */
  execute(input: JsonValue, execution: ToolExecution): JsonValue | Promise<JsonValue>
}

export function createLocalTools(registrations: readonly LocalTool[]): Owned<ToolService> {
  const definitions = toolDefinitions(registrations.map(tool => tool.definition))
  const handlers = new Map(registrations.map((tool, index) => [definitions[index].id, tool.execute]))
  const active = new Set<ToolCallHandle>()
  const cleanupErrors: unknown[] = []
  let closed = false
  let closing: Promise<void> | undefined
  const service: ToolService = {
    definitions: () => {
      if (closed) throw fault('CLOSED', 'tool service is closed')
      return structuredClone(definitions)
    },
    call(request: ToolCall) {
      if (closed) throw fault('CLOSED', 'tool service is closed')
      const definition = definitions.find(tool => tool.id === request.request.toolId && tool.revision === request.toolRevision)
      if (!definition) throw fault('DEPENDENCY_UNAVAILABLE', 'tool version is unavailable')
      const handler = handlers.get(definition.id)!
      const input = structuredClone(request.request.input)
      const controller = new AbortController()
      const completion = deferred<void>()
      const cleanups: (() => void | Promise<void>)[] = []
      let acceptingCleanup = true
      const result: Promise<ToolOutcome> = Promise.resolve().then(async () => {
        if (controller.signal.aborted) return { status: 'cancelled' }
        const output = await handler(input, { signal: controller.signal, onCleanup(cleanup) {
          if (!acceptingCleanup) throw fault('CLOSED', 'tool cleanup registration is closed')
          cleanups.push(cleanup)
        } })
        return { status: 'succeeded', output: structuredClone(output) }
      })
      const handle: ToolCallHandle = { result, done: completion.promise,
        cancel(reason) { controller.abort(reason ?? { code: 'CANCELLED', message: 'tool cancellation requested' }) } }
      active.add(handle)
      const finish = async () => {
        acceptingCleanup = false
        const errors: unknown[] = []
        for (const cleanup of cleanups.reverse()) {
          try { await cleanup() } catch (error) { errors.push(error) }
        }
        active.delete(handle); cleanupErrors.push(...errors)
        try { throwCollected(errors, 'tool cleanup failed'); completion.resolve() }
        catch (error) { completion.reject(error) }
      }
      void result.then(finish, finish).catch(completion.reject)
      return handle
    },
  }
  return { service, close() {
    if (closing) return closing
    closed = true
    const pending = [...active]
    closing = Promise.resolve().then(async () => {
      for (const call of pending) call.cancel()
      await Promise.allSettled(pending.map(call => call.done))
      throwCollected(cleanupErrors, 'tool cleanup failed')
    })
    return closing
  } }
}
