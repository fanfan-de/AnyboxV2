import type { ChangeConnection, ChangeHandlers } from './run-change-client.js'

/** Fetch keeps the product and connection lease on SSE requests, including reconnects. */
export function openChangeStream(url: string, headers: Readonly<Record<string, string>>, handlers: ChangeHandlers): ChangeConnection {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const run = async () => {
    try {
      const response = await fetch(url, { headers, signal: controller.signal, cache: 'no-store' })
      if (!response.ok || !response.body) throw new Error('stream unavailable')
      const reader = response.body.getReader(), decoder = new TextDecoder()
      let buffer = ''
      try {
        while (!controller.signal.aborted) {
          const next = await reader.read()
          if (next.done) break
          buffer = (buffer + decoder.decode(next.value, { stream: true })).replace(/\r\n/g, '\n')
          if (buffer.length > 2 * 1024 * 1024) throw new Error('stream frame too large')
          let boundary: number
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
            let event = 'message'; const data: string[] = []
            for (const line of frame.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim()
              else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
            }
            if (controller.signal.aborted) break
            if (event === 'ready') handlers.ready()
            else if (event === 'run-changed') handlers.change(data.join('\n'))
            else if (event === 'protocol-view') handlers.view(data.join('\n'))
          }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    } catch { /* Reconnect with the same product and host identity. */ }
    if (!controller.signal.aborted) { handlers.error(); timer = setTimeout(() => { void run() }, 1500) }
  }
  void run()
  return { close() { controller.abort(); if (timer !== undefined) clearTimeout(timer) } }
}
