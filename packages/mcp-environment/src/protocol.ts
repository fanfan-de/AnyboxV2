import { randomUUID } from 'node:crypto'
import type { JsonValue } from '@anybox/tool-api'
import { maxTools, mcpError, record } from './contracts.js'

const versions = ['2025-11-25', '2025-06-18', '2025-03-26']
export const wireLimit = 1_048_576

export type McpReply = { readonly failed: true } | { readonly failed: false; readonly value: unknown }

export interface McpClient {
  discover(signal: AbortSignal): Promise<readonly unknown[]>
  call(id: string, name: string, args: Readonly<Record<string, JsonValue>>, signal: AbortSignal): Promise<McpReply>
  close(): Promise<void>
}

interface McpWire {
  request(id: string, method: string, params: object, signal: AbortSignal): Promise<McpReply>
  notify(method: string, params: object | undefined, signal: AbortSignal): Promise<void>
  setVersion?(version: string): void
  close(): Promise<void>
}

export function parseMessage(text: string): unknown {
  try { return JSON.parse(text) as unknown } catch { throw mcpError('mcp-invalid-response', 502) }
}

/** Validate and correlate an ordinary JSON-RPC reply. Notifications carry no reply. */
export function responseMessage(message: unknown, id: string | number): McpReply | undefined {
  if (!record(message) || message.jsonrpc !== '2.0') throw mcpError('mcp-invalid-response', 502)
  if (Object.hasOwn(message, 'method')) {
    if (typeof message.method === 'string' && !Object.hasOwn(message, 'id') &&
      !Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error')) return undefined
    throw mcpError('mcp-invalid-response', 502)
  }
  if (message.id !== id || Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')) {
    throw mcpError('mcp-invalid-response', 502)
  }
  if (Object.hasOwn(message, 'result')) return { failed: false, value: message.result }
  if (!record(message.error) || !Number.isSafeInteger(message.error.code) || typeof message.error.message !== 'string') {
    throw mcpError('mcp-invalid-response', 502)
  }
  return { failed: true }
}

export function createMcpClient(wire: McpWire, timeoutMs: number): McpClient {
  let initialization: Promise<void> | undefined
  const withTimeout = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  const initialize = async (signal: AbortSignal) => {
    const reply = await wire.request(randomUUID(), 'initialize', { protocolVersion: versions[0], capabilities: {},
      clientInfo: { name: 'Anybox MCP', version: '1.0.0' } }, signal)
    if (reply.failed || !record(reply.value) || typeof reply.value.protocolVersion !== 'string' ||
      !versions.includes(reply.value.protocolVersion) || !record(reply.value.serverInfo) ||
      typeof reply.value.serverInfo.name !== 'string' || typeof reply.value.serverInfo.version !== 'string' ||
      !record(reply.value.capabilities) || !record(reply.value.capabilities.tools)) throw mcpError('mcp-incompatible-server', 502)
    wire.setVersion?.(reply.value.protocolVersion)
    await wire.notify('notifications/initialized', undefined, signal)
  }
  return {
    async discover(signal) {
      const initSignal = withTimeout(signal)
      await (initialization ??= initialize(initSignal))
      const list: unknown[] = []
      const cursors = new Set<string>()
      let cursor: string | undefined
      do {
        const page = await wire.request(randomUUID(), 'tools/list', cursor ? { cursor } : {}, initSignal)
        if (page.failed || !record(page.value) || !Array.isArray(page.value.tools) ||
          page.value.tools.length > maxTools - list.length) throw mcpError('mcp-invalid-tool-list', 502)
        list.push(...page.value.tools)
        cursor = undefined
        if (page.value.nextCursor !== undefined) {
          const next = page.value.nextCursor
          if (typeof next !== 'string' || !next || next.length > 2048 || cursors.has(next) || cursors.size >= 31) {
            throw mcpError('mcp-invalid-tool-list', 502)
          }
          cursors.add(next)
          cursor = next
        }
      } while (cursor !== undefined)
      return list
    },
    async call(id, name, args, signal) {
      const callSignal = withTimeout(signal)
      callSignal.throwIfAborted()
      let notice: Promise<void> | undefined
      const cancel = () => {
        notice ??= wire.notify('notifications/cancelled', { requestId: id }, AbortSignal.timeout(Math.min(1000, timeoutMs)))
          .catch(() => {})
      }
      callSignal.addEventListener('abort', cancel, { once: true })
      try { return await wire.request(id, 'tools/call', { name, arguments: args }, callSignal) }
      finally {
        callSignal.removeEventListener('abort', cancel)
        await notice
      }
    },
    close: () => wire.close(),
  }
}
