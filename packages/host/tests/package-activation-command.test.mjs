import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { runPackageActivationCommand } from '../dist/package-management/activation-command.js'

const base = '/api/client/v1/app-packages'
const view = (phase = 'prepared') => ({ id: 'activation-one', requestId: 'request-one', kind: 'activate', revision: 1, registryRevision: 3, phase, targets: [], roles: [{ role: 'client', ready: phase === 'completed' }], error: null, recovery: phase === 'recovery-required' ? { from: 'handoff', reason: 'owner-restarted' } : null, createdAt: '2026-10-17T00:00:00.000Z', updatedAt: '2026-10-17T00:00:01.000Z' })
const json = (response, value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
async function fixture(t, handler) {
  const calls = [], sockets = new Set()
  let endpoint
  const server = createServer(async (request, response) => { const chunks = []; for await (const bytes of request) chunks.push(bytes); const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined; calls.push({ method: request.method, path: request.url, body, origin: request.headers.origin }); await handler(request, response, body, calls) })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); endpoint = `http://127.0.0.1:${server.address().port}`
  t.after(async () => { const done = new Promise(resolve => server.close(resolve)); for (const socket of sockets) socket.destroy(); await done })
  return { endpoint, calls }
}
async function run(args, changes = {}) { let stdout = '', stderr = ''; const code = await runPackageActivationCommand(args, { stdout: value => { stdout += value }, stderr: value => { stderr += value }, pollIntervalMs: 1, ...changes }); return { code, output: stdout ? JSON.parse(stdout) : undefined, error: stderr ? JSON.parse(stderr).error : undefined } }
const apply = endpoint => ['apply', '--endpoint', endpoint, '--request-id', 'request-one']
const initialStatus = (request, calls) => request.method === 'GET' && (request.url === base || request.url === base + '?requestId=request-one') && !calls.some(call => call.method === 'POST')

test('online apply prepares and commits once, then observes actual completion through the same lifecycle API', async t => {
  let polls = 0
  const env = await fixture(t, (request, response, body, calls) => {
    if (initialStatus(request, calls)) return json(response, { registryRevision: 3, activations: [] })
    if (request.url === base + '/activations') { assert.deepEqual(body, { requestId: 'request-one', expectedRegistryRevision: 3, appIds: ['calculator'] }); return json(response, view(), 202) }
    if (request.url.endsWith('/commit')) return json(response, view('handoff'), 202)
    if (request.method === 'GET') return json(response, view(++polls < 2 ? 'loading' : 'completed'))
    assert.fail(request.url)
  })
  const result = await run([...apply(env.endpoint), '--app', 'calculator'])
  assert.equal(result.code, 0); assert.equal(result.output.phase, 'completed'); assert.equal(result.error, undefined)
  assert.equal(env.calls.filter(call => call.path.endsWith('/commit')).length, 1)
  assert.ok(env.calls.every(call => call.path.startsWith(base) && call.origin === env.endpoint))
})

test('a lost admission response is queried by request ID without preparing the operation twice', async t => {
  const env = await fixture(t, (request, response, _body, calls) => {
    if (initialStatus(request, calls)) return json(response, { registryRevision: 3, activations: [] })
    if (request.url === base + '/activations') { response.destroy(); return }
    if (request.url === base + '?requestId=request-one') return json(response, { activations: [view()] })
    if (request.url.endsWith('/commit')) return json(response, view('completed'))
    assert.fail(request.url)
  })
  const result = await run(apply(env.endpoint)); assert.equal(result.code, 0)
  assert.equal(env.calls.filter(call => call.method === 'POST' && call.path === base + '/activations').length, 1)
  assert.equal(env.calls.filter(call => call.path.endsWith('/commit')).length, 1)
})

test('lost preparation waits for the same request to become durable before its only commit', async t => {
  let clock = 0, lookups = 0
  const env = await fixture(t, (request, response, _body, calls) => {
    if (initialStatus(request, calls)) return json(response, { registryRevision: 3, activations: [] })
    if (request.url === base + '/activations') { response.destroy(); return }
    if (request.url === base + '?requestId=request-one') return json(response, { activations: ++lookups === 1 ? [] : [view()] })
    if (request.url.endsWith('/commit')) return json(response, view('completed'))
    assert.fail(request.url)
  })
  const result = await run(apply(env.endpoint), { timeoutMs: 100, now: () => clock, sleep: async ms => { clock += ms }, pollIntervalMs: 10 })
  assert.equal(result.code, 0); assert.equal(result.output.phase, 'completed'); assert.equal(lookups, 2); assert.equal(clock, 10)
  assert.equal(env.calls.filter(call => call.method === 'POST' && call.path === base + '/activations').length, 1)
  assert.equal(env.calls.filter(call => call.path.endsWith('/commit')).length, 1)
})

test('a lost commit response is followed only by reads across temporary role restart unavailability', async t => {
  let polls = 0
  const env = await fixture(t, (request, response, _body, calls) => {
    if (initialStatus(request, calls)) return json(response, { registryRevision: 3, activations: [] })
    if (request.url === base + '/activations') return json(response, view())
    if (request.url.endsWith('/commit')) { response.destroy(); return }
    if (++polls === 1) return json(response, { error: { code: 'role-unavailable' } }, 503)
    return json(response, view('completed'))
  })
  const result = await run(apply(env.endpoint)); assert.equal(result.code, 0); assert.equal(result.output.phase, 'completed')
  assert.equal(env.calls.filter(call => call.path.endsWith('/commit')).length, 1); assert.equal(polls, 2)
})

test('ambiguous admission remains bounded by the default two minute window and never resends the mutation', async t => {
  let clock = 0
  const env = await fixture(t, (request, response, _body, calls) => {
    if (initialStatus(request, calls)) return json(response, { registryRevision: 3, activations: [] })
    if (request.url === base + '/activations') { response.destroy(); return }
    if (request.url === base + '?requestId=request-one') return json(response, { activations: [] })
    assert.fail(request.url)
  })
  const result = await run(apply(env.endpoint), { now: () => clock, sleep: async ms => { clock += ms }, pollIntervalMs: 5000 }); assert.equal(result.code, 1); assert.equal(result.error.code, 'activation-acceptance-unconfirmed'); assert.equal(result.output, undefined)
  assert.equal(clock, 120000); assert.equal(env.calls.filter(call => call.path === base + '?requestId=request-one').length, 25)
  assert.equal(env.calls.filter(call => call.method === 'POST').length, 1)
})

test('explicit recovery uses resume followed by one commit while inspect stays read-only and cancel reports its durable result', async t => {
  const env = await fixture(t, (request, response, _body, calls) => {
    if (request.url.endsWith('/resume')) return json(response, view('recovery-required'))
    if (request.url.endsWith('/commit')) return json(response, view('handoff'))
    if (request.url.endsWith('/cancel')) return json(response, view('cancelled'))
    return json(response, view('completed'))
  })
  const args = ['activation', 'activation-one', '--endpoint', env.endpoint]
  assert.equal((await run([...args, '--action', 'resume'])).code, 0)
  assert.deepEqual(env.calls.filter(call => call.method === 'POST').map(call => call.path.split('/').at(-1)), ['resume', 'commit'])
  const before = env.calls.length; assert.equal((await run(args)).output.phase, 'completed'); assert.deepEqual(env.calls.slice(before).map(call => call.method), ['GET'])
  assert.equal((await run([...args, '--action', 'cancel'])).output.phase, 'cancelled')
})

test('only explicit HTTP loopback root origins are accepted and management rejection codes survive intact', async t => {
  let fetched = 0
  for (const endpoint of ['https://127.0.0.1:3000', 'http://example.com:3000', 'http://127.0.0.1:3000/path', 'http://127.0.0.1:3000?secret=x', 'http://user:password@127.0.0.1:3000', 'http://127.0.0.1:3000/#fragment']) {
    const result = await run(apply(endpoint), { fetch: async () => { fetched++; throw Error('must not call') } }); assert.equal(result.error.code, 'invalid-endpoint')
  }
  assert.equal(fetched, 0)
  for (const code of ['product-busy', 'revision-conflict']) {
    const env = await fixture(t, (request, response, _body, calls) => initialStatus(request, calls) ? json(response, { registryRevision: 3, activations: [] }) : json(response, { error: { code } }, 409))
    const result = await run(apply(env.endpoint)); assert.equal(result.code, 1); assert.equal(result.error.code, code)
  }
})

test('observation timeout preserves the last actual phase and strips internal receipts from CLI output', async () => {
  let clock = 0, commits = 0
  const result = await run(apply('http://127.0.0.1:3000'), { timeoutMs: 50, now: () => clock, sleep: async ms => { clock += ms }, pollIntervalMs: 10,
    fetch: async (url, options) => {
      const path = new URL(url).pathname
      if (path === base) return new Response(JSON.stringify({ registryRevision: 3, activations: [] }))
      if (path.endsWith('/commit')) commits++
      return new Response(JSON.stringify({ ...view(path.endsWith('/commit') ? 'handoff' : 'prepared'), receipt: { secret: 'must-not-print' }, workGuardIds: ['private'], directory: '/private/path' }))
    } })
  assert.equal(result.code, 1); assert.equal(result.error.code, 'activation-observation-timeout'); assert.equal(result.output.phase, 'prepared'); assert.equal(result.output.receipt, undefined); assert.equal(result.output.directory, undefined); assert.equal(result.output.workGuardIds, undefined); assert.equal(commits, 1)
})

test('online uninstall requests one application once and observes reclamation of every installed version before completion', async t => {
  let polls = 0
  const removal = phase => ({ ...view(phase), kind: 'remove', targets: ['1.0.0', '2.0.0'].map(version => ({ identity: { appId: 'calculator', version, digest: 'a'.repeat(64), target: { os: 'darwin', arch: 'arm64' } }, previousSelected: null })) })
  const env = await fixture(t, (request, response, body, calls) => {
    if (initialStatus(request, calls)) return json(response, { registryRevision: 3, activations: [] })
    if (request.url === base + '/activations') { assert.deepEqual(body, { requestId: 'request-one', kind: 'remove', expectedRegistryRevision: 3, appIds: ['calculator'] }); return json(response, removal('prepared'), 202) }
    if (request.url.endsWith('/commit')) return json(response, removal('reclaiming'), 202)
    assert.equal(request.method, 'GET'); return json(response, removal(++polls === 1 ? 'reclaiming' : 'completed'))
  })
  const result = await run(['uninstall', 'calculator', '--endpoint', env.endpoint, '--request-id', 'request-one'])
  assert.equal(result.code, 0); assert.equal(result.output.kind, 'remove'); assert.equal(result.output.phase, 'completed'); assert.equal(result.output.targets.length, 2)
  assert.equal(env.calls.filter(call => call.method === 'POST' && call.path === base + '/activations').length, 1)
  assert.equal(env.calls.filter(call => call.path.endsWith('/commit')).length, 1)
  assert.ok(env.calls.every(call => call.path.startsWith(base) && call.origin === env.endpoint))
})

test('lost uninstall commit and explicit removal recovery never repeat an unknown mutation or hide a failed reclamation', async t => {
  let reads = 0
  const removal = phase => ({ ...view(phase), kind: 'remove', ...(phase === 'recovery-required' ? { error: { code: 'package-reclamation-failed' }, recovery: { from: 'reclaiming', reason: 'outcome-unconfirmed' } } : {}) })
  const env = await fixture(t, (request, response, _body, calls) => {
    if (initialStatus(request, calls)) return json(response, { registryRevision: 3, activations: [] })
    if (request.url === base + '/activations') return json(response, removal('prepared'))
    if (request.url.endsWith('/commit')) { response.destroy(); return }
    if (request.url.endsWith('/resume')) return json(response, removal('handoff'))
    return json(response, removal(++reads === 1 ? 'reclaiming' : 'recovery-required'))
  })
  const args = ['uninstall', 'calculator', '--endpoint', env.endpoint, '--request-id', 'request-one']
  const failed = await run(args); assert.equal(failed.code, 1); assert.equal(failed.output.phase, 'recovery-required'); assert.equal(failed.output.error.code, 'package-reclamation-failed')
  assert.equal(env.calls.filter(call => call.path.endsWith('/commit')).length, 1)
  const resumed = await run(['activation', 'activation-one', '--endpoint', env.endpoint, '--action', 'resume'])
  assert.equal(resumed.code, 1); assert.equal(resumed.output.kind, 'remove'); assert.equal(resumed.output.phase, 'recovery-required')
  assert.equal(env.calls.filter(call => call.path.endsWith('/resume')).length, 1); assert.equal(env.calls.filter(call => call.path.endsWith('/commit')).length, 2)
})

test('uninstall rejects data deletion, server paths, duplicate selectors and foreign lifecycle kinds', async () => {
  let calls = 0
  const args = ['uninstall', 'calculator', '--endpoint', 'http://127.0.0.1:3000', '--request-id', 'request-one']
  for (const extra of [['--delete-data', 'true'], ['--directory', '/tmp/apps'], ['--app', 'calculator'], ['--action', 'resume']]) {
    const result = await run([...args, ...extra], { fetch: async () => { calls++; throw Error('must not send') } })
    assert.equal(result.error.code, 'invalid-input')
  }
  assert.equal(calls, 0)
  const result = await run(args, { fetch: async url => new Response(JSON.stringify(new URL(url).pathname === base ? { registryRevision: 3, activations: [] } : view())) })
  assert.equal(result.error.code, 'invalid-response')
})

test('the distributable main dispatches uninstall to the online command without opening a local registry', async () => {
  const execute = promisify(execFile)
  await assert.rejects(execute(process.execPath, [fileURLToPath(new URL('../dist/main.js', import.meta.url)), 'uninstall', 'calculator', '--endpoint', 'http://example.com:3000', '--request-id', 'main-dispatch']), error => error.code === 1 && JSON.parse(error.stderr).error.code === 'invalid-endpoint')
})

test('repeating a completed uninstall request observes its original batch despite a newer registry revision', async t => {
  const target = version => ({ identity: { appId: 'calculator', version, digest: 'a'.repeat(64), target: { os: 'darwin', arch: 'arm64' } }, previousSelected: null })
  const prior = { ...view('completed'), kind: 'remove', targets: [target('1.0.0'), target('2.0.0')] }
  const env = await fixture(t, (request, response) => { assert.equal(request.method, 'GET'); assert.equal(request.url, base + '?requestId=request-one'); return json(response, { registryRevision: 99, activations: [prior] }) })
  const result = await run(['uninstall', 'calculator', '--endpoint', env.endpoint, '--request-id', 'request-one'])
  assert.equal(result.code, 0); assert.equal(result.output.id, prior.id); assert.equal(result.output.registryRevision, 3); assert.equal(result.output.targets.length, 2)
  assert.deepEqual(env.calls.map(call => call.method), ['GET'])
})

test('an existing handoff or reclamation is only observed and a prior prepared batch is returned without claiming its protection', async t => {
  for (const phase of ['handoff', 'loading', 'reclaiming', 'prepared']) {
    const prior = { ...view(phase), kind: 'remove', targets: [{ identity: { appId: 'calculator', version: '1.0.0', digest: 'a'.repeat(64), target: { os: 'darwin', arch: 'arm64' } }, previousSelected: null }] }
    const env = await fixture(t, (request, response) => {
      assert.equal(request.method, 'GET')
      return json(response, request.url.includes('?') ? { registryRevision: 99, activations: [prior] } : { ...prior, phase: 'completed' })
    })
    const result = await run(['uninstall', 'calculator', '--endpoint', env.endpoint, '--request-id', 'request-one'])
    assert.equal(result.code, phase === 'prepared' ? 1 : 0); assert.equal(result.output.phase, phase === 'prepared' ? 'prepared' : 'completed')
    assert.ok(env.calls.every(call => call.method === 'GET'))
  }
})

test('existing request IDs cannot be reused for another lifecycle kind or another application', async () => {
  for (const prior of [{ ...view('completed'), kind: 'activate' }, { ...view('completed'), kind: 'remove', targets: [{ identity: { appId: 'other', version: '1.0.0', digest: 'a'.repeat(64), target: { os: 'darwin', arch: 'arm64' } }, previousSelected: null }] }]) {
    let mutations = 0
    const result = await run(['uninstall', 'calculator', '--endpoint', 'http://127.0.0.1:3000', '--request-id', 'request-one'], { fetch: async (_url, options) => { if (options.method !== 'GET') mutations++; return new Response(JSON.stringify({ registryRevision: 99, activations: [prior] })) } })
    assert.equal(result.code, 1); assert.equal(result.error.code, 'request-conflict'); assert.equal(mutations, 0)
  }
})
