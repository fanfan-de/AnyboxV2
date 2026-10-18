import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { createDirectoryPickerComponent, directoryPickerServiceKey } from '../dist/index.js'

const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value }); return { promise, resolve } }

test('picker cancellation keeps admission busy and close waits for actual dialog exit', async () => {
  const entered = deferred(), exit = deferred(), root = new Context()
  let dialogSignal
  await root.installComponent(createDirectoryPickerComponent({ platform: 'darwin', runDialog: async signal => {
    dialogSignal = signal; entered.resolve(); await exit.promise; return '/selected'
  } }))
  const picker = root.get(directoryPickerServiceKey)
  const selected = picker.pick(); const rejected = assert.rejects(selected, { code: 'cancelled' })
  await entered.promise
  await assert.rejects(picker.pick(), { code: 'busy' })
  let closed = false
  const closing = root.fiber.dispose().then(() => { closed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(dialogSignal.aborted, true)
  assert.equal(closed, false)
  await assert.rejects(picker.pick(), { code: 'unavailable' })
  exit.resolve(); await rejected; await closing
  assert.equal(closed, true)
})

test('unsupported platform does not invoke a native dialog', async () => {
  const root = new Context(); let called = false
  await root.installComponent(createDirectoryPickerComponent({ platform: 'linux', runDialog: async () => { called = true; return '/selected' } }))
  try {
    const picker = root.get(directoryPickerServiceKey)
    assert.equal(picker.supported, false)
    await assert.rejects(picker.pick(), { code: 'unsupported' })
    assert.equal(called, false)
  } finally { await root.fiber.dispose() }
})
