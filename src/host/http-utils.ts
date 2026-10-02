import type { IncomingMessage, ServerResponse } from 'node:http'
export interface HttpFailure extends Error { readonly status: number; readonly code: string }
export function failure(status: number, code: string): HttpFailure {
  return Object.assign(new Error(code), { status, code })
}
export function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}
export async function requestObject(request: IncomingMessage, fields: readonly string[], maxBytes = 65_536): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    throw failure(415, 'json-required')
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += value.length
    if (bytes > maxBytes) throw failure(413, 'request-too-large')
    chunks.push(value)
  }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw failure(400, 'invalid-json') }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !fields.includes(key))) throw failure(400, 'invalid-input')
  return value as Record<string, unknown>
}
