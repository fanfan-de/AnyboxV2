import { mcpError } from './contracts.js'
import { createMcpClient, parseMessage, responseMessage, wireLimit } from './protocol.js'
import type { McpClient, McpReply } from './protocol.js'

export type McpHttpClient = McpClient

async function readReply(response: Response, id: string): Promise<McpReply> {
  const media = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  const reader = response.body?.getReader()
  if (!reader) throw mcpError('mcp-invalid-response', 502)
  let size = 0
  let buffer = ''
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    if (!response.ok || media !== 'text/event-stream' && media !== 'application/json') {
      throw mcpError(response.status === 401 || response.status === 403 ? 'mcp-authentication-required' : 'mcp-http-failed', 502)
    }
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > wireLimit) throw mcpError('mcp-response-too-large', 502)
      buffer += decoder.decode(chunk.value, { stream: true })
      if (media === 'application/json') continue
      // A POST stream may send notifications before its correlated reply.
      let delimiter: RegExpExecArray | null
      while ((delimiter = /(?:\r\n|\n)(?:\r\n|\n)|\r\r/.exec(buffer))) {
        const event = buffer.slice(0, delimiter.index)
        buffer = buffer.slice(delimiter.index + delimiter[0].length)
        const data = event.split(/\r\n|\n|\r/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
        if (!data) continue
        const reply = responseMessage(parseMessage(data), id)
        if (reply) return reply
      }
    }
    if (media === 'application/json') {
      const reply = responseMessage(parseMessage(buffer + decoder.decode()), id)
      if (reply) return reply
    }
    throw mcpError('mcp-incomplete-response', 502)
  } finally {
    try { await reader.cancel() } catch { /* The stream may have been aborted while reading. */ }
    reader.releaseLock()
  }
}

export function createMcpHttpClient(endpoint: string, fetchRequest: typeof fetch, timeoutMs: number): McpHttpClient {
  let version: string | undefined
  let session: string | undefined
  let closing: Promise<void> | undefined
  const send = (message: object, signal: AbortSignal) => fetchRequest(endpoint, {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json',
      ...(version ? { 'mcp-protocol-version': version } : {}), ...(session ? { 'mcp-session-id': session } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', ...message }), signal, redirect: 'error',
  })
  const notify = async (method: string, params: object | undefined, signal: AbortSignal) => {
    const response = await send({ method, ...(params ? { params } : {}) }, signal)
    await response.body?.cancel()
    if (response.status !== 202) throw mcpError('mcp-notification-failed', 502)
  }
  const request = async (id: string, method: string, params: object, signal: AbortSignal) => {
    const response = await send({ id, method, params }, signal)
    if (method === 'initialize') {
      const offered = response.headers.get('mcp-session-id')
      if (offered && /^[!-~]{1,512}$/.test(offered)) session = offered
      else if (offered !== null) {
        await response.body?.cancel()
        throw mcpError('mcp-invalid-session', 502)
      }
    }
    return readReply(response, id)
  }
  return createMcpClient({
    request, notify,
    setVersion(value) { version = value },
    close() {
      return closing ??= (async () => {
        if (!session) return
        try {
          const response = await fetchRequest(endpoint, { method: 'DELETE', signal: AbortSignal.timeout(Math.min(1000, timeoutMs)),
            headers: { 'mcp-session-id': session, ...(version ? { 'mcp-protocol-version': version } : {}) }, redirect: 'error' })
          await response.body?.cancel()
        } catch { /* Session retirement cannot prove any individual invocation exited. */ }
      })()
    },
  }, timeoutMs)
}
