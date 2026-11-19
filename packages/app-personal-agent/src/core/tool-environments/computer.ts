import { isDeepStrictEqual } from 'node:util'
import type { JsonValue, ToolCall, ToolDescriptor, ToolEnvironment, ToolEnvironmentDescriptor, ToolEnvironmentRequest, ToolEnvironmentResult, ToolEnvironmentScope } from '@anybox/tool-api'
import { computerToolContracts } from '@anybox/computer-tools/contracts'
import { computerOperationsServiceKey } from '../computer/operations-port.js'
import type { ComputerOperationsPort, ComputerRunScope } from '../computer/operations-port.js'
import { sessionRunServiceKey } from '../session/port.js'
import type { SessionRunPort } from '../session/port.js'
import { getToolById, listTools } from '../tool/catalog.js'
import { updateToolPlan } from '../tool/plan-domain.js'
import { needsComputer } from '../computer/operations-domain.js'
import { createToolEnvironmentCatalog } from './registry.js'
import type { ToolEnvironmentCatalog, ToolEnvironmentCatalogEntry, ToolEnvironmentRuntimeBinding } from './port.js'

export const computerToolEnvironmentVersion = '1.0.0'
const describeTool = ({ toolId, version, definition }: ToolDescriptor): ToolDescriptor => Object.freeze({ toolId, version, definition })

/** Pure metadata; it cannot open a scope or acquire an execution dependency. */
export const computerToolEnvironmentDescriptor: ToolEnvironmentDescriptor = Object.freeze({
  environmentId: 'computer', version: computerToolEnvironmentVersion, recovery: 'observe-existing',
  tools: Object.freeze(listTools().map(describeTool)),
})

/** Computer selection and exact retired declarations are explicit catalog policy. */
export const computerToolEnvironmentCatalogEntry: ToolEnvironmentCatalogEntry = Object.freeze({
  descriptor: computerToolEnvironmentDescriptor,
  historyTools: Object.freeze(computerToolContracts.filter(tool => !tool.selectable).map(describeTool)),
  validateSelection(tools: readonly ToolDescriptor[]) {
    if (tools.some(tool => getToolById(tool.toolId)?.dependencies.some(id => !tools.some(candidate => candidate.toolId === id)))) {
      throw new TypeError('missing tool dependency')
    }
  },
})

/** Contributes real Nya dependencies to the existing Runtime, without a separate registry component. */
export function createComputerToolEnvironmentBinding(
  catalog: ToolEnvironmentCatalog = createToolEnvironmentCatalog([computerToolEnvironmentCatalogEntry]),
  providers: readonly ToolEnvironment[] = [],
): ToolEnvironmentRuntimeBinding {
  const additional = [...providers]
  return {
    inject: [computerOperationsServiceKey],
    bind: deps => catalog.bind([createComputerToolEnvironment({ records: deps[sessionRunServiceKey] as SessionRunPort,
      operations: deps[computerOperationsServiceKey] as ComputerOperationsPort }), ...additional]),
  }
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

/** Execution is constructed only after both dependencies are bound to the current Nya generation. */
export function createComputerToolEnvironment(dependencies: { readonly records: SessionRunPort; readonly operations: ComputerOperationsPort }): ToolEnvironment {
  if (!dependencies?.records || !dependencies.operations) throw new TypeError('Computer tool environment execution dependencies are required')
  return {
    ...computerToolEnvironmentDescriptor,
    openScope(context): ToolEnvironmentScope {
      let scope: ComputerRunScope | undefined, preparing: Promise<ComputerRunScope> | undefined
      let cancellation: Promise<void> | undefined, closing: ToolCall<JsonValue> | undefined, stopped = false
      const getScope = () => preparing ??= (async () => {
        const run = await dependencies.records.getRun(context.scopeId)
        if (!run) throw unavailable()
        scope = dependencies.operations.openRun({ runId: context.scopeId, runOwnerEpoch: context.ownerEpoch,
          imageInput: run.modelSnapshot?.schemaVersion === 3 && run.modelSnapshot.capabilities.imageInput === true,
          ...(run.units ? { unit: run.units.computer } : {}) })
        return scope
      })()
      const readRequest = async (request: ToolEnvironmentRequest) => {
        const tool = getToolById(request.toolId)
        const operation = await dependencies.records.getRunOperation(context.scopeId, request.operationId)
        if (!tool || tool.version !== request.version || !operation?.start.tool || operation.start.tool.name !== tool.definition.name || !isDeepStrictEqual(operation.start.tool.arguments, request.arguments)) throw unavailable()
        return operation.start.tool
      }
      const service: ToolEnvironmentScope = {
        execute(request) {
          if (stopped) throw cancelled()
          return deferred<ToolEnvironmentResult>(async isCancelled => {
            const original = await readRequest(request)
            if (!needsComputer(original)) {
              if (isCancelled() && !request.resuming) throw cancelled()
              return { result: Promise.resolve({ result: updateToolPlan(original.name, original.arguments) }), done: Promise.resolve(), cancel() {} }
            }
            const current = await getScope()
            if (isCancelled() && !request.resuming) throw cancelled()
            const owned = current.execute(request.operationId)
            return { result: owned.result.then(value => ({ result: value.result, ...(value.images ? { images: value.images } : {}) })), done: owned.done, cancel: reason => owned.cancel(reason) }
          })
        },
        hasResources: () => scope !== undefined || preparing !== undefined,
        cancel() {
          if (!cancellation) cancellation = (async () => {
            // Cancellation must also reconcile a scope retained by an earlier Runtime.
            if (!preparing && !await dependencies.operations.hasRunResources(context.scopeId)) return
            await (await getScope()).cancel()
          })()
          return cancellation
        },
        close() {
          if (closing) return closing
          stopped = true
          closing = deferred<JsonValue>(async () => {
            if (!preparing && !await dependencies.operations.hasRunResources(context.scopeId)) return { result: Promise.resolve({ processes: [] }), done: Promise.resolve(), cancel() {} }
            await cancellation
            return (await getScope()).close()
          }, true)
          return closing
        },
      }
      return service
    },
  }
}
