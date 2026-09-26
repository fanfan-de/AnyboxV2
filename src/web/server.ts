import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import type { Run, Session } from '../run/domain.js'
import type { RunInput, ConversationNode, NodePage, NodeQuery, RunQuery } from '../run/domain.js'
import type { RunEvent } from '../run/execution.js'
import type { ValidatedToolRequest } from '../run/domain.js'
import { LLMFailure } from '../llm/port.js'
import { CredentialFailure } from '../credentials/port.js'
import { UnmanagedCredentialError } from '../credentials/settings.js'
import type { ManagedCredentialStatus } from '../credentials/settings.js'
import { isProjectUnavailableError } from '../project/component.js'
import type { Project } from '../project/component.js'
import { DirectoryPickerFailure } from './directory-picker.js'
import type { PromptBinding, PromptCreateInput, PromptDocument, PromptEditInput,
  PromptSnapshot, PromptVersion } from '../prompt/domain.js'

export interface WebCommands {
  listAgents(): readonly { readonly id: string }[]
  directoryPickerSupported(): boolean
  pickProject(signal: AbortSignal): Promise<Project | null>
  listProjects(): Promise<readonly Project[]>
  createSession(projectId: string, agentId: string): Promise<Session>
  getSession(id: string): Promise<Session | undefined>
  listSessions(projectId: string): Promise<readonly Session[]>
  getNode(sessionId: string, id: string): Promise<ConversationNode | undefined>
  getNodePath(sessionId: string, id: string | null): Promise<readonly ConversationNode[]>
  listNodes(sessionId: string, parentId: string | null, query?: NodeQuery): Promise<NodePage>
  getRunByKey(sessionId: string, key: string): Promise<Run | undefined>
  waitRun(id: string, signal?: AbortSignal): Promise<Run | undefined>
  startRun(input: RunInput): Promise<Run>
  getRun(id: string): Promise<Run | undefined>
  listRuns(sessionId: string, query?: RunQuery): Promise<readonly Run[]>
  getRunEvents(id: string, afterSeq?: number): Promise<readonly RunEvent[] | undefined>
  cancelRun(id: string): Promise<Run | undefined>
  listCredentials(): Promise<readonly ManagedCredentialStatus[]>
  saveCredential(id: string, secret: string): Promise<ManagedCredentialStatus>
  deleteCredential(id: string): Promise<ManagedCredentialStatus>
  listPrompts(): readonly PromptDocument[]
  getPrompt(id: string): PromptDocument | undefined
  createPrompt(input: PromptCreateInput): Promise<PromptDocument>
  editPrompt(id: string, revision: number, patch: PromptEditInput): Promise<PromptDocument>
  publishPrompt(id: string, revision: number): Promise<PromptVersion>
  getPromptVersions(id: string): readonly PromptVersion[]
  getAgentPrompts(id: string): readonly PromptSnapshot[]
  bindPrompt(id: string, versionId: string): Promise<PromptBinding>
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
  if (isProjectUnavailableError(error)) return failure(409, 'project-unavailable')
  if (error instanceof DirectoryPickerFailure) {
    if (error.code === 'busy') return failure(409, 'picker-busy')
    if (error.code === 'unsupported') return failure(503, 'picker-unsupported')
    return failure(503, 'picker-unavailable')
  }
  if (error instanceof Error) {
    if (/^unknown (agent|session|project|prompt) /.test(error.message)) return failure(404, 'not-found')
    if (error.message === 'prompt draft revision conflict') return failure(409, 'prompt-conflict')
    if (error.message === 'prompt draft has no unpublished changes') return failure(409, 'prompt-publication-conflict')
    if (error.message === 'prompt access denied' || error.message === 'agent configuration access denied') {
      return failure(403, 'prompt-forbidden')
    }
    if ('code' in error && error.code === 'node-not-found') return failure(404, 'node-not-found')
    if ('code' in error && error.code === 'invalid-history') return failure(409, 'invalid-history')
    if (/idempotency key already used/.test(error.message)) {
      return failure(409, 'conflict')
    }
    if (/service is unavailable|harness is closing|service is closing|prompt storage is closing|agent prompt bindings are closing/.test(error.message)) {
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
    id: session.id, projectId: session.projectId, agentId: session.agentId, createdAt: session.createdAt,
  }
}

function runView(run: Run): object {
  return {
    id: run.id, sessionId: run.sessionId, input: run.input, status: run.status,
    createdAt: run.createdAt, updatedAt: run.updatedAt, revision: run.revision, history: run.history,
    ...(run.resultNodeId ? { resultNodeId: run.resultNodeId } : {}),
    ...(run.output === undefined ? {} : { output: run.output }),
    ...(run.error === undefined ? {} : { error: run.error }),
    ...(run.errorCategory === undefined ? {} : { errorCategory: run.errorCategory }),
  }
}

function promptView(document: PromptDocument): object {
  const { revision, kind, role, content } = document.draft
  return { id: document.id, name: document.name, description: document.description,
    draft: { revision, kind, role, content }, versionIds: document.versionIds,
    ...(document.publishedDraftRevision === undefined ? {} : { publishedDraftRevision: document.publishedDraftRevision }) }
}

function promptVersionView(version: PromptVersion): object {
  const { id, documentId, kind, role, content, createdAt } = version
  return { id, documentId, kind, role, content, createdAt }
}

function promptRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw failure(400, 'invalid-input')
  return value
}

function outputSummary(value: string): { readonly text: string; readonly truncated: boolean } {
  const parts: string[] = []
  let bytes = 0
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8')
    if (bytes + size > 2_048) return { text: parts.join(''), truncated: true }
    parts.push(character)
    bytes += size
  }
  return { text: value, truncated: false }
}

function toolCallView(call: ValidatedToolRequest): object {
  if (call.name === 'bash') return { id: call.id, name: call.name, command: call.arguments.command }
  const patch = outputSummary(call.arguments.patch)
  return { id: call.id, name: call.name, patch: patch.text, patchTruncated: patch.truncated }
}

function runEventView(event: RunEvent): object {
  const base = { seq: event.seq, at: event.at, kind: event.kind }
  switch (event.kind) {
    case 'model-started': return base
    case 'model-tool-calls': return { ...base, calls: event.calls.map(toolCallView) }
    case 'tool-started': return { ...base, ...toolCallView(event.call), requestId: event.call.id }
    case 'tool-observed': {
      if (event.name === 'apply_patch') return { ...base, name: event.name, requestId: event.requestId, result: event.result }
      const stdout = outputSummary(event.result.stdout)
      const stderr = outputSummary(event.result.stderr)
      return { ...base, name: event.name, requestId: event.requestId, exitCode: event.result.exitCode,
        signal: event.result.signal, stdout: stdout.text, stderr: stderr.text,
        truncated: event.result.truncated || stdout.truncated || stderr.truncated }
    }
    case 'tool-failed': return { ...base, name: event.name, requestId: event.requestId, category: event.category,
      ...(event.result ? { result: event.result } : {}) }
    case 'terminal': return { ...base, status: event.status,
      ...(event.errorCategory ? { errorCategory: event.errorCategory } : {}) }
    case 'interrupted': return { ...base, previousPhase: event.previousPhase }
  }
}

async function requestObject(request: IncomingMessage, fields: readonly string[], maxBytes = 65_536): Promise<Record<string, unknown>> {
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

function integerQuery(url: URL, key: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(key)
  const value = raw === null ? fallback : /^\d+$/.test(raw) ? Number(raw) : NaN
  if (!Number.isSafeInteger(value) || value < min || value > max) throw failure(400, 'invalid-input')
  return value
}

const assets = new Map([
  ['/', { file: fileURLToPath(new URL('../../web/index.html', import.meta.url)), type: 'text/html; charset=utf-8' }],
  ['/style.css', { file: fileURLToPath(new URL('../../web/style.css', import.meta.url)), type: 'text/css; charset=utf-8' }],
  ['/client.js', { file: fileURLToPath(new URL('./client.js', import.meta.url)), type: 'text/javascript; charset=utf-8' }],
  ['/prompt-client.js', { file: fileURLToPath(new URL('./prompt-client.js', import.meta.url)), type: 'text/javascript; charset=utf-8' }],
  ['/workspace-client.js', { file: fileURLToPath(new URL('./workspace-client.js', import.meta.url)), type: 'text/javascript; charset=utf-8' }],
  ['/workspace-layout.js', { file: fileURLToPath(new URL('./workspace-layout.js', import.meta.url)), type: 'text/javascript; charset=utf-8' }],
  ['/session-client.js', { file: fileURLToPath(new URL('./session-client.js', import.meta.url)), type: 'text/javascript; charset=utf-8' }],
  ['/tool-trace.js', { file: fileURLToPath(new URL('./tool-trace.js', import.meta.url)), type: 'text/javascript; charset=utf-8' }],
  ['/session-view.js', { file: fileURLToPath(new URL('./session-view.js', import.meta.url)), type: 'text/javascript; charset=utf-8' }],
])

/** Hosts the public browser contract, including registered credential status and mutations without raw reads. */
export async function startWebServer(commands: WebCommands, port = 0): Promise<WebServer> {
  let origin = ''
  let closing = false
  const pickerRequests = new Set<AbortController>()
  const waitRequests = new Set<() => void>()
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
      const promptFields = ['name', 'description', 'kind', 'role', 'content']
      if (path === '/api/v1/prompts' && method === 'GET') {
        json(response, 200, commands.listPrompts().map(promptView))
        return
      }
      if (path === '/api/v1/prompts' && method === 'POST') {
        const body = await requestObject(request, promptFields, 1_048_576)
        json(response, 200, promptView(await commands.createPrompt(body as unknown as PromptCreateInput)))
        return
      }
      const promptMatch = /^\/api\/v1\/prompts\/([^/]+)$/.exec(path)
      if (promptMatch && method === 'GET') {
        const document = commands.getPrompt(decodeURIComponent(promptMatch[1]))
        if (!document) throw failure(404, 'not-found')
        json(response, 200, promptView(document))
        return
      }
      if (promptMatch && method === 'POST') {
        const { expectedRevision, ...patch } = await requestObject(request, [...promptFields, 'expectedRevision'], 1_048_576)
        json(response, 200, promptView(await commands.editPrompt(decodeURIComponent(promptMatch[1]),
          promptRevision(expectedRevision), patch as PromptEditInput)))
        return
      }
      const versionsMatch = /^\/api\/v1\/prompts\/([^/]+)\/versions$/.exec(path)
      if (versionsMatch && method === 'GET') {
        json(response, 200, commands.getPromptVersions(decodeURIComponent(versionsMatch[1])).map(promptVersionView))
        return
      }
      const publishMatch = /^\/api\/v1\/prompts\/([^/]+)\/publish$/.exec(path)
      if (publishMatch && method === 'POST') {
        const body = await requestObject(request, ['expectedRevision'])
        json(response, 200, promptVersionView(await commands.publishPrompt(decodeURIComponent(publishMatch[1]),
          promptRevision(body.expectedRevision))))
        return
      }
      const agentPromptsMatch = /^\/api\/v1\/agents\/([^/]+)\/prompts$/.exec(path)
      if (agentPromptsMatch && method === 'GET') {
        json(response, 200, commands.getAgentPrompts(decodeURIComponent(agentPromptsMatch[1])))
        return
      }
      if (agentPromptsMatch && method === 'POST') {
        const body = await requestObject(request, ['versionId'])
        if (typeof body.versionId !== 'string' || !body.versionId.trim()) throw failure(400, 'invalid-input')
        const binding = await commands.bindPrompt(decodeURIComponent(agentPromptsMatch[1]), body.versionId)
        json(response, 200, { kind: binding.kind, versionId: binding.versionId })
        return
      }
      if (method === 'GET' && path === '/api/v1/projects') {
        json(response, 200, await commands.listProjects())
        return
      }
      if (method === 'GET' && path === '/api/v1/projects/picker') {
        json(response, 200, { supported: commands.directoryPickerSupported() })
        return
      }
      if (method === 'POST' && path === '/api/v1/projects/pick') {
        await requestObject(request, [])
        const controller = new AbortController()
        const disconnected = () => { if (!response.writableEnded) controller.abort() }
        response.once('close', disconnected)
        pickerRequests.add(controller)
        try { json(response, 200, await commands.pickProject(controller.signal)) }
        finally {
          pickerRequests.delete(controller)
          response.off('close', disconnected)
        }
        return
      }
      const projectSessionsMatch = /^\/api\/v1\/projects\/([^/]+)\/sessions$/.exec(path)
      if (method === 'GET' && projectSessionsMatch) {
        json(response, 200, (await commands.listSessions(decodeURIComponent(projectSessionsMatch[1]))).map(sessionView))
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
        const body = await requestObject(request, ['projectId', 'agentId'])
        json(response, 200, sessionView(await commands.createSession(body.projectId as string, body.agentId as string)))
        return
      }
      const nodesMatch = /^\/api\/v1\/sessions\/([^/]+)\/nodes$/.exec(path)
      if (method === 'GET' && nodesMatch) {
        const parent = url.searchParams.get('parentNodeId')
        if (!parent) throw failure(400, 'invalid-input')
        json(response, 200, await commands.listNodes(decodeURIComponent(nodesMatch[1]), parent === 'root' ? null : parent, {
          ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor')! } : {}),
          ...(url.searchParams.has('limit') ? { limit: integerQuery(url, 'limit', 50, 1, 100) } : {}),
        }))
        return
      }
      const nodeMatch = /^\/api\/v1\/sessions\/([^/]+)\/nodes\/([^/]+)(\/path)?$/.exec(path)
      if (method === 'GET' && nodeMatch) {
        const sessionId = decodeURIComponent(nodeMatch[1]), id = decodeURIComponent(nodeMatch[2])
        const value = nodeMatch[3] ? await commands.getNodePath(sessionId, id === 'root' ? null : id)
          : await commands.getNode(sessionId, id)
        if (!value) throw failure(404, 'node-not-found')
        json(response, 200, value)
        return
      }
      const keyMatch = /^\/api\/v1\/sessions\/([^/]+)\/runs\/by-key\/([^/]+)$/.exec(path)
      if (method === 'GET' && keyMatch) {
        const run = await commands.getRunByKey(decodeURIComponent(keyMatch[1]), decodeURIComponent(keyMatch[2]))
        if (!run) throw failure(404, 'not-found')
        json(response, 200, runView(run))
        return
      }
      const sessionRunsMatch = /^\/api\/v1\/sessions\/([^/]+)\/runs$/.exec(path)
      if (method === 'GET' && sessionRunsMatch) {
        const status = url.searchParams.get('status')
        if (status !== null && status !== 'active') throw failure(400, 'invalid-input')
        const parent = url.searchParams.get('parentNodeId')
        if (parent === '') throw failure(400, 'invalid-input')
        json(response, 200, (await commands.listRuns(decodeURIComponent(sessionRunsMatch[1]), {
          ...(status ? { active: true } : {}),
          ...(parent !== null ? { parentNodeId: parent === 'root' ? null : parent } : {}),
        })).map(runView))
        return
      }
      const sessionMatch = /^\/api\/v1\/sessions\/([^/]+)$/.exec(path)
      if (method === 'GET' && sessionMatch) {
        const session = await commands.getSession(decodeURIComponent(sessionMatch[1]))
        if (!session) throw failure(404, 'not-found')
        json(response, 200, sessionView(session))
        return
      }
      const createRunMatch = /^\/api\/v1\/sessions\/([^/]+)\/runs$/.exec(path)
      if (method === 'POST' && createRunMatch) {
        const body = await requestObject(request, ['parentNodeId', 'input', 'idempotencyKey'])
        const run = await commands.startRun({
          sessionId: decodeURIComponent(createRunMatch[1]),
          parentNodeId: body.parentNodeId as string | null,
          input: body.input as string,
          idempotencyKey: body.idempotencyKey as string,
        })
        json(response, 200, runView(run))
        return
      }
      const runMatch = /^\/api\/v1\/runs\/([^/]+)$/.exec(path)
      if (method === 'GET' && runMatch) {
        const run = await commands.getRun(decodeURIComponent(runMatch[1]))
        if (!run) throw failure(404, 'not-found')
        json(response, 200, runView(run))
        return
      }
      const runEventsMatch = /^\/api\/v1\/runs\/([^/]+)\/events$/.exec(path)
      if (method === 'GET' && runEventsMatch) {
        const events = await commands.getRunEvents(decodeURIComponent(runEventsMatch[1]), integerQuery(url, 'afterSeq', 0, 0, Number.MAX_SAFE_INTEGER))
        if (!events) throw failure(404, 'not-found')
        json(response, 200, events.map(runEventView))
        return
      }
      const waitMatch = /^\/api\/v1\/runs\/([^/]+)\/wait$/.exec(path)
      if (method === 'GET' && waitMatch) {
        const id = decodeURIComponent(waitMatch[1])
        const timeout = integerQuery(url, 'timeoutMs', 25000, 0, 25000)
        if (!await commands.getRun(id)) throw failure(404, 'not-found')
        if (closing) throw failure(503, 'service-unavailable')
        if (response.destroyed) return
        const waiter = new AbortController()
        let finish!: () => void
        const interrupted = new Promise<undefined>(resolve => { finish = () => resolve(undefined) })
        const timer = setTimeout(finish, timeout)
        response.once('close', finish)
        waitRequests.add(finish)
        try {
          const terminal = await Promise.race([commands.waitRun(id, waiter.signal), interrupted])
          if (closing || response.destroyed) {
            if (!response.destroyed) json(response, 503, { error: { code: 'service-unavailable' } })
            return
          }
          const run = terminal ?? await commands.getRun(id)
          const ended = run && run.status !== 'running' && run.status !== 'cancelling'
          json(response, 200, { done: Boolean(ended), timedOut: !ended, run: run ? runView(run) : null })
        } finally {
          waiter.abort()
          clearTimeout(timer)
          response.off('close', finish)
          waitRequests.delete(finish)
        }
        return
      }
      const cancelMatch = /^\/api\/v1\/runs\/([^/]+)\/cancel$/.exec(path)
      if (method === 'POST' && cancelMatch) {
        const body = await requestObject(request, [])
        void body
        const run = await commands.cancelRun(decodeURIComponent(cancelMatch[1]))
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
      for (const controller of pickerRequests) controller.abort()
      for (const finish of waitRequests) finish()
      shutdown = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      return shutdown
    },
  }
}
