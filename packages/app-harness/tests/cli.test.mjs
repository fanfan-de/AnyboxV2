import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, mkdir, stat, chmod, symlink, writeFile, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runApplicationCli } from '@anybox/application-api/cli'
import { harnessCliRegistration } from '../dist/cli/registration.js'
import { createHarnessCliHttp, segment } from '../dist/cli/http.js'
import { endpointOrigin, targetConfigPath, readTargets } from '../dist/cli/config.js'

const clientTest = (name, fn) => test(name, { skip: process.platform === 'win32' ? 'Private target storage awaits a Windows ACL adapter' : false }, fn)
const token = 'cli-secret-DO-NOT-LOG', identity = 'test-instance', endpoint = 'http://127.0.0.1:12345'
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'X-Anybox-Instance-Id': identity } })
async function fixture(t, handler) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-cli-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'private', 'targets.json'), requests = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const parsed = new URL(url)
    assert.equal(parsed.origin, endpoint, 'no external traffic')
    assert.equal(init.headers.Authorization, `Bearer ${token}`)
    assert.equal(init.redirect, 'manual')
    requests.push({ path: parsed.pathname + parsed.search, method: init.method, body: init.body ? JSON.parse(init.body) : undefined })
    if (parsed.pathname === '/api/v1/instance') return jsonResponse({ instanceId: identity })
    assert.equal(init.headers['X-Anybox-Instance-Id'], identity)
    return handler ? handler(parsed, init, requests) : jsonResponse([])
  })
  const controller = new AbortController()
  const call = async (args, input = '', extra = {}) => {
    let stdout = '', stderr = ''
    const io = { cwd: directory, env: { ANYBOX_HARNESS_CLI_CONFIG: path }, signal: controller.signal,
      stdin: (async function* () { yield input })(), stdout: async value => { stdout += value }, stderr: async value => { stderr += value }, ...extra }
    const code = await runApplicationCli(['harness', ...args, '--json'], [harnessCliRegistration], io, { version: 'test' })
    assert.doesNotMatch(stdout + stderr, new RegExp(token))
    return { code, stdout, stderr, rows: stdout.trim() ? stdout.trim().split('\n').map(line => JSON.parse(line)) : [], error: stderr.trim() ? JSON.parse(stderr).error : undefined }
  }
  const add = () => call(['target', 'add', 'local', '--endpoint', endpoint, '--token-stdin'], token + '\n')
  return { directory, path, requests, controller, call, add }
}

clientTest('target management uses private atomic files, fixed identity and never emits the token', async t => {
  const f = await fixture(t)
  assert.equal((await f.add()).code, 0)
  if (process.platform !== 'win32') {
    assert.equal((await stat(f.path)).mode & 0o777, 0o600)
    assert.equal((await stat(join(f.directory, 'private'))).mode & 0o777, 0o700)
  }
  const listed = await f.call(['target', 'list'])
  assert.deepEqual(listed.rows[0].data, { selected: 'local', targets: [{ name: 'local', endpoint, instanceId: identity }] })
  assert.equal((await f.call(['target', 'check'])).code, 0)
  assert.equal((await f.add()).code, 5)
  assert.equal((await f.call(['target', 'use', 'missing'])).code, 4)
  assert.equal((await f.call(['target', 'use', 'local'])).code, 0)
  assert.equal((await f.call(['target', 'remove', 'local'])).code, 0)
  assert.equal((await readTargets(f.path)).selected, null)
  assert.equal((await f.call(['agents', 'list'])).code, 4)
  assert.deepEqual(await readdir(join(f.directory, 'private')), ['targets.json'])
})

clientTest('help and completion do not read config, access credentials or send HTTP', async t => {
  const f = await fixture(t)
  for (const args of [[], ['--help'], ['target', 'add', '--help'], ['run', 'start', '--help']]) assert.equal((await f.call(args)).code, 0)
  assert.equal(f.requests.length, 0)
  assert.deepEqual(await readdir(f.directory), [])
})

clientTest('tokens only use hidden input or stdin; malformed input and insecure endpoints fail without exposure', async t => {
  const f = await fixture(t)
  assert.equal((await f.call(['target', 'add', 'local', '--endpoint', endpoint])).code, 2)
  assert.equal((await f.call(['target', 'add', 'local', '--endpoint', endpoint, '--token=' + token])).code, 2)
  assert.equal((await f.call(['target', 'add', 'local', '--endpoint', endpoint, '--token-stdin'], token + '\nextra')).code, 2)
  for (const value of ['https://user:password@example.test', 'https://example.test?token=secret', 'https://example.test/path', 'http://remote.test']) assert.throws(() => endpointOrigin(value))
  assert.equal((await f.call(['target', 'add', 'local', '--endpoint', endpoint], '', { readSecret: async prompt => { assert.match(prompt, /hidden/); return token } })).code, 0)
})

clientTest('config rejects corrupt data, insecure modes and symlinks; a busy writer cannot lose updates', async t => {
  const f = await fixture(t); await f.add()
  await writeFile(f.path + '.lock', '')
  assert.equal((await f.call(['target', 'use', 'local'])).code, 5)
  await rm(f.path + '.lock')
  if (process.platform !== 'win32') {
    await chmod(f.path, 0o644); assert.equal((await f.call(['target', 'list'])).code, 6); await chmod(f.path, 0o600)
    const destination = f.path + '.original'; await writeFile(destination, await readFile(f.path), { mode: 0o600 })
    await rm(f.path); await symlink(destination, f.path)
    assert.equal((await f.call(['target', 'list'])).code, 6)
    await rm(f.path)
  }
  await writeFile(f.path, '{"token":"' + token + '"}', { mode: 0o600 })
  assert.equal((await f.call(['target', 'list'])).code, 6)
})

clientTest('client read commands route through the canonical application prefix and redact reflected tokens', async t => {
  const f = await fixture(t, async () => jsonResponse({ reflected: token, nested: [token], [token]: 'value' }))
  await f.add()
  const commands = [['agents', 'list'], ['models', 'list'], ['projects', 'list'], ['session', 'list', '--project', 'project-id'], ['session', 'show', 'session-id']]
  for (const args of commands) { const result = await f.call(args); assert.equal(result.code, 0); assert.match(result.stdout, /REDACTED/) }
  assert.deepEqual(f.requests.filter(request => request.path !== '/api/v1/instance').map(request => request.path), [
    '/api/v1/apps/agent/agents', '/api/v1/apps/agent/models', '/api/v1/apps/agent/projects', '/api/v1/apps/agent/projects/project-id/sessions', '/api/v1/apps/agent/sessions/session-id',
  ])
})

clientTest('authentication, missing, conflict, unavailable and remote errors have fixed safe exits', async t => {
  let status = 401
  const f = await fixture(t, async () => jsonResponse({ error: { code: token, message: token } }, status)); await f.add()
  for (const [httpStatus, exit] of [[401, 3], [403, 3], [404, 4], [409, 5], [503, 6], [400, 2], [302, 6], [429, 6]]) {
    status = httpStatus; const result = await f.call(['agents', 'list']); assert.equal(result.code, exit); assert.equal(result.error.exitCode, exit)
  }
  assert.throws(() => segment('..')); assert.throws(() => segment('.')); assert.equal(segment('a/b'), 'a%2Fb')
})

clientTest('fixed instance mismatch rejects requests before sending business writes', async t => {
  const f = await fixture(t); await f.add()
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ instanceId: 'replacement' }))
  const result = await f.call(['session', 'create', '--project', 'p', '--agent', 'assistant'])
  assert.equal(result.code, 5); assert.equal(result.error.code, 'instance-mismatch')
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 0)
})

const run = (status = 'completed', revision = 1) => ({ id: 'r1', sessionId: 's1', status, revision, output: 'answer' })
clientTest('session creation and detached run submission map explicit parent and request-id once', async t => {
  const f = await fixture(t, async url => jsonResponse(url.pathname.endsWith('/sessions') ? { id: 's1' } : run('running'))); await f.add()
  assert.equal((await f.call(['session', 'create', '--project', 'p', '--agent', 'assistant', '--model', 'm'])).code, 0)
  const result = await f.call(['run', 'start', 's1', '--parent', 'root', '--request-id', 'key', '--stdin', '--detach'], 'hello from stdin')
  assert.equal(result.code, 0); assert.deepEqual(result.rows.map(row => row.type), ['request', 'accepted'])
  const posts = f.requests.filter(request => request.method === 'POST')
  assert.deepEqual(posts[1].body, { parentNodeId: null, input: 'hello from stdin', idempotencyKey: 'key' })
  assert.equal((await f.call(['run', 'start', 's1', '--parent', 'node-id', '--request-id', 'key2', '--input', 'branch', '--detach'])).code, 0)
  assert.equal(f.requests.at(-1).body.parentNodeId, 'node-id')
})

clientTest('unknown write outcomes are not retried and run find queries the original key', async t => {
  let writes = 0
  const f = await fixture(t, async (_url, init) => { if (init.method === 'POST') { writes++; throw new Error(token) } return jsonResponse(run()) }); await f.add()
  const result = await f.call(['run', 'start', 's1', '--parent', 'root', '--request-id', 'original', '--input', 'hello'])
  assert.equal(result.code, 7); assert.equal(writes, 1); assert.equal(result.rows[0].data.requestId, 'original')
  assert.equal((await f.call(['run', 'find', 's1', '--request-id', 'original'])).code, 0)
  assert.equal(f.requests.at(-1).path, '/api/v1/apps/agent/sessions/s1/runs/by-key/original')
  assert.equal((await f.call(['session', 'create', '--project', 'p', '--agent', 'a'])).code, 7); assert.equal(writes, 2)
})

clientTest('lost or oversized write responses preserve unknown outcome instead of retrying', async () => {
  let calls = 0
  const target = { name: 'test', endpoint, token, instanceId: identity }
  const http = createHarnessCliHttp(target, new AbortController().signal, async () => { calls++; return new Response('invalid json') })
  await assert.rejects(http.request('/write', {}), error => error.exitCode === 7)
  assert.equal(calls, 1)
})

clientTest('watch treats SSE EOF as a hint and reconciles with query snapshots', async t => {
  let queries = 0, streams = 0
  const f = await fixture(t, async url => {
    if (url.pathname.endsWith('/changes')) { streams++; return new Response('event: ready\ndata: {}\n\nevent: run-changed\ndata: {"status":"completed"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }) }
    queries++; return jsonResponse(run(queries >= 3 ? 'completed' : 'running', queries))
  }); await f.add()
  const result = await f.call(['run', 'watch', 'r1'])
  assert.equal(result.code, 0); assert.ok(streams > 0); assert.ok(queries >= 3)
  assert.equal(result.rows.at(-1).data.status, 'completed'); assert.ok(result.rows.every(row => row.type === 'snapshot'))
})

clientTest('SSE failure falls back to queries; failed terminal runs exit 8 and cancellation exits 130', async t => {
  let queries = 0
  const f = await fixture(t, async url => {
    if (url.pathname.endsWith('/changes')) throw new Error(token)
    queries++; return jsonResponse(run(queries > 1 ? 'failed' : 'running', queries))
  }); await f.add()
  assert.equal((await f.call(['run', 'watch', 'r1'])).code, 8)
  queries = 0
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/instance')) return jsonResponse({ instanceId: identity })
    if (String(url).includes('/changes')) return new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'text/event-stream' } })
    f.controller.abort(); return jsonResponse(run('running'))
  })
  const result = await f.call(['run', 'watch', 'r1']); assert.equal(result.code, 130)
  assert.equal(f.requests.filter(request => request.path.endsWith('/cancel')).length, 0)
})

clientTest('run show/cancel/find use separate read and explicit write endpoints', async t => {
  const f = await fixture(t, async () => jsonResponse(run('cancelled'))); await f.add()
  for (const args of [['run', 'show', 'r1'], ['run', 'cancel', 'r1'], ['run', 'find', 's1', '--request-id', 'key']]) assert.equal((await f.call(args)).code, 0)
  assert.deepEqual(f.requests.filter(request => request.method === 'POST').map(request => request.path), ['/api/v1/apps/agent/runs/r1/cancel'])
})

clientTest('path selection is CLI-owned and explicit relative overrides resolve against cwd', () => {
  assert.equal(targetConfigPath({ env: { ANYBOX_HARNESS_CLI_CONFIG: './cli/config.json' }, cwd: '/tmp/example' }), '/tmp/example/cli/config.json')
  if (process.platform === 'linux') assert.equal(targetConfigPath({ env: { HOME: '/tmp/cli-home' }, cwd: '/tmp' }), '/tmp/cli-home/.config/Anybox/harness-cli/targets.json')
})

clientTest('invalid run input combinations and repeated options are rejected before contacting a server', async t => {
  const f = await fixture(t)
  const base = ['run', 'start', 's1', '--parent', 'root', '--request-id', 'key']
  for (const args of [base, [...base, '--input', 'x', '--stdin'], [...base, '--stdin'], ['run', 'start', 's1', '--request-id', 'key', '--input', 'x'], [...base, '--input', 'x', '--request-id', 'key']]) {
    assert.equal((await f.call(args)).code, 2)
  }
  assert.equal(f.requests.length, 0)
})

clientTest('target directory links and an interrupted stdin are rejected without exposing input', async t => {
  const f = await fixture(t)
  if (process.platform !== 'win32') {
    const actual = join(f.directory, 'actual'); await mkdir(actual, { mode: 0o700 }); await symlink(actual, join(f.directory, 'private'))
    assert.equal((await f.call(['target', 'list'])).code, 6)
  }
  const controller = new AbortController(); let unblock, entered
  const reading = new Promise(resolve => { entered = resolve })
  const pending = new Promise(resolve => { unblock = resolve })
  const stdin = { async *[Symbol.asyncIterator]() { entered(); await pending; yield token }, destroy() { unblock() } }
  const started = f.call(['run', 'start', 's1', '--parent', 'root', '--request-id', 'key', '--stdin'], '', { stdin, signal: controller.signal })
  await reading; controller.abort()
  assert.equal((await started).code, 130)
})

clientTest('oversized and mismatched run responses cannot be mistaken for a successful submission', async t => {
  const f = await fixture(t, async () => jsonResponse({ ...run(), sessionId: 'wrong-session' })); await f.add()
  assert.equal((await f.call(['run', 'start', 's1', '--parent', 'root', '--request-id', 'key', '--input', 'hello', '--detach'])).code, 7)
  const http = createHarnessCliHttp({ name: 'test', endpoint, token, instanceId: identity }, new AbortController().signal, async () => new Response('x'.repeat(8 * 1024 * 1024 + 1)))
  await assert.rejects(http.request('/read'), error => error.exitCode === 6)
  await assert.rejects(http.request('/write', {}), error => error.exitCode === 7)
})


test('Windows target storage fails closed pending ACL support', { skip: process.platform !== 'win32' }, async () => {
  await assert.rejects(readTargets('C:\\AnyboxCliTest\\targets.json'), error => error.code === 'target-config-unsupported' && error.exitCode === 6)
})
