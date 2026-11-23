import type { ToolCall } from '@anybox/tool-api'
import type { ToolScopeTarget } from './catalog-port.js'
import type { ExecutionEnvironmentManager } from './index.js'
import type { EnvironmentGrant } from './contracts.js'
import { environmentError, exactGrantKey, targetKey } from './contracts.js'
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

interface TargetAdmission {
  readonly target: ToolScopeTarget
  readonly operationId: string
  readonly grants: EnvironmentGrant[]
  original: boolean
  opening?: Promise<void>
  admission?: Promise<void>
  settle?: (proven: boolean) => void
  closing?: Promise<void>
}

/** A target joins the Run's resource ledger only when its scope is acquired. */
export function createRunTargetScopeAuthority(manager: ExecutionEnvironmentManager, access: RunEnvironmentAccess,
  runId: string, cancel: () => void) {
  const admissions = new Map<string, TargetAdmission>()
  const legacyId = JSON.stringify([runId, 'scope'])
  for (const { grant } of access.functions) {
    const { environmentId, targetId } = grant.tool
    const key = targetKey(environmentId, targetId)
    let admission = admissions.get(key)
    if (!admission) {
      admission = { target: { environmentId, targetId }, operationId: JSON.stringify([runId, 'scope', environmentId, targetId]),
        grants: [], original: false }
      admissions.set(key, admission)
    }
    admission.grants.push(grant)
  }

  const lookup = ({ environmentId, targetId }: ToolScopeTarget) => {
    const admission = admissions.get(targetKey(environmentId, targetId))
    if (!admission) throw environmentError('environment-target-unavailable', 409)
    return admission
  }

  const open = (admission: TargetAdmission, adopt: boolean, signal?: AbortSignal) => {
    if (admission.closing) throw environmentError('environment-scope-unavailable', 409)
    if (admission.opening) return admission.opening
    let attached!: () => void
    const ready = new Promise<void>(resolve => { attached = resolve })
    const start = (admitted: AbortSignal) => {
      const release = new Promise<void>((resolve, reject) => {
        admission.settle = proven => {
          if (proven) resolve()
          else reject(environmentError('environment-exit-unknown', 409))
        }
      })
      admitted.addEventListener('abort', cancel, { once: true })
      const done = release.finally(() => admitted.removeEventListener('abort', cancel))
      attached()
      return { result: done, done }
    }
    const claim = adopt ? manager.resumeScope : manager.runScope
    admission.admission = claim(access.agentId, admission.grants, admission.operationId, start, signal)
    admission.opening = Promise.race([ready, admission.admission])
    return admission.opening
  }

  const close = (admission: TargetAdmission, proven: boolean) => admission.closing ??= (async () => {
    // If close races with acquisition, wait for its decision before releasing its receipt.
    await admission.opening?.catch(() => {})
    if (admission.settle) {
      admission.settle(proven)
      if (proven) await admission.admission
      else await admission.admission?.catch(() => {})
    } else if (proven && admission.original) {
      const keys = new Set(admission.grants.map(exactGrantKey))
      const reconciled = await manager.reconcile(access.agentId, admission.operationId,
        async previous => previous.length === keys.size && previous.every(grant => keys.has(exactGrantKey(grant))))
      if (!reconciled) throw environmentError('environment-exit-unknown', 409)
    }
  })()

  return {
    async lifecycles() {
      const all = [...admissions.values()]
      const outstanding = await manager.outstandingScopes(access.agentId, [legacyId, ...all.map(value => value.operationId)])
      const targets = all.filter(admission => outstanding.has(admission.operationId))
      for (const admission of targets) admission.original = true
      return { legacy: outstanding.has(legacyId), targets: targets.map(({ target }) => target) }
    },
    acquire(target: ToolScopeTarget, signal?: AbortSignal): Promise<void> {
      const admission = lookup(target)
      if (admission.original && !admission.opening) throw environmentError('environment-scope-unavailable', 409)
      return open(admission, false, signal)
    },
    adopt(target: ToolScopeTarget, signal?: AbortSignal): Promise<void> {
      const admission = lookup(target)
      if (!admission.original) throw environmentError('environment-no-original-scope', 409)
      return open(admission, true, signal)
    },
    closed(target: ToolScopeTarget, proven: boolean): Promise<void> {
      return close(lookup(target), proven)
    },
    async finishPending() {
      await Promise.all([...admissions.values()].filter(admission => admission.opening && !admission.closing)
        .map(admission => close(admission, false)))
    },
  }
}
