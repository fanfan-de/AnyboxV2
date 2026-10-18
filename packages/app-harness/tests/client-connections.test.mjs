import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '@anybox/storage-sqlite'
import { createConnectionsComponent, connectionsServiceKey } from '../dist/client/connections.js'
import { expectedConnection, requestBinding } from '../dist/client/connection-proxy.js'

const instance = { instanceId: '10000000-0000-0000-0000-000000000001', name: 'Device', apiVersion: 1, capabilities: ['tokens'] }
const token = '20000000-0000-0000-0000-000000000002.' + 'A'.repeat(43)
const memoryKeys = values => (_namespace, id) => ({
  async getPassword() { return values.get(id) },
  async setPassword(value) { values.set(id, value) },
  async deleteCredential() { values.delete(id) },
})
async function open(file, values) {
  const root = new Context()
  await root.installComponent(createLocalSqliteComponent(file))
  await root.installComponent(createConnectionsComponent({ openEntry: memoryKeys(values), fetch: async () => new Response(JSON.stringify(instance)) }))
  return { root, connections: root.get(connectionsServiceKey) }
}

test('agent connections preserve identity, revision and credential reference across reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-connections-package-')), file = join(directory, 'client.sqlite'), keys = new Map()
  let current
  try {
    current = await open(file, keys)
    const saved = await current.connections.save({ name: 'Device', endpoint: 'https://device.example', token })
    assert.equal(saved.instanceId, instance.instanceId)
    assert.equal(saved.revision, 1)
    assert.equal((await current.connections.acquire(saved.id)).token, token)
    await current.root.fiber.dispose()
    assert.equal((await readFile(file)).includes(Buffer.from(token)), false)
    current = await open(file, keys)
    const [restored] = await current.connections.list()
    assert.deepEqual(restored, saved)
    const renamed = await current.connections.save({ ...saved, name: 'Renamed', expectedRevision: saved.revision })
    assert.equal(renamed.id, saved.id)
    assert.equal(renamed.revision, 2)
    assert.equal((await current.connections.acquire(saved.id)).token, token)
    await current.connections.remove(saved.id, renamed.revision)
    assert.deepEqual(await current.connections.list(), [])
    assert.equal(keys.size, 0)
  } finally { await current?.root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
})

test('forwarding contract rejects stale identity and revision before sending upstream work', () => {
  const connection = { instanceId: instance.instanceId, revision: 3 }
  const binding = requestBinding({ headers: { 'x-anybox-expected-instance-id': instance.instanceId, 'x-anybox-connection-revision': '2' } })
  assert.throws(() => expectedConnection(binding, connection), { code: 'connection-changed', status: 409 })
  assert.throws(() => requestBinding({ headers: {} }, new URLSearchParams('__anyboxInstanceId=' + instance.instanceId)), { code: 'invalid-input', status: 400 })
})
