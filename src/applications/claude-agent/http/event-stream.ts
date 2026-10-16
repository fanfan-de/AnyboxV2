import type { ServerResponse } from 'node:http'
import type { RunChangedView, RunEventFrameView } from '../core/view.js'

export interface ClaudeAgentEventStream {
  publishChange(change: RunChangedView): void
  publishEvent(frame: RunEventFrameView): void
  close(): void
  readonly done: Promise<void>
}
/** A slow browser loses only its subscription; it never delays the agent. Frames keep their causal order. */
export const eventStreamLimits = Object.freeze({ frames: 1024, bytes: 1024 * 1024, drainTimeoutMs: 15_000, heartbeatMs: 15_000 })
/** One SSE response owns its timers and listeners and reports only the agent runs of the subscribed threads. */
export function openClaudeAgentEventStream(response: ServerResponse, threadIds: ReadonlySet<string>): ClaudeAgentEventStream {
  const queue: string[] = []
  let queuedBytes = 0, closed = false, blocked = false
  let flushTask: ReturnType<typeof setImmediate> | undefined, heartbeat: ReturnType<typeof setInterval> | undefined, drainTimeout: ReturnType<typeof setTimeout> | undefined
  let exited!: () => void
  const done = new Promise<void>(resolve => { exited = resolve })
  const cleanup = () => {
    closed = true; queue.length = 0; queuedBytes = 0
    if (flushTask) clearImmediate(flushTask)
    if (heartbeat) clearInterval(heartbeat)
    if (drainTimeout) clearTimeout(drainTimeout)
    response.off('drain', drain); response.off('error', close); response.off('close', cleanup)
    exited()
  }
  const close = () => { if (closed) return; closed = true; response.destroy() }
  const write = (frame: string) => {
    try { blocked = !response.write(frame); if (blocked) drainTimeout = setTimeout(close, eventStreamLimits.drainTimeoutMs) } catch { close() }
  }
  const flush = () => {
    flushTask = undefined
    while (!closed && !blocked && queue.length) { const frame = queue.shift()!; queuedBytes -= Buffer.byteLength(frame, 'utf8'); write(frame) }
  }
  const schedule = () => { if (!closed && !blocked && !flushTask) flushTask = setImmediate(flush) }
  const drain = () => { if (drainTimeout) clearTimeout(drainTimeout); drainTimeout = undefined; blocked = false; schedule() }
  const enqueue = (event: string, payload: unknown) => {
    if (closed) return
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`, bytes = Buffer.byteLength(frame, 'utf8')
    if (queue.length >= eventStreamLimits.frames || queuedBytes + bytes > eventStreamLimits.bytes) { close(); return }
    queue.push(frame); queuedBytes += bytes; schedule()
  }
  response.on('drain', drain); response.once('error', close); response.once('close', cleanup)
  if (response.destroyed) cleanup()
  else {
    try {
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' })
      // No replay cursor: a (re)connecting browser reconciles through the run view queries.
      write('event: ready\ndata: {}\n\n')
      if (!closed) heartbeat = setInterval(() => { if (!closed && !blocked) write(': heartbeat\n\n') }, eventStreamLimits.heartbeatMs)
    } catch { close() }
  }
  return {
    done, close,
    publishChange(change) { if (threadIds.has(change.threadId)) enqueue('run-changed', change) },
    publishEvent(frame) { if (threadIds.has(frame.threadId)) enqueue('run-event', frame) },
  }
}
