import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runApplicationCli } from '@anybox/application-api/cli'
import { harnessCliRegistration } from '../dist/cli/registration.js'
import { createStandaloneHarnessServer } from '../dist/server.js'
import { parseHarnessServerConfig } from '../dist/server-config.js'

async function fixture(t, model, releaseModel = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-cli-server-'))
  let server
  t.after(async () => { releaseModel(); try { await server?.close() } finally { await rm(directory, { recursive: true, force: true }) } })
  const secrets = new Map()
  const config = parseHarnessServerConfig({ ANYBOX_HARNESS_DATABASE: join(directory, 'harness.sqlite'), ANYBOX_MODELS_DATABASE: join(directory, 'models.sqlite'), ANYBOX_LLM_BASE_URL: 'http://127.0.0.1:9' })
  server = await createStandaloneHarnessServer(config, { projectDirectoryHome: directory, models: {
    catalogAutoRefresh: false, catalogFetch: async () => { throw new Error('Network forbidden in CLI tests') },
    readLegacyCredential: async () => 'fake-model-key', fetch: model,
    openEntry(namespace, id) { const key = namespace + ':' + id; return {
      getPassword: async () => secrets.get(key), setPassword: async value => { secrets.set(key, value) }, deleteCredential: async () => secrets.delete(key),
    } },
  } })
  await server.api.setAgentTools('assistant', { toolIds: [], expectedRevision: 0 })
  const issued = await server.access.issue('CLI test')
  const request = async (path, body) => {
    const response = await fetch(server.url + '/api/v1/apps/agent' + path, { method: body ? 'POST' : 'GET', headers: {
      Authorization: `Bearer ${issued.token}`, 'X-Anybox-Instance-Id': server.instance.instanceId, 'Content-Type': 'application/json',
    }, ...(body ? { body: JSON.stringify(body) } : {}) })
    assert.equal(response.status, 200); return response.json()
  }
  const project = await request('/projects', { path: directory })
  const call = async (args, input = '', signal = new AbortController().signal) => {
    let stdout = '', stderr = ''
    const code = await runApplicationCli(['harness', ...args, '--json'], [harnessCliRegistration], {
      stdin: (async function* () { yield input })(), stdout: async text => { stdout += text }, stderr: async text => { stderr += text },
      cwd: directory, env: { ANYBOX_HARNESS_CLI_CONFIG: join(directory, 'cli', 'targets.json') }, signal,
    }, { version: 'test' })
    assert.ok(!(stdout + stderr).includes(issued.token))
    return { code, stdout, stderr, rows: stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
  }
  assert.equal((await call(['target', 'add', 'test', '--endpoint', server.url, '--token-stdin'], issued.token + '\n')).code, 0)
  return { server, project, call, issued }
}
const successfulModel = async () => new Response('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"CLI answer"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })

test('Harness CLI integrates target, read commands, sessions, idempotent runs and observation over temporary HTTP/SSE', { skip: process.platform === 'win32' }, async t => {
  let modelCalls = 0
  const f = await fixture(t, async (...args) => { modelCalls++; return successfulModel(...args) })
  for (const args of [['target', 'check'], ['agents', 'list'], ['models', 'list'], ['projects', 'list']]) assert.equal((await f.call(args)).code, 0)
  const created = await f.call(['session', 'create', '--project', f.project.id, '--agent', 'assistant'])
  assert.equal(created.code, 0); const sessionId = created.rows[0].data.id
  assert.equal((await f.call(['session', 'list', '--project', f.project.id])).rows[0].data[0].id, sessionId)
  assert.equal((await f.call(['session', 'show', sessionId])).code, 0)
  const args = ['run', 'start', sessionId, '--parent', 'root', '--request-id', 'cli-first', '--stdin']
  const first = await f.call(args, 'Hello'), repeated = await f.call(args, 'Hello')
  assert.equal(first.code, 0); assert.equal(repeated.code, 0); assert.equal(modelCalls, 1)
  const run = first.rows.at(-1).data
  assert.equal(run.status, 'completed'); assert.equal(run.output, 'CLI answer'); assert.ok(run.resultNodeId)
  assert.equal((await f.call(['run', 'find', sessionId, '--request-id', 'cli-first'])).rows[0].data.id, run.id)
  assert.equal((await f.call(['run', 'show', run.id])).code, 0)
  assert.equal((await f.call(['run', 'watch', run.id])).code, 0)
  const branch = await f.call(['run', 'start', sessionId, '--parent', run.resultNodeId, '--request-id', 'cli-child', '--input', 'Again', '--detach'])
  assert.equal(branch.code, 0); const child = branch.rows.at(-1).data
  assert.equal(child.history.parentNodeId, run.resultNodeId)
  assert.equal((await f.call(['run', 'watch', child.id])).code, 0)
  await f.server.access.revoke(f.issued.record.id)
  assert.equal((await f.call(['agents', 'list'])).code, 3)
})

test('Harness CLI explicit cancellation observes actual model exit without cancel-on-disconnect', { skip: process.platform === 'win32' }, async t => {
  let entered, release
  const modelEntered = new Promise(resolve => { entered = resolve })
  const modelRelease = new Promise(resolve => { release = resolve })
  const f = await fixture(t, async (_url, init) => {
    entered()
    if (!init.signal.aborted) await new Promise(resolve => init.signal.addEventListener('abort', resolve, { once: true }))
    await modelRelease; throw new DOMException('Cancelled', 'AbortError')
  }, () => release())
  const session = (await f.call(['session', 'create', '--project', f.project.id, '--agent', 'assistant'])).rows[0].data
  const started = await f.call(['run', 'start', session.id, '--parent', 'root', '--request-id', 'cli-cancel', '--input', 'Wait', '--detach'])
  assert.equal(started.code, 0); const runId = started.rows.at(-1).data.id
  await modelEntered
  assert.equal((await f.call(['run', 'show', runId])).rows[0].data.status, 'running')
  assert.equal((await f.call(['run', 'cancel', runId])).code, 0)
  release()
  const ended = await f.call(['run', 'watch', runId])
  assert.equal(ended.code, 8); assert.equal(ended.rows.at(-1).data.status, 'cancelled')
})

test('Harness CLI consumes live SSE and disconnects observation without cancelling the accepted run', { skip: process.platform === 'win32' }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const f = await fixture(t, async () => { entered.resolve(); await release.promise; return successfulModel() }, () => release.resolve())
  const session = (await f.call(['session', 'create', '--project', f.project.id, '--agent', 'assistant'])).rows[0].data
  const started = await f.call(['run', 'start', session.id, '--parent', 'root', '--request-id', 'cli-live-sse', '--input', 'Wait for observation', '--detach'])
  assert.equal(started.code, 0)
  const runId = started.rows.at(-1).data.id
  await entered.promise

  const received = Promise.withResolvers(), closed = Promise.withResolvers()
  const fetchHttp = globalThis.fetch
  let subscriptions = 0
  t.mock.method(globalThis, 'fetch', async (...args) => {
    const response = await fetchHttp(...args)
    if (!String(args[0]).startsWith(f.server.url + '/api/v1/apps/agent/changes?')) return response
    assert.match(response.headers.get('content-type'), /^text\/event-stream/)
    subscriptions++
    const reader = response.body.getReader()
    // Forward bytes from the real socket; reaching this gate proves a live SSE stream was read.
    return new Response(new ReadableStream({
      async pull(controller) {
        try {
          const next = await reader.read()
          if (next.done) { closed.resolve(); controller.close(); return }
          controller.enqueue(next.value)
          received.resolve()
        } catch (error) { closed.resolve(); controller.error(error) }
      },
      async cancel(reason) { try { await reader.cancel(reason) } finally { closed.resolve() } },
    }), { status: response.status, headers: response.headers })
  })
  const observing = new AbortController()
  const watched = f.call(['run', 'watch', runId], '', observing.signal)
  await Promise.race([received.promise, watched.then(() => { throw new Error('Observation ended before receiving live SSE') })])
  observing.abort()
  assert.equal((await watched).code, 130)
  await closed.promise
  assert.equal(subscriptions, 1)
  assert.equal((await f.call(['run', 'show', runId])).rows[0].data.status, 'running')

  release.resolve()
  const completed = await f.call(['run', 'watch', runId])
  assert.equal(completed.code, 0)
  assert.equal(completed.rows.at(-1).data.status, 'completed')
  assert.equal(completed.rows.at(-1).data.output, 'CLI answer')
})
