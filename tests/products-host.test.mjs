import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHarnessServer } from '../dist/entrypoints/harness-server-main.js'
import { createClientHost } from '../dist/entrypoints/client-main.js'
import { parseHarnessServerConfig } from '../dist/applications/harness/server-config.js'

const request = async (url, path, body, expected = 200) => {
  const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { Origin: url, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const data = await response.json(); assert.equal(response.status, expected, `${path}: ${JSON.stringify(data)}`); return data
}
test('Harness owns local/remote connections and opening a remote Agent leaves local execution stopped', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-application-host-')), secrets = new Map()
  const openEntry = (namespace, id) => { const key = `${namespace}:${id}`; return {
    getPassword: async () => secrets.get(key), setPassword: async value => { secrets.set(key, value) }, deleteCredential: async () => secrets.delete(key),
  } }
  const config = name => parseHarnessServerConfig({ ANYBOX_HARNESS_DATABASE: join(directory, name + '.sqlite'), ANYBOX_MODELS_DATABASE: join(directory, name + '-models.sqlite') })
  const models = { openEntry, readLegacyCredential: async () => undefined, catalogAutoRefresh: false, fetch: async () => { throw new Error('no model network in this test') } }
  let local, remote, client
  try {
    local = await createHarnessServer(config('local'), { models }); remote = await createHarnessServer(config('remote'), { models })
    await Promise.all([local.ready, remote.ready])
    client = await createClientHost({ path: join(directory, 'client.sqlite'), localInstanceId: local.instance.instanceId, openEntry })
    assert.equal(client.root.get('client.connections'), undefined); assert.equal(client.root.get('client.gateway'), undefined)
    assert.equal(client.root.get('host.directory-picker'), undefined)
    assert.equal((await request(client.url, '/api/client/v1/products'))[0].definition.name, 'Anybox Harness')
    await request(client.url, '/api/client/v1/connections', undefined, 503)
    await request(client.url, '/api/client/v1/products', { name: 'Models', pages: [] }, 404)
    await request(client.url, '/api/client/v1/products/modules', undefined, 404)
    assert.equal((await request(client.url, '/api/client/v1/products/agent/open', {})).state, 'running')
    assert.ok(client.root.get('client.connections')); assert.ok(client.root.get('client.gateway'))
    assert.equal(client.root.get('models'), undefined); assert.equal(client.root.get('harness.runs'), undefined)
    const token = await remote.root.get('host.access').issue('Client')
    const connection = await request(client.url, '/api/client/v1/connections', { name: 'Remote Agent', endpoint: remote.url, token: token.token })
    const base = `/api/connections/${connection.id}/v1`
    assert.equal((await request(client.url, base + '/products/agent')).state, 'disabled')
    assert.equal((await request(client.url, base + '/products/agent/open', {})).state, 'running')
    assert.ok(remote.root.get('models')); assert.ok(remote.root.get('harness.sessions'))
    assert.equal(local.api, undefined); assert.equal(existsSync(config('local').modelsDatabasePath), false)
    const prompt = await request(client.url, base + '/prompts', { name: 'Retained', kind: 'context', role: 'user', content: 'Saved on remote' })
    const activity = remote.root.get('app.activity'), lease = activity.enter('agent')
    await request(client.url, base + '/products/agent/stop', {}, 409)
    assert.equal(remote.products.get('agent').desiredEnabled, true); lease.release()
    assert.equal((await request(client.url, base + '/products/agent/stop', {})).state, 'disabled')
    assert.equal(remote.root.get('models'), undefined)
    await request(client.url, base + '/products/agent/open', {})
    assert.equal((await request(client.url, base + `/prompts/${prompt.id}`)).draft.content, 'Saved on remote')
    const activeWrite = client.root.get('app.activity').enter('agent')
    await request(client.url, '/api/client/v1/products/agent/stop', {}, 409); activeWrite.release()
    await request(client.url, '/api/client/v1/products/agent/stop', {})
    assert.equal(client.root.get('client.connections'), undefined); assert.equal(client.root.get('client.gateway'), undefined)
    assert.equal(remote.products.get('agent').state, 'running', 'closing the client does not stop a remote Agent')
    assert.equal((await fetch(client.url)).status, 200)
    await request(client.url, '/api/client/v1/connections', undefined, 503)
    await request(client.url, '/api/client/v1/products/agent/open', {})
    assert.equal((await request(client.url, '/api/client/v1/connections'))[0].id, connection.id)
    await client.close(); client = await createClientHost({ path: join(directory, 'client.sqlite'), openEntry })
    assert.equal(client.products.get('agent').state, 'running'); assert.equal((await request(client.url, '/api/client/v1/connections'))[0].id, connection.id)
    assert.equal(local.products.get('agent').state, 'disabled')
  } finally { await client?.close(); await remote?.close(); await local?.close(); await rm(directory, { recursive: true, force: true }) }
})
