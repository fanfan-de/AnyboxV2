import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context, FiberState } from '@nya/core'
import { createExternalCredentialSourceComponent } from '../dist/credentials/external-source.js'
import { CredentialFailure, credentialManageServiceKey, credentialReadServiceKey } from '../dist/credentials/port.js'
import { createSystemKeyringComponent } from '../dist/credentials/system-keyring.js'
import { deferred } from './helpers/controlled-llm.mjs'
import { memoryCredentials } from './helpers/memory-credentials.mjs'

/** An in-memory stand-in for the platform store. Every operation is recorded with its namespace, id and signal. */
function fakeStore() {
  const secrets = new Map()
  const operations = []
  const api = {
    secrets, operations, failure: undefined, holding: false, unavailable: false,
    openEntry(namespace, id) {
      if (api.unavailable) throw new Error('org.freedesktop.secrets is not on the session bus at /run/user/1000/bus')
      const key = `${namespace}\u0000${id}`
      const track = async (kind, signal, work) => {
        const entry = { kind, namespace, id, aborted: deferred(), released: deferred() }
        signal.addEventListener('abort', () => entry.aborted.resolve(signal.reason))
        operations.push(entry)
        // A native task that already runs cannot be interrupted; it exits when released and reports the abort then.
        if (api.holding) await entry.released.promise
        if (signal.aborted) throw new Error('native task aborted')
        if (api.failure) throw api.failure
        return work()
      }
      return {
        getPassword: signal => track('read', signal, () => secrets.get(key)),
        setPassword: (secret, signal) => track('write', signal, () => { secrets.set(key, secret) }),
        deleteCredential: signal => track('delete', signal, () => secrets.delete(key)),
      }
    },
    release() { for (const operation of operations) operation.released.resolve() },
  }
  return api
}

async function keyringFixture(store, namespace = 'anybox-test') {
  const root = new Context()
  const fiber = root.installComponent(createSystemKeyringComponent({ namespace, openEntry: store.openEntry }))
  try { await fiber } catch {}
  return {
    root, fiber,
    read: root.get(credentialReadServiceKey), manage: root.get(credentialManageServiceKey),
    close: () => root.fiber.dispose(),
  }
}

const settle = promise => promise.then(() => {}, () => {})

test('the system keyring files secrets under its namespace and reports absence as undefined', async () => {
  const store = fakeStore()
  const f = await keyringFixture(store)
  const other = await keyringFixture(store, 'anybox-other')
  try {
    assert.equal(f.fiber.state, FiberState.ACTIVE)
    assert.equal(await f.read.read('llm/deepseek-chat-completions/default'), undefined)
    await f.manage.write('llm/deepseek-chat-completions/default', 'sk-first')
    assert.equal(await f.read.read('llm/deepseek-chat-completions/default'), 'sk-first')
    assert.deepEqual(store.operations.map(item => [item.kind, item.namespace, item.id]), [
      ['read', 'anybox-test', 'llm/deepseek-chat-completions/default'],
      ['write', 'anybox-test', 'llm/deepseek-chat-completions/default'],
      ['read', 'anybox-test', 'llm/deepseek-chat-completions/default'],
    ])
    assert.equal(await other.read.read('llm/deepseek-chat-completions/default'), undefined)
    await f.manage.write('llm/deepseek-chat-completions/default', 'sk-second')
    assert.equal(await f.read.read('llm/deepseek-chat-completions/default'), 'sk-second')
    assert.equal(await f.manage.delete('llm/deepseek-chat-completions/default'), true)
    assert.equal(await f.read.read('llm/deepseek-chat-completions/default'), undefined)
    assert.equal(await f.manage.delete('llm/deepseek-chat-completions/default'), false)

    assert.throws(() => createSystemKeyringComponent({ namespace: ' ' }), /namespace/)
    assert.throws(() => createSystemKeyringComponent({ namespace: 'x', openEntry: 'nope' }), /entry factory/)
    await assert.rejects(f.read.read(''), /credential id/)
    await assert.rejects(f.manage.write('id', ''), /credential secret/)
    await assert.rejects(f.manage.write('id', 42), /credential secret/)
    await assert.rejects(f.manage.delete(undefined), /credential id/)
  } finally { await f.close(); await other.close() }
})

test('an unavailable store fails startup with a fixed category and registers no service', async () => {
  const store = fakeStore()
  store.unavailable = true
  const f = await keyringFixture(store)
  try {
    assert.equal(f.fiber.state, FiberState.FAILED)
    assert.equal(f.fiber.error?.category, 'store-unavailable')
    assert.equal(String(f.fiber.error?.message).includes('freedesktop'), false)
    assert.equal(f.read, undefined)
    assert.equal(f.manage, undefined)
  } finally { await f.close() }
})

test('store failures are normalized and never carry native text, entry names or secrets', async () => {
  const store = fakeStore()
  const f = await keyringFixture(store)
  try {
    store.failure = new Error('keychain item sk-secret-value for anybox-test denied at /Users/me/Library')
    for (const attempt of [
      () => f.read.read('id'), () => f.manage.write('id', 'sk-secret-value'), () => f.manage.delete('id'),
    ]) {
      const error = await attempt().then(() => assert.fail('expected rejection'), error => error)
      assert.ok(error instanceof CredentialFailure)
      assert.equal(error.category, 'operation-failed')
      assert.equal(error.message, 'credential store operation failed')
      assert.equal(error.cause, undefined)
      assert.equal(JSON.stringify(error).includes('sk-secret-value'), false)
    }
    assert.equal(f.fiber.state, FiberState.ACTIVE)
  } finally { await f.close() }
})

test('reads and mutations of one key follow admission order, including a held native operation', async () => {
  const store = fakeStore()
  const f = await keyringFixture(store)
  try {
    await f.manage.write('id', 'old')
    store.holding = true
    const first = f.read.read('id')
    await new Promise(resolve => setImmediate(resolve))
    const writing = f.manage.write('id', 'new')
    const second = f.read.read('id')
    assert.equal(store.operations.length, 2)
    store.operations[1].released.resolve()
    assert.equal(await first, 'old')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(store.operations[2].kind, 'write')
    store.operations[2].released.resolve()
    await writing
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(store.operations[3].kind, 'read')
    store.operations[3].released.resolve()
    assert.equal(await second, 'new')
  } finally { store.release(); await f.close() }
})

test('a cancelled read waits for native exit and never returns a late value', async () => {
  const store = fakeStore()
  store.holding = true
  const f = await keyringFixture(store)
  try {
    const controller = new AbortController()
    const reading = f.read.read('id', controller.signal)
    await new Promise(resolve => setImmediate(resolve))
    controller.abort('run-cancelled')
    assert.equal(await store.operations[0].aborted.promise, 'run-cancelled')
    let exited = false
    void settle(reading).then(() => { exited = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(exited, false)
    store.release()
    await assert.rejects(reading, error => error.category === 'cancelled')
    assert.equal(exited, true)
  } finally { store.release(); await f.close() }
})

test('disposing the system keyring aborts and joins a held read', async () => {
  const store = fakeStore()
  store.holding = true
  const f = await keyringFixture(store)
  try {
    const reading = f.read.read('id')
    await new Promise(resolve => setImmediate(resolve))
    let disposed = false
    const disposing = f.fiber.dispose().then(() => { disposed = true })
    assert.equal(await store.operations[0].aborted.promise, 'credentials-disposed')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(disposed, false)
    await assert.rejects(f.read.read('id'), error => error.category === 'closed')
    store.release()
    await assert.rejects(reading, error => error.category === 'cancelled')
    await disposing
  } finally { store.release(); await f.close() }
})

test('the external source component serves a trusted reader and reports its failures as store-unavailable', async () => {
  const credentials = memoryCredentials({ 'llm/deepseek-chat-completions/default': 'sk-external' })
  const root = new Context()
  const fiber = root.installComponent(credentials.component())
  await fiber
  const read = root.get(credentialReadServiceKey)
  try {
    assert.equal(fiber.state, FiberState.ACTIVE)
    assert.equal(root.get(credentialManageServiceKey), undefined)
    assert.equal(await read.read('llm/deepseek-chat-completions/default'), 'sk-external')
    assert.equal(await read.read('other'), undefined)
    await assert.rejects(read.read(' '), /credential id/)

    credentials.failure = new Error('vault at https://vault.internal:8200 returned 503')
    const failure = await read.read('other').then(() => assert.fail('expected rejection'), error => error)
    assert.ok(failure instanceof CredentialFailure)
    assert.equal(failure.category, 'store-unavailable')
    assert.equal(failure.message.includes('vault'), false)
    credentials.failure = undefined

    credentials.secrets.set('number', 42)
    await assert.rejects(read.read('number'), TypeError)
    credentials.secrets.set('nothing', null)
    assert.equal(await read.read('nothing'), undefined)
    assert.throws(() => createExternalCredentialSourceComponent({}), /read\(\)/)
    assert.throws(() => createExternalCredentialSourceComponent(), /read\(\)/)
  } finally { await root.fiber.dispose() }
})

test('disposing the external source aborts held reads, refuses new ones and waits for the host reader to exit', async () => {
  const credentials = memoryCredentials({ id: 'value' })
  credentials.holding = true
  const root = new Context()
  const fiber = root.installComponent(credentials.component())
  await fiber
  const read = root.get(credentialReadServiceKey)
  try {
    const reading = read.read('id')
    let disposed = false
    const disposing = fiber.dispose().then(() => { disposed = true })
    assert.equal(await credentials.reads[0].aborted.promise, 'credentials-disposed')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(disposed, false)
    await assert.rejects(read.read('id'), error => error.category === 'closed')
    credentials.release()
    await assert.rejects(reading, error => error.category === 'cancelled')
    await disposing
    assert.equal(root.get(credentialReadServiceKey), undefined)
    assert.equal(credentials.reads.length, 1)
    await settle(fiber.restart())
  } finally { credentials.release(); await root.fiber.dispose() }
})
