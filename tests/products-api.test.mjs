import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, request as httpRequest } from 'node:http'
import { Context, FiberState } from '@nya/core'
import { startHarnessServerHttp } from './helpers/harness-server-http.mjs'
import { hostHttpServiceKey } from '../dist/host/component.js'
import { createProductActivity } from '../dist/host/applications/activity.js'
import { productsServiceKey, productActivityServiceKey } from '../dist/host/applications/contracts.js'
import { createFixtureApplicationApiComponent } from './helpers/application-api.mjs'
import { promptServiceKey } from '../dist/applications/harness/core/prompt/component.js'
import { startClientGateway } from './helpers/client-gateway.mjs'
import { allowedProxyPath } from '../dist/applications/harness/client/gateway.js'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const prompt = { id: 'p', name: 'Prompt', description: '', draft: { revision: 1, kind: 'instruction', role: 'system', content: 'test' }, versionIds: [] }
function productService(extra = {}) {
  return {
    list: () => [], get: () => undefined,
    authorize(id) {
      if (id === 'disabled') throw Object.assign(new Error('product-unavailable'), { status: 503, code: 'product-unavailable' })
      if (id !== 'agent') throw Object.assign(new Error('product-not-found'), { status: 404, code: 'product-not-found' })
    }, ...extra,
  }
}
async function request(web, path, body, productId) {
  const response = await fetch(web.url + '/api/v1' + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { Origin: web.url, 'Content-Type': 'application/json' }), ...(productId ? { 'X-Anybox-Product-Id': productId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: response.status, data: await response.json() }
}

test('application HTTP remains active with no products and across optional service generations', async () => {
  const root = new Context(), activity = createProductActivity(), products = productService()
  await root.installComponent(ctx => { ctx.provide(productsServiceKey, products); ctx.provide(productActivityServiceKey, activity) })
  const api = root.installComponent(createFixtureApplicationApiComponent(root, [{ id: 'assistant' }]))
  await api
  const web = root.get(hostHttpServiceKey)
  try {
    assert.equal(api.state, FiberState.ACTIVE)
    assert.equal((await request(web, '/products')).status, 200)
    assert.equal((await request(web, '/models', undefined, 'disabled')).status, 403)
    assert.equal((await request(web, '/models', undefined, 'unknown')).status, 403)
    const provider = root.installComponent(ctx => { ctx.provide(promptServiceKey, { listPrompts: () => [prompt] }) })
    await provider
    assert.equal((await request(web, '/prompts', undefined, 'agent')).data[0].id, 'p')
    await provider.dispose()
    assert.equal(api.state, FiberState.ACTIVE)
    assert.equal(root.get(hostHttpServiceKey).url, web.url)
    assert.equal((await request(web, '/prompts', undefined, 'agent')).status, 503)
    await root.installComponent(ctx => { ctx.provide(promptServiceKey, { listPrompts: () => [{ ...prompt, id: 'replacement' }] }) })
    assert.equal((await request(web, '/prompts', undefined, 'agent')).data[0].id, 'replacement')
  } finally { await root.fiber.dispose() }
})

test('instance metadata advertises product management and registered Harness capabilities before optional services are installed', async () => {
  const instanceId = '11111111-1111-1111-1111-111111111111'
  const access = { instance: { instanceId, capabilities: [] }, authenticate: () => 'owner', onRevoked: () => () => {} }
  const web = await startHarnessServerHttp({}, 0, { access, products: productService() })
  try {
    const response = await fetch(web.url + '/api/v1/instance')
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).capabilities, ['products.v2', 'projects.path', 'images', 'project-files', 'sse'])
  } finally { await web.close() }
})

test('business write admission precedes reading its body and survives browser disconnect until actual completion', async () => {
  const activity = createProductActivity(), admitted = deferred(), entered = deferred(), complete = deferred()
  const products = productService({ authorize(id) { assert.equal(id, 'agent'); admitted.resolve() } })
  const web = await startHarnessServerHttp({ createPrompt: async () => { entered.resolve(); await complete.promise; return prompt } }, 0, { products, activity })
  let upload
  try {
    upload = httpRequest(web.url + '/api/v1/prompts', { method: 'POST', headers: { Origin: web.url, 'Content-Type': 'application/json', 'X-Anybox-Product-Id': 'agent' } })
    upload.on('error', () => {})
    upload.flushHeaders()
    await admitted.promise
    assert.throws(() => activity.freeze(['agent']), { code: 'product-busy' })
    upload.end('{}')
    await entered.promise
    upload.destroy()
    await new Promise(resolve => setImmediate(resolve))
    assert.throws(() => activity.freeze(['agent']), { code: 'product-busy' })
    complete.resolve()
    await activity.wait()
    const freeze = activity.freeze(['agent']); await freeze.drain(); freeze.release()
  } finally { upload?.destroy(); complete.resolve(); await web.close() }
})

test('accepted Run holds its product lease after the response and HTTP shutdown joins native exit', { timeout: 5_000 }, async () => {
  const activity = createProductActivity(), exited = deferred(), waiting = deferred()
  const run = { id: 'r', sessionId: 's', status: 'running', input: 'hi', history: [], revision: 1 }
  const web = await startHarnessServerHttp({ startRun: async () => run, waitRun: async () => { waiting.resolve(); await exited.promise; return { ...run, status: 'succeeded' } } }, 0, { products: productService(), activity })
  try {
    assert.equal((await request(web, '/sessions/s/runs', { input: 'hi', parentNodeId: null, idempotencyKey: 'key' }, 'agent')).status, 200)
    await waiting.promise
    assert.throws(() => activity.freeze(['agent']), { code: 'product-busy' })
    let closed = false
    const closing = web.close().then(() => { closed = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(closed, false)
    assert.throws(() => activity.freeze(['agent']), { code: 'product-busy' })
    exited.resolve(); await closing; await activity.wait()
    assert.equal(closed, true)
    const freeze = activity.freeze(['agent']); await freeze.drain(); freeze.release()
  } finally { exited.resolve(); await web.close() }
})

test('product stop closes SSE observers and joins their leases without making them busy writes', async () => {
  const activity = createProductActivity()
  const web = await startHarnessServerHttp({ getSession: async () => ({ id: 's' }) }, 0, { products: productService(), activity })
  let reader
  try {
    const response = await fetch(web.url + '/api/v1/changes?sessionId=s', { headers: { 'X-Anybox-Product-Id': 'agent' } })
    reader = response.body.getReader(); await reader.read()
    const freeze = activity.freeze(['agent'])
    await freeze.drain()
    assert.equal((await request(web, '/changes?sessionId=s', undefined, 'agent')).status, 503)
    freeze.release()
  } finally { await reader?.cancel().catch(() => {}); await web.close() }
})

test('product mutations are not cancelled by a lost browser and management stays available without Agent', async () => {
  const entered = deferred(), completed = deferred(), abort = new AbortController()
  let applied = false
  const products = productService({ open: async (_id) => { entered.resolve(); await completed.promise; applied = true; return { state: 'running' } } })
  const web = await startHarnessServerHttp({}, 0, { products, activity: createProductActivity() })
  try {
    assert.equal((await request(web, '/products')).status, 200)
    const pending = fetch(web.url + '/api/v1/products/agent/open', { method: 'POST', headers: { Origin: web.url, 'Content-Type': 'application/json' }, body: JSON.stringify({}), signal: abort.signal }).catch(() => {})
    await entered.promise; abort.abort(); await pending
    assert.equal(applied, false)
    completed.resolve(); await web.close(); assert.equal(applied, true)
  } finally { completed.resolve(); await web.close() }
})

test('gateway forwards only product identity and validates image URL connection bindings before contacting the host', async () => {
  const instanceId = '11111111-1111-1111-1111-111111111111', received = []
  const upstream = createServer((req, res) => { received.push({ url: req.url, headers: req.headers }); res.setHeader('X-Anybox-Instance-Id', instanceId); res.setHeader('Content-Type', 'application/json'); res.end('{}') })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const connection = { id: 'c', endpoint: `http://127.0.0.1:${upstream.address().port}`, instanceId, revision: 4 }
  const gateway = await startClientGateway({ acquire: async () => ({ connection, token: 'host-secret' }) })
  const base = gateway.url + '/api/connections/c/v1'
  try {
    const headers = { 'X-Anybox-Product-Id': 'agent', 'X-Anybox-Expected-Instance-Id': instanceId, 'X-Anybox-Connection-Revision': '4', Authorization: 'browser-forgery', 'X-Anybox-Instance-Id': 'browser-forgery' }
    assert.equal((await fetch(base + '/products', { headers })).status, 200)
    assert.equal(received[0].headers.authorization, 'Bearer host-secret')
    assert.equal(received[0].headers['x-anybox-product-id'], 'agent')
    assert.equal(received[0].headers['x-anybox-instance-id'], instanceId)
    assert.equal(received[0].headers['x-anybox-expected-instance-id'], undefined)
    const query = new URLSearchParams({ __anyboxProductId: 'agent', __anyboxInstanceId: instanceId, __anyboxConnectionRevision: '4' })
    assert.equal((await fetch(base + '/sessions/s/images/a/content?' + query)).status, 200)
    assert.equal(received[1].url, '/api/v1/sessions/s/images/a/content')
    assert.equal(received[1].headers['x-anybox-product-id'], 'agent')
    query.set('__anyboxConnectionRevision', '3')
    assert.equal((await fetch(base + '/sessions/s/images/a/content?' + query)).status, 409)
    assert.equal((await fetch(base + '/products?' + query)).status, 400)
    assert.equal(received.length, 2)
    assert.equal(allowedProxyPath('POST', '/products/x/open'), true)
    assert.equal(allowedProxyPath('POST', '/products/x/apply'), false)
    assert.equal(allowedProxyPath('POST', '/products/x/restore'), false)
    assert.equal(allowedProxyPath('POST', '/products/x/../../shutdown'), false)
  } finally { await gateway.close(); await new Promise(resolve => upstream.close(resolve)) }
})
