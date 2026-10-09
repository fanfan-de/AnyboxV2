import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClientHost } from '../dist/host/client.js'
import { createExecutionHost } from '../dist/host/execution.js'
import { createApplicationCatalog } from '../dist/host/applications/registration.js'
import { testApplication } from './helpers/test-application.mjs'
import { deferred } from './helpers/controlled-models.mjs'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-multi-app-')), hosts = []
  t.after(async () => { for (const host of hosts.reverse()) await host.close(); await rm(directory, { recursive: true, force: true }) })
  return async applications => { const host = await createClientHost({ path: join(directory, 'apps.sqlite'), applications }); hosts.push(host); return host }
}
async function api(host, id, value) {
  const response = await fetch(`${host.url}/api/client/v1/apps/${id}/value`, value === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: host.url }, body: JSON.stringify({ value }),
  })
  return { status: response.status, data: await response.json() }
}
test('empty and multi-application directories work without Models; factories are lazy and persisted targets stay independent', async t => {
  const start = await fixture(t); let host = await start([])
  assert.deepEqual(host.products.list(), [])
  assert.equal((await fetch(host.url)).status, 200)
  assert.equal((await fetch(host.url + '/host/web/client.js')).status, 200)
  assert.equal((await fetch(host.url + '/applications/harness/web/harness-app.js')).status, 404)
  assert.equal((await fetch(host.url + '/api/client/v1/connections')).status, 404)
  await host.close()
  let factories = 0
  const directory = [testApplication('notes', { created: () => factories++ }), testApplication('other', { created: () => factories++ })]
  host = await start(directory)
  assert.equal(factories, 0); assert.deepEqual(host.products.list().map(app => [app.definition.id, app.state]), [['notes', 'disabled'], ['other', 'disabled']])
  await Promise.all([host.products.open('notes'), host.products.open('other')]); assert.equal(factories, 2)
  assert.equal(host.root.get('models'), undefined); assert.equal(host.root.get('harness.runs'), undefined)
  assert.equal((await fetch(host.url + '/apps/notes/index.js')).status, 200)
  assert.equal((await fetch(host.url + '/apps/notes/style.css')).status, 200)
  assert.equal((await fetch(host.url + '/applications/harness/web/harness-app.js')).status, 404)
  assert.equal((await api(host, 'notes', 'retained')).status, 200); assert.equal((await api(host, 'other', 'separate')).status, 200)
  const other = host.root.get('test.other'), old = host.root.get('test.notes')
  await host.products.disable('notes'); assert.equal(host.root.get('test.other'), other); assert.equal((await api(host, 'notes')).status, 503)
  await host.products.open('notes'); assert.notEqual(host.root.get('test.notes'), old); assert.equal(host.root.get('test.other'), other)
  assert.equal((await api(host, 'notes')).data.value, 'retained'); await host.products.disable('notes'); await host.close()
  host = await start(directory)
  assert.deepEqual(host.products.list().map(app => app.state), ['disabled', 'running'])
  assert.equal((await api(host, 'other')).data.value, 'separate'); await host.close()
  host = await start([testApplication('notes')]); assert.equal(host.products.get('other'), undefined)
  const row = await host.root.get('local-storage').read(reader => reader.get('SELECT desired_enabled FROM app_product_targets WHERE id=?', ['other']))
  assert.equal(row.desired_enabled, 1); await host.close()
  host = await start(directory); assert.equal((await api(host, 'other')).data.value, 'separate')
})

test('generic execution hosts authenticate and persist registered applications without installing or advertising Harness', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-execution-app-')), hosts = []
  t.after(async () => { for (const host of hosts.reverse()) await host.close(); await rm(directory, { recursive: true, force: true }) })
  const start = async applications => {
    const host = await createExecutionHost({ databasePath: join(directory, 'apps.sqlite'), applications })
    hosts.push(host); await host.ready
    const { token } = await host.root.get('host.access').issue('test')
    const request = async (path, body) => {
      const response = await fetch(host.url + '/api/v1' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'X-Anybox-Instance-Id': host.instance.instanceId,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: response.status, data: await response.json() }
    }
    return { host, request }
  }
  let { host, request } = await start([])
  assert.equal((await fetch(host.url + '/api/v1/products')).status, 401)
  assert.deepEqual((await request('/products')).data, [])
  const instance = (await request('/instance')).data
  assert.equal(instance.name, 'Anybox')
  assert.equal(instance.capabilities.some(value => ['projects.path', 'images', 'project-files'].includes(value)), false)
  assert.equal((await request('/models')).status, 404)
  assert.equal(host.root.get('models'), undefined); assert.equal(host.root.get('harness.sessions'), undefined)
  await host.close()

  let factories = 0
  const notes = testApplication('notes', { created: () => factories++ })
  const applications = [{ ...notes, http: { ...notes.http, capabilities: ['notes.text'] } }]
  ;({ host, request } = await start(applications))
  assert.equal(factories, 0)
  assert.ok((await request('/instance')).data.capabilities.includes('notes.text'), 'registered capabilities are discoverable before application startup')
  assert.equal((await request('/products/notes/open', {})).data.state, 'running'); assert.equal(factories, 1)
  assert.equal((await request('/apps/notes/value', { value: 'execution-owned' })).status, 200)
  assert.equal((await request('/apps/notes/value')).data.value, 'execution-owned')
  assert.equal(host.root.get('models'), undefined); assert.equal(host.root.get('harness.runs'), undefined)
  await host.close()
  ;({ host, request } = await start(applications))
  assert.equal(host.products.get('notes').state, 'running')
  assert.equal((await request('/apps/notes/value')).data.value, 'execution-owned')
  await host.close()
  ;({ host, request } = await start([]))
  assert.deepEqual((await request('/products')).data, [])
  assert.equal((await request('/apps/notes/value')).status, 404)
  assert.equal(host.root.get('test.notes'), undefined)
})

test('a slow or failed application does not serialize other applications and duplicate control does not reinstall', async t => {
  const start = await fixture(t), entered = deferred(), release = deferred(); let installations = 0, broken = true
  const host = await start([testApplication('slow', { setup: async () => { installations++; entered.resolve(); await release.promise; if (broken) throw new Error('test failure') } }), testApplication('other')])
  const opening = host.products.open('slow'); await entered.promise
  assert.equal((await host.products.open('other')).state, 'running')
  const other = host.root.get('test.other'); release.resolve()
  assert.equal((await opening).state, 'failed'); assert.equal(host.root.get('test.slow'), undefined)
  assert.equal(host.root.get('test.other'), other); broken = false
  assert.equal((await host.products.retry('slow')).state, 'running')
  await Promise.all([host.products.open('slow'), host.products.open('slow')]); assert.equal(installations, 2)
  await Promise.all([host.products.disable('slow'), host.products.open('slow'), host.products.retry('slow')]); assert.equal(host.products.get('slow').state, 'running')
  assert.equal(host.root.get('test.other'), other)
})

test('registered routes fix ownership and observers wait for actual exit before application removal', async t => {
  const start = await fixture(t), observerExit = deferred(), cleanup = deferred(); let disposed = false
  const host = await start([testApplication('notes', { observerExit: () => observerExit.promise, cleanup: async () => { await cleanup.promise; disposed = true } }), testApplication('other')])
  await host.products.open('notes'); await host.products.open('other')
  const spoof = await fetch(host.url + '/api/client/v1/apps/notes/value', { headers: { 'X-Anybox-Product-Id': 'other' } }); assert.equal(spoof.status, 403)
  const response = await fetch(host.url + '/api/client/v1/apps/notes/watch'), reader = response.body.getReader(); await reader.read()
  const stopping = host.products.disable('notes'); let done = false; void stopping.then(() => { done = true })
  await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false); assert.ok(host.root.get('test.notes'))
  observerExit.resolve(); await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false); assert.equal(disposed, false)
  cleanup.resolve(); assert.equal((await stopping).state, 'disabled'); assert.equal(disposed, true)
  assert.equal((await api(host, 'other')).status, 200); await reader.cancel().catch(() => {})
})

test('busy writes and retries reject before changing targets and host close joins accepted writes', async t => {
  const start = await fixture(t), entered = deferred(), release = deferred()
  const host = await start([testApplication('notes', { write: async () => { entered.resolve(); await release.promise } })])
  await host.products.open('notes')
  const writing = api(host, 'notes', 'committed'); await entered.promise
  await assert.rejects(host.products.disable('notes'), { code: 'product-busy' })
  await assert.rejects(host.products.retry('notes'), { code: 'product-busy' })
  assert.equal(host.products.get('notes').desiredEnabled, true)
  let closed = false; const close = host.close().then(() => { closed = true })
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false)
  release.resolve(); assert.equal((await writing).status, 200); await close
  const restarted = await start([testApplication('notes')]); assert.equal((await api(restarted, 'notes')).data.value, 'committed')
})

test('registration rejects duplicate IDs, route ownership, unsafe assets, missing entries and incorrect MIME', () => {
  const a = testApplication('a'), b = testApplication('b')
  assert.throws(() => createApplicationCatalog([a, a]), /duplicate/)
  assert.throws(() => createApplicationCatalog([a, { ...b, assets: a.assets }]), /duplicate/)
  const route = { prefix: '/legacy', stripPrefix: '/legacy' }
  assert.throws(() => createApplicationCatalog([{ ...a, http: { service: 'a', legacyRoutes: [route] } }, { ...b, http: { service: 'b', legacyRoutes: [{ ...route, prefix: '/legacy/child' }] } }]), /route/)
  assert.throws(() => createApplicationCatalog([{ ...a, assets: [] }]), /unregistered/)
  assert.throws(() => createApplicationCatalog([{ ...a, assets: a.assets.map(value => ({ ...value, type: 'text/plain' })) }]), /MIME/)
  assert.throws(() => createApplicationCatalog([{ ...a, assets: [{ path: '/api/client/v1/products', file: '/tmp/file', type: 'text/plain' }] }]), /asset/)
  assert.throws(() => createApplicationCatalog([{ ...a, assets: [{ path: '/a/%2e%2e/b.js', file: '/tmp/file', type: 'text/javascript' }] }]), /asset/)
  const catalog = createApplicationCatalog([b, a]); assert.deepEqual(catalog.applications.map(app => app.definition.id), ['b', 'a'])
  assert.equal(catalog.route('/api/client/v1/apps/a/value', '/api/client/v1').application.definition.id, 'a')
})

test('one runtime admission failure still closes other applications and releases the host database', async t => {
  const start = await fixture(t); let cleaned = 0
  const ordinary = testApplication('other', { disposed: () => cleaned++ }), failing = testApplication('broken')
  const host = await start([{ ...failing, createRuntime(root) {
    const runtime = failing.createRuntime(root), close = runtime.closeAdmission
    return { ...runtime, closeAdmission() { close(); throw new Error('admission failure') } }
  } }, ordinary])
  await Promise.all([host.products.open('broken'), host.products.open('other')])
  await assert.rejects(host.close(), AggregateError); assert.equal(cleaned, 1)
  // Teardown also observes the same remembered failure; make only this fixture's after hook idempotent.
  host.close = async () => {}
  const restored = await start([]); assert.deepEqual(restored.products.list(), [])
})
