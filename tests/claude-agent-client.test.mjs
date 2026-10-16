import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startApplicationHttpServer } from '../dist/host/http-server.js'
import { createApplicationCatalog } from '../dist/host/applications/registration.js'
import { shellAssets } from '../dist/host/assets.js'
import { createExecutionHost } from '../dist/host/execution.js'
import { createClientHost } from '../dist/entrypoints/client-main.js'
import { allowedClaudeAgentProxyPath, createClaudeAgentGateway } from '../dist/applications/claude-agent/client/gateway.js'
import { claudeAgentClientApplication } from '../dist/applications/claude-agent/client/registration.js'
import { claudeAgentServerApplication } from '../dist/applications/claude-agent/registration.js'
import { claudeAgentSdkServiceKey } from '../dist/applications/claude-agent/core/sdk/port.js'
import { DirectoryPickerFailure } from '../dist/host/directory-picker.js'
import { fakeSdk, sampleResult, waitFor } from './helpers/claude-agent.mjs'

const base = '/api/client/v1/apps/claude-agent'
async function startGateway(connections, options = {}) {
  const gateway = createClaudeAgentGateway(connections, options)
  const catalog = createApplicationCatalog([claudeAgentClientApplication()], shellAssets)
  const server = await startApplicationHttpServer({ base: '/api/client/v1', catalog, service: () => gateway })
  return { ...server, async close() { await server.close(); await gateway.close() } }
}
test('the proxy whitelist admits only product control and this application\'s routes', () => {
  for (const [method, path, expected] of [
    ['GET', '/instance', true], ['GET', '/products/claude-agent', true], ['POST', '/products/claude-agent/open', true], ['POST', '/products/claude-agent/apply', false],
    ['GET', '/products/agent', false], ['POST', '/products/agent/open', false], ['GET', '/apps/claude-agent/threads', true], ['GET', '/apps/claude-agent/threads/t/messages', true],
    ['POST', '/apps/claude-agent/threads/t/runs', true], ['GET', '/apps/claude-agent/runs/r/view', true], ['GET', '/apps/claude-agent/runs/r/wait', true], ['POST', '/apps/claude-agent/runs/r/cancel', true],
    ['POST', '/apps/claude-agent/approvals/a', true], ['GET', '/apps/claude-agent/events', true], ['GET', '/apps/agent/sessions', false], ['GET', '/models', false], ['POST', '/apps/claude-agent/threads/%2e%2e/runs', false],
    ['GET', '/apps/claude-agent/runs/r/events', false], ['POST', '/apps/claude-agent/threads/t', false],
    ['GET', '/apps/claude-agent/projects/recent', true], ['GET', '/apps/claude-agent/models/recent', true], ['GET', '/apps/claude-agent/directories', true], ['POST', '/apps/claude-agent/directories', false], ['GET', '/apps/claude-agent/projects', false],
  ]) assert.equal(allowedClaudeAgentProxyPath(method, path), expected, `${method} ${path}`)
})
test('the gateway lists host connections, forwards only whitelisted routes with the device credentials and streams SSE through', async () => {
  const instanceId = '11111111-1111-1111-1111-111111111111', received = []
  const upstream = createServer((req, res) => {
    received.push({ url: req.url, headers: req.headers })
    res.setHeader('X-Anybox-Instance-Id', instanceId)
    if (req.url === '/api/v1/apps/claude-agent/events?threadId=t') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('event: ready\ndata: {}\n\n')
      setTimeout(() => res.write('event: run-changed\ndata: {"runId":"r"}\n\n'), 20)
      req.on('close', () => res.end()); return
    }
    res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}')
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const connection = { id: 'c', name: 'Laptop', endpoint: `http://127.0.0.1:${upstream.address().port}`, instanceId, revision: 2, credentialConfigured: true }
  const connections = { list: async () => [connection], acquire: async id => { if (id !== 'c') throw Object.assign(new Error('not-found'), { status: 404, code: 'not-found' }); return { connection, token: 'device-secret' } },
    localStatus: () => ({ enabled: true, state: 'ready', instanceId, connectionId: 'c', connectionRevision: 2 }) }
  const gateway = await startGateway(connections)
  try {
    const listed = await (await fetch(gateway.url + base + '/connections')).json()
    assert.deepEqual(listed, { connections: [connection], localInstanceId: instanceId })
    assert.deepEqual(await (await fetch(gateway.url + base + '/local')).json(), { instanceId, picker: false, status: { enabled: true, state: 'ready', instanceId, connectionId: 'c', connectionRevision: 2 } }, 'no picker was given to this gateway')
    const headers = { 'X-Anybox-Product-Id': 'claude-agent', 'X-Anybox-Expected-Instance-Id': instanceId, 'X-Anybox-Connection-Revision': '2', Authorization: 'browser-forgery', 'X-Anybox-Instance-Id': 'browser-forgery' }
    assert.equal((await fetch(`${gateway.url}${base}/connections/c/v1/apps/claude-agent/threads`, { headers })).status, 200)
    assert.equal(received[0].url, '/api/v1/apps/claude-agent/threads')
    assert.equal(received[0].headers.authorization, 'Bearer device-secret'); assert.equal(received[0].headers['x-anybox-instance-id'], instanceId)
    assert.equal(received[0].headers['x-anybox-product-id'], 'claude-agent'); assert.equal(received[0].headers['x-anybox-expected-instance-id'], undefined)
    assert.equal((await fetch(`${gateway.url}${base}/connections/c/v1/apps/claude-agent/threads`, { headers: { ...headers, 'X-Anybox-Connection-Revision': '1' } })).status, 409)
    assert.equal((await fetch(`${gateway.url}${base}/connections/c/v1/apps/agent/sessions`, { headers })).status, 404)
    assert.equal((await fetch(`${gateway.url}${base}/connections/c/v1/models`, { headers })).status, 404)
    assert.equal((await fetch(`${gateway.url}${base}/connections/missing/v1/instance`, { headers })).status, 404)
    assert.equal((await fetch(`${gateway.url}${base}/connections/c/v1/apps/claude-agent/threads?__anyboxInstanceId=${instanceId}`, { headers })).status, 400, 'reserved query bindings are refused')
    assert.equal(received.length, 1)
    const stream = await fetch(`${gateway.url}${base}/connections/c/v1/apps/claude-agent/events?threadId=t`, { headers })
    assert.match(stream.headers.get('content-type'), /text\/event-stream/)
    const reader = stream.body.getReader(), decoder = new TextDecoder()
    let text = ''
    while (!text.includes('run-changed')) { const next = await reader.read(); if (next.done) break; text += decoder.decode(next.value, { stream: true }) }
    assert.match(text, /event: ready/); assert.match(text, /"runId":"r"/)
    await reader.cancel().catch(() => {})
  } finally { await gateway.close(); await new Promise(resolve => upstream.close(resolve)) }
})
test('both client applications share the host connection library and the Claude Agent client reaches a remote execution device', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-claude-agent-client-')), secrets = new Map()
  const openEntry = (namespace, id) => { const key = `${namespace}:${id}`; return { getPassword: async () => secrets.get(key), setPassword: async value => { secrets.set(key, value) }, deleteCredential: async () => secrets.delete(key) } }
  const sdk = fakeSdk({ onClose(run) { run.finish({ kind: 'failed', error: { code: 'cancelled', message: 'terminated' } }); setTimeout(() => run.exit(), 10) } })
  const sdkComponent = { name: 'fake-claude-agent-sdk', apply(ctx) { ctx.provide(claudeAgentSdkServiceKey, sdk.port) } }
  let execution, client
  t.after(async () => { await client?.close(); await execution?.close(); await rm(directory, { recursive: true, force: true }) })
  execution = await createExecutionHost({ databasePath: join(directory, 'execution.sqlite'), applications: [claudeAgentServerApplication({}, { sdkComponent, runs: { directoryExists: async () => true } })] })
  await execution.ready
  client = await createClientHost({ path: join(directory, 'client.sqlite'), openEntry, localInstanceId: execution.instance.instanceId })
  const request = async (path, body, expected = 200) => {
    const response = await fetch(client.url + path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { Origin: client.url, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const data = await response.json(); assert.equal(response.status, expected, `${path}: ${JSON.stringify(data)}`); return data
  }
  assert.deepEqual((await request('/api/client/v1/products')).map(product => product.definition.id), ['agent', 'claude-agent'])
  assert.equal(client.products.get('claude-agent').state, 'disabled')
  await request(base + '/connections', undefined, 503)
  const token = await execution.root.get('host.access').issue('client')
  const saved = await client.root.get('client.connections').save({ name: 'Local device', endpoint: execution.url, token: token.token })
  assert.equal((await request('/api/client/v1/products/claude-agent/open', {})).state, 'running')
  assert.ok(client.root.get('claude-agent.gateway')); assert.equal(client.root.get('client.gateway'), undefined, 'the Harness client application stays closed')
  const listed = await request(base + '/connections')
  assert.equal(listed.connections[0].id, saved.id); assert.equal(listed.localInstanceId, execution.instance.instanceId)
  const device = `${base}/connections/${saved.id}/v1`
  assert.equal((await request(device + '/products/claude-agent')).state, 'disabled')
  assert.equal((await request(device + '/products/claude-agent/open', {})).state, 'running')
  assert.ok(execution.root.get('claude-agent.runs')); assert.equal(execution.root.get('models'), undefined)
  const thread = await request(device + '/apps/claude-agent/threads', { projectPath: '/projects/demo' }, 201)
  const run = await request(device + `/apps/claude-agent/threads/${thread.id}/runs`, { prompt: 'hello', idempotencyKey: 'k' }, 202)
  assert.equal(run.status, 'running')
  await waitFor(() => sdk.runs.length === 1)
  sdk.runs[0].hooks.onEvent({ type: 'init', init: { nativeSessionId: 's', model: 'm', cwd: '/projects/demo', permissionMode: 'default', claudeCodeVersion: '2.1.278', toolCount: 1 } })
  sdk.runs[0].finish({ kind: 'result', result: sampleResult() }); sdk.runs[0].exit()
  assert.equal((await request(device + `/apps/claude-agent/runs/${run.id}/wait`)).run.status, 'completed')
  assert.equal((await request(device + `/apps/claude-agent/threads/${thread.id}`)).nativeSessionId, 's')
  await request(device + '/apps/agent/sessions', undefined, 404)
  await request('/api/client/v1/products/claude-agent/stop', {})
  assert.equal(client.root.get('claude-agent.gateway'), undefined); assert.ok(client.root.get('client.connections'), 'connections remain a resident host provider')
  assert.equal(execution.products.get('claude-agent').state, 'running', 'closing the client application does not stop the execution device')
})
test('the native directory window is offered only for the confirmed local connection, with the connection binding and picker failures mapped', async () => {
  const instanceId = '22222222-2222-2222-2222-222222222222', remoteId = '33333333-3333-3333-3333-333333333333'
  const connections = [{ id: 'local', name: 'This Mac', endpoint: 'http://127.0.0.1:1', instanceId, revision: 3, credentialConfigured: true }, { id: 'remote', name: 'Server', endpoint: 'https://example.invalid', instanceId: remoteId, revision: 1, credentialConfigured: true }]
  let selection = '/Users/me/project', picks = 0
  const picker = { supported: true, async pick(signal) { picks++; if (selection === 'busy') throw new DirectoryPickerFailure('busy'); if (selection === 'unavailable') throw new DirectoryPickerFailure('unavailable'); if (signal?.aborted) return undefined; return selection } }
  const library = { list: async () => connections, acquire: async () => { throw new Error('not used') }, localStatus: () => ({ enabled: false, state: 'disabled', instanceId: null, connectionId: null }) }
  const gateway = await startGateway(library, { localInstanceId: instanceId, picker })
  const post = (id, headers = {}) => fetch(`${gateway.url}${base}/connections/${id}/pick`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: gateway.url, 'X-Anybox-Product-Id': 'claude-agent', ...headers }, body: '{}' })
  try {
    assert.deepEqual(await (await fetch(gateway.url + base + '/local')).json(), { instanceId, picker: true })
    const picked = await post('local', { 'X-Anybox-Expected-Instance-Id': instanceId, 'X-Anybox-Connection-Revision': '3' })
    assert.equal(picked.status, 200); assert.deepEqual(await picked.json(), { path: '/Users/me/project' })
    selection = undefined
    assert.deepEqual(await (await post('local', { 'X-Anybox-Expected-Instance-Id': instanceId, 'X-Anybox-Connection-Revision': '3' })).json(), { path: null }, 'cancelling the window is not an error')
    assert.equal((await post('remote', { 'X-Anybox-Expected-Instance-Id': remoteId, 'X-Anybox-Connection-Revision': '1' })).status, 403, 'remote devices never open a window on this machine')
    assert.equal((await post('missing')).status, 403)
    assert.equal((await post('local', { 'X-Anybox-Expected-Instance-Id': instanceId, 'X-Anybox-Connection-Revision': '2' })).status, 409, 'a stale connection revision is refused before the window opens')
    assert.equal(picks, 2)
    const bound = { 'X-Anybox-Expected-Instance-Id': instanceId, 'X-Anybox-Connection-Revision': '3' }
    selection = 'busy'; assert.deepEqual(await (await post('local', bound)).json(), { error: { code: 'picker-busy' } })
    selection = 'unavailable'; assert.deepEqual(await (await post('local', bound)).json(), { error: { code: 'picker-unavailable' } })
    assert.equal((await fetch(`${gateway.url}${base}/connections/local/pick?x=1`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: gateway.url }, body: '{}' })).status, 400)
  } finally { await gateway.close() }
})
