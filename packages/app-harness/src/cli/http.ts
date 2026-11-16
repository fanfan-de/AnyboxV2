import { cliExit, cliFailure, isCliObject } from '@anybox/application-api/cli'
import type { CliJson } from '@anybox/application-api/cli'
import type { HarnessCliTarget } from './config.js'

export function redactCliData(value: CliJson, token: string): CliJson {
  const redact = (text: string) => text.split(token).join('[REDACTED]')
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map(item => redactCliData(item, token))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redactCliData(item, token)]))
  return value
}
export const applicationBase = '/api/v1/apps/agent'
export const segment = (value: string) => {
  if (!value || value.length > 1024 || value === '.' || value === '..' || /[\0-\x1f\x7f]/.test(value)) throw cliFailure('invalid-id', 'Invalid resource identity', cliExit.usage)
  return encodeURIComponent(value)
}
export function createHarnessCliHttp(target: HarnessCliTarget, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  const headers = { Authorization: `Bearer ${target.token}`, 'X-Anybox-Instance-Id': target.instanceId }
  async function open(path: string, body?: CliJson, requestSignal = signal): Promise<Response> {
    const write = body !== undefined
    try {
      const response = await fetcher(target.endpoint + path, { method: write ? 'POST' : 'GET',
        headers: { ...headers, ...(write ? { 'Content-Type': 'application/json' } : {}) },
        ...(write ? { body: JSON.stringify(body) } : {}), redirect: 'manual', signal: requestSignal })
      const responseInstance = response.headers.get('x-anybox-instance-id')
      if (target.instanceId && responseInstance && responseInstance !== target.instanceId) {
        await response.body?.cancel()
        throw cliFailure('instance-mismatch', 'Server identity changed; no request is retried', cliExit.conflict)
      }
      if (!response.ok) {
        await response.body?.cancel()
        const code = response.status === 401 || response.status === 403 ? cliExit.authentication
          : response.status === 404 ? cliExit.notFound : response.status === 409 ? cliExit.conflict
          : response.status >= 500 || response.status < 400 || response.status === 408 || response.status === 429 ? cliExit.unavailable : cliExit.usage
        // The remote body may contain credentials or arbitrary text; never log it.
        throw cliFailure('http-rejected', `Server rejected the request (HTTP ${response.status})`, code)
      }
      return response
    } catch (error) {
      if (error instanceof Error && 'cliFailure' in error) throw error
      if (signal.aborted) throw cliFailure('cancelled', 'CLI invocation cancelled; accepted runs continue on the server', cliExit.cancelled)
      throw cliFailure(write ? 'unknown-outcome' : 'server-unavailable', write
        ? 'The server may have accepted this request; no write was retried. For run start, query run find with the original request-id.'
        : 'Cannot read the configured server', write ? cliExit.unknownOutcome : cliExit.unavailable)
    }
  }
  async function request(path: string, body?: CliJson): Promise<CliJson> {
    if (body !== undefined && Buffer.byteLength(JSON.stringify(body)) > 65_536) throw cliFailure('request-too-large', 'JSON request exceeds the server limit of 65536 bytes', cliExit.usage)
    const response = await open(path, body, AbortSignal.any([signal, AbortSignal.timeout(15000)]))
    const reader = response.body?.getReader()
    try {
      if (!reader) throw new Error()
      const chunks: Uint8Array[] = []; let size = 0
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.byteLength
        if (size > 8 * 1024 * 1024) throw new Error()
        chunks.push(next.value)
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as CliJson
    } catch {
      if (signal.aborted) throw cliFailure('cancelled', 'CLI invocation cancelled', cliExit.cancelled)
      throw cliFailure(body === undefined ? 'invalid-response' : 'unknown-outcome', body === undefined
        ? 'Server returned an invalid or oversized JSON response' : 'Write response was lost or invalid; query the original request before taking further action', body === undefined ? cliExit.unavailable : cliExit.unknownOutcome)
    } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock() }
  }
  async function check() {
    const identity = await request('/api/v1/instance')
    if (!isCliObject(identity) || typeof identity.instanceId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(identity.instanceId)) throw cliFailure('invalid-instance', 'Server did not provide a valid instance identity', cliExit.unavailable)
    if (target.instanceId && identity.instanceId !== target.instanceId) throw cliFailure('instance-mismatch', 'Server identity changed; remove and explicitly re-add this target', cliExit.conflict)
    return identity.instanceId
  }
  return { request, check, open }
}
