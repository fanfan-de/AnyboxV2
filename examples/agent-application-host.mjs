/** Long-running loopback host. Process signals, HTTP and shutdown deadlines belong to this executable. */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgentApplication } from '@anybox/agent-application'
import { createSQLiteState, createMockModel } from '@anybox/agent-kernel'
import { KernelFault } from '@anybox/agent-contracts/api'

const invalid = message => new KernelFault({ code: 'INVALID_ARGUMENT', message })

function parseArguments(args) {
  const defaults = { path: resolve('.anybox/agent.sqlite'), port: 4318,
    definition: fileURLToPath(new URL('./agent-application/agent.json', import.meta.url)), once: false }
  return args.reduce((result, argument, index) => {
    if (index && ['--data', '--port', '--definition'].includes(args[index - 1])) return result
    if (argument === '--once') return { ...result, once: true }
    const value = args[index + 1]
    if (argument === '--data' && value) return { ...result, path: resolve(value) }
    if (argument === '--definition' && value) return { ...result, definition: resolve(value) }
    if (argument === '--port' && value && /^\d+$/.test(value) && Number(value) <= 65535) return { ...result, port: Number(value) }
    throw invalid('Usage: npm run start:agent -- [--data file.sqlite] [--port number] [--definition file.json] [--once]')
  }, defaults)
}

/** Pure route selection; effectful execution is handled separately. */
function route(method, url) {
  const path = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  if (method === 'GET' && path.join('/') === 'health') return { action: 'health' }
  if (method === 'GET' && path.join('/') === 'agent') return { action: 'agent' }
  if (method === 'POST' && path.join('/') === 'sessions') return { action: 'createSession' }
  if (method === 'GET' && path.join('/') === 'sessions') return { action: 'sessions' }
  if (method === 'GET' && path.length === 3 && path[0] === 'sessions' && path[2] === 'messages') return { action: 'messages', sessionId: path[1] }
  if (method === 'POST' && path.join('/') === 'tasks') return { action: 'submit' }
  if (method === 'GET' && path.join('/') === 'tasks') return { action: 'tasks' }
  if (path[0] === 'tasks' && path[1]) {
    if (method === 'GET' && path.length === 2) return { action: 'task', runId: path[1] }
    if (method === 'GET' && path.length === 3 && path[2] === 'events') return { action: 'events', runId: path[1] }
    if (method === 'POST' && path.length === 3 && path[2] === 'cancel') return { action: 'cancel', runId: path[1] }
  }
  return { action: 'missing' }
}

async function readBody(request) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw invalid('Content-Type must be application/json')
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 64 * 1024) throw new KernelFault({ code: 'LIMIT_EXCEEDED', message: 'request body exceeds 64 KiB' })
    chunks.push(chunk)
  }
  let body
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw invalid('request body must be valid JSON') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('request body must be an object')
  return body
}

const number = (url, key) => url.searchParams.has(key) ? Number(url.searchParams.get(key)) : undefined
const page = url => ({ offset: number(url, 'offset'), limit: number(url, 'limit') })
const statusForError = code => ({ INVALID_ARGUMENT: 400, NOT_FOUND: 404, CONFLICT: 409, SESSION_BUSY: 409,
  LIMIT_EXCEEDED: 413, NOT_READY: 503, CLOSED: 503, STATE_FAILED: 503, SETTLEMENT_FAILED: 503 }[code] ?? 500)
const send = (response, status, value) => {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  response.end(JSON.stringify(value))
}

async function dispatch(app, selected, url, body) {
  switch (selected.action) {
    case 'health': { const status = app.status(); return [status.ready ? 200 : 503, status] }
    case 'agent': return [200, app.describe()]
    case 'createSession': return [201, await app.sessions.create()]
    case 'sessions': return [200, await app.sessions.list(page(url))]
    case 'messages': return [200, await app.sessions.messages({ sessionId: selected.sessionId })]
    case 'submit': return [202, await app.tasks.submit(body)]
    case 'tasks': return [200, await app.tasks.list({ ...page(url), sessionId: url.searchParams.get('sessionId') ?? undefined })]
    case 'task': return [200, await app.tasks.inspect({ runId: selected.runId })]
    case 'events': return [200, await app.tasks.events({ runId: selected.runId, afterSeq: number(url, 'afterSeq'), limit: number(url, 'limit') })]
    case 'cancel': return [200, await app.tasks.cancel({ runId: selected.runId, reason: body.reason })]
    default: return [404, { error: { code: 'NOT_FOUND', message: 'route not found' } }]
  }
}

const options = parseArguments(process.argv.slice(2))
const definition = JSON.parse(await readFile(options.definition, 'utf8'))
const app = createAgentApplication({ configPath: fileURLToPath(new URL('./application/config.json', import.meta.url)),
  logger: false, definition, state: () => createSQLiteState({ path: options.path }), model: createMockModel })
let stopping = false, closing, finish
const stopped = new Promise(resolve => { finish = resolve })
const onInterrupt = () => { void stop(130) }
const onTerminate = () => { void stop(143) }
const onMessage = message => { if (message === 'close') void stop() }

function stop(code = 0) {
  if (closing) return closing
  stopping = true; process.exitCode = code
  const deadline = setTimeout(() => { console.error('Agent shutdown exceeded 5 seconds.'); process.exit(1) }, 5000)
  closing = app.close().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => {
    clearTimeout(deadline)
    process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate); process.off('message', onMessage)
    if (process.connected) process.disconnect()
    finish()
  })
  return closing
}

process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate); process.on('message', onMessage)
void app.failure.then(error => { if (!stopping) { console.error(error); void stop(1) } })
try {
  await app.start()
  if (!stopping && options.once) await stop()
  else if (!stopping) {
    const server = createServer(async (request, response) => {
      try {
        if (stopping) throw new KernelFault({ code: 'CLOSED', message: 'Agent is stopping' })
        // This local executable does not grant browser origins access to the Agent.
        if (request.headers.origin) { send(response, 403, { error: { code: 'TOOL_DENIED', message: 'browser origins are not enabled' } }); return }
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        const selected = route(request.method, url)
        const body = request.method === 'POST' ? await readBody(request) : undefined
        const [status, value] = await dispatch(app, selected, url, body)
        send(response, status, value)
      } catch (cause) {
        const error = cause instanceof KernelFault ? cause.error : { code: 'INTERNAL', message: 'request failed' }
        send(response, statusForError(error.code), { error })
      }
    })
    server.requestTimeout = 10000
    app.context.effect(() => () => new Promise((resolve, reject) => {
      server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve())
      server.closeIdleConnections()
    }), 'Agent HTTP listener')
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port, '127.0.0.1', resolve) })
    server.on('error', error => { console.error(error); void stop(1) })
    const port = server.address().port
    console.log(`Agent application ready at http://127.0.0.1:${port}; model=mock; state=${options.path}`)
    process.send?.({ type: 'ready', port, agent: app.status().agent })
  }
} catch (error) { if (!stopping) { console.error(error); await stop(1) } }
await stopped
