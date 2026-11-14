import { isDeepStrictEqual } from 'node:util'
import { validateToolArguments, validateToolDescriptors } from '@anybox/tool-api'
import type { JsonValue, ToolCall, ToolEnvironment, ToolEnvironmentResult, ToolEnvironmentScope } from '@anybox/tool-api'
import { createToolSelection, getToolById } from '../tool/catalog.js'
import type { ToolObservation, ValidatedToolRequest } from '../run/domain.js'
import { environmentForTool, parseToolEnvironmentSnapshot } from './domain.js'
import type { ToolEnvironmentSnapshot } from './domain.js'
import type { ToolEnvironmentRegistry, ToolEnvironmentRun, ToolEnvironmentRunContext } from './port.js'

function failure(category: 'invalid-request' | 'cancelled' | 'cleanup-failure' | 'unavailable' | 'outcome-unknown'): Error {
  return Object.assign(new Error(`tool environment ${category}`), { name: 'ToolEnvironmentError', category })
}

function resultValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 64) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(child => resultValue(child, depth + 1))
  return !!value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) && Object.values(value).every(child => resultValue(child, depth + 1))
}

function observation(name: string, value: ToolEnvironmentResult): ToolObservation {
  if (!value || !Object.hasOwn(value, 'result') || !resultValue(value.result)) throw failure('invalid-request')
  if (value.images !== undefined && (!Array.isArray(value.images) || value.images.some(image => !image || typeof image.assetId !== 'string' || !/^[0-9a-f]{64}$/.test(image.sha256) || !['image/jpeg', 'image/png', 'image/webp'].includes(image.mediaType) || ![image.byteLength, image.width, image.height].every(number => Number.isSafeInteger(number) && number > 0)))) throw failure('invalid-request')
  const result = { name, result: value.result, ...(value.images?.length ? { images: value.images } : {}) }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 32 * 1024 * 1024) throw failure('invalid-request')
  return structuredClone(result)
}

function openRun(environments: ReadonlyMap<string, ToolEnvironment>, snapshot: ToolEnvironmentSnapshot, context: ToolEnvironmentRunContext): ToolEnvironmentRun {
  const scopes = new Map<string, ToolEnvironmentScope>()
  const calls = new Map<string, { readonly request: ValidatedToolRequest; readonly call: ToolCall<ToolObservation> }>()
  const active = new Set<ToolCall<unknown>>()
  let accepting = true, cancelling: Promise<void> | undefined, closing: ToolCall<JsonValue> | undefined
  let initializationFailure: unknown
  const scopeFor = (environmentId: string) => {
    let scope = scopes.get(environmentId)
    if (!scope) {
      scope = environments.get(environmentId)!.openScope({ scopeId: context.runId, ownerEpoch: context.runOwnerEpoch, signal: context.signal })
      scopes.set(environmentId, scope)
    }
    return scope
  }
  // A reopened scope also owns recovery/close of resources retained by an earlier Runtime.
  // A provider cannot start tool work merely because the lightweight scope was opened.
  for (const environment of snapshot.environments) {
    try { scopeFor(environment.environmentId) } catch (error) { initializationFailure ??= error }
  }
  const service: ToolEnvironmentRun = {
    execute(request, operationId, resuming = false) {
      if (initializationFailure) throw initializationFailure
      if ((!accepting || context.signal.aborted) && !resuming || closing) throw failure('cancelled')
      const prior = calls.get(operationId)
      if (prior) {
        if (!isDeepStrictEqual(prior.request, request)) throw failure('invalid-request')
        return prior.call
      }
      const selection = environmentForTool(snapshot, request.name)
      const tool = selection?.tools.find(tool => tool.definition.name === request.name)
      const environment = selection && environments.get(selection.environmentId)
      if (!tool || !environment) throw failure('unavailable')
      if (resuming && environment.recovery !== 'observe-existing') throw failure('outcome-unknown')
      validateToolArguments(tool.definition, request.arguments)
      const owned = scopeFor(environment.environmentId).execute({ operationId, toolId: tool.toolId, version: tool.version, arguments: request.arguments, resuming })
      const call: ToolCall<ToolObservation> = { result: owned.result.then(value => observation(request.name, value)),
        done: owned.done, cancel: reason => owned.cancel(reason) }
      active.add(call)
      void call.done.finally(() => active.delete(call)).catch(() => {})
      void call.result.catch(() => {})
      calls.set(operationId, { request: structuredClone(request), call })
      return call
    },
    hasResources: () => scopes.size > 0,
    hasProcesses: () => [...scopes.values()].some(scope => 'hasProcesses' in scope && typeof scope.hasProcesses === 'function' && scope.hasProcesses()),
    cancel() {
      accepting = false
      if (!cancelling) cancelling = (async () => {
        const failures: unknown[] = []
        const pending = [...active]
        for (const call of pending) try { call.cancel('run-cancelled') } catch (error) { failures.push(error) }
        const [outcomes, exits] = await Promise.all([
          Promise.allSettled([...scopes.values()].map(scope => Promise.resolve().then(() => scope.cancel('run-cancelled')))),
          Promise.allSettled(pending.map(call => call.done)),
        ])
        for (const result of [...outcomes, ...exits]) if (result.status === 'rejected') failures.push(result.reason)
        if (failures.length) throw failure('cleanup-failure')
      })()
      return cancelling
    },
    close() {
      if (closing) return closing
      accepting = false
      const closures = [...scopes.entries()].map(([environmentId, scope]) => {
        try { return { environmentId, call: scope.close() } }
        catch (error) { const result = Promise.reject<JsonValue>(error); void result.catch(() => {}); return { environmentId, call: { result, done: result.then(() => undefined), cancel() {} } } }
      })
      const available = new Map<string, JsonValue>()
      let resultFailures = 0
      const results = Promise.allSettled(closures.map(({ environmentId, call }) => call.result.then(value => {
        if (!resultValue(value)) throw failure('cleanup-failure')
        available.set(environmentId, structuredClone(value))
      }).catch(error => { resultFailures++; throw error })))
      const exits = Promise.allSettled([...closures.map(({ call }) => call.done), ...[...active].map(call => call.done)])
      const report = (failedExit = false): JsonValue => {
        const values = closures.flatMap(({ environmentId }) => available.has(environmentId) ? [{ environmentId, result: available.get(environmentId)! }] : [])
        // Preserve the existing Computer cleanup receipt and its historical representation.
        if (values.length === 1 && values[0]!.environmentId === 'computer') return values[0]!.result
        if (!values.length && (resultFailures || initializationFailure || failedExit)) throw failure('cleanup-failure')
        return { environments: values }
      }
      const result = Promise.race([
        results.then(() => report()),
        // A failed exit must not wait forever for a broken provider's absent result.
        exits.then(outcomes => outcomes.some(result => result.status === 'rejected') || initializationFailure ? report(true) : new Promise<never>(() => {})),
      ])
      const done = (async () => {
        const outcomes = await exits
        // Publish all available partial facts before rejecting actual exit, so observers retain them.
        await result.catch(() => {})
        if (initializationFailure || resultFailures || outcomes.some(result => result.status === 'rejected')) throw failure('cleanup-failure')
      })()
      void result.catch(() => {}); void done.catch(() => {})
      closing = { result, done, cancel: reason => { for (const call of active) call.cancel(reason) } }
      return closing
    },
  }
  return service
}

/** Trusted providers are fixed for this application generation; Sessions retain exact definitions. */
export function createToolEnvironmentRegistry(providers: readonly ToolEnvironment[]): ToolEnvironmentRegistry {
  const environments = new Map<string, ToolEnvironment>()
  for (const provider of providers) {
    if (!provider || typeof provider.openScope !== 'function' || provider.recovery !== undefined && provider.recovery !== 'observe-existing') throw new TypeError('invalid tool environment')
    // New registrations enforce the executable schema subset. The history parser
    // deliberately remains structural so unsupported older definitions stay readable.
    validateToolDescriptors(provider.tools)
    const snapshot = parseToolEnvironmentSnapshot({ schemaVersion: 1, environments: [{ environmentId: provider.environmentId, version: provider.version, tools: provider.tools }] })
    if (environments.has(provider.environmentId)) throw new TypeError('duplicate tool environment')
    const selection = snapshot.environments[0]!
    const openScope = provider.openScope.bind(provider)
    environments.set(provider.environmentId, Object.freeze({ environmentId: provider.environmentId, version: provider.version, tools: selection.tools,
      ...(provider.recovery ? { recovery: provider.recovery } : {}), openScope }))
  }
  const registry: ToolEnvironmentRegistry = {
    environments: Object.freeze([...environments.values()]),
    snapshot(ids, computerToolIds) {
      if (!Array.isArray(ids) || new Set(ids).size !== ids.length) throw new TypeError('invalid tool environment selection')
      return parseToolEnvironmentSnapshot({ schemaVersion: 1, environments: ids.map(environmentId => {
        const provider = environments.get(environmentId)
        if (!provider) throw new TypeError('unavailable tool environment')
        const tools = environmentId === 'computer' && computerToolIds !== undefined ? createToolSelection(computerToolIds).tools : provider.tools
        if (tools.some(tool => !provider.tools.some(current => isDeepStrictEqual(current, tool)))) throw new TypeError('tool not supplied by environment')
        if (environmentId === 'computer' && tools.some(tool => getToolById(tool.toolId)?.dependencies.some(id => !tools.some(candidate => candidate.toolId === id)))) throw new TypeError('missing tool dependency')
        return { environmentId, version: provider.version, tools }
      }) })
    },
    validate(value) {
      const snapshot = parseToolEnvironmentSnapshot(value)
      for (const selection of snapshot.environments) {
        const provider = environments.get(selection.environmentId)
        if (!provider || provider.version !== selection.version || selection.tools.some(tool => {
          if (provider.tools.some(current => isDeepStrictEqual(current, tool))) return false
          const legacy = selection.environmentId === 'computer' ? getToolById(tool.toolId) : undefined
          return !legacy || legacy.selectable || !isDeepStrictEqual({ toolId: legacy.toolId, version: legacy.version, definition: legacy.definition }, tool)
        })) throw new TypeError('tool environment snapshot unavailable')
        if (selection.environmentId === 'computer' && selection.tools.some(tool => getToolById(tool.toolId)?.dependencies.some(id => !selection.tools.some(candidate => candidate.toolId === id)))) throw new TypeError('missing tool dependency')
      }
      return snapshot
    },
    openRun(snapshot, context, overrides = []) {
      const selected = new Map(environments)
      for (const provider of overrides) {
        const registered = environments.get(provider.environmentId)
        if (!registered || provider.version !== registered.version || !isDeepStrictEqual(provider.tools, registered.tools)) throw new TypeError('tool environment override conflict')
        selected.set(provider.environmentId, provider)
      }
      return openRun(selected, registry.validate(snapshot), context)
    },
  }
  return Object.freeze(registry)
}
