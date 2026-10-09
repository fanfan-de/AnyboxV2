import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { Context, FiberState } from '@nya/core'
import { createModelsVaultComponent, modelsVaultServiceKey } from '@anybox/models'

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
  const script = `
    import { Context } from '@nya/core'
    import { createModelsVaultComponent, modelsVaultServiceKey } from '@anybox/models'
    const root = new Context()
    await root.installComponent(createModelsVaultComponent({ namespace: ${JSON.stringify(namespace)} }))
    const value = await root.get(modelsVaultServiceKey).read(${JSON.stringify(id)})
    await root.fiber.dispose()
    process.stdout.write(JSON.stringify(value ?? null))
  `
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { cwd: resolve('.') })
  return JSON.parse(stdout)
}

test('the platform credential store writes, reads across processes, and deletes under a private namespace',
  { skip: skipUnless(enabled && !expectNoStore) }, async () => {
    const namespace = `anybox-test-${randomUUID()}`
    const id = 'llm/chat-completions/test'
    const root = new Context()
    const fiber = root.installComponent(createModelsVaultComponent({ namespace }))
    await fiber
    assert.equal(fiber.state, FiberState.ACTIVE)
    const read = root.get(modelsVaultServiceKey)
    const manage = root.get(modelsVaultServiceKey)
    try {
      assert.equal(await read.read(id), undefined)
      await manage.write(id, 'first-secret')
      assert.equal(await read.read(id), 'first-secret')
      await manage.write(id, 'second-secret')
      assert.equal(await read.read(id), 'second-secret')
      assert.equal(await readInChildProcess(namespace, id), 'second-secret')
      await manage.delete(id)
      assert.equal(await read.read(id), undefined)
      assert.equal(await readInChildProcess(namespace, id), null)
      await manage.delete(id)
    } finally {
      try { await manage.delete(id) } catch {}
      await root.fiber.dispose()
    }
  })

test('Linux without Secret Service refuses credential access rather than falling back to the kernel keyring',
  { skip: skipUnless(enabled && expectNoStore) }, async () => {
    const root = new Context()
    const fiber = root.installComponent(createModelsVaultComponent({ namespace: `anybox-test-${randomUUID()}` }))
    try { await fiber } catch {}
    try {
      assert.equal(process.platform, 'linux')
      assert.equal(fiber.state, FiberState.ACTIVE)
      await assert.rejects(root.get(modelsVaultServiceKey).read('test'), error => error.code === 'credential-unavailable')
    } finally { await root.fiber.dispose() }
  })
