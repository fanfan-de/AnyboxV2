import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Context, FiberState } from '@nya/core'
import { credentialManageServiceKey, credentialReadServiceKey } from '../dist/credentials/port.js'
import { createSystemKeyringComponent } from '../dist/credentials/system-keyring.js'

/**
 * Real credential store tests. They touch the operating system's store, may prompt for access on a desktop, and need
 * a store to exist, so `npm test` skips them unless ANYBOX_KEYRING_TESTS=1 is set on the machine under test.
 * On a Linux machine without Secret Service, set ANYBOX_KEYRING_EXPECT_NO_STORE=1 as well to check the refusal path.
 */
const enabled = process.env.ANYBOX_KEYRING_TESTS === '1'
const expectNoStore = process.env.ANYBOX_KEYRING_EXPECT_NO_STORE === '1'
const skipUnless = condition => condition
  ? false
  : 'set ANYBOX_KEYRING_TESTS=1 on the machine under test; add ANYBOX_KEYRING_EXPECT_NO_STORE=1 only on Linux without Secret Service'

/** A separate process stands in for an application restart reading the stored key. */
async function readInChildProcess(namespace, id) {
  const importUrl = file => JSON.stringify(pathToFileURL(resolve('dist/credentials', file)).href)
  const script = `
    import { Context } from '@nya/core'
    import { createSystemKeyringComponent } from ${importUrl('system-keyring.js')}
    import { credentialReadServiceKey } from ${importUrl('port.js')}
    const root = new Context()
    await root.installComponent(createSystemKeyringComponent({ namespace: ${JSON.stringify(namespace)} }))
    const value = await root.get(credentialReadServiceKey).read(${JSON.stringify(id)})
    await root.fiber.dispose()
    process.stdout.write(JSON.stringify(value ?? null))
  `
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { cwd: resolve('.') })
  return JSON.parse(stdout)
}

test('the platform credential store writes, reads across processes, and deletes under a private namespace',
  { skip: skipUnless(enabled && !expectNoStore) }, async () => {
    const namespace = `anybox-test-${randomUUID()}`
    const id = 'llm/deepseek-chat-completions/test'
    const root = new Context()
    const fiber = root.installComponent(createSystemKeyringComponent({ namespace }))
    await fiber
    assert.equal(fiber.state, FiberState.ACTIVE)
    const read = root.get(credentialReadServiceKey)
    const manage = root.get(credentialManageServiceKey)
    try {
      assert.equal(await read.read(id), undefined)
      await manage.write(id, 'first-secret')
      assert.equal(await read.read(id), 'first-secret')
      await manage.write(id, 'second-secret')
      assert.equal(await read.read(id), 'second-secret')
      assert.equal(await readInChildProcess(namespace, id), 'second-secret')
      assert.equal(await manage.delete(id), true)
      assert.equal(await read.read(id), undefined)
      assert.equal(await readInChildProcess(namespace, id), null)
      assert.equal(await manage.delete(id), false)
    } finally {
      try { await manage.delete(id) } catch {}
      await root.fiber.dispose()
    }
  })

test('Linux without Secret Service refuses to start rather than falling back to the kernel keyring',
  { skip: skipUnless(enabled && expectNoStore) }, async () => {
    const root = new Context()
    const fiber = root.installComponent(createSystemKeyringComponent({ namespace: `anybox-test-${randomUUID()}` }))
    try { await fiber } catch {}
    try {
      assert.equal(process.platform, 'linux')
      assert.equal(fiber.state, FiberState.FAILED)
      assert.equal(fiber.error?.category, 'store-unavailable')
      assert.equal(root.get(credentialReadServiceKey), undefined)
      assert.equal(root.get(credentialManageServiceKey), undefined)
    } finally { await root.fiber.dispose() }
  })
