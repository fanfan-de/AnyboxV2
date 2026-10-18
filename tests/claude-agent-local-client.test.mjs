import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createClientHost } from '../packages/host/dist/client.js'
import { createExecutionHost } from '../packages/host/dist/execution.js'
import { claudeAgentClientApplication } from '../packages/app-claude-agent/dist/client/registration.js'
import { claudeAgentServerApplication } from '../packages/app-claude-agent/dist/registration.js'
import { claudeAgentSdkServiceKey } from '../packages/app-claude-agent/dist/core/sdk/port.js'
import { createDeviceClient } from '../packages/app-claude-agent/dist/web/client.js'
import { fakeSdk, fakeEnvironment, sampleResult } from './helpers/claude-agent.mjs'

const base = '/api/client/v1/apps/claude-agent'
const instanceId = '11111111-2222-3333-4444-555555555555'
async function fixture(t, channel) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-claude-local-client-'))
  let vaultOpens = 0
  const host = await createClientHost({ path: join(directory, 'client.sqlite'), applications: [claudeAgentClientApplication({
    localChannel: channel, openEntry() { vaultOpens++; throw Error('local execution must not open the Vault') },
  })] })
  t.after(async () => { await host.close(); await rm(directory, { recursive: true, force: true }) })
  const call = async (path, body, headers = {}) => {
    const response = await fetch(host.url + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...(body === undefined ? {} : { Origin: host.url, 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, value: await response.json() }
  }
  await call('/api/client/v1/products/claude-agent/open', {})
  return { host, call, vaultOpens: () => vaultOpens }
}
test('a managed local target needs neither a saved connection nor a Vault credential', async t => {
  const messages = []
  const channel = { async request(value) {
    messages.push(value)
    if (value.type === 'describe') return { instanceId, name: '本机', capabilities: ['claude-agent.v1'] }
    if (value.type === 'reserve') return { requestId: value.requestId, instanceId, reserved: true }
    if (value.type === 'watch') return { instanceId, closed: true }
    if (value.type === 'request') return { requestId: value.requestId, instanceId, status: 200, headers: { 'content-type': 'application/json' }, chunk: Buffer.from('{"state":"disabled"}').toString('base64'), done: true }
    if (value.type === 'close') return { instanceId, closed: true }
    assert.fail(`unexpected channel message ${value.type}`)
  } }
  const f = await fixture(t, channel)
  const local = await f.call(base + '/local')
  assert.deepEqual(local.value, { managed: true, instanceId, picker: false, device: { id: 'local', kind: 'local', name: '本机', instanceId, revision: 1 } })
  assert.deepEqual((await f.call(base + '/connections')).value.connections, [])
  const headers = { 'X-Anybox-Product-Id': 'claude-agent', 'X-Anybox-Expected-Instance-Id': instanceId, 'X-Anybox-Connection-Revision': '1', Authorization: 'browser-secret' }
  assert.deepEqual(await f.call(base + '/local/v1/products/claude-agent', undefined, headers), { status: 200, value: { state: 'disabled' } })
  const sent = messages.find(value => value.type === 'request')
  assert.deepEqual(sent, { type: 'request', requestId: sent.requestId, reserved: true, method: 'GET', path: '/products/claude-agent', instanceId })
  assert.match(sent.requestId, /^[0-9a-f-]{36}$/)
  assert.equal(messages.find(value => value.type === 'reserve').requestId, sent.requestId)
  assert.equal(f.vaultOpens(), 0)
  assert.equal((await f.call(base + '/local/v1/apps/agent/sessions', undefined, headers)).status, 404)
  assert.equal((await f.call(base + '/local/v1/access/tokens', {}, headers)).status, 404)
  assert.equal((await f.call(base + '/local/v1/products/claude-agent', undefined, { ...headers, 'X-Anybox-Connection-Revision': '2' })).status, 409)
  assert.equal(messages.filter(value => value.type === 'request').length, 1)
  await f.call('/api/client/v1/products/claude-agent/stop', {})
  assert.equal(messages.some(value => /issue|pair|token|stop/.test(value.type)), false, 'closing this client does not stop execution or pair a device')
})
test('local SSE uses the private channel with backpressure and closes its observer after disconnect', async t => {
  let readEntered, closeObserved
  const entered = new Promise(resolve => { readEntered = resolve }), closed = new Promise(resolve => { closeObserved = resolve })
  const channel = { async request(value, signal) {
    if (value.type === 'describe') return { instanceId, name: '本机', capabilities: ['claude-agent.v1'] }
    if (value.type === 'reserve') return { requestId: value.requestId, instanceId, reserved: true }
    if (value.type === 'watch') {
      await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }) })
      return { instanceId, closed: true }
    }
    if (value.type === 'request') return { requestId: value.requestId, instanceId, status: 200, headers: { 'content-type': 'text/event-stream' }, chunk: Buffer.from('event: ready\ndata: {}\n\n').toString('base64'), done: false }
    if (value.type === 'read') {
      readEntered()
      await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }) })
      throw Object.assign(Error('cancelled'), { code: 'cancelled' })
    }
    if (value.type === 'close') { closeObserved(); return { instanceId, closed: true } }
    assert.fail(`unexpected channel message ${value.type}`)
  } }
  const f = await fixture(t, channel)
  const response = await fetch(f.host.url + base + '/local/v1/apps/claude-agent/events?threadId=t')
  assert.match(response.headers.get('content-type'), /event-stream/)
  const reader = response.body.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/)
  await entered
  await reader.cancel()
  await closed
  assert.equal(f.vaultOpens(), 0)
})
test('unavailable local execution stays distinct from remote connection configuration', async t => {
  const f = await fixture(t, { request: async () => { throw Object.assign(Error('not ready'), { code: 'channel-unavailable' }) } })
  assert.deepEqual((await f.call(base + '/local')).value, { managed: true, instanceId: null, picker: false, error: { code: 'local-execution-unavailable' } })
  assert.deepEqual((await f.call(base + '/connections')).value.connections, [])
  assert.deepEqual(await f.call(base + '/local/v1/instance'), { status: 503, value: { error: { code: 'local-execution-unavailable' } } })
  assert.equal(f.vaultOpens(), 0)
})
test('browser local requests and directory selection use local routes without a connection id', async t => {
  const original = globalThis.fetch, calls = []
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return Response.json(url.endsWith('/pick') ? { path: '/projects/demo' } : { state: 'running' }) }
  t.after(() => { globalThis.fetch = original })
  const client = createDeviceClient(base, { id: 'local', kind: 'local', name: '本机', instanceId, revision: 1 }, new AbortController().signal)
  assert.deepEqual(await client.request('/products/claude-agent'), { state: 'running' })
  assert.equal(await client.pickDirectory(), '/projects/demo')
  assert.deepEqual(calls.map(call => call.url), [base + '/local/v1/products/claude-agent', base + '/local/pick'])
  assert.ok(calls.every(call => !('Authorization' in call.init.headers)))
})

test('the real client gateway and execution adapter exchange business JSON and SSE without pairing', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-claude-private-roles-')), sdk = fakeSdk()
  const account = { schemaVersion: 1, checkedAt: new Date().toISOString(), account: { email: 'qa@example.com', organization: null, subscription: 'max', provider: 'firstParty' }, accountError: null, quotas: { status: 'available', reason: null, fiveHour: { usedPercent: 3, resetsAt: '2026-10-19T00:00:00Z' }, weekly: { usedPercent: 16, resetsAt: null } } }
  sdk.port.readAccountUsage = async cwd => { assert.equal(cwd, undefined); return account }
  const sdkComponent = { name: 'private-role-sdk', apply(ctx) { ctx.provide(claudeAgentSdkServiceKey, sdk.port) } }
  const application = claudeAgentServerApplication({}, { sdkComponent, runs: { directoryExists: async () => true } })
  const execution = await createExecutionHost({ databasePath: join(directory, 'execution.sqlite'), applications: [application] })
  await execution.ready
  t.after(async () => { await execution.close(); await rm(directory, { recursive: true, force: true }) })
  const f = await fixture(t, { request: (payload, signal) => application.channel.handle(execution.root, payload, { signal, sourceRole: 'client', appId: 'claude-agent' }) })
  assert.deepEqual((await f.call(base + '/connections')).value.connections, [])
  assert.equal((await f.call(base + '/local')).value.device.kind, 'local')
  assert.equal(execution.products.get('claude-agent').state, 'disabled')
  assert.equal((await f.call(base + '/local/v1/products/claude-agent/open', {})).value.state, 'running')
  assert.deepEqual((await f.call(base + '/local/v1/apps/claude-agent/environment')).value, fakeEnvironment)
  const accountReply = await f.call(base + '/local/v1/apps/claude-agent/account')
  assert.equal(accountReply.status, 200); assert.deepEqual(accountReply.value, account)
  assert.equal((await f.call(base + '/local/v1/apps/claude-agent/account?threadId=a&cwd=%2Fb')).status, 400)
  assert.equal((await f.call(base + '/local/v1/apps/claude-agent/account?cwd=relative')).status, 400)
  assert.equal((await f.call(base + '/local/v1/apps/claude-agent/account?unexpected=yes')).status, 400)
  assert.equal((await f.call(base + '/local/v1/apps/claude-agent/account', {})).status, 404)
  const thread = (await f.call(base + '/local/v1/apps/claude-agent/threads', { projectPath: '/projects/demo' })).value
  const app=base+'/local/v1/apps/claude-agent',bytes=Buffer.from('private channel attachment\n'.repeat(16000))
  let upload=(await f.call(app+'/attachments',{name:'notes.txt',mime:'text/plain',size:bytes.length,idempotencyKey:'local-asset'})).value
  assert.ok(upload.id,'new upload route is admitted by the client gateway')
  while(!upload.ready){const part=await f.call(`${app}/attachments/${upload.id}/chunks`,{offset:upload.received,data:bytes.subarray(upload.received,upload.received+192*1024).toString('base64')});assert.equal(part.status,200);upload=part.value}
  const run=(await f.call(`${app}/threads/${thread.id}/runs`,{prompt:'read the attachment',attachmentIds:[upload.id],idempotencyKey:'local-input'})).value
  assert.equal(run.attachments[0].name,'notes.txt');assert.equal('data' in run.attachments[0],false)
  const native=sdk.runs[0];native.handle.enqueue=(message,assets)=>{assert.deepEqual(Buffer.from(assets[0].data,'base64'),bytes);native.hooks.onEvent({type:'input',message})};native.handle.cancelInput=id=>{const message=execution.root.get('claude-agent.runs').getRunView(run.id).inputs.find(m=>m.id===id);native.hooks.onEvent({type:'input',message:{...message,status:'cancelled'}});return true}
  const queued=await f.call(`${app}/runs/${run.id}/messages`,{prompt:'follow up',attachmentIds:[upload.id],idempotencyKey:'local-follow-up'});assert.equal(queued.status,202)
  assert.equal((await f.call(`${app}/runs/${run.id}/messages`)).value.length,1)
  assert.equal((await f.call(`${app}/runs/${run.id}/messages/${queued.value.id}/cancel`,{})).status,200)
  sdk.port.listNativeSessions=async()=>[{sessionId:instanceId,title:'Native session',updatedAt:new Date().toISOString()}];sdk.port.readSessionInfo=async()=>({title:'Native session'})
  assert.equal((await f.call(`${app}/threads/${thread.id}/native-sessions`)).status,200)
  assert.equal((await f.call(`${app}/threads/${thread.id}/native-sessions`,{sessionId:instanceId})).status,201)
  native.finish({kind:'result',result:sampleResult()});native.exit();await execution.root.get('claude-agent.runs').waitRun(run.id)
  assert.equal((await f.call(`${app}/attachments/${upload.id}/discard`,{})).status,409,'referenced attachments remain protected through the private channel')
  const stream = await fetch(f.host.url + base + `/local/v1/apps/claude-agent/events?threadId=${thread.id}`)
  const reader = stream.body.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/)
  await f.call('/api/client/v1/products/claude-agent/stop', {})
  await reader.cancel().catch(() => {})
  assert.equal(execution.products.get('claude-agent').state, 'running')
  assert.deepEqual(await execution.root.get('host.access').list(), [])
  assert.equal(f.vaultOpens(), 0)
})
