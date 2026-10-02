import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, readFile, mkdir, writeFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { createHostAccessComponent, hostAccessServiceKey } from '../dist/host/access.js'
import { createConnectionsComponent, connectionsServiceKey, connectionEndpoint, inspectInstance } from '../dist/applications/harness/client/connections.js'
import { startClientGateway } from './helpers/client-gateway.mjs'
import { allowedProxyPath } from '../dist/applications/harness/client/gateway.js'
import { startHarnessApiServer } from './helpers/harness-api-server.mjs'
import { createTestHarnessHost } from './helpers/harness-host.mjs'
import { createImageAssetsComponent } from '../dist/applications/harness/core/image/component.js'
import { hostHttpServiceKey } from '../dist/host/component.js'
import { createFixtureApplicationApiComponent } from './helpers/application-api.mjs'
import { installManagedModels } from './helpers/managed-models.mjs'
import { controlledModels } from './helpers/controlled-models.mjs'

const memoryKeys = () => {
  const values = new Map(); let fail = false
  return { values, fail: value => { fail = value }, openEntry: (_namespace, id) => ({
    async getPassword() { return values.get(id) },
    async setPassword(value) { if (fail) throw new Error('native vault failure'); values.set(id, value) },
    async deleteCredential() { return values.delete(id) },
  }) }
}
async function storage(path) { const root = new Context(); await root.installComponent(createLocalSqliteComponent(path)); return root }
async function access(root) { await root.installComponent(createHostAccessComponent('Test device')); return root.get(hostAccessServiceKey) }
async function client(path, options = {}) { const root = await storage(path); await root.installComponent(createConnectionsComponent(options)); return { root, connections: root.get(connectionsServiceKey) } }
async function call(url, path, body, headers = {}) {
  const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { Origin: url, 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: response.status, data: await response.json() }
}

test('instance identity survives reopen; database and public metadata contain only token digests; reset revokes inheritance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anybox-access-')); let root
  try {
    root = await storage(join(dir, 'db')); let a = await access(root)
    const info = a.instance, issued = await a.issue('Laptop'), events = []
    a.onRevoked(id => events.push(id))
    assert.equal(a.authenticate(`Bearer ${issued.token}`), issued.record.id)
    assert.throws(() => a.authenticate(undefined), { code: 'authentication-failed' })
    assert.equal(JSON.stringify(await a.list()).includes(issued.token), false)
    await root.fiber.dispose()
    assert.equal((await readFile(join(dir, 'db'))).includes(Buffer.from(issued.token.split('.')[1])), false)
    root = await storage(join(dir, 'db')); a = await access(root)
    assert.equal(a.instance.instanceId, info.instanceId)
    assert.equal(a.authenticate(`Bearer ${issued.token}`), issued.record.id)
    const subscription = []; a.onRevoked(id => subscription.push(id))
    await a.revoke(issued.record.id)
    assert.deepEqual(subscription, [issued.record.id])
    assert.throws(() => a.authenticate(`Bearer ${issued.token}`), { code: 'authentication-failed' })
    const second = await a.issue('Other'); await a.resetIdentity()
    assert.notEqual(a.instance.instanceId, info.instanceId)
    assert.throws(() => a.authenticate(`Bearer ${second.token}`), { code: 'authentication-failed' })
    await root.fiber.dispose(); await assert.rejects(a.issue('closed'), { code: 'service-unavailable' })
  } finally { await root?.fiber.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('connection pairing pins identity, validates transport/version and preserves old credentials after failed changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anybox-connections-')), roots = [], servers = []
  const keys = memoryKeys(); let c
  try {
    const root = await storage(join(dir, 'host')); roots.push(root); const a = await access(root), issued = await a.issue('owner')
    const server = await startHarnessApiServer({ listProjects: () => [] }, 0, { access: a }); servers.push(server)
    c = await client(join(dir, 'client'), keys); roots.push(c.root)
    const input = { name: 'device', endpoint: server.url, token: issued.token }
    const saved = await c.connections.save(input)
    assert.deepEqual(Object.keys(saved).sort(), ['credentialConfigured', 'endpoint', 'id', 'instanceId', 'name', 'revision'])
    assert.equal(saved.instanceId, a.instance.instanceId)
    assert.equal((await c.connections.acquire(saved.id)).token, issued.token)
    keys.fail(true)
    await assert.rejects(c.connections.save({ ...input, id: saved.id, expectedRevision: saved.revision }), { code: 'credential-unavailable' })
    keys.fail(false)
    assert.equal((await c.connections.list())[0].revision, 1)
    assert.equal((await c.connections.acquire(saved.id)).token, issued.token)
    await assert.rejects(c.connections.save({ ...input, id: saved.id, expectedRevision: 0 }), { code: 'conflict' })
    const renamed = await c.connections.save({ ...saved, name: 'renamed', expectedRevision: 1 })
    assert.equal(renamed.revision, 2)
    await a.resetIdentity(); const replacement = await a.issue('replacement')
    await assert.rejects(c.connections.save({ ...input, id: saved.id, token: replacement.token, expectedRevision: 2 }), { code: 'instance-mismatch' })
    for (const endpoint of ['http://example.com', 'http://localhost', 'https://a:b@example.com', 'https://a.test/?q=1']) assert.throws(() => connectionEndpoint(endpoint), { code: 'invalid-endpoint' })
    assert.equal(connectionEndpoint('https://host.example/prefix/'), 'https://host.example/prefix')
    assert.equal(connectionEndpoint('http://[::1]:1234'), 'http://[::1]:1234')
    await c.root.fiber.dispose()
    assert.equal((await readFile(join(dir, 'client'))).includes(Buffer.from(issued.token)), false)
    c = await client(join(dir, 'client'), { openEntry() { throw new Error('locked system keyring') } }); roots.push(c.root)
    assert.equal((await c.connections.list())[0].name, 'renamed')
    await assert.rejects(c.connections.acquire(saved.id), { code: 'credential-unavailable' })
  } finally { for (const s of servers) await s.close(); for (const r of roots.reverse()) await r.fiber.dispose(); await rm(dir, { recursive: true, force: true }) }
})

async function execution(dir) {
  await mkdir(dir); const root = new Context(), llm = controlledModels()
  await installManagedModels(root, dir, { controlled: llm })
  await root.installComponent(createLocalSqliteComponent(join(dir, 'harness.sqlite')))
  const auth = await access(root), token = await auth.issue('Browser device')
  await root.installComponent(createImageAssetsComponent({ directory: join(dir, 'images') }))
  const harness = await createTestHarnessHost(root, { projectDirectoryHome: dir, agents: [{ id: 'assistant', modelId: 'default', instructions: 'Test' }] })
  await root.installComponent(createFixtureApplicationApiComponent(root, harness.listAgents(), 0, { authenticated: true }))
  const server = root.get(hostHttpServiceKey)
  return { root, llm, auth, token, harness, server, async close() { for (const call of llm.calls) { call.result.resolve('done'); call.done.resolve() } await harness.close() } }
}

test('authenticated gateway preserves accepted Runs across client disconnect and revocation, isolates two devices and never forwards browser identity', { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anybox-remote-')), hosts = []; let c, gateway, reader
  try {
    for (const name of ['a', 'b']) hosts.push(await execution(join(dir, name)))
    c = await client(join(dir, 'client.sqlite'), memoryKeys())
    const connections = []
    for (const h of hosts) connections.push(await c.connections.save({ name: h.auth.instance.instanceId, endpoint: h.server.url, token: h.token.token }))
    gateway = await startClientGateway(c.connections)
    const base = id => `/api/connections/${id}/v1`
    assert.equal((await call(hosts[0].server.url, '/api/v1/projects')).status, 401)
    assert.equal((await call(hosts[0].server.url, '/api/v1/projects', undefined, { Authorization: `Bearer ${hosts[0].token.token}`, 'X-Anybox-Instance-Id': hosts[1].auth.instance.instanceId })).status, 409)
    assert.equal((await call(gateway.url, base(connections[0].id) + '/projects', {}, { Origin: 'https://evil.test' })).status, 403)
    assert.equal((await call(gateway.url, base(connections[0].id) + '/shutdown', {})).status, 404)
    const project = await call(gateway.url, base(connections[0].id) + '/projects', { path: join(dir, 'a') }, { Authorization: 'Bearer invalid', 'X-Anybox-Instance-Id': hosts[1].auth.instance.instanceId })
    assert.equal(project.status, 200)
    assert.equal((await call(gateway.url, base(connections[1].id) + '/projects')).data.length, 0)
    const session = (await call(gateway.url, base(connections[0].id) + '/sessions', { projectId: project.data.id, agentId: 'assistant' })).data
    await writeFile(join(dir, 'a', 'reference.txt'), 'host A file')
    await writeFile(join(dir, 'b', 'reference.txt'), 'host B file')
    const fileBase = base(connections[0].id) + `/sessions/${session.id}/project-files`
    assert.equal((await call(gateway.url, fileBase + '/preview', { path: 'reference.txt' })).data.text, 'host A file')
    const prepared = await call(gateway.url, fileBase + '/prepare', { preparationKey: 'file', selections: [{ kind: 'project-file', path: 'reference.txt' }] })
    assert.equal(prepared.status, 200)
    assert.equal((await call(gateway.url, fileBase + '/snapshots/' + prepared.data[0].snapshotId)).data.text, 'host A file')
    const events = await fetch(gateway.url + base(connections[0].id) + '/changes?sessionId=' + session.id)
    assert.equal(events.status, 200); reader = events.body.getReader(); assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/)
    const lostInput = { input: 'accepted response lost', parentNodeId: null, idempotencyKey: 'lost-response' }
    const lostResponse = await fetch(gateway.url + base(connections[0].id) + `/sessions/${session.id}/runs`, { method: 'POST', headers: { Origin: gateway.url, 'Content-Type': 'application/json' }, body: JSON.stringify(lostInput) })
    await lostResponse.body.cancel() // The client never received or persisted the returned Run ID.
    const recovered = await call(gateway.url, base(connections[0].id) + `/sessions/${session.id}/runs/by-key/lost-response`)
    assert.equal(recovered.status, 200)
    const acceptedAgain = await call(gateway.url, base(connections[0].id) + `/sessions/${session.id}/runs`, lostInput)
    assert.equal(acceptedAgain.data.id, recovered.data.id); assert.equal(hosts[0].llm.calls.length, 1)
    hosts[0].llm.calls[0].result.resolve('recovered'); hosts[0].llm.calls[0].done.resolve(); await hosts[0].harness.waitRun(recovered.data.id)
    const input = { input: 'continue without browser', parentNodeId: null, idempotencyKey: 'same-key' }
    const run = await call(gateway.url, base(connections[0].id) + `/sessions/${session.id}/runs`, input)
    assert.equal(run.status, 200)
    await gateway.close(); gateway = undefined
    await reader.cancel().catch(() => {}); reader = undefined
    assert.equal((await hosts[0].harness.getRun(run.data.id)).status, 'running')
    assert.deepEqual(hosts[0].llm.calls[1].cancellations, [])
    gateway = await startClientGateway(c.connections)
    const replay = await call(gateway.url, base(connections[0].id) + `/sessions/${session.id}/runs`, input)
    assert.equal(replay.data.id, run.data.id); assert.equal(hosts[0].llm.calls.length, 2)
    const stream = await fetch(gateway.url + base(connections[0].id) + '/changes?sessionId=' + session.id)
    reader = stream.body.getReader(); await reader.read()
    await hosts[0].auth.revoke(hosts[0].token.record.id)
    await assert.rejects(async () => { while (!(await reader.read()).done) {} })
    assert.equal((await call(gateway.url, base(connections[0].id) + '/projects')).status, 401)
    assert.equal((await call(gateway.url, base(connections[1].id) + '/projects')).status, 200)
    hosts[0].llm.calls[1].result.resolve('survived'); hosts[0].llm.calls[1].done.resolve()
    assert.equal((await hosts[0].harness.waitRun(run.data.id)).status, 'completed')
    await hosts[0].close()
    assert.equal((await call(gateway.url, base(connections[0].id) + '/projects')).status, 502)
    assert.equal((await call(gateway.url, base(connections[1].id) + '/projects')).status, 200)
  } finally { await reader?.cancel().catch(() => {}); await gateway?.close(); await c?.root.fiber.dispose(); for (const h of hosts) await h.close(); await rm(dir, { recursive: true, force: true }) }
})

test('gateway whitelist omits control-plane internals and encoded traversal', () => {
  for (const path of ['/shutdown', '/sessions/a/records', '/sessions/a/images/%2e%2e/content', '/runs/a%2fb', '/runs/%00']) assert.equal(allowedProxyPath('GET', path), false)
  for (const [method, path] of [['POST', '/projects'], ['POST', '/sessions/a/project-files/preview'], ['GET', '/sessions/archived'], ['GET', '/models/configurations/a/history'], ['POST', '/access/tokens/a/revoke']]) assert.equal(allowedProxyPath(method, path), true)
  for (const path of ['/projects/directories/browse', '/projects/directories/close']) {
    assert.equal(allowedProxyPath('POST', path), true)
    assert.equal(allowedProxyPath('GET', path), false)
  }
  for (const path of ['/projects/directories/read', '/projects/directories/browse/extra', '/projects/directories/%62rowse', '/projects/directories/../browse']) assert.equal(allowedProxyPath('POST', path), false)
})

test('offline connection checks do not hold other devices; close aborts and joins the handshake', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anybox-parallel-')); let c, block = false, observed, aborted = false
  const entered = new Promise(resolve => { observed = resolve })
  const instanceA = '11111111-1111-4111-8111-111111111111', instanceB = '22222222-2222-4222-8222-222222222222'
  const token = instanceA + '.' + 'a'.repeat(43)
  try {
    c = await client(join(dir, 'client'), { ...memoryKeys(), fetch: async (url, options) => {
      assert.equal(options.redirect, 'error')
      if (block && url.includes('slow')) { observed(); await new Promise((_, reject) => options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) })) }
      return Response.json({ instanceId: url.includes('slow') ? instanceA : instanceB, name: 'device', apiVersion: 1, capabilities: [] })
    } })
    const a = await c.connections.save({ name: 'slow', endpoint: 'https://slow.test', token })
    const b = await c.connections.save({ name: 'fast', endpoint: 'https://fast.test', token })
    block = true
    const slow = assert.rejects(c.connections.check(a.id), { code: 'cancelled' }); await entered
    assert.equal((await c.connections.check(b.id)).instanceId, instanceB)
    assert.equal((await c.connections.acquire(b.id)).connection.id, b.id)
    await c.root.fiber.dispose(); await slow; assert.equal(aborted, true)
  } finally { await c?.root.fiber.dispose(); await rm(dir, { recursive: true, force: true }) }
})


test('pairing rejects incompatible API versions, unbounded identity and invalid authentication', async () => {
  const signal = new AbortController().signal
  await assert.rejects(inspectInstance('https://a.test', 'token', signal, async () => Response.json({ apiVersion: 2 })), { code: 'version-incompatible' })
  await assert.rejects(inspectInstance('https://a.test', 'token', signal, async () => new Response('denied', { status: 401 })), { code: 'authentication-failed' })
  await assert.rejects(inspectInstance('https://a.test', 'token', signal, async () => new Response('a'.repeat(65537))), { code: 'invalid-instance' })
})

test('directory browsing authenticates, remains read only, and scopes reservations and registration to the chosen instance', { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anybox-directory-remote-')), hosts = []; let c, gateway
  const browse = '/projects/directories/browse', close = '/projects/directories/close'
  try {
    for (const name of ['a', 'b']) hosts.push(await execution(join(dir, name)))
    await mkdir(join(dir, 'a', 'Visible')); await mkdir(join(dir, 'a', '.hidden')); await mkdir(join(dir, 'a', 'Empty'))
    c = await client(join(dir, 'client.sqlite'), memoryKeys())
    const connections = []
    for (const h of hosts) connections.push(await c.connections.save({ name: h.auth.instance.instanceId, endpoint: h.server.url, token: h.token.token }))
    gateway = await startClientGateway(c.connections)
    const base = index => `/api/connections/${connections[index].id}/v1`
    const pinned = index => ({ 'X-Anybox-Expected-Instance-Id': connections[index].instanceId, 'X-Anybox-Connection-Revision': String(connections[index].revision) })
    const a = hosts[0], authorization = { Authorization: `Bearer ${a.token.token}`, 'X-Anybox-Instance-Id': a.auth.instance.instanceId }
    assert.equal((await call(a.server.url, '/api/v1' + browse, { action: 'open' })).status, 401)
    assert.equal((await call(a.server.url, '/api/v1' + browse, { action: 'open' }, { ...authorization, 'X-Anybox-Instance-Id': hosts[1].auth.instance.instanceId })).status, 409)
    const info = await call(gateway.url, base(0) + '/instance', undefined, pinned(0))
    assert.equal(info.data.apiVersion, 1); assert.ok(info.data.capabilities.includes('projects.browse'))
    const opened = await call(gateway.url, base(0) + browse, { action: 'open' }, pinned(0))
    assert.equal(opened.status, 200); assert.equal(opened.data.homePath, join(dir, 'a'))
    const page = await call(gateway.url, base(0) + browse, { action: 'page', browseId: opened.data.browseId, page: 0 }, pinned(0))
    assert.equal(page.status, 200); assert.equal(page.data.path, await realpath(opened.data.homePath))
    assert.ok(page.data.entries.some(entry => entry.name === 'Visible'))
    assert.ok(!page.data.entries.some(entry => entry.name === '.hidden'))
    assert.equal((await call(gateway.url, base(1) + browse, { action: 'page', browseId: opened.data.browseId, page: 0 }, pinned(1))).status, 409)
    const otherToken = await a.auth.issue('Other reader')
    assert.equal((await call(a.server.url, '/api/v1' + browse, { action: 'page', browseId: opened.data.browseId, page: 0 }, { ...authorization, Authorization: `Bearer ${otherToken.token}` })).status, 409)
    const hidden = await call(gateway.url, base(0) + browse, { action: 'open', query: '.hidden', showHidden: true }, pinned(0))
    const hiddenPage = await call(gateway.url, base(0) + browse, { action: 'page', browseId: hidden.data.browseId, page: 0 }, pinned(0))
    assert.deepEqual(hiddenPage.data.entries.map(entry => entry.name), ['.hidden'])
    const empty = await call(gateway.url, base(0) + browse, { action: 'open', path: join(dir, 'a', 'Empty') }, pinned(0))
    const emptyPage = await call(gateway.url, base(0) + browse, { action: 'page', browseId: empty.data.browseId, page: 0 }, pinned(0))
    assert.deepEqual(emptyPage.data.entries, []); assert.equal(emptyPage.data.nextPage, null)
    for (const id of [opened.data.browseId, hidden.data.browseId, empty.data.browseId]) assert.equal((await call(gateway.url, base(0) + close, { browseId: id }, pinned(0))).status, 200)
    for (const index of [0, 1]) assert.deepEqual((await call(gateway.url, base(index) + '/projects')).data, [])
    const project = await call(gateway.url, base(0) + '/projects', { path: page.data.path }, pinned(0))
    assert.equal(project.status, 200)
    assert.equal((await call(gateway.url, base(0) + '/projects', { path: page.data.path }, pinned(0))).data.id, project.data.id)
    assert.deepEqual((await call(gateway.url, base(1) + '/projects')).data, [])
    const samePath = await call(gateway.url, base(1) + '/projects', { path: page.data.path }, pinned(1))
    assert.equal(samePath.status, 200); assert.equal(samePath.data.path, project.data.path); assert.notEqual(samePath.data.id, project.data.id)
    assert.equal((await call(gateway.url, base(0) + '/projects', { path: page.data.path }, pinned(1))).status, 409)
    assert.equal((await call(gateway.url, base(0) + browse, { action: 'open' }, { 'X-Anybox-Connection-Revision': '1' })).status, 400)
    await c.connections.save({ ...connections[0], name: 'Changed', expectedRevision: connections[0].revision })
    for (const [path, body] of [[browse, { action: 'open' }], ['/projects', { path: page.data.path }]]) {
      const stale = await call(gateway.url, base(0) + path, body, pinned(0))
      assert.equal(stale.status, 409); assert.equal(stale.data.error.code, 'connection-changed')
    }
  } finally { await gateway?.close(); await c?.root.fiber.dispose(); for (const h of hosts) await h.close(); await rm(dir, { recursive: true, force: true }) }
})

test('native directory shortcut requires launcher identity and rejects changed connection revisions', async () => {
  const instance = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222'
  let revision = 1, picks = 0, release, entered
  const selected = new Promise(resolve => { release = resolve }), started = new Promise(resolve => { entered = resolve })
  const connection = id => ({ id, name: id, endpoint: 'https://same.example', instanceId: id === 'local' ? instance : other, revision, credentialConfigured: true })
  const connections = { list: async () => [connection('local'), connection('remote')] }
  const picker = { supported: true, async pick() { picks++; entered(); return selected } }
  const gateway = await startClientGateway(connections, { localInstanceId: instance, picker })
  const pinned = { 'X-Anybox-Expected-Instance-Id': instance, 'X-Anybox-Connection-Revision': '1' }
  try {
    assert.equal((await call(gateway.url, '/api/client/v1/connections/remote/pick', {})).status, 403); assert.equal(picks, 0)
    assert.equal((await call(gateway.url, '/api/client/v1/connections/local/pick', {}, { ...pinned, 'X-Anybox-Connection-Revision': '2' })).status, 409); assert.equal(picks, 0)
    const pending = call(gateway.url, '/api/client/v1/connections/local/pick', {}, pinned)
    await started; revision = 2; release('/client/path')
    const changed = await pending; assert.equal(changed.status, 409); assert.equal(changed.data.error.code, 'connection-changed'); assert.equal(picks, 1)
  } finally { release(null); await gateway.close() }
})

test('old Harness capability metadata remains API v1 and never advertises unavailable directory browsing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anybox-directory-old-')); let root, server
  try {
    root = await storage(join(dir, 'db')); const a = await access(root), issued = await a.issue('Browser')
    server = await startHarnessApiServer({ listProjects: () => [] }, 0, { access: a })
    const headers = { Authorization: `Bearer ${issued.token}`, 'X-Anybox-Instance-Id': a.instance.instanceId }
    const info = await call(server.url, '/api/v1/instance', undefined, headers)
    assert.equal(info.status, 200); assert.equal(info.data.apiVersion, 1); assert.ok(!info.data.capabilities.includes('projects.browse'))
    const unsupported = await call(server.url, '/api/v1/projects/directories/browse', { action: 'open' }, headers)
    assert.equal(unsupported.status, 503); assert.equal(unsupported.data.error.code, 'directory-browse-unsupported')
  } finally { await server?.close(); await root?.fiber.dispose(); await rm(dir, { recursive: true, force: true }) }
})

for (const stop of ['disconnect', 'shutdown']) test(`directory HTTP ${stop} joins cancelled page work and cursor cleanup before closing`, async () => {
  const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
  const started = deferred(), cancelled = deferred(), done = deferred(), result = deferred(), closingCursor = deferred(), cursorClosed = deferred()
  let closed = false, owner, cancelCount = 0, retire
  const commands = {
    directoryBrowsingSupported: () => true,
    onDirectoryBrowseRetired(listener) { retire = listener; return () => { retire = undefined } },
    openDirectoryBrowse(value) {
      owner = value
      return { result: Promise.resolve({ browseId: 'reserved', homePath: '/target/home' }), done: Promise.resolve(), cancel() {} }
    },
    readDirectoryPage(value, id, page) {
      assert.equal(value, owner); assert.equal(id, 'reserved'); assert.equal(page, 0); started.resolve()
      return { result: result.promise, done: done.promise, cancel() {
        cancelCount++; cancelled.resolve(); result.reject(Object.assign(new Error('cancelled'), { name: 'DirectoryBrowseFailure', code: 'directory-browse-cancelled' }))
      } }
    },
    async closeDirectoryBrowse(value, id) { assert.equal(value, owner); assert.equal(id, 'reserved'); closingCursor.resolve(); await cursorClosed.promise; retire?.(id) },
  }
  const server = await startHarnessApiServer(commands), abort = new AbortController()
  try {
    assert.equal((await call(server.url, '/api/v1/projects/directories/browse', { action: 'open' })).status, 200)
    const reading = fetch(server.url + '/api/v1/projects/directories/browse', { method: 'POST', headers: { Origin: server.url, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'page', browseId: 'reserved', page: 0 }), signal: abort.signal }).then(async response => ({ status: response.status, data: await response.json() }), error => ({ error }))
    await started.promise
    if (stop === 'disconnect') { abort.abort(); await cancelled.promise }
    const shutdown = server.close().then(() => { closed = true })
    await cancelled.promise; await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false)
    done.resolve(); await closingCursor.promise; assert.equal(closed, false)
    cursorClosed.resolve(); await shutdown; assert.equal(closed, true); assert.ok(cancelCount > 0)
    const response = await reading
    if (stop === 'shutdown') { assert.equal(response.status, 503); assert.equal(response.data.error.code, 'directory-browse-cancelled') }
    else assert.ok(response.error)
  } finally { abort.abort(); done.resolve(); cursorClosed.resolve(); result.reject(new Error('cleanup')); await server.close() }
})

test('directory HTTP observes cleanup failure even when a replaced provider never settles result', async () => {
  let cancellations = 0
  const server = await startHarnessApiServer({ directoryBrowsingSupported: () => true,
    readDirectoryPage() { return { result: new Promise(() => {}), done: Promise.reject(new Error('private filesystem failure')), cancel() { cancellations++ } } },
  })
  try {
    const response = await call(server.url, '/api/v1/projects/directories/browse', { action: 'page', browseId: 'reserved', page: 0 })
    assert.equal(response.status, 503); assert.equal(response.data.error.code, 'directory-browse-cleanup-failed'); assert.ok(cancellations > 0)
    assert.ok(!JSON.stringify(response.data).includes('private filesystem'))
  } finally { await server.close() }
})

test('directory reservation retirement removes API cleanup ownership and unsubscribes after shutdown', async () => {
  let retire, counter = 0, unsubscribed = false
  const closed = []
  const server = await startHarnessApiServer({
    directoryBrowsingSupported: () => true,
    onDirectoryBrowseRetired(listener) { retire = listener; return () => { unsubscribed = true; retire = undefined } },
    openDirectoryBrowse() { return { result: Promise.resolve({ browseId: String(++counter), homePath: '/home' }), done: Promise.resolve(), cancel() {} } },
    async closeDirectoryBrowse(_owner, id) { closed.push(id); retire?.(id) },
  })
  try {
    for (let index = 0; index < 32; index++) {
      const response = await call(server.url, '/api/v1/projects/directories/browse', { action: 'open' })
      assert.equal(response.status, 200); retire(response.data.browseId)
    }
    const active = await call(server.url, '/api/v1/projects/directories/browse', { action: 'open' })
    await server.close(); assert.deepEqual(closed, [active.data.browseId]); assert.equal(unsubscribed, true)
  } finally { await server.close() }
})
