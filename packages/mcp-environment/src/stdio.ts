import { isAbsolute } from 'node:path'
import { processRuntimeAvailable, spawnManagedProcess } from '@anybox/computer-tools/platform/process-runtime'
import { mcpError, record } from './contracts.js'
import { createMcpClient, parseMessage, responseMessage, wireLimit } from './protocol.js'
import type { McpClient, McpReply } from './protocol.js'

const inheritedKeys = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP',
  'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME'])
const eofGraceMs = 250
const terminationGraceMs = 1_000
const maxPendingRequests = 64

interface PendingRequest {
  receive(reply: McpReply): void
  reject(error: unknown): void
}

export function createMcpStdioClient(config: { command: string; args: readonly string[]; cwd: string }, timeoutMs: number): McpClient {
  if (!isAbsolute(config.command) || !isAbsolute(config.cwd)) throw mcpError('mcp-invalid-stdio-config', 400)
  if (!processRuntimeAvailable()) throw mcpError('mcp-stdio-unavailable', 503)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => inheritedKeys.has(key.toUpperCase())))
  const child = spawnManagedProcess({ executable: config.command, args: config.args, cwd: config.cwd,
    env, stdin: 'pipe', terminationGraceMs })
  const pending = new Map<string, PendingRequest>()
  let stopped: Error | undefined
  let closing: Promise<void> | undefined

  const stop = (reason: Error) => {
    stopped ??= reason
    for (const entry of pending.values()) entry.reject(stopped)
  }
  const close = () => {
    if (closing) return closing
    stop(mcpError('mcp-stdio-closed', 502))
    // Ending stdin allows a cooperative server to exit. The native supervisor
    // escalates against the owned tree if it remains alive.
    const timer = setTimeout(() => child.terminate(), eofGraceMs)
    closing = child.done.catch(() => { throw mcpError('mcp-stdio-exit-unknown', 503, 'cleanup-failure') })
      .finally(() => clearTimeout(timer))
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end()
    return closing
  }
  const protocolFailure = (reason: Error = mcpError('mcp-invalid-response', 502)) => {
    stop(reason)
    void close().catch(() => {})
  }

  const write = async (message: object, signal: AbortSignal) => {
    signal.throwIfAborted()
    if (stopped) throw stopped
    const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
    if (bytes.length > wireLimit || child.stdin.writableLength + bytes.length > wireLimit) {
      throw mcpError('mcp-stdio-input-too-large', 502)
    }
    await new Promise<void>((resolve, reject) => {
      const aborted = () => reject(signal.reason)
      signal.addEventListener('abort', aborted, { once: true })
      try {
        child.stdin.write(bytes, error => {
          signal.removeEventListener('abort', aborted)
          if (error) reject(mcpError('mcp-stdio-write-failed', 502))
          else resolve()
        })
      } catch {
        signal.removeEventListener('abort', aborted)
        reject(mcpError('mcp-stdio-write-failed', 502))
      }
    })
  }

  const request = async (id: string, method: string, params: object, signal: AbortSignal): Promise<McpReply> => {
    signal.throwIfAborted()
    if (stopped) throw stopped
    if (pending.size >= maxPendingRequests || pending.has(id)) throw mcpError('mcp-stdio-request-unavailable', 502)
    return new Promise<McpReply>((resolve, reject) => {
      const finish = () => {
        signal.removeEventListener('abort', aborted)
        if (pending.get(id) === entry) pending.delete(id)
      }
      const entry: PendingRequest = {
        receive(reply) { finish(); resolve(reply) },
        reject(error) { finish(); reject(error) },
      }
      const aborted = () => entry.reject(signal.reason)
      pending.set(id, entry)
      signal.addEventListener('abort', aborted, { once: true })
      void write({ id, method, params }, signal).catch(error => entry.reject(error))
    })
  }

  const receive = (message: unknown) => {
    if (!record(message) || message.jsonrpc !== '2.0') throw mcpError('mcp-invalid-response', 502)
    const id = message.id
    if (Object.hasOwn(message, 'method') && Object.hasOwn(message, 'id')) {
      if (typeof message.method !== 'string' || (typeof id !== 'string' && !Number.isSafeInteger(id)) ||
        Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')) throw mcpError('mcp-invalid-response', 502)
      // Ping is permitted before and after initialization. No other
      // server-initiated feature was negotiated by this client.
      const reply = message.method === 'ping' ? { id, result: {} } :
        { id, error: { code: -32601, message: 'Method not found' } }
      void write(reply, AbortSignal.timeout(Math.min(1000, timeoutMs))).catch(() => protocolFailure())
      return
    }
    if (!Object.hasOwn(message, 'method') && typeof id !== 'string') throw mcpError('mcp-invalid-response', 502)
    const reply = responseMessage(message, typeof id === 'string' ? id : '')
    // An ordinary reply can race a cancelled request. Only a still-live
    // correlation ID can deliver a result.
    if (reply && typeof id === 'string') pending.get(id)?.receive(reply)
  }

  const decoder = new TextDecoder('utf-8', { fatal: true })
  const fragments: Buffer[] = []
  let buffered = 0
  child.stdout.on('data', (chunk: Buffer) => {
    if (stopped) return
    try {
      let start = 0
      while (start < chunk.length) {
        const newline = chunk.indexOf(0x0a, start)
        const end = newline === -1 ? chunk.length : newline
        const bytes = chunk.subarray(start, end)
        buffered += bytes.length
        if (buffered > wireLimit || child.outputTruncated) throw mcpError('mcp-response-too-large', 502)
        if (bytes.length) fragments.push(bytes)
        if (newline === -1) break
        receive(parseMessage(decoder.decode(Buffer.concat(fragments, buffered))))
        fragments.length = 0
        buffered = 0
        start = newline + 1
      }
    } catch (error) {
      fragments.length = 0
      buffered = 0
      protocolFailure(error instanceof Error && error.name === 'McpEnvironmentError' ? error : undefined)
    }
  })
  child.stdout.once('error', () => protocolFailure(mcpError('mcp-stdio-read-failed', 502)))
  child.stderr.resume()
  // The supervisor's `done` additionally covers the descendant tree and its
  // pipes, including when the direct executable exits or never launched.
  void child.done.then(
    () => stop(mcpError('mcp-stdio-exited', 502)),
    () => stop(mcpError('mcp-stdio-exit-unknown', 503, 'cleanup-failure')),
  )

  return createMcpClient({
    request,
    notify: (method, params, signal) => write({ method, ...(params ? { params } : {}) }, signal),
    close,
  }, timeoutMs)
}
