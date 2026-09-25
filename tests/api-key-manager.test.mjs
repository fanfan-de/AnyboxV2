import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApiKeyManager, createApiKeyService, createSystemKeyringStore, UnmanagedCredentialError } from '@anybox/api-key-manager'

test('the standalone manager supports unrelated services through one unchanged API', async () => {
  const values = new Map()
  const store = {
    read: async id => values.get(id),
    write: async (id, secret) => { values.set(id, secret) },
    delete: async id => values.delete(id),
  }
  const definitions = [
    { id: 'llm/example/default', label: 'LLM', category: 'language' },
    { id: 'video/example/default', label: 'Video', category: 'video' },
    { id: 'service/example/default', label: 'Other', category: 'service' },
  ]
  const manager = createApiKeyManager(definitions, store)
  assert.deepEqual(await manager.list(), definitions.map(item => ({ ...item, configured: false })))
  assert.deepEqual(await manager.write('video/example/default', 'video-secret'), { ...definitions[1], configured: true })
  assert.deepEqual(await manager.write('service/example/default', 'service-secret'), { ...definitions[2], configured: true })
  assert.equal(values.get('video/example/default'), 'video-secret')
  assert.equal(values.get('service/example/default'), 'service-secret')
  assert.doesNotMatch(JSON.stringify(await manager.list()), /-secret/)
  await assert.rejects(manager.write('unregistered', 'secret'), UnmanagedCredentialError)
  assert.equal(values.has('unregistered'), false)
  assert.deepEqual(await manager.delete('video/example/default'), { ...definitions[1], configured: false })
  assert.equal(values.has('video/example/default'), false)
  assert.equal(values.get('service/example/default'), 'service-secret')
  const reopened = createApiKeyManager(definitions, store)
  assert.equal((await reopened.list())[2].configured, true)
  assert.throws(() => createApiKeyManager([...definitions, definitions[0]], store), /unique/)
})

test('the standalone OS store can be supplied with a platform entry without Anybox or Nya', async () => {
  const values = new Map()
  const store = createSystemKeyringStore({ namespace: 'portable-test', openEntry(namespace, id) {
    const key = `${namespace}:${id}`
    return {
      async getPassword() { return values.get(key) },
      async setPassword(secret) { values.set(key, secret) },
      async deleteCredential() { return values.delete(key) },
    }
  } })
  try {
    await store.write('video/example/default', 'video-secret')
    assert.equal(await store.read('video/example/default'), 'video-secret')
    assert.equal(await store.delete('video/example/default'), true)
    assert.equal(await store.read('video/example/default'), undefined)
  } finally { await store.close() }
})

test('one self-contained service owns storage and management without injected project components', async () => {
  const values = new Map()
  const service = createApiKeyService({
    namespace: 'portable-test',
    definitions: [{ id: 'video/example/default', label: 'Video', category: 'video' }],
    openEntry(_namespace, id) {
      return {
        async getPassword() { return values.get(id) },
        async setPassword(value) { values.set(id, value) },
        async deleteCredential() { return values.delete(id) },
      }
    },
  })
  try {
    assert.equal(await service.read('video/example/default'), undefined)
    assert.equal((await service.write('video/example/default', 'secret')).configured, true)
    assert.equal(await service.read('video/example/default'), 'secret')
    assert.equal((await service.list())[0].configured, true)
    assert.throws(() => service.read('unregistered'), UnmanagedCredentialError)
    assert.equal((await service.delete('video/example/default')).configured, false)
    assert.equal(await service.read('video/example/default'), undefined)
  } finally { await service.close() }
})
