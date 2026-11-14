import { isDeepStrictEqual } from 'node:util'
import { validateToolArguments, validateToolDescriptors } from '@anybox/tool-api'
import type { JsonValue, ToolCall, ToolDescriptor, ToolEnvironment, ToolEnvironmentDescriptor, ToolEnvironmentResult, ToolEnvironmentScope } from '@anybox/tool-api'
import type { ToolObservation, ValidatedToolRequest } from '../run/domain.js'
import { environmentForTool, parseToolEnvironmentSnapshot } from './domain.js'
import type { ToolEnvironmentSnapshot } from './domain.js'
import type { ToolEnvironmentCatalog, ToolEnvironmentCatalogEntry, ToolEnvironmentRegistry, ToolEnvironmentRun, ToolEnvironmentRunContext } from './port.js'

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

interface CatalogRegistration {
  readonly descriptor: ToolEnvironmentDescriptor
  readonly historyTools: readonly ToolDescriptor[]
  readonly validateSelection?: (tools: readonly ToolDescriptor[]) => void
}

/** Pure declarations and selection policies; constructing a catalog never opens execution scopes. */
export function createToolEnvironmentCatalog(entries: readonly ToolEnvironmentCatalogEntry[]): ToolEnvironmentCatalog {
  if (!Array.isArray(entries)) throw new TypeError('invalid tool environment catalog')
  const registrations = new Map<string, CatalogRegistration>()
  for (const entry of entries) {
    const declaration = entry?.descriptor
    if (!declaration || declaration.recovery !== undefined && declaration.recovery !== 'observe-existing' || entry.validateSelection !== undefined && typeof entry.validateSelection !== 'function') throw new TypeError('invalid tool environment')
    // Current declarations must be executable. Historical declarations remain
    // structural, so retired schemas stay readable without becoming selectable.
    validateToolDescriptors(declaration.tools)
    const selection = parseToolEnvironmentSnapshot({ schemaVersion: 1, environments: [{ environmentId: declaration.environmentId, version: declaration.version, tools: declaration.tools }] }).environments[0]!
    if (registrations.has(selection.environmentId)) throw new TypeError('duplicate tool environment')
    const historyTools = entry.historyTools === undefined ? Object.freeze([]) : parseToolEnvironmentSnapshot({ schemaVersion: 1,
      environments: [{ environmentId: selection.environmentId, version: selection.version, tools: entry.historyTools }] }).environments[0]!.tools
    const descriptor: ToolEnvironmentDescriptor = Object.freeze({ ...selection, ...(declaration.recovery ? { recovery: declaration.recovery } : {}) })
    registrations.set(selection.environmentId, { descriptor, historyTools,
      ...(entry.validateSelection ? { validateSelection: entry.validateSelection } : {}) })
  }
  const catalog: ToolEnvironmentCatalog = {
    environments: Object.freeze([...registrations.values()].map(({ descriptor }) => descriptor)),
    snapshot(ids, toolIdsByEnvironment) {
      if (!Array.isArray(ids) || new Set(ids).size !== ids.length) throw new TypeError('invalid tool environment selection')
      return parseToolEnvironmentSnapshot({ schemaVersion: 1, environments: ids.map(environmentId => {
        const registration = registrations.get(environmentId)
        if (!registration) throw new TypeError('unavailable tool environment')
        const { descriptor } = registration
        const selectedIds = toolIdsByEnvironment && Object.hasOwn(toolIdsByEnvironment, environmentId) ? toolIdsByEnvironment[environmentId] : undefined
        let tools = descriptor.tools
        if (selectedIds !== undefined) {
          if (!Array.isArray(selectedIds) || selectedIds.some(id => typeof id !== 'string') || new Set(selectedIds).size !== selectedIds.length) throw new TypeError('invalid tool selection')
          const selected = new Set(selectedIds)
          if (selectedIds.some(id => !descriptor.tools.some(tool => tool.toolId === id))) throw new TypeError('tool not supplied by environment')
          tools = descriptor.tools.filter(tool => selected.has(tool.toolId))
        }
        registration.validateSelection?.(tools)
        return { environmentId, version: descriptor.version, tools }
      }) })
    },
    validate(value) {
      const snapshot = parseToolEnvironmentSnapshot(value)
      for (const selection of snapshot.environments) {
        const registration = registrations.get(selection.environmentId)
        if (!registration || registration.descriptor.version !== selection.version || selection.tools.some(tool =>
          ![...registration.descriptor.tools, ...registration.historyTools].some(current => isDeepStrictEqual(current, tool)))) throw new TypeError('tool environment snapshot unavailable')
        registration.validateSelection?.(selection.tools)
      }
      return snapshot
    },
    bind(providers) {
      if (!Array.isArray(providers)) throw new TypeError('invalid tool environment providers')
      const bound = new Map<string, ToolEnvironment>()
      for (const provider of providers) {
        if (!provider || typeof provider.openScope !== 'function') throw new TypeError('invalid executable tool environment')
        const registration = registrations.get(provider.environmentId)
        const descriptor = registration?.descriptor
        if (!descriptor || bound.has(provider.environmentId) || provider.version !== descriptor.version || provider.recovery !== descriptor.recovery || !isDeepStrictEqual(provider.tools, descriptor.tools)) throw new TypeError('tool environment binding conflict')
        bound.set(provider.environmentId, Object.freeze({ ...descriptor, openScope: provider.openScope.bind(provider) }))
      }
      if (bound.size !== registrations.size) throw new TypeError('missing executable tool environment')
      return Object.freeze({ openRun(snapshot: ToolEnvironmentSnapshot, context: ToolEnvironmentRunContext) {
        return openRun(bound, catalog.validate(snapshot), context)
      } })
    },
  }
  return Object.freeze(catalog)
}

/** Convenience for callers whose pure declarations and executable providers are already available together. */
export function createToolEnvironmentRegistry(providers: readonly ToolEnvironment[]): ToolEnvironmentCatalog & ToolEnvironmentRegistry {
  if (!Array.isArray(providers)) throw new TypeError('invalid tool environment providers')
  const catalog = createToolEnvironmentCatalog(providers.map(descriptor => ({ descriptor })))
  return Object.freeze({ ...catalog, ...catalog.bind(providers) })
}
