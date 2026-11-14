import { isDeepStrictEqual } from 'node:util'
import type { JsonValue, ToolCall, ToolEnvironment, ToolEnvironmentRequest, ToolEnvironmentResult, ToolEnvironmentScope } from '@anybox/tool-api'
import type { ComputerOperationsPort, ComputerRunScope } from '../computer/operations-port.js'
import type { SessionRunPort } from '../session/port.js'
import { getToolById, legacyToolSelection, listTools } from '../tool/catalog.js'
import type { ToolSelectionSnapshot } from '../tool/catalog.js'
import { updateToolPlan } from '../tool/plan-domain.js'
import { needsComputer } from '../computer/operations-domain.js'
import { computerToolEnvironmentVersion, parseToolEnvironmentSnapshot } from './domain.js'
import type { ToolEnvironmentSnapshot } from './domain.js'

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

/** Old initialization formats keep their exact declarations, including retired plan tools. */
export function legacyToolEnvironmentSnapshot(initialization: { readonly schemaVersion: number; readonly toolSelection?: ToolSelectionSnapshot }): ToolEnvironmentSnapshot {
  const selection = initialization.schemaVersion >= 2 && initialization.toolSelection ? initialization.toolSelection : legacyToolSelection
  return parseToolEnvironmentSnapshot({ schemaVersion: 1, environments: [{ environmentId: 'computer', version: computerToolEnvironmentVersion, tools: selection.tools }] })
}

/** Metadata can be used before Session exists. Execution is bound to the current Nya dependency generation. */
export function createComputerToolEnvironment(dependencies?: { readonly records: SessionRunPort; readonly operations: ComputerOperationsPort }): ToolEnvironment {
  return {
    environmentId: 'computer', version: computerToolEnvironmentVersion, recovery: 'observe-existing',
    tools: Object.freeze(listTools().map(({ toolId, version, definition }) => Object.freeze({ toolId, version, definition }))),
    openScope(context): ToolEnvironmentScope {
      let scope: ComputerRunScope | undefined, preparing: Promise<ComputerRunScope> | undefined
      let cancellation: Promise<void> | undefined, closing: ToolCall<JsonValue> | undefined, stopped = false
      const getScope = () => preparing ??= (async () => {
        if (!dependencies) throw unavailable()
        const run = await dependencies.records.getRun(context.scopeId)
        if (!run) throw unavailable()
        scope = dependencies.operations.openRun({ runId: context.scopeId, runOwnerEpoch: context.ownerEpoch,
          imageInput: run.modelSnapshot?.schemaVersion === 3 && run.modelSnapshot.capabilities.imageInput === true,
          ...(run.units ? { unit: run.units.computer } : {}) })
        return scope
      })()
      const readRequest = async (request: ToolEnvironmentRequest) => {
        if (!dependencies) throw unavailable()
        const tool = getToolById(request.toolId)
        const operation = await dependencies.records.getRunOperation(context.scopeId, request.operationId)
        if (!tool || tool.version !== request.version || !operation?.start.tool || operation.start.tool.name !== tool.definition.name || !isDeepStrictEqual(operation.start.tool.arguments, request.arguments)) throw unavailable()
        return operation.start.tool
      }
      const service: ToolEnvironmentScope & { hasProcesses(): boolean } = {
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
        hasProcesses: () => scope?.hasProcesses() ?? false,
        cancel() {
          if (!cancellation) cancellation = (async () => {
            if (!dependencies) throw unavailable()
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
            if (!dependencies) throw unavailable()
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
