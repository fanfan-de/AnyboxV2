import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ApplicationHttpContext, ApplicationHttpPort } from '../../../host/applications/registration.js'
import { failure, json, requestObject } from '../../../host/http-utils.js'
import { isClaudeAgentError } from '../core/domain.js'
import type { ClaudeAgentRunsPort } from '../core/runs/component.js'
import type { ClaudeAgentSdkPort } from '../core/sdk/port.js'
import type { ClaudeAgentRunStatus, RunChangedView, RunEventFrameView } from '../core/view.js'
import { openClaudeAgentEventStream } from './event-stream.js'
import type { ClaudeAgentEventStream } from './event-stream.js'

/** Services captured synchronously per request; a later generation never receives an older request. */
export interface ClaudeAgentHttpServices { readonly runs: ClaudeAgentRunsPort; readonly sdk: ClaudeAgentSdkPort }
export interface ClaudeAgentHttpHandler extends ApplicationHttpPort {
  notifyChange(change: RunChangedView): void
  notifyEvent(frame: RunEventFrameView): void
  close(): Promise<void>
}
interface KnownFailure { readonly status: number; readonly code: string; readonly message?: string }
const terminal: ReadonlySet<ClaudeAgentRunStatus> = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
// The client proxy answers a handshake within 15 s, so a long poll must return well before that.
const maxStreams = 64, waitLimitMs = 10_000, runBodyLimit = 512 * 1024
const validId = (value: string) => /^[A-Za-z0-9._:-]{1,128}$/.test(value)
function knownFailure(error: unknown): KnownFailure {
  if (isClaudeAgentError(error)) return { status: error.status, code: error.code, ...(error.message && error.message !== error.code ? { message: error.message } : {}) }
  if (error instanceof URIError || error instanceof TypeError) return { status: 400, code: 'invalid-input' }
  if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' && 'code' in error && typeof error.code === 'string') return { status: error.status, code: error.code }
  return { status: 500, code: 'internal-error' }
}
const segment = (value: string) => { const id = decodeURIComponent(value); if (!validId(id)) throw failure(400, 'invalid-input'); return id }

/** Business routes relative to `/api/v1/apps/claude-agent`. DTOs are the whitelisted views; SDK objects never appear here. */
export function createClaudeAgentHttpHandler(services: () => ClaudeAgentHttpServices): ClaudeAgentHttpHandler {
  let closing = false
  const tasks = new Set<Promise<void>>(), streams = new Set<ClaudeAgentEventStream>(), controllers = new Set<AbortController>()
  const serve = async (request: IncomingMessage, response: ServerResponse, url: URL, context: ApplicationHttpContext, controller: AbortController) => {
    const { runs, sdk } = services()
    const method = request.method ?? 'GET', path = url.pathname
    const noQuery = () => { if (url.search) throw failure(400, 'invalid-input') }
    if (method === 'GET' && path === '/events') {
      const ids = url.searchParams.getAll('threadId')
      if (!ids.length || ids.length > 4 || new Set(ids).size !== ids.length || ids.some(id => !validId(id)) || [...url.searchParams.keys()].some(key => key !== 'threadId')) throw failure(400, 'invalid-input')
      if (streams.size >= maxStreams) throw failure(503, 'too-many-streams')
      const stream = openClaudeAgentEventStream(response, new Set(ids))
      streams.add(stream)
      const stop = () => stream.close()
      controller.signal.addEventListener('abort', stop, { once: true })
      try { await stream.done } finally { streams.delete(stream); controller.signal.removeEventListener('abort', stop) }
      return
    }
    if (method === 'GET' && path === '/environment') { noQuery(); json(response, 200, sdk.environment()); return }
    if (path === '/threads') {
      noQuery()
      if (method === 'GET') { json(response, 200, await runs.listThreads()); return }
      if (method === 'POST') { json(response, 201, await runs.createThread(await requestObject(request, ['projectPath', 'title']))); return }
    }
    const thread = /^\/threads\/([^/]+)(?:\/(runs|messages|approvals))?$/.exec(path)
    if (thread) {
      noQuery()
      const id = segment(thread[1]), part = thread[2]
      if (method === 'GET' && !part) { const view = await runs.getThread(id); if (!view) throw failure(404, 'thread-not-found'); json(response, 200, view); return }
      if (method === 'GET' && part === 'runs') { if (!await runs.getThread(id)) throw failure(404, 'thread-not-found'); json(response, 200, await runs.listRuns(id)); return }
      if (method === 'GET' && part === 'messages') { json(response, 200, await runs.readThreadMessages(id, controller.signal)); return }
      if (method === 'GET' && part === 'approvals') { if (!await runs.getThread(id)) throw failure(404, 'thread-not-found'); json(response, 200, runs.listPendingApprovals(id)); return }
      if (method === 'POST' && part === 'runs') {
        const run = await runs.startRun(id, await requestObject(request, ['prompt', 'idempotencyKey', 'model', 'effort'], runBodyLimit))
        // The accepted Run keeps the application lease until its process exits, regardless of this response or the browser.
        context.retainUntil(runs.waitRun(run.id))
        json(response, 202, run); return
      }
    }
    const run = /^\/runs\/([^/]+)(?:\/(view|wait|cancel))?$/.exec(path)
    if (run) {
      const id = segment(run[1]), part = run[2]
      if (part !== 'wait') noQuery()
      if (method === 'GET' && !part) { const view = await runs.getRun(id); if (!view) throw failure(404, 'run-not-found'); json(response, 200, view); return }
      if (method === 'GET' && part === 'view') {
        const view = runs.getRunView(id)
        if (view) { json(response, 200, view); return }
        throw failure(404, await runs.getRun(id) ? 'view-unavailable' : 'run-not-found')
      }
      if (method === 'GET' && part === 'wait') {
        const raw = url.searchParams.get('timeoutMs'), timeoutMs = raw === null ? waitLimitMs : Number(raw)
        if ([...url.searchParams.keys()].some(key => key !== 'timeoutMs') || !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > waitLimitMs) throw failure(400, 'invalid-input')
        const waiter = new AbortController(), stop = () => waiter.abort()
        let timedOut = false
        const timer = setTimeout(() => { timedOut = true; waiter.abort() }, timeoutMs)
        controller.signal.addEventListener('abort', stop, { once: true })
        try {
          const current = await runs.waitRun(id, waiter.signal)
          if (!current) throw failure(404, 'run-not-found')
          const done = terminal.has(current.status)
          json(response, 200, { done, timedOut: timedOut && !done, run: current }); return
        } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', stop) }
      }
      if (method === 'POST' && part === 'cancel') {
        await requestObject(request, [])
        const current = await runs.cancelRun(id)
        if (!current) throw failure(404, 'run-not-found')
        json(response, 200, current); return
      }
    }
    const approval = /^\/approvals\/([^/]+)$/.exec(path)
    if (approval && method === 'POST') {
      noQuery()
      const body = await requestObject(request, ['decision', 'answers'])
      json(response, 200, await runs.resolveApproval(segment(approval[1]), body.decision, body.answers)); return
    }
    throw failure(404, 'not-found')
  }
  return {
    handle(request, response, url, context) {
      const controller = new AbortController(), abort = () => controller.abort()
      const task = (async () => {
        if (closing) throw failure(503, 'service-unavailable')
        controllers.add(controller)
        context.signal.addEventListener('abort', abort, { once: true }); if (context.signal.aborted) abort()
        response.once('close', abort)
        try { await serve(request, response, url, context, controller) }
        finally { controllers.delete(controller); context.signal.removeEventListener('abort', abort); response.off('close', abort) }
      })().catch(error => {
        if (response.destroyed) return
        const known = knownFailure(error)
        if (!response.headersSent) json(response, known.status, { error: { code: known.code, ...(known.message ? { message: known.message } : {}) } })
        else response.destroy()
      }).finally(() => { tasks.delete(task) })
      tasks.add(task)
      return task
    },
    notifyChange(change) { for (const stream of streams) stream.publishChange(change) },
    notifyEvent(frame) { for (const stream of streams) stream.publishEvent(frame) },
    async close() {
      closing = true
      for (const controller of controllers) controller.abort()
      for (const stream of streams) stream.close()
      await Promise.allSettled([...tasks])
    },
  }
}
