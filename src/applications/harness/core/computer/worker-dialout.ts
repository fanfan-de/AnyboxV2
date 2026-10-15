import type { Component } from '@nya/core'
import type { JsonValue } from '@anybox/models'
import { fullScope } from '../unit/domain.js'
import type { UnitAttachment } from '../unit/domain.js'
import { unitAuthorization } from '../unit/domain.js'
import { transportLimits } from '../unit/transport-domain.js'
import type { UnitReply, UnitRequest } from '../unit/transport-domain.js'
import { unitApiUrl, validateComputerCeiling, validateHarnessUrl, workerContractVersion } from './worker-attachments-domain.js'
import type { WorkerAttachment } from './worker-attachments-domain.js'
import { workerAttachmentsServiceKey } from './worker-attachments.js'
import type { WorkerAttachmentsPort } from './worker-attachments.js'
import { computerWorkerServiceKey, workerError } from './worker-port.js'
import type { ComputerWorkerPort, PushedBytes, WorkerAuthorization, WorkerImage, WorkerOperation, WorkerSubmission } from './worker-port.js'
import { imageAssetsServiceKey } from '../image/port.js'
import type { ImageAssetsPort } from '../image/port.js'
import type { OwnedCall } from '../contracts.js'

export const workerDialoutServiceKey = 'computer.worker-dialout'
export type WorkerDialoutState = 'connected' | 'connecting' | 'offline' | 'instance-mismatch' | 'revoked'
export interface WorkerAttachmentView extends WorkerAttachment { readonly connection: WorkerDialoutState; readonly lastError: string | null }
export interface WorkerAttachInput { readonly harnessUrl: string; readonly code: string; readonly ceiling: unknown }
/** The unit's control face: consume attach codes, list attachments with their connection state, revoke. */
export interface WorkerDialoutPort {
  attach(input: WorkerAttachInput, signal?: AbortSignal): Promise<WorkerAttachmentView>
  list(): Promise<readonly WorkerAttachmentView[]>
  revoke(attachmentId: string): Promise<WorkerAttachmentView>
  updatePermissions(attachmentId: string, ceiling: unknown): Promise<WorkerAttachmentView>
}
export interface WorkerDialoutOptions { readonly fetch?: typeof fetch; readonly pollWaitMs?: number; readonly getWaitMs?: number; readonly requestTimeoutMs?: number }
interface Loop { readonly abort: AbortController; done: Promise<void>; state: WorkerDialoutState; lastError: string | null }
const wait = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  if (signal.aborted) { resolve(); return }
  const timer = setTimeout(end, ms)
  function end() { clearTimeout(timer); signal.removeEventListener('abort', end); resolve() }
  signal.addEventListener('abort', end, { once: true })
})
const terminal = (state: string) => ['succeeded', 'failed', 'cancelled', 'outcome-unknown'].includes(state)
async function joined<T>(call: OwnedCall<T>): Promise<T> { try { return await call.result } finally { await call.done } }
function pushedReceipt(value: unknown): PushedBytes {
  const body = value as Record<string, unknown> | null
  if (!body || typeof body.assetId !== 'string' || !body.assetId || typeof body.sha256 !== 'string' || !Number.isSafeInteger(body.byteLength) || typeof body.mimeType !== 'string') throw workerError('worker-bytes-invalid')
  return { assetId: body.assetId, sha256: body.sha256, byteLength: body.byteLength as number, mimeType: body.mimeType }
}
/** Attach codes are consumed once: only a failure that proves the request never reached the harness server is repeated. */
export const attachRetry = Object.freeze({ attempts: 3, delayMs: (attempt: number) => attempt * 1_000 })
const connectFailureCodes = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'UND_ERR_CONNECT_TIMEOUT'])
export function isConnectFailure(error: unknown): boolean {
  const cause = error instanceof Error && 'cause' in error ? (error as { cause?: unknown }).cause : undefined
  const code = cause && typeof cause === 'object' && 'code' in cause ? (cause as { code?: unknown }).code : undefined
  return typeof code === 'string' && connectFailureCodes.has(code)
}
function replyError(error: unknown): Extract<UnitReply, { error: unknown }>['error'] {
  if (!(error instanceof Error)) return { code: 'worker-request-failed' }
  return { code: 'code' in error && typeof error.code === 'string' ? error.code : 'worker-request-failed', name: error.name, message: error.message,
    ...('category' in error && typeof error.category === 'string' ? { category: error.category } : {}) }
}

/** Each approved attachment gets one long-poll loop. Loops own only their HTTP requests; accepted work belongs to the executor. */
export function createWorkerDialoutComponent(options: WorkerDialoutOptions = {}): Component.Object<void, {
  [computerWorkerServiceKey]: ComputerWorkerPort; [workerAttachmentsServiceKey]: WorkerAttachmentsPort; [imageAssetsServiceKey]: ImageAssetsPort
}> {
  return { name: 'computer-worker-dialout', inject: [computerWorkerServiceKey, workerAttachmentsServiceKey, imageAssetsServiceKey], async apply(ctx, _config, deps) {
    const worker = deps[computerWorkerServiceKey], attachments = deps[workerAttachmentsServiceKey], imageAssets = deps[imageAssetsServiceKey]
    /** bytes already accepted by a harness server, per attachment and worker asset; a restart pushes again and the extra draft expires there */
    const pushedBytes = new Map<string, PushedBytes>()
    const send = options.fetch ?? fetch
    const loops = new Map<string, Loop>()
    let closing = false
    const lifetime = new AbortController()
    const http = async (url: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string | Uint8Array }, timeoutMs: number, signal?: AbortSignal): Promise<{ status: number; body: unknown }> => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort('worker-request-timeout'), timeoutMs)
      const forward = () => controller.abort('worker-observer-closed')
      signal?.addEventListener('abort', forward, { once: true }); lifetime.signal.addEventListener('abort', forward, { once: true })
      if (signal?.aborted || lifetime.signal.aborted) forward()
      try {
        const response = await send(url, { method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body as BodyInit }), signal: controller.signal })
        const text = await response.text()
        let body: unknown = null
        if (text) { try { body = JSON.parse(text) } catch { body = null } }
        return { status: response.status, body }
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', forward); lifetime.signal.removeEventListener('abort', forward) }
    }
    const errorCode = (body: unknown) => (body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object' && 'code' in body.error && typeof body.error.code === 'string') ? body.error.code : undefined
    const longGet = async (input: WorkerAuthorization & { operationId: string; known?: { state: string; receipt: string } }, signal: AbortSignal): Promise<WorkerOperation | null> => {
      const deadline = Date.now() + (options.getWaitMs ?? 5_000)
      while (true) {
        const current = await worker.get(input)
        if (!current || !input.known || terminal(current.state) || current.state !== input.known.state || current.receipt !== input.known.receipt || Date.now() >= deadline || signal.aborted) return current ?? null
        await wait(50, signal)
      }
    }
    // Tool images never cross the network inline: each one is pushed to the harness server's byte channel first,
    // and the fact carries only the receipt. A failed push leaves the fact unreported so the harness server asks again.
    const deliverImages = async (attachment: WorkerAttachment, headers: Record<string, string>, operation: WorkerOperation | null, signal: AbortSignal): Promise<WorkerOperation | null> => {
      if (!operation?.images?.length) return operation
      if (!operation.sessionId) throw workerError('worker-invalid')
      const images: WorkerImage[] = []
      for (const image of operation.images) {
        const key = `${attachment.attachmentId}\0${image.ref.assetId}`
        let receipt = pushedBytes.get(key)
        if (!receipt) {
          const bytes = await joined(imageAssets.readImage(operation.sessionId, image.ref.assetId, signal))
          const response = await http(`${unitApiUrl(attachment.harnessUrl, 'bytes')}?${new URLSearchParams({ scope: operation.sessionId })}`,
            { method: 'POST', headers: { ...headers, 'content-type': image.ref.mediaType, 'x-anybox-sha256': image.ref.sha256, 'x-anybox-byte-length': String(image.ref.byteLength) }, body: bytes },
            options.requestTimeoutMs ?? 30_000, signal).catch(() => { throw workerError('worker-unavailable') })
          if (response.status !== 201) throw workerError('worker-unavailable')
          receipt = pushedReceipt(response.body)
          if (receipt.sha256 !== image.ref.sha256 || receipt.byteLength !== image.ref.byteLength) throw workerError('worker-bytes-mismatch')
          pushedBytes.set(key, receipt)
        }
        images.push({ ref: image.ref, pushed: receipt })
      }
      return { ...operation, images }
    }
    const execute = async (attachment: WorkerAttachment, headers: Record<string, string>, request: UnitRequest, signal: AbortSignal): Promise<UnitReply> => {
      try {
        const payload = (request.payload && typeof request.payload === 'object' && !Array.isArray(request.payload) ? request.payload : {}) as Record<string, JsonValue>
        // Authorization is derived from the attachment that delivered the request, never from the payload.
        const authorized = { ...payload, attachmentId: attachment.attachmentId } as unknown
        let value: unknown
        switch (request.kind) {
          case 'info': value = await worker.info(); break
          case 'claim': value = await worker.claimRun(authorized as WorkerAuthorization); break
          case 'submit': value = await deliverImages(attachment, headers, await worker.submit(authorized as WorkerSubmission), signal); break
          case 'get': value = await deliverImages(attachment, headers, await longGet(authorized as WorkerAuthorization & { operationId: string }, signal), signal); break
          case 'query': value = await worker.query(authorized as Parameters<ComputerWorkerPort['query']>[0]); break
          default: throw workerError('worker-request-unsupported')
        }
        return { requestId: request.requestId, value: (value ?? null) as JsonValue }
      } catch (error) { return { requestId: request.requestId, error: replyError(error) } }
    }
    const start = (attachment: WorkerAttachment, credential: string) => {
      if (loops.has(attachment.attachmentId) || closing) return
      const abort = new AbortController()
      const loop: Loop = { abort, state: 'connecting', lastError: null, done: Promise.resolve() }
      loops.set(attachment.attachmentId, loop)
      const headers = { authorization: unitAuthorization(attachment.attachmentId, credential), 'x-anybox-instance-id': attachment.instanceId, 'content-type': 'application/json' }
      const replies = new Set<Promise<void>>()
      const answer = async (request: UnitRequest) => {
        const reply = await execute(attachment, headers, request, abort.signal)
        if (abort.signal.aborted) return
        try { await http(unitApiUrl(attachment.harnessUrl, 'replies'), { method: 'POST', headers, body: JSON.stringify({ bootId: info.bootId, replies: [reply] }) }, options.requestTimeoutMs ?? 30_000, abort.signal) }
        catch { /* The harness server retries unanswered requests by identity; the executor keeps the fact. */ }
      }
      let info: { workerId: string; bootId: string; platform: string; architecture: string }
      loop.done = (async () => {
        info = await worker.info()
        let backoff = 1_000
        while (!abort.signal.aborted) {
          try {
            const waitMs = options.pollWaitMs ?? transportLimits.defaultWaitMs
            const query = new URLSearchParams({ unitId: info.workerId, bootId: info.bootId, platform: info.platform, architecture: info.architecture, waitMs: String(waitMs) })
            const response = await http(`${unitApiUrl(attachment.harnessUrl, 'poll')}?${query}`, { method: 'GET', headers }, waitMs + (options.requestTimeoutMs ?? 30_000), abort.signal)
            if (response.status === 401 || (response.status === 409 && errorCode(response.body) === 'unit-attachment-state')) {
              // The harness server no longer honours this attachment: stop accepting and drop the credential.
              loop.state = 'revoked'; loop.lastError = errorCode(response.body) ?? 'unit-credential-invalid'
              serverRejected.add(attachment.attachmentId)
              void attachments.revoke(attachment.attachmentId).catch(() => {})
              return
            }
            if (response.status === 409 && errorCode(response.body) === 'instance-mismatch') { loop.state = 'instance-mismatch'; loop.lastError = 'instance-mismatch'; await wait(30_000, abort.signal); continue }
            if (response.status !== 200) throw workerError(errorCode(response.body) ?? `unit-poll-${response.status}`)
            loop.state = 'connected'; loop.lastError = null; backoff = 1_000
            const batch = response.body && typeof response.body === 'object' && Array.isArray((response.body as { requests?: unknown }).requests) ? (response.body as { requests: UnitRequest[] }).requests : []
            for (const request of batch) { const task = answer(request); replies.add(task); void task.finally(() => replies.delete(task)).catch(() => {}) }
          } catch (error) {
            if (abort.signal.aborted) break
            loop.state = 'offline'; loop.lastError = error instanceof Error && 'code' in error ? String(error.code) : 'unit-unreachable'
            await wait(backoff, abort.signal); backoff = Math.min(backoff * 2, 15_000)
          }
        }
      })().catch(() => {}).then(async () => { await Promise.allSettled([...replies]) })
    }
    const serverRejected = new Set<string>()
    const stop = async (attachmentId: string) => {
      const loop = loops.get(attachmentId)
      if (!loop) return
      loops.delete(attachmentId)
      loop.abort.abort('attachment-revoked')
      await loop.done
    }
    const revokeRemote = async (attachment: WorkerAttachment, credential: string) => {
      try { await http(unitApiUrl(attachment.harnessUrl, 'revoke'), { method: 'POST', headers: { authorization: unitAuthorization(attachment.attachmentId, credential), 'x-anybox-instance-id': attachment.instanceId, 'content-type': 'application/json' }, body: '{}' }, 5_000) }
      catch { /* The harness server owner can still revoke from their side. */ }
    }
    const unsubscribe = attachments.onChanged(async attachment => {
      if (attachment.state === 'approved') { try { start(attachment, await attachments.credential(attachment.attachmentId)) } catch { /* Credential unavailable: the attachment stays listed as offline. */ } return }
      await stop(attachment.attachmentId)
    })
    const view = (attachment: WorkerAttachment): WorkerAttachmentView => {
      const loop = loops.get(attachment.attachmentId)
      return Object.freeze({ ...attachment, connection: attachment.state === 'revoked' ? 'revoked' : loop?.state ?? 'offline', lastError: loop?.lastError ?? null })
    }
    const service: WorkerDialoutPort = {
      async updatePermissions(attachmentId, ceiling) {
        if (closing) throw workerError('worker-closing')
        return view(await attachments.updatePermissions(attachmentId, ceiling))
      },
      async attach(input, signal) {
        if (closing) throw workerError('worker-closing')
        const harnessUrl = validateHarnessUrl(input?.harnessUrl), ceiling = validateComputerCeiling(input?.ceiling)
        if (typeof input.code !== 'string' || !input.code.trim() || input.code.length > 1024) throw workerError('worker-attachment-invalid')
        const identity = await worker.info()
        const payload = JSON.stringify({ code: input.code.trim(), unitKind: 'computer', unitId: identity.workerId,
          contractVersion: workerContractVersion, capabilities: { platform: identity.platform, architecture: identity.architecture, workerId: identity.workerId, tools: 'all' }, ceiling })
        let response: { status: number; body: unknown } | undefined
        for (let attempt = 1; response === undefined; attempt++) {
          try { response = await http(unitApiUrl(harnessUrl, 'attach'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload }, options.requestTimeoutMs ?? 30_000, signal) }
          catch (error) {
            // A failure after the request may have been sent (reset, timeout) surfaces instead of burning the code a second time.
            if (attempt >= attachRetry.attempts || !isConnectFailure(error) || signal?.aborted || closing) throw workerError('worker-attach-unreachable')
            await wait(attachRetry.delayMs(attempt), lifetime.signal)
            if (signal?.aborted || closing) throw workerError('worker-attach-unreachable')
          }
        }
        if (response.status !== 201 && response.status !== 200) throw workerError(errorCode(response.body) ?? `worker-attach-${response.status}`)
        const body = response.body as { attachment?: UnitAttachment; credential?: unknown; instanceId?: unknown }
        const approved = body?.attachment
        if (!approved || approved.state !== 'approved' || typeof body.credential !== 'string' || !body.credential || typeof body.instanceId !== 'string' || !body.instanceId) throw workerError('worker-attach-invalid')
        const now = new Date().toISOString()
        const recorded = await attachments.record({ attachmentId: approved.attachmentId, harnessUrl, instanceId: body.instanceId, state: 'approved', ceiling,
          scope: approved.scope ?? fullScope('computer'), epoch: approved.epoch, createdAt: now, revokedAt: null }, body.credential)
        return view(recorded)
      },
      async list() { return Object.freeze((await attachments.list()).map(view)) },
      async revoke(attachmentId) {
        if (closing) throw workerError('worker-closing')
        let credential: string | undefined
        const current = (await attachments.list()).find(attachment => attachment.attachmentId === attachmentId)
        if (current?.state === 'approved') { try { credential = await attachments.credential(attachmentId) } catch { credential = undefined } }
        const revoked = await attachments.revoke(attachmentId)
        if (credential !== undefined && current && !serverRejected.has(attachmentId)) await revokeRemote(current, credential)
        return view(revoked)
      },
    }
    const pending = new Set<Promise<unknown>>()
    const track = <T>(work: () => Promise<T>): Promise<T> => {
      if (closing) return Promise.reject(workerError('worker-closing'))
      const task = Promise.resolve().then(work)
      pending.add(task); void task.finally(() => pending.delete(task)).catch(() => {})
      return task
    }
    ctx.provide(workerDialoutServiceKey, {
      attach: (input, signal) => track(() => service.attach(input, signal)), list: () => track(() => service.list()),
      revoke: id => track(() => service.revoke(id)), updatePermissions: (id, ceiling) => track(() => service.updatePermissions(id, ceiling)),
    } satisfies WorkerDialoutPort)
    for (const attachment of await attachments.list()) {
      if (attachment.state !== 'approved') continue
      try { start(attachment, await attachments.credential(attachment.attachmentId)) } catch { /* Listed as offline until the credential becomes readable. */ }
    }
    ctx.effect(() => async () => {
      closing = true; unsubscribe(); lifetime.abort('worker-dialout-closing')
      await Promise.allSettled([...pending])
      await Promise.allSettled([...loops.values()].map(loop => { loop.abort.abort('worker-dialout-closing'); return loop.done }))
      loops.clear()
    }, 'stop unit dial-out loops and join their requests')
  } }
}
