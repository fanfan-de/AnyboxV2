import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ApplicationPackageRuntimeContext } from '@anybox/application-api/node'
import { failure } from '@anybox/application-api/node'
import { requestBinding } from './connection-proxy.js'
import type { LocalExecutionDescription, LocalExecutionResponse, LocalExecutionChunk } from '../local-execution/protocol.js'

export type LocalChannel = NonNullable<ApplicationPackageRuntimeContext['channel']>
const validInstance = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value)
const transportFailure = (error: unknown): never => {
  if (error && typeof error === 'object' && 'status' in error) throw error
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  throw failure(code === 'instance-mismatch' ? 409 : 503, code === 'instance-mismatch' ? code : 'local-execution-unavailable')
}
export async function describeLocalExecution(channel: LocalChannel, signal: AbortSignal): Promise<LocalExecutionDescription> {
  try {
    const value = await channel.request({ type: 'describe' }, signal) as LocalExecutionDescription
    if (!value || !validInstance(value.instanceId) || typeof value.name !== 'string' || !Array.isArray(value.capabilities) || value.capabilities.some(item => typeof item !== 'string')) throw failure(502, 'invalid-local-response')
    return value
  } catch (error) { return transportFailure(error) }
}
async function requestBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') throw failure(415, 'json-required')
  const chunks: Buffer[] = []; let size = 0
  for await (const part of request) {
    const chunk = Buffer.from(part); size += chunk.length
    if (size > 512 * 1024) throw failure(413, 'request-too-large')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw failure(400, 'invalid-json') }
}
/** Application-owned framing over the host's opaque channel. No device connection or credential is involved. */
export async function forwardLocalExecutionRequest(channel: LocalChannel, path: string, query: string, request: IncomingMessage, response: ServerResponse, signal: AbortSignal): Promise<void> {
  const search = new URLSearchParams(query), binding = requestBinding(request, search)
  if (binding.productId !== undefined && binding.productId !== 'claude-agent') throw failure(403, 'product-mismatch')
  if (binding.revision !== undefined && binding.revision !== 1) throw failure(409, 'connection-changed')
  const suffix = search.toString(), body = request.method === 'POST' ? await requestBody(request) : undefined
  const instanceId = binding.instance ?? (await describeLocalExecution(channel, signal)).instanceId
  const requestId = randomUUID(), observer = new AbortController()
  let opened: LocalExecutionResponse | undefined
  let observation: Promise<unknown> | undefined, reserved = false
  try {
    const reservation = await channel.request({ type: 'reserve', requestId, instanceId }, signal) as { instanceId?: string; requestId?: string; reserved?: boolean }
    if (reservation?.instanceId !== instanceId || reservation.requestId !== requestId || reservation.reserved !== true) throw failure(502, 'invalid-local-response')
    reserved = true
    // Attach the lifetime before opening HTTP resources. The application waits for this
    // observer even if its opening request reaches the peer first.
    observation = channel.request({ type: 'watch', requestId, instanceId }, AbortSignal.any([signal, observer.signal])).catch(() => {
      if (!observer.signal.aborted && !signal.aborted) response.destroy()
    })
    opened = await channel.request({ type: 'request', requestId, reserved: true, instanceId, method: request.method ?? 'GET', path: path + (suffix ? `?${suffix}` : ''),
      ...(body === undefined ? {} : { body }) }, signal) as LocalExecutionResponse
    if (!opened || !validInstance(opened.instanceId) || typeof opened.requestId !== 'string' || !opened.requestId || !Number.isInteger(opened.status) || opened.status < 100 || opened.status > 599 || !opened.headers || typeof opened.headers !== 'object') throw failure(502, 'invalid-local-response')
    if (opened.requestId !== requestId || opened.instanceId !== instanceId) throw failure(409, 'instance-mismatch')
    if (binding.instance !== undefined && opened.instanceId !== binding.instance) throw failure(409, 'instance-mismatch')
    response.statusCode = opened.status
    for (const key of ['content-type', 'content-length', 'cache-control', 'cross-origin-resource-policy']) {
      const value = opened.headers[key]; if (typeof value === 'string') response.setHeader(key, value)
    }
    response.flushHeaders()
    let frame: LocalExecutionChunk = opened
    while (true) {
      if (!frame || frame.instanceId !== opened.instanceId || typeof frame.chunk !== 'string' || frame.chunk.length > 87384 || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.chunk) || typeof frame.done !== 'boolean') throw failure(502, 'invalid-local-response')
      const chunk = Buffer.from(frame.chunk, 'base64')
      if (chunk.length > 65536) throw failure(502, 'invalid-local-response')
      if (chunk.length && !response.write(chunk)) await once(response, 'drain', { signal })
      if (frame.done) break
      frame = await channel.request({ type: 'read', requestId: opened.requestId, instanceId: opened.instanceId }, signal) as LocalExecutionChunk
    }
    response.end()
  } catch (error) { transportFailure(error) }
  finally {
    observer.abort()
    await observation
    if (reserved) {
      try { await channel.request({ type: 'close', requestId, instanceId }, new AbortController().signal) } catch { /* The joined observer already owns actual stream exit. */ }
    }
  }
}
