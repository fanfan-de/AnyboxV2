import type { ServerResponse } from 'node:http'
import type { RunChange } from '../harness/run/notifications.js'
import type { ProtocolViewFrame } from '../harness/view/types.js'

export interface RunChangeStream {
  publish(change: RunChange): void
  publishProtocolView(progress: ProtocolViewFrame): void
  close(): void
  readonly done: Promise<void>
}

/** One SSE response owns its timers/listeners. At most one pending hint per subscribed Session. */
export function openRunChangeStream(response: ServerResponse, sessionIds: ReadonlySet<string>): RunChangeStream {
  const pending = new Map<string, RunChange>()
  const progressFrames = new Map<string, string>()
  let progressBytes = 0
  let closed = false, blocked = false
  let flushTask: ReturnType<typeof setImmediate> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let drainTimeout: ReturnType<typeof setTimeout> | undefined
  let exited!: () => void
  const done = new Promise<void>(resolve => { exited = resolve })
  const cleanup = () => {
    closed = true
    pending.clear()
    progressFrames.clear()
    progressBytes = 0
    if (flushTask) clearImmediate(flushTask)
    if (heartbeat) clearInterval(heartbeat)
    if (drainTimeout) clearTimeout(drainTimeout)
    response.off('drain', drain)
    response.off('error', close)
    response.off('close', cleanup)
    exited()
  }
  const close = () => {
    if (closed) return
    closed = true
    // A slow response must not hold Web shutdown open while waiting for its buffer to drain.
    response.destroy()
  }
  const write = (frame: string) => {
    try {
      blocked = !response.write(frame)
      if (blocked) drainTimeout = setTimeout(close, 15_000)
    } catch { close() }
  }
  const flush = () => {
    flushTask = undefined
    if (closed || blocked) return
    for (const [sessionId, change] of pending) {
      pending.delete(sessionId)
      write(`event: run-changed\ndata: ${JSON.stringify(change)}\n\n`)
      if (closed || blocked) break
    }
    for (const [id, frame] of progressFrames) {
      if (closed || blocked) break
      progressFrames.delete(id)
      progressBytes -= Buffer.byteLength(frame, 'utf8')
      write(frame)
    }
  }
  const schedule = () => {
    if (!closed && !blocked && !flushTask) flushTask = setImmediate(flush)
  }
  const drain = () => {
    if (drainTimeout) clearTimeout(drainTimeout)
    drainTimeout = undefined
    blocked = false
    schedule()
  }
  response.on('drain', drain)
  response.once('error', close)
  response.once('close', cleanup)
  if (response.destroyed) cleanup()
  else {
    try {
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no' })
      // No replay cursor: every initial connection/reconnection reconciles through the query APIs.
      write('event: ready\ndata: {}\n\n')
      if (!closed) heartbeat = setInterval(() => { if (!closed && !blocked) write(': heartbeat\n\n') }, 15_000)
    } catch { close() }
  }
  return {
    done, close,
    publish(change) {
      if (closed || !sessionIds.has(change.sessionId)) return
      pending.set(change.sessionId, change)
      schedule()
    },
    publishProtocolView(progress) {
      if (closed || !sessionIds.has(progress.sessionId)) return
      const frame = `event: protocol-view\ndata: ${JSON.stringify(progress)}\n\n`
      const bytes = Buffer.byteLength(frame, 'utf8')
      const key = JSON.stringify([progress.sessionId, progress.runId])
      const previous = progressFrames.get(key)
      const queuedBytes = progressBytes - (previous ? Buffer.byteLength(previous, 'utf8') : 0) + bytes
      // A slow browser only loses its subscription. It never delays a model callback.
      // Replacement snapshots supersede unsent frames from the same Run.
      if ((!previous && progressFrames.size >= 128) || queuedBytes > 262_144) { close(); return }
      progressFrames.set(key, frame)
      progressBytes = queuedBytes
      schedule()
    },
  }
}
