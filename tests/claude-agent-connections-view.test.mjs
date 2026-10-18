import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openConnectionManager } from '../packages/app-claude-agent/dist/web/connections.js'
import { installClaudeAgentDOM } from './helpers/claude-agent-dom.mjs'

const base = '/api/client/v1/apps/claude-agent'
const until = async check => { for (let turn = 0; turn < 100; turn++) { if (check()) return; await new Promise(resolve => setImmediate(resolve)) }; assert.fail('condition not met') }

test('Claude Agent manages its own connections without a Harness request and clears credential drafts', async t => {
  const dom = installClaudeAgentDOM(t), requests = [], original = globalThis.fetch
  let connections = [], changed = 0, manager
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url, init })
    if (url === base + '/local') return Response.json({ status: { enabled: true, state: 'disabled' } })
    if (url === base + '/connections' && init.method === 'POST') {
      const body = JSON.parse(init.body)
      connections = [{ id: 'saved', name: body.name, endpoint: body.endpoint, instanceId: 'device', revision: 1, credentialConfigured: true }]
      return Response.json(connections[0])
    }
    if (url === base + '/connections') return Response.json({ connections, localInstanceId: null })
    if (url === base + '/connections/saved/delete') { connections = []; return Response.json({ ok: true }) }
    assert.fail(`unexpected URL: ${url}`)
  }
  t.after(async () => { await manager?.close(); globalThis.fetch = original })
  manager = openConnectionManager(dom.container, base, id => 'own-' + id, async () => { changed++ })
  await until(() => !dom.find('.primary-button').disabled)
  dom.find('#own-connection-name').value = 'My device'
  dom.find('#own-connection-endpoint').value = 'https://device.example'
  const secret = dom.find('#own-connection-token'); secret.value = 'temporary-secret'
  dom.fire(dom.find('form'), 'submit')
  await until(() => changed === 1 && !dom.find('.primary-button').disabled)
  assert.equal(secret.value, '')
  assert.equal(dom.find('.ca-connections-list strong').textContent, 'My device')
  dom.find('[aria-label="删除 My device"]').click()
  await until(() => changed === 2)
  assert.equal(dom.all('.ca-connections-list li').length, 0)
  secret.value = 'unsaved-secret'
  await manager.close()
  assert.equal(secret.value, ''); assert.equal(dom.find('dialog'), null)
  assert.ok(requests.every(request => request.url.startsWith(base)))
})

test('closing a connection dialog removes secrets immediately and joins a late save without altering its replacement', async t => {
  const dom = installClaudeAgentDOM(t), original = globalThis.fetch
  let release, saveRequest, changed = 0, manager, replacement
  globalThis.fetch = async (url, init = {}) => {
    if (url === base + '/local') return Response.json({})
    if (url === base + '/connections' && init.method === 'POST') {
      saveRequest = init
      await new Promise(resolve => { release = resolve })
      return Response.json({ id: 'late' })
    }
    if (url === base + '/connections') return Response.json({ connections: [], localInstanceId: null })
    assert.fail(`unexpected URL: ${url}`)
  }
  t.after(async () => { release?.(); await manager?.close(); await replacement?.close(); globalThis.fetch = original })
  manager = openConnectionManager(dom.container, base, id => id, async () => { changed++ })
  await until(() => !dom.find('.primary-button').disabled)
  const secret = dom.find('#connection-token'); secret.value = 'old-secret'
  dom.find('#connection-name').value = 'Old'; dom.find('#connection-endpoint').value = 'https://old.example'
  dom.fire(dom.find('form'), 'submit'); await until(() => release)
  let closed = false
  const closing = manager.close().then(() => { closed = true })
  assert.equal(secret.value, ''); assert.equal(dom.find('dialog'), null); assert.equal(saveRequest.signal.aborted, true)
  await dom.flush(); assert.equal(closed, false)
  replacement = openConnectionManager(dom.container, base, id => id, async () => { changed++ })
  await until(() => !dom.find('.primary-button').disabled)
  dom.find('#connection-token').value = 'new-secret'
  release(); await closing
  assert.equal(dom.find('#connection-token').value, 'new-secret'); assert.equal(changed, 0)
})
