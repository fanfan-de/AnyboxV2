import { isDeepStrictEqual } from 'node:util'
import type { JsonValue, ToolCall, ToolDescriptor, ToolEnvironment, ToolEnvironmentDescriptor, ToolEnvironmentResult,
  ToolEnvironmentScope, ToolEnvironmentScopeContext, ToolRequest } from '@anybox/tool-api'
import { computerToolContracts, getToolById, listTools } from './contracts/index.js'

export const computerToolEnvironmentId = 'computer'
export const computerToolEnvironmentVersion = '1.0.0'

export function computerToolTarget(binding: { readonly attachmentId: string; readonly unitId: string; readonly epoch: number }): string {
  return JSON.stringify([binding.attachmentId, binding.unitId, binding.epoch, computerToolEnvironmentVersion])
}

const describeTool = ({ toolId, version, definition }: ToolDescriptor): ToolDescriptor => Object.freeze({ toolId, version, definition })

/** Pure metadata; it cannot open a scope or acquire an execution dependency. */
export const computerToolEnvironmentDescriptor: ToolEnvironmentDescriptor = Object.freeze({
  environmentId: computerToolEnvironmentId, version: computerToolEnvironmentVersion, recovery: 'observe-existing',
  tools: Object.freeze(listTools().map(describeTool)),
})

/** Computer selection and exact retired declarations are explicit catalog policy. */
export const computerToolEnvironmentCatalogEntry = Object.freeze({
  descriptor: computerToolEnvironmentDescriptor,
  historyTools: Object.freeze(computerToolContracts.filter(tool => !tool.selectable).map(describeTool)),
  validateSelection(tools: readonly ToolDescriptor[]) {
    if (tools.some(tool => getToolById(tool.toolId)?.dependencies.some(id => !tools.some(candidate => candidate.toolId === id)))) {
      throw new TypeError('missing tool dependency')
    }
  },
})

interface ComputerEnvironmentOperationScope {
  execute(operationId: string): ToolCall<ToolEnvironmentResult>
  cancel(): Promise<void>
  close(): ToolCall<JsonValue>
}

interface AcceptedComputerEnvironmentOperation {
  readonly request: Pick<ToolRequest, 'name' | 'arguments'>
  /** Recorded retired tools can return a historical result without acquiring Computer resources. */
  readonly historicalResult?: () => JsonValue
}

export interface ComputerEnvironmentExecution {
  getAcceptedOperation(scopeId: string, operationId: string): Promise<AcceptedComputerEnvironmentOperation | undefined>
  /** Resolve the original caller binding, including when restoring a scope. */
  openRunScope(context: ToolEnvironmentScopeContext): Promise<ComputerEnvironmentOperationScope | undefined>
  hasRunResources(scopeId: string): Promise<boolean>
}

const unavailable = () => Object.assign(new Error('tool environment unavailable'), { name: 'ToolEnvironmentError', category: 'unavailable' })
const cancelled = () => Object.assign(new Error('tool environment cancelled'), { name: 'ToolEnvironmentError', category: 'cancelled' })

/** Takes synchronous ownership of an asynchronous adapter setup and its eventual underlying call. */
function deferred<T>(start: (cancelled: () => boolean) => Promise<ToolCall<T>>, cleanup = false): ToolCall<T> {
  let reason: string | undefined
  const handle = Promise.resolve().then(() => start(() => reason !== undefined))
  const result = handle.then(call => call.result)
  const done = handle.then(call => call.done, error => { if (cleanup) throw error })
  void result.catch(() => {}); void done.catch(() => {})
  return { result, done, cancel(value) {
    reason ??= value
    void handle.then(call => call.cancel(value), () => {}).catch(() => {})
  } }
}

export function createComputerToolEnvironment(execution: ComputerEnvironmentExecution): ToolEnvironment {
  const openScope = (context: ToolEnvironmentScopeContext): ToolEnvironmentScope => {
    let preparing: Promise<ComputerEnvironmentOperationScope> | undefined
    let cancellation: Promise<void> | undefined, closing: ToolCall<JsonValue> | undefined, stopped = false
    const getScope = () => preparing ??= (async () => {
      const scope = await execution.openRunScope(context)
      if (!scope) throw unavailable()
      return scope
    })()
    return {
      execute(request) {
        if (stopped) throw cancelled()
        return deferred<ToolEnvironmentResult>(async isCancelled => {
          const tool = getToolById(request.toolId)
          const original = await execution.getAcceptedOperation(context.scopeId, request.operationId)
          if (!tool || tool.version !== request.version || !original || original.request.name !== tool.definition.name ||
            !isDeepStrictEqual(original.request.arguments, request.arguments)) throw unavailable()
          if (original.historicalResult) {
            if (isCancelled() && !request.resuming) throw cancelled()
            return { result: Promise.resolve({ result: original.historicalResult() }), done: Promise.resolve(), cancel() {} }
          }
          const current = await getScope()
          if (isCancelled() && !request.resuming) throw cancelled()
          const owned = current.execute(request.operationId)
          return { result: owned.result.then(value => ({ result: value.result, ...(value.images ? { images: value.images } : {}) })),
            done: owned.done, cancel: reason => owned.cancel(reason) }
        })
      },
      hasResources: () => preparing !== undefined,
      cancel() {
        if (!cancellation) cancellation = (async () => {
          // Cancellation must also reconcile a scope retained by an earlier Runtime.
          if (!preparing && !await execution.hasRunResources(context.scopeId)) return
          await (await getScope()).cancel()
        })()
        return cancellation
      },
      close() {
        if (closing) return closing
        stopped = true
        closing = deferred<JsonValue>(async () => {
          if (!preparing && !await execution.hasRunResources(context.scopeId)) return { result: Promise.resolve({ processes: [] }), done: Promise.resolve(), cancel() {} }
          await cancellation
          return (await getScope()).close()
        }, true)
        return closing
      },
    }
  }
  return { ...computerToolEnvironmentDescriptor, openScope, restoreScope: openScope }
}
