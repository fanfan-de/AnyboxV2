import type { ProtocolViewSnapshot } from '../harness/view/types.js'
import { decodeProtocolWebView } from './protocols/modules.js'

export interface ChangeConnection { close(): void }
export interface ChangeHandlers { ready(): void; change(data: string): void; view(data: string): void; error(): void }
export interface ChangeEnvironment {
  open(url: string, handlers: ChangeHandlers): ChangeConnection
  refresh(sessionId: string): void
  connected(value: boolean): void
  view?(snapshot: ProtocolViewSnapshot): void
}

/** One connection per workspace. Ready always reconciles, including after EventSource reconnects. */
export function createRunChangeClient(env: ChangeEnvironment) {
  let connection: ChangeConnection | undefined, generation = 0, disposed = false, key = ''
  let subscribed = new Set<string>(), connected = false
  const status = (value: boolean) => {
    if (connected === value) return
    connected = value
    env.connected(value)
  }
  return {
    update(sessionIds: readonly string[]) {
      if (disposed) return
      const ids = [...new Set(sessionIds)].sort()
      if (ids.length > 4) throw new TypeError('at most four sessions can subscribe')
      const next = JSON.stringify(ids)
      if (next === key) return
      key = next
      const version = ++generation
      connection?.close()
      connection = undefined
      subscribed = new Set(ids)
      status(false)
      if (!ids.length) return
      const current = () => !disposed && generation === version
      const query = new URLSearchParams(ids.map(id => ['sessionId', id]))
      try {
        connection = env.open(`/api/v1/changes?${query}`, {
          ready() {
            if (!current()) return
            status(true)
            for (const id of subscribed) env.refresh(id)
          },
          change(data) {
            if (!current()) return
            let value: unknown
            try { value = JSON.parse(data) } catch { return }
            if (!value || typeof value !== 'object') return
            const change = value as Record<string, unknown>
            if (typeof change.sessionId !== 'string' || !subscribed.has(change.sessionId) ||
                typeof change.runId !== 'string' || !change.runId ||
                !Number.isSafeInteger(change.revision) || Number(change.revision) < 0) return
            env.refresh(change.sessionId)
          },
          view(data) {
            if (!current() || !env.view) return
            let value: unknown
            try { value = JSON.parse(data) } catch { return }
            if (!value || typeof value !== 'object') return
            const message = value as Record<string, unknown>
            const snapshot = decodeProtocolWebView(message.snapshot)
            if (!snapshot || !subscribed.has(snapshot.sessionId) || message.sessionId !== snapshot.sessionId || message.runId !== snapshot.runId) return
            env.view(snapshot)
          },
          error() { if (current()) status(false) },
        })
      } catch { status(false) }
    },
    dispose() {
      disposed = true
      generation++
      connection?.close()
      connection = undefined
      subscribed.clear()
      status(false)
    },
  }
}
