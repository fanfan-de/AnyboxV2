import type { Component } from '@nya/core'
import type { JsonValue } from '@anybox/models'
import { computerError } from './domain.js'
import { computerInstanceProviderServiceKey, localComputerProviderId, unitComputerProviderId } from './port.js'
import type { ComputerInstanceProvider } from './port.js'
import { unitAttachmentOfComputer } from './operations-domain.js'
import { computerWorkerServiceKey, localComputerWorkerServiceKey, workerBootExited, workerError, workerProviderRef } from './worker-port.js'
import type { ComputerWorkerPort, WorkerAuthorization, WorkerOperation } from './worker-port.js'
import { localAttachmentId } from '../unit/domain.js'
import { unitAttachmentsServiceKey } from '../unit/port.js'
import type { UnitAttachmentsPort } from '../unit/port.js'
import { unitTransportServiceKey } from '../unit/transport-component.js'
import type { UnitTransportPort } from '../unit/transport-component.js'
import { isTransportError } from '../unit/transport-domain.js'

export interface WorkerRouterOptions {
  /** Local form: this harness server's own worker serves `local:computer`; remote form has no local worker at all. */
  readonly local: boolean
  readonly claimTimeoutMs?: number
  readonly replyTimeoutMs?: number
}
interface UnitInfo { readonly workerId: string; readonly bootId: string; readonly platform: string; readonly architecture: string }
type RouterDependencies = { [unitTransportServiceKey]: UnitTransportPort; [unitAttachmentsServiceKey]: UnitAttachmentsPort; [localComputerWorkerServiceKey]?: ComputerWorkerPort }
const terminal = (state: string) => ['succeeded', 'failed', 'cancelled', 'outcome-unknown'].includes(state)
const localAttachment = localAttachmentId('computer')

/**
 * One `computer.worker` and one `computer.instance-provider` for every Computer unit this harness server uses. Calls are routed
 * by the authorization's attachment: `local:computer` goes over loopback to this harness server's own worker, every other
 * attachment through the unit transport. The router owns no ledger; its Effect only abandons local observations.
 */
export function createWorkerRouterComponent(options: WorkerRouterOptions): Component.Object<void, RouterDependencies> {
  return { name: 'computer-worker-router', inject: [unitTransportServiceKey, unitAttachmentsServiceKey, ...(options.local ? [localComputerWorkerServiceKey] : [])], apply(ctx, _config, deps) {
    const transport = deps[unitTransportServiceKey], attachments = deps[unitAttachmentsServiceKey], local = options.local ? deps[localComputerWorkerServiceKey] : undefined
    const lifetime = new AbortController()
    let closing = false
    /** claims already installed at a unit boot: `${attachmentId}\0${runId}\0${epoch}` -> bootId */
    const claimed = new Map<string, string>()
    /** last seen non-terminal state per operation, so `get` can wait remotely for a change instead of polling across the network */
    const known = new Map<string, { readonly state: string; readonly receipt: string }>()
    /** submissions a unit claimed at least once in this process: a later unclaimed retry may still have executed */
    const delivered = new Set<string>()
    const deliveredRuns = new Set<string>()
    const runKey = (input: WorkerAuthorization) => `${input.attachmentId}\0${input.runId}`
    const request = async <T>(attachmentId: string, kind: string, payload: JsonValue, signal?: AbortSignal, deliveryKey?: string, ownerKey?: string): Promise<T> => {
      if (closing) throw workerError('worker-observer-closed')
      const controller = new AbortController(), forward = () => controller.abort()
      lifetime.signal.addEventListener('abort', forward, { once: true }); signal?.addEventListener('abort', forward, { once: true })
      if (lifetime.signal.aborted || signal?.aborted) forward()
      try {
        const value = await transport.request(attachmentId, { kind, payload }, { signal: controller.signal, claimTimeoutMs: options.claimTimeoutMs, replyTimeoutMs: options.replyTimeoutMs }) as T
        if (deliveryKey !== undefined) { delivered.add(deliveryKey); if (ownerKey !== undefined) deliveredRuns.add(ownerKey) }
        return value
      } catch (error) {
        // Unclaimed requests never reached a unit: `worker-unreachable` lets admission fail. A claimed request whose reply was lost
        // may have executed, so it and every later retry stay ambiguous (`worker-unavailable`, retried like any outage).
        if (isTransportError(error)) {
          if (error.code === 'unit-request-aborted') throw workerError('worker-observer-closed')
          if ((error.code === 'unit-reply-timeout' || error.code === 'unit-claimed-unavailable') && deliveryKey !== undefined) {
            delivered.add(deliveryKey); if (ownerKey !== undefined) deliveredRuns.add(ownerKey)
          }
          const mayHaveExecuted = deliveryKey !== undefined && delivered.has(deliveryKey) || ownerKey !== undefined && deliveredRuns.has(ownerKey)
          throw workerError(error.code === 'unit-unavailable' && !mayHaveExecuted ? 'worker-unreachable' : 'worker-unavailable')
        }
        // The unit's own rejections keep their name and code so owner, scope and file fences stay visible to callers.
        if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
          throw Object.assign(new Error(error.message), { name: error.name === 'UnitReplyError' ? 'ComputerWorkerError' : error.name, code: error.code,
            ...('category' in error && typeof error.category === 'string' ? { category: error.category } : {}) })
        }
        throw workerError('worker-request-failed')
      } finally { lifetime.signal.removeEventListener('abort', forward); signal?.removeEventListener('abort', forward) }
    }
    const attachmentOf = (input: { readonly attachmentId: string }): string => {
      if (typeof input?.attachmentId !== 'string' || !input.attachmentId) throw workerError('worker-attachment-rejected')
      return input.attachmentId
    }
    const requireLocal = (): ComputerWorkerPort => { if (!local) throw workerError('worker-attachment-rejected'); return local }
    const info = (attachmentId: string, signal?: AbortSignal) => request<UnitInfo>(attachmentId, 'info', {}, signal)
    const remember = (operation: WorkerOperation | null | undefined) => {
      if (!operation) return
      if (terminal(operation.state)) known.delete(operation.operationId)
      else known.set(operation.operationId, { state: operation.state, receipt: operation.receipt })
    }
    const worker: ComputerWorkerPort = {
      info: () => local ? local.info() : Promise.reject(workerError('worker-attachment-rejected')),
      async claimRun(input) {
        const attachmentId = attachmentOf(input)
        if (attachmentId === localAttachment) return requireLocal().claimRun(input)
        const key = `${attachmentId}\0${input.runId}\0${input.runOwnerEpoch}`, boot = transport.connection(attachmentId)?.bootId
        if (boot !== undefined && claimed.get(key) === boot) return
        await request(attachmentId, 'claim', { runId: input.runId, runOwnerEpoch: input.runOwnerEpoch }, undefined, undefined, runKey(input))
        const after = transport.connection(attachmentId)?.bootId
        if (after !== undefined) claimed.set(key, after)
      },
      async submit(input) {
        const attachmentId = attachmentOf(input)
        if (attachmentId === localAttachment) return requireLocal().submit(input)
        const { attachmentId: _delivering, ...payload } = input
        const operation = await request<WorkerOperation>(attachmentId, 'submit', payload as unknown as JsonValue, undefined, `${attachmentId}\0${input.operationId}`, runKey(input))
        remember(operation); return operation
      },
      async get(input) {
        const attachmentId = attachmentOf(input)
        if (attachmentId === localAttachment) return requireLocal().get(input)
        const hint = known.get(input.operationId)
        const operation = await request<WorkerOperation | null>(attachmentId, 'get', { runId: input.runId, runOwnerEpoch: input.runOwnerEpoch, operationId: input.operationId, ...(hint ? { known: hint } : {}) }, undefined, undefined, runKey(input))
        remember(operation); return operation ?? undefined
      },
      async query(input, signal) {
        const attachmentId = attachmentOf(input)
        const querySignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
        if (querySignal.aborted) throw workerError('worker-observer-closed')
        if (attachmentId === localAttachment) return requireLocal().query(input, querySignal)
        const attachment = await attachments.get(attachmentId)
        if (!attachment) throw workerError('worker-unreachable')
        if (attachment.state !== 'approved' || attachment.unitKind !== 'computer') throw workerError('worker-attachment-rejected')
        // The worker resolves both grants and query roots against its own filesystem, including authorized aliases.
        return request<Awaited<ReturnType<ComputerWorkerPort['query']>>>(attachmentId, 'query', { query: input.query } as unknown as JsonValue, querySignal)
      },
      // A harness server stops only the worker it owns, never a unit attached from elsewhere.
      shutdown: () => local ? local.shutdown() : Promise.reject(workerError('worker-remote-control')),
    }
    const provider: ComputerInstanceProvider = { providerId: options.local ? localComputerProviderId : unitComputerProviderId,
      providerIds: options.local ? [localComputerProviderId, unitComputerProviderId] : [unitComputerProviderId], activate({ resource, previousInstance }) {
      const controller = new AbortController()
      const result = (async () => {
        let current: UnitInfo
        if (resource.spec.providerId === localComputerProviderId) {
          if (!local) throw computerError('computer-unavailable')
          try { current = await local.info() } catch { throw computerError(controller.signal.aborted ? 'computer-cancelled' : 'computer-unavailable') }
        } else {
          const attachmentId = unitAttachmentOfComputer(resource.computerId)
          if (!attachmentId || resource.spec.providerId !== unitComputerProviderId) throw computerError('computer-unavailable')
          try { current = await info(attachmentId, controller.signal) } catch { throw computerError(controller.signal.aborted ? 'computer-cancelled' : 'computer-unavailable') }
        }
        if (controller.signal.aborted) throw computerError('computer-cancelled')
        if (current.platform !== resource.spec.platform || current.architecture !== resource.spec.architecture) throw computerError('computer-unavailable')
        // A restarted worker answers with a new boot: the previous instance of the same worker can never run anything again.
        const previousExited = previousInstance !== undefined && previousInstance.providerId === resource.spec.providerId && workerBootExited(previousInstance.providerRef, current)
        return { providerRef: workerProviderRef(current), platform: current.platform, architecture: current.architecture, ...(previousExited ? { previousExited } : {}) }
      })()
      return { result, done: result.then(() => {}, () => {}), cancel() { controller.abort() } }
    } }
    ctx.effect(() => () => { closing = true; lifetime.abort('worker-router-closing') }, 'abandon local observations of remote Computer units')
    ctx.provide(computerWorkerServiceKey, worker)
    ctx.provide(computerInstanceProviderServiceKey, provider)
  } }
}
