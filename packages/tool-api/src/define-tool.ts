import { validateToolArguments, validateToolDescriptor } from './index.js'
import type { JsonValue, ToolCall, ToolDescriptor } from './index.js'
import type { ToolEnvironment, ToolEnvironmentResult } from './environment.js'

export interface ToolExecutionContext {
  readonly operationId: string
  readonly signal: AbortSignal
}

export interface DefineToolOptions extends ToolDescriptor {
  readonly resourceId?: string
  /** The returned promise must settle only after all work owned by this operation exits. */
  execute(args: Readonly<Record<string, JsonValue>>, context: ToolExecutionContext): JsonValue | Promise<JsonValue>
}

function freezeJson<T extends JsonValue>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child)
    Object.freeze(value)
  }
  return value
}

function refused(error: unknown): ToolCall<ToolEnvironmentResult> {
  const result = Promise.reject<ToolEnvironmentResult>(error)
  void result.catch(() => {})
  return { result, done: Promise.resolve(), cancel() {} }
}

/** Define one standalone tool. Providers that retain resources or recover operations implement ToolEnvironment directly. */
export function defineTool(options: DefineToolOptions): ToolEnvironment {
  const { toolId, version, definition } = validateToolDescriptor(options)
  const { resourceId, execute } = options
  if (typeof execute !== 'function') throw new TypeError('invalid tool implementation')
  if (resourceId !== undefined && (typeof resourceId !== 'string' || !resourceId.trim() || resourceId.length > 1024 || resourceId.includes('\0'))) {
    throw new TypeError('invalid environment resource identity')
  }
  const { name, description, parameters } = definition
  const declared = Object.freeze({ name, ...(description === undefined ? {} : { description }),
    parameters: freezeJson(structuredClone(parameters)) })
  return Object.freeze<ToolEnvironment>({
    environmentId: toolId, version, ...(resourceId === undefined ? {} : { resourceId }),
    tools: Object.freeze([Object.freeze({ toolId, version, definition: declared })]),
    openScope(context) {
      const stopController = new AbortController()
      const scopeSignal = AbortSignal.any([context.signal, stopController.signal])
      const active = new Set<Promise<void>>()
      let stopped: Promise<void> | undefined
      let closing: ToolCall<JsonValue> | undefined
      const stop = (reason = 'tool scope cancelled') => {
        if (!stopped) {
          stopped = Promise.all(active).then(() => {})
          stopController.abort(new DOMException(reason, 'AbortError'))
        }
        return stopped
      }
      return {
        execute(request) {
          const { operationId } = request
          let args: Readonly<Record<string, JsonValue>>
          try {
            if (request.resuming) throw Object.assign(new Error('tool operation outcome is unknown'), {
              name: 'ToolEnvironmentError', category: 'outcome-unknown',
            })
            scopeSignal.throwIfAborted()
            if (request.toolId !== toolId || request.version !== version ||
              typeof operationId !== 'string' || !operationId.trim() || operationId.includes('\0')) throw new TypeError('invalid tool environment request')
            args = freezeJson(structuredClone(validateToolArguments(declared, request.arguments)))
          } catch (error) { return refused(error) }
          const controller = new AbortController()
          const signal = AbortSignal.any([scopeSignal, controller.signal])
          const result = Promise.resolve().then(async () => {
            signal.throwIfAborted()
            const value = await execute.call(options, args, { operationId, signal })
            // Keep the actual outcome if accepted work completes during cancellation.
            return { result: value }
          })
          const finish = () => { active.delete(done) }
          const done = result.then(finish, finish)
          active.add(done)
          return { result, done, cancel: reason => controller.abort(new DOMException(reason, 'AbortError')) }
        },
        hasResources: () => active.size > 0,
        cancel: stop,
        close() {
          const done = stop('tool scope closed')
          return closing ??= { result: done.then(() => null), done, cancel() {} }
        },
      }
    },
  })
}
