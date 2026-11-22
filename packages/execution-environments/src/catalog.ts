import { isDeepStrictEqual } from 'node:util'
import { validateToolArguments, validateToolDescriptors } from '@anybox/tool-api'
import type { JsonValue, ToolCall, ToolDescriptor, ToolEnvironment, ToolEnvironmentDescriptor, ToolEnvironmentResult, ToolEnvironmentScope, ToolEnvironmentScopeContext } from '@anybox/tool-api'
import type { StorageReader } from '@anybox/storage-sqlite/port'
import type { ToolObservation } from './catalog-port.js'
import type { ToolRequest as ValidatedToolRequest } from '@anybox/tool-api'
import { checkedId, targetKey } from './contracts.js'
import { environmentForTool, originalToolDescriptor, parseToolEnvironmentSnapshot } from './snapshot.js'
import type { ToolEnvironmentSnapshot, ToolEnvironmentSnapshotTool } from './snapshot.js'
import type { TargetedToolEnvironmentTarget, ToolEnvironmentCatalog, ToolEnvironmentCatalogEntry, ToolEnvironmentRegistry, ToolEnvironmentRun, ToolEnvironmentRunContext, ToolScopeTarget } from './catalog-port.js'

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

interface BoundEnvironment {
  readonly targeted: boolean
  readonly recovery?: 'observe-existing'
  openScope(targetId: string | undefined, context: ToolEnvironmentScopeContext): ToolEnvironmentScope
  restoreScope?(targetId: string | undefined, context: ToolEnvironmentScopeContext): ToolEnvironmentScope
}

interface RunScope {
  readonly environmentId: string
  readonly targetId?: string
  readonly active: Set<ToolCall<unknown>>
  readonly restored: boolean
  scope?: ToolEnvironmentScope
  exitFailed: boolean
}

function openRun(environments: ReadonlyMap<string, BoundEnvironment>, snapshot: ToolEnvironmentSnapshot, context: ToolEnvironmentRunContext,
  unavailable?: Error, validateTarget?: (target: ToolScopeTarget, restoring: boolean) => void): ToolEnvironmentRun {
  const scopes = new Map<string, RunScope>()
  const staticTargets = new Map<string, string>()
  const calls = new Map<string, { readonly request: ValidatedToolRequest; readonly target?: ToolScopeTarget; readonly call: ToolCall<ToolObservation> }>()
  const active = new Set<ToolCall<unknown>>()
  let accepting = true, cancelling: Promise<void> | undefined, closing: ToolCall<JsonValue> | undefined
  let initializationFailure: unknown = unavailable
  const usesTargets = (environmentId: string) => environments.get(environmentId)?.targeted ||
    snapshot.environments.find(entry => entry.environmentId === environmentId)?.tools.some(tool => tool.workspaceBindingId !== undefined)
  const scopeFor = (environmentId: string, targetId?: string, restoring = false) => {
    const key = targetKey(environmentId, targetId ?? '')
    const existing = scopes.get(key)
    if (existing) {
      if (!existing.scope || restoring && !existing.restored) throw failure('unavailable')
      return { entry: existing, scope: existing.scope }
    }
    const environment = environments.get(environmentId)
    if (!environment || restoring && !environment.restoreScope) throw failure('unavailable')
    const entry: RunScope = { environmentId, ...(targetId === undefined ? {} : { targetId }), active: new Set(),
      restored: restoring, exitFailed: false }
    scopes.set(key, entry)
    const scopeContext = { scopeId: context.runId, ownerEpoch: context.runOwnerEpoch, signal: context.signal }
    const providerTarget = usesTargets(environmentId) ? targetId : undefined
    const scope = restoring ? environment.restoreScope?.(providerTarget, scopeContext) : environment.openScope(providerTarget, scopeContext)
    if (!scope) throw failure('unavailable')
    entry.scope = scope
    return { entry, scope }
  }
  if (!context.lazyScopes) {
    // Historical aggregate ownership reopens every selected scope for cleanup.
    for (const environment of snapshot.environments) {
      const targets = usesTargets(environment.environmentId) ? new Set(environment.tools.map(tool => tool.targetId)) : [undefined]
      for (const targetId of targets) {
        try { scopeFor(environment.environmentId, targetId) } catch (error) { initializationFailure ??= error }
      }
    }
  }
  const validateExactScope = (target: ToolScopeTarget, restoring: boolean) => {
    if (!context.lazyScopes || restoring && !context.resuming) throw failure('invalid-request')
    if (closing || !restoring && (!accepting || context.signal.aborted)) throw failure('cancelled')
    validateTarget?.(target, restoring)
    if (!usesTargets(target.environmentId)) {
      const prior = staticTargets.get(target.environmentId)
      if (prior !== undefined && prior !== target.targetId) throw failure('unavailable')
      staticTargets.set(target.environmentId, target.targetId)
    }
  }
  const exactScope = (target: ToolScopeTarget, restoring: boolean) => {
    validateExactScope(target, restoring)
    return scopeFor(target.environmentId, target.targetId, restoring)
  }

  const service: ToolEnvironmentRun = {
    execute(request, operationId, resuming = false, target) {
      if (initializationFailure) throw initializationFailure
      if ((!accepting || context.signal.aborted) && !resuming || closing) throw failure('cancelled')
      const selection = environmentForTool(snapshot, request.name)
      const tool = selection?.tools.find(tool => tool.definition.name === request.name)
      if (!selection || !tool) throw failure('unavailable')
      const environment = environments.get(selection.environmentId)
      if (!environment) throw failure('unavailable')
      if (context.lazyScopes && (!target || target.environmentId !== selection.environmentId ||
        tool.targetId !== undefined && tool.targetId !== target.targetId)) throw failure('unavailable')
      const prior = calls.get(operationId)
      if (prior) {
        if (!isDeepStrictEqual(prior.request, request) || !isDeepStrictEqual(prior.target, target)) throw failure('invalid-request')
        return prior.call
      }
      if (resuming && environment.recovery !== 'observe-existing') throw failure('outcome-unknown')
      validateToolArguments(tool.definition, request.arguments)
      let scoped: ReturnType<typeof scopeFor>
      if (context.lazyScopes) {
        // Original-operation lookup may observe a restored scope, but it cannot create a replacement.
        if (resuming) {
          const entry = scopes.get(targetKey(target!.environmentId, target!.targetId))
          if (!entry?.scope) throw failure('outcome-unknown')
          scoped = { entry, scope: entry.scope }
        } else {
          scoped = exactScope(target!, false)
        }
      } else scoped = scopeFor(selection.environmentId, tool.targetId)
      let owned: ToolCall<ToolEnvironmentResult>
      try { owned = scoped.scope.execute({ operationId, toolId: tool.toolId, version: tool.version, arguments: request.arguments, resuming }) }
      catch (error) { scoped.entry.exitFailed = true; throw error }
      const call: ToolCall<ToolObservation> = { result: owned.result.then(value => observation(request.name, value)),
        done: owned.done, cancel: reason => owned.cancel(reason) }
      active.add(call)
      scoped.entry.active.add(call)
      void call.done.catch(() => { scoped.entry.exitFailed = true }).finally(() => {
        active.delete(call)
        scoped.entry.active.delete(call)
      })
      void call.result.catch(() => {})
      calls.set(operationId, { request: structuredClone(request), ...(target ? { target: { ...target } } : {}), call })
      return call
    },
    openTarget(target) {
      try { validateExactScope(target, false) } catch { return false }
      scopeFor(target.environmentId, target.targetId)
      return true
    },
    restoreTarget(target) { exactScope(target, true) },
    hasResources: () => scopes.size > 0,
    cancel() {
      accepting = false
      if (!cancelling) cancelling = (async () => {
        const failures: unknown[] = []
        const pending = [...active]
        for (const call of pending) try { call.cancel('run-cancelled') } catch (error) { failures.push(error) }
        const [outcomes, exits] = await Promise.all([
          Promise.allSettled([...scopes.values()].map(({ scope }) => Promise.resolve().then(() => scope?.cancel('run-cancelled')))),
          Promise.allSettled(pending.map(call => call.done)),
        ])
        for (const result of [...outcomes, ...exits]) if (result.status === 'rejected') failures.push(result.reason)
        if (failures.length) throw failure('cleanup-failure')
      })()
      return cancelling
    },
    close(onTargetExit) {
      if (closing) return closing
      accepting = false
      const closures = [...scopes.entries()].map(([key, entry]) => {
        const { scope, environmentId, targetId } = entry
        const identity = { environmentId, ...(targetId !== undefined && (context.lazyScopes ? usesTargets(environmentId) : true) ? { targetId } : {}) }
        try {
          if (!scope) throw failure('cleanup-failure')
          return { key, entry, identity, call: scope.close() }
        } catch (error) {
          const result = Promise.reject<JsonValue>(error)
          return { key, entry, identity, call: { result, done: result.then(() => undefined), cancel() {} } }
        }
      })
      const available = new Map<string, JsonValue>()
      let resultFailures = 0
      const results = Promise.allSettled(closures.map(({ key, call }) => call.result.then(value => {
        if (!resultValue(value)) throw failure('cleanup-failure')
        available.set(key, structuredClone(value))
      }).catch(error => { resultFailures++; throw error })))
      const exits = Promise.allSettled(closures.map(async ({ call, entry }) => {
        const outcomes = await Promise.allSettled([call.done, ...[...entry.active].map(activeCall => activeCall.done)])
        const proven = !entry.exitFailed && outcomes.every(outcome => outcome.status === 'fulfilled')
        if (context.lazyScopes && entry.targetId !== undefined) await onTargetExit?.({ environmentId: entry.environmentId, targetId: entry.targetId }, proven)
        if (!proven) throw failure('cleanup-failure')
      }))
      const report = (failedExit = false): JsonValue => {
        const values = closures.flatMap(({ key, identity }) => available.has(key) ? [{ ...identity, result: available.get(key)! }] : [])
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
  readonly contextualTarget?: boolean
  readonly descriptor: ToolEnvironmentDescriptor
  readonly historyTools: readonly ToolDescriptor[]
  readonly targets?: ToolEnvironmentCatalogEntry['targets']
  readonly validateSelection?: (tools: readonly ToolDescriptor[]) => void
}

function readTargets(source: NonNullable<ToolEnvironmentCatalogEntry['targets']>, reader?: StorageReader): readonly TargetedToolEnvironmentTarget[] {
  const targets = source(reader)
  if (!Array.isArray(targets)) throw new TypeError('invalid tool environment targets')
  const ids = new Set<string>(), selectionIds = new Set<string>()
  for (const target of targets) {
    const targetId = checkedId(target?.targetId, 256), selectionId = checkedId(target?.selectionId, 256)
    if (target.name !== undefined) checkedId(target.name, 256)
    if (ids.has(targetId) || selectionIds.has(selectionId)) throw new TypeError('duplicate tool environment target')
    ids.add(targetId)
    selectionIds.add(selectionId)
    validateToolDescriptors(target.tools)
  }
  return targets
}

function availableDescriptor(tool: ToolEnvironmentSnapshotTool, targets: readonly TargetedToolEnvironmentTarget[]): boolean {
  const { targetId, ...descriptor } = tool
  return targets.some(target => target.targetId === targetId && target.tools.some(current => isDeepStrictEqual(current, descriptor)))
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
    if (entry.targets !== undefined && (typeof entry.targets !== 'function' || declaration.tools.length || declaration.resourceId !== undefined || declaration.recovery !== undefined || entry.historyTools !== undefined)) throw new TypeError('invalid targeted tool environment')
    const selection = parseToolEnvironmentSnapshot({ schemaVersion: 1, environments: [{ environmentId: declaration.environmentId, version: declaration.version, tools: declaration.tools }] }).environments[0]!
    if (registrations.has(selection.environmentId)) throw new TypeError('duplicate tool environment')
    const historyTools = entry.historyTools === undefined ? Object.freeze([]) : parseToolEnvironmentSnapshot({ schemaVersion: 1,
      environments: [{ environmentId: selection.environmentId, version: selection.version, tools: entry.historyTools }] }).environments[0]!.tools
    if (selection.environmentId === 'model-search') throw new TypeError('reserved hosted tool environment')
    if (declaration.resourceId !== undefined && (typeof declaration.resourceId !== 'string' || !declaration.resourceId.trim() || declaration.resourceId.length > 1024)) throw new TypeError('invalid environment resource identity')
    const descriptor: ToolEnvironmentDescriptor = Object.freeze({ ...selection, ...(declaration.resourceId ? { resourceId: declaration.resourceId } : {}), ...(declaration.recovery ? { recovery: declaration.recovery } : {}) })
    registrations.set(selection.environmentId, { descriptor, historyTools, contextualTarget: entry.contextualTarget, ...(entry.targets ? { targets: entry.targets } : {}),
      ...(entry.validateSelection ? { validateSelection: entry.validateSelection } : {}) })
  }
  const catalog: ToolEnvironmentCatalog = {
    environments: Object.freeze([...registrations.values()].map(({ descriptor }) => descriptor)),
    isTargeted: environmentId => registrations.get(environmentId)?.targets !== undefined,
    targets(environmentId, reader) {
      const targets = registrations.get(environmentId)?.targets
      return targets ? readTargets(targets, reader) : []
    },
    snapshot(ids, toolIdsByEnvironment, toolIdsByTarget, reader) {
      if (!Array.isArray(ids) || new Set(ids).size !== ids.length) throw new TypeError('invalid tool environment selection')
      const schemaVersion = ids.some(id => registrations.get(id)?.targets) ? 2 : 1
      return parseToolEnvironmentSnapshot({ schemaVersion, environments: ids.map(environmentId => {
        const registration = registrations.get(environmentId)
        if (!registration) throw new TypeError('unavailable tool environment')
        const { descriptor } = registration
        if (registration.targets) {
          const tools = catalog.targets(environmentId, reader).flatMap(target => {
            const key = targetKey(environmentId, target.selectionId)
            const selected = new Set(toolIdsByTarget && Object.hasOwn(toolIdsByTarget, key) ? toolIdsByTarget[key] : [])
            return target.tools.filter(tool => selected.has(tool.toolId)).map(tool => ({ ...tool, targetId: target.targetId }))
          })
          registration.validateSelection?.(tools)
          return { environmentId, version: descriptor.version, tools }
        }
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
    validate(value, reader) {
      const snapshot = parseToolEnvironmentSnapshot(value)
      for (const selection of snapshot.environments) {
        const registration = registrations.get(selection.environmentId)
        if (!registration || registration.descriptor.version !== selection.version) throw new TypeError('tool environment snapshot unavailable')
        const targets = registration.targets && catalog.targets(selection.environmentId, reader)
        const available = targets ? selection.tools.every(tool => availableDescriptor(tool, targets)) : selection.tools.every(tool =>
          (tool.targetId === undefined || tool.workspaceBindingId !== undefined && registration.contextualTarget === true) &&
          [...registration.descriptor.tools, ...registration.historyTools].some(current => isDeepStrictEqual(current, originalToolDescriptor(tool))))
        if (!available) throw new TypeError('tool environment snapshot unavailable')
        if (selection.tools.some(tool => tool.workspaceBindingId !== undefined)) {
          for (const id of new Set(selection.tools.map(tool => tool.workspaceBindingId))) {
            registration.validateSelection?.(selection.tools.filter(tool => tool.workspaceBindingId === id).map(originalToolDescriptor))
          }
        } else registration.validateSelection?.(selection.tools)
      }
      return snapshot
    },
    bind(providers, targetedProviders = []) {
      if (!Array.isArray(providers) || !Array.isArray(targetedProviders)) throw new TypeError('invalid tool environment providers')
      const bound = new Map<string, BoundEnvironment>()
      for (const provider of providers) {
        if (!provider || typeof provider.openScope !== 'function') throw new TypeError('invalid executable tool environment')
        const registration = registrations.get(provider.environmentId)
        const descriptor = registration?.descriptor
        if (!descriptor || registration.targets || bound.has(provider.environmentId) || provider.version !== descriptor.version || provider.resourceId !== descriptor.resourceId || provider.recovery !== descriptor.recovery || !isDeepStrictEqual(provider.tools, descriptor.tools)) throw new TypeError('tool environment binding conflict')
        const open = provider.openScope.bind(provider)
        // Existing observe-existing providers returned their original scope through openScope.
        const restore = provider.restoreScope?.bind(provider) ?? (descriptor.recovery === 'observe-existing' ? open : undefined)
        bound.set(provider.environmentId, { targeted: false, recovery: descriptor.recovery, openScope: (targetId, context) => {
          if (targetId === undefined) return open(context)
          if (!registration.contextualTarget || !provider.openBoundScope) throw failure('unavailable')
          return provider.openBoundScope(targetId, context)
        }, ...(restore ? { restoreScope: (targetId: string | undefined, context: ToolEnvironmentScopeContext) => {
          if (targetId === undefined) return restore(context)
          if (!registration.contextualTarget || !provider.restoreBoundScope) throw failure('unavailable')
          return provider.restoreBoundScope(targetId, context)
        } } : {}) })
      }
      for (const provider of targetedProviders) {
        if (!provider || typeof provider.openTargetScope !== 'function' || typeof provider.targets !== 'function') throw new TypeError('invalid targeted tool environment provider')
        const registration = registrations.get(provider.environmentId)
        if (!registration?.targets || bound.has(provider.environmentId) || provider.version !== registration.descriptor.version ||
          provider.recovery !== undefined && provider.recovery !== 'observe-existing') throw new TypeError('tool environment binding conflict')
        const open = provider.openTargetScope.bind(provider)
        const restore = provider.restoreTargetScope?.bind(provider)
        bound.set(provider.environmentId, { targeted: true, recovery: provider.recovery, openScope(targetId, context) {
          if (targetId === undefined) throw failure('unavailable')
          return open(targetId, context)
        }, ...(restore ? { restoreScope(targetId, context) {
          if (targetId === undefined) throw failure('unavailable')
          return restore(targetId, context)
        } } : {}) })
      }
      if (bound.size !== registrations.size) throw new TypeError('missing executable tool environment')
      return Object.freeze({ openRun(value: ToolEnvironmentSnapshot, context: ToolEnvironmentRunContext) {
        if (context.lazyScopes) {
          const snapshot = parseToolEnvironmentSnapshot(value)
          return openRun(bound, snapshot, context, undefined, ({ environmentId, targetId }, restoring) => {
            const selection = snapshot.environments.find(environment => environment.environmentId === environmentId)
            const registration = registrations.get(environmentId)
            if (!selection || !registration || registration.descriptor.version !== selection.version) throw failure('unavailable')
            const tools = registration.targets || selection.tools.some(tool => tool.workspaceBindingId !== undefined) ? selection.tools.filter(tool => tool.targetId === targetId) : selection.tools
            if (!tools.length) throw failure('unavailable')
            // An exit observer needs the original identity. Current tool discovery may have changed.
            if (!restoring) catalog.validate({ ...snapshot, environments: [{ ...selection, tools }] })
          })
        }
        if (value.schemaVersion === 3) throw failure('unavailable')
        if (!context.resuming || value.schemaVersion !== 2) return openRun(bound, catalog.validate(value), context)
        const snapshot = parseToolEnvironmentSnapshot(value)
        let unavailable: Error | undefined
        const environments = snapshot.environments.flatMap(selection => {
          const registration = registrations.get(selection.environmentId)
          if (!registration?.targets) {
            if (selection.tools.every(tool => tool.targetId === undefined)) {
              return catalog.validate({ ...snapshot, environments: [selection] }).environments
            }
            unavailable ??= failure('unavailable')
            return []
          }
          let targets: readonly TargetedToolEnvironmentTarget[] = []
          try {
            if (registration.descriptor.version === selection.version) {
              registration.validateSelection?.(selection.tools)
              targets = catalog.targets(selection.environmentId)
            }
          } catch { /* This target cannot be verified, but other scopes can still close. */ }
          const missing = new Set(selection.tools.filter(tool => !availableDescriptor(tool, targets)).map(tool => tool.targetId))
          if (!missing.size) return selection
          unavailable ??= failure('unavailable')
          return { ...selection, tools: selection.tools.filter(tool => !missing.has(tool.targetId)) }
        })
        // Cleanup must still reach intact scopes even if another target is no longer observable.
        return openRun(bound, { ...snapshot, environments }, context, unavailable)
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

export * from './snapshot.js'
export { createToolRegistry } from './tool-registry.js'
export type { ToolRegistrar, ToolRegistration } from './tool-registry.js'
export type * from './catalog-port.js'
