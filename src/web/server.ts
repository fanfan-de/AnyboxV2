import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import type { Run, Session } from '../run/domain.js'
import type { RunInput } from '../run/domain.js'
import { LLMFailure } from '../llm/port.js'
import { CredentialFailure } from '../credentials/port.js'
import { UnmanagedCredentialError } from '../credentials/settings.js'
import type { ManagedCredentialStatus } from '../credentials/settings.js'

export interface WebCommands {
  listAgents(): readonly { readonly id: string }[]
  createSession(agentId: string): Session
  getSession(id: string): Session | undefined
  startRun(input: RunInput): Run
  getRun(id: string): Run | undefined
  cancelRun(id: string): Run | undefined
  listCredentials(): Promise<readonly ManagedCredentialStatus[]>
  saveCredential(id: string, secret: string): Promise<ManagedCredentialStatus>
  deleteCredential(id: string): Promise<ManagedCredentialStatus>
}

export interface WebServer {
  readonly url: string
  close(): Promise<void>
}

interface HttpFailure extends Error {
  readonly status: number
  readonly code: string
}

function failure(status: number, code: string): HttpFailure {
  return Object.assign(new Error(code), { status, code })
}

function isFailure(error: unknown): error is HttpFailure {
  return error instanceof Error && 'status' in error && 'code' in error
}

function knownFailure(error: unknown): HttpFailure {
  if (isFailure(error)) return error
  if (error instanceof URIError) return failure(400, 'invalid-input')
  if (error instanceof TypeError) return failure(400, 'invalid-input')
  if (error instanceof LLMFailure) return failure(503, 'service-unavailable')
  if (error instanceof CredentialFailure) return failure(503, 'credential-unavailable')
  if (error instanceof UnmanagedCredentialError) return failure(404, 'not-found')
  if (error instanceof Error) {
    if (/^unknown (agent|session) /.test(error.message)) return failure(404, 'not-found')
    if (/idempotency key already used|session already has an active run/.test(error.message)) {
      return failure(409, 'conflict')
    }
    if (/service is unavailable|harness is closing|service is closing/.test(error.message)) {
      return failure(503, 'service-unavailable')
    }
  }
  return failure(500, 'internal-error')
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

function sessionView(session: Session): object {
  return {
    id: session.id, agentId: session.agentId, createdAt: session.createdAt,
    turns: session.turns.map(turn => ({ input: turn.input, output: turn.output })),
  }
}

function runView(run: Run): object {
  return {
    id: run.id, sessionId: run.sessionId, input: run.input, status: run.status,
    createdAt: run.createdAt, updatedAt: run.updatedAt,
    ...(run.output === undefined ? {} : { output: run.output }),
    ...(run.error === undefined ? {} : { error: run.error }),
    ...(run.errorCategory === undefined ? {} : { errorCategory: run.errorCategory }),
  }
}

async function requestObject(request: IncomingMessage, fields: readonly string[]): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    throw failure(415, 'json-required')
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += value.length
    if (bytes > 65_536) throw failure(413, 'request-too-large')
    chunks.push(value)
  }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw failure(400, 'invalid-json') }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !fields.includes(key))) throw failure(400, 'invalid-input')
  return value as Record<string, unknown>
}

const assets = new Map([
  ['/', { file: fileURLToPath(new URL('../../web/index.html', import.meta.url)), type: 'text/html; charset=utf-8' }],
  ['/style.css', { file: fileURLToPath(new URL('../../web/style.css', import.meta.url)), type: 'text/css; charset=utf-8' }],
  ['/client.js', { file: fileURLToPath(new URL('./client.js', import.meta.url)), type: 'text/javascript; charset=utf-8' }],
])

/** Hosts the public browser contract, including registered credential status and mutations without raw reads. */
export async function startWebServer(commands: WebCommands, port = 0): Promise<WebServer> {
  let origin = ''
  let closing = false
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'")
    void (async () => {
      if (closing) throw failure(503, 'service-unavailable')
      if (request.headers.host !== new URL(origin).host) throw failure(403, 'forbidden-host')
      const method = request.method ?? 'GET'
      if (method === 'POST' && request.headers.origin !== origin) throw failure(403, 'forbidden-origin')
      const url = new URL(request.url ?? '/', origin)
      if (url.origin !== origin) throw failure(403, 'forbidden-host')
      const path = url.pathname
      if (method === 'GET' && assets.has(path)) {
        const asset = assets.get(path)!
        const content = await readFile(asset.file)
        response.writeHead(200, { 'Content-Type': asset.type })
        response.end(content)
        return
      }
      if (method === 'GET' && path === '/api/v1/agents') {
        json(response, 200, commands.listAgents())
        return
      }
      if (method === 'GET' && path === '/api/v1/credentials') {
        json(response, 200, await commands.listCredentials())
        return
      }
      const credentialMatch = /^\/api\/v1\/credentials\/([^/]+)$/.exec(path)
      if (method === 'POST' && credentialMatch) {
        const body = await requestObject(request, ['key'])
        if (typeof body.key !== 'string' || !body.key.trim()) throw failure(400, 'invalid-input')
        json(response, 200, await commands.saveCredential(decodeURIComponent(credentialMatch[1]), body.key))
        return
      }
      const credentialDeleteMatch = /^\/api\/v1\/credentials\/([^/]+)\/delete$/.exec(path)
      if (method === 'POST' && credentialDeleteMatch) {
        await requestObject(request, [])
        json(response, 200, await commands.deleteCredential(decodeURIComponent(credentialDeleteMatch[1])))
        return
      }
      if (method === 'POST' && path === '/api/v1/sessions') {
        const body = await requestObject(request, ['agentId'])
        json(response, 200, sessionView(commands.createSession(body.agentId as string)))
        return
      }
      const sessionMatch = /^\/api\/v1\/sessions\/([^/]+)$/.exec(path)
      if (method === 'GET' && sessionMatch) {
        const session = commands.getSession(decodeURIComponent(sessionMatch[1]))
        if (!session) throw failure(404, 'not-found')
        json(response, 200, sessionView(session))
        return
      }
      const createRunMatch = /^\/api\/v1\/sessions\/([^/]+)\/runs$/.exec(path)
      if (method === 'POST' && createRunMatch) {
        const body = await requestObject(request, ['input', 'idempotencyKey'])
        const run = commands.startRun({
          sessionId: decodeURIComponent(createRunMatch[1]),
          input: body.input as string,
          idempotencyKey: body.idempotencyKey as string,
        })
        json(response, 200, runView(run))
        return
      }
      const runMatch = /^\/api\/v1\/runs\/([^/]+)$/.exec(path)
      if (method === 'GET' && runMatch) {
        const run = commands.getRun(decodeURIComponent(runMatch[1]))
        if (!run) throw failure(404, 'not-found')
        json(response, 200, runView(run))
        return
      }
      const cancelMatch = /^\/api\/v1\/runs\/([^/]+)\/cancel$/.exec(path)
      if (method === 'POST' && cancelMatch) {
        const body = await requestObject(request, [])
        void body
        const run = commands.cancelRun(decodeURIComponent(cancelMatch[1]))
        if (!run) throw failure(404, 'not-found')
        json(response, 200, runView(run))
        return
      }
      throw failure(404, 'not-found')
    })().catch(error => {
      const safe = knownFailure(error)
      if (!response.headersSent) json(response, safe.status, { error: { code: safe.code } })
      else response.destroy()
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
  } catch (error) {
    server.close()
    throw error
  }
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('web server has no TCP address')
  origin = `http://127.0.0.1:${address.port}`
  let shutdown: Promise<void> | undefined
  return {
    url: origin,
    close() {
      if (shutdown) return shutdown
      closing = true
      shutdown = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      return shutdown
    },
  }
}
