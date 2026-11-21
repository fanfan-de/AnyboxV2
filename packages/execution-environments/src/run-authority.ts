import type { ToolCall } from '@anybox/tool-api'
import type { ExecutionEnvironmentManager } from './index.js'
import type { EnvironmentGrant } from './contracts.js'
import { environmentError, exactGrantKey } from './contracts.js'
import { runGrants, type RunEnvironmentAccess } from './bindings.js'

/** Only an original provider observation can retire a durable uncertain tool admission. */
export function authorizeFunction<T>(manager: ExecutionEnvironmentManager, access: RunEnvironmentAccess, grant: EnvironmentGrant,
  runId: string, id: string, resuming: boolean, parent: AbortSignal, start: () => ToolCall<T>): ToolCall<T> {
  const operation = JSON.stringify([runId, 'tool', id])
  if (resuming) {
    const call = start()
    const result = call.result.then(async value => {
      await call.done
      await manager.reconcile(access.agentId, operation, async grants =>
        grants.length === 1 && exactGrantKey(grants[0]!) === exactGrantKey(grant))
      return value
    })
    return { result, done: call.done, cancel: reason => call.cancel(reason) }
  }
  const abort = new AbortController()
  let resolveValue!: (value: T) => void, rejectValue!: (error: unknown) => void
  const result = new Promise<T>((resolve, reject) => { resolveValue = resolve; rejectValue = reject })
  let failedExit = false, entered = false, providerError: unknown
  const admitted = manager.run(access.agentId, [grant], operation, signal => {
    const call = start()
    entered = true
    void call.result.then(resolveValue, error => { providerError = error; rejectValue(error) })
    const cancel = () => call.cancel('dependency-unavailable')
    signal.addEventListener('abort', cancel, { once: true })
    // Keep partial results such as already patched files even if actual cleanup fails.
    return { result: call.result, done: call.done.catch(error => { failedExit = true; throw error })
      .finally(() => signal.removeEventListener('abort', cancel)) }
  }, AbortSignal.any([abort.signal, parent]))
  const done = admitted.then(() => {}, error => {
    rejectValue(error)
    if (failedExit || entered && error !== providerError) throw error
  })
  return { result, done, cancel: reason => abort.abort(reason) }
}

/** A completed function may still own a running process. Hold its scope admission until the provider's final close. */
export function createRunScopeAuthority(manager: ExecutionEnvironmentManager, access: RunEnvironmentAccess,
  runId: string, cancel: () => void, canObserveOriginal: boolean) {
  const operation = JSON.stringify([runId, 'scope']), grants = runGrants(access)
  let finish: (() => void) | undefined, fail: ((reason: unknown) => void) | undefined
  let admission: Promise<unknown> | undefined, opening: Promise<boolean> | undefined
  const claim = async (existing: boolean) => {
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const attach = (signal: AbortSignal) => {
      if (existing && !canObserveOriginal) throw environmentError('environment-target-unavailable', 409)
      const exit = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject })
      signal.addEventListener('abort', cancel, { once: true })
      const done = exit.finally(() => signal.removeEventListener('abort', cancel))
      started()
      return { result: done, done }
    }
    admission = existing ? manager.resumeScope(access.agentId, grants, operation, attach).catch(error => {
      if (error?.code !== 'environment-no-original-scope') throw error
    }) : manager.runScope(access.agentId, grants, operation, attach)
    return Promise.race([ready.then(() => true), admission.then(() => false)])
  }
  return {
    async acquire(existing = false) {
      if (!grants.length) return
      if (!await (opening ??= claim(existing))) opening = undefined
    },
    async closed(proven: boolean) {
      if (proven) finish?.()
      else fail?.(environmentError('environment-exit-unknown', 409))
      await admission?.catch(() => {})
    },
    async reconcileClose() {
      if (!canObserveOriginal) return
      const keys = new Set(grants.map(exactGrantKey))
      await manager.reconcile(access.agentId, operation,
        async previous => previous.length === keys.size && previous.every(grant => keys.has(exactGrantKey(grant))))
    },
  }
}
