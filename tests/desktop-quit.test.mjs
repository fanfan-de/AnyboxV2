import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { desktopBeforeUnloadProbe, prepareDesktopQuit } from '../dist/desktop/quit.js'

function fixture(overrides = {}) {
  const calls = []
  const options = {
    async canLeave() { calls.push('page'); return true },
    async confirmDiscard() { calls.push('discard'); return true },
    async inspectActivity() { calls.push('inspect'); return { busy: false } },
    async confirmCancelRuns() { calls.push('cancel-runs'); return true },
    async releaseActivity() { calls.push('release') },
    ...overrides,
  }
  return { calls, options }
}

test('declining dirty-page discard does not inspect or freeze backend activity', async () => {
  const f = fixture()
  f.options.canLeave = async () => { f.calls.push('page'); return false }
  f.options.confirmDiscard = async () => { f.calls.push('discard'); return false }
  assert.equal(await prepareDesktopQuit(f.options), false)
  assert.deepEqual(f.calls, ['page', 'discard'])
})

test('dirty-page discard completes before activity inspection or cancellation consent', async () => {
  const f = fixture()
  let allowDiscard
  const discarded = new Promise(resolve => { allowDiscard = resolve })
  f.options.canLeave = async () => { f.calls.push('page'); return false }
  f.options.confirmDiscard = async () => { f.calls.push('discard'); return discarded }
  f.options.inspectActivity = async () => { f.calls.push('inspect'); return { busy: true } }
  const quitting = prepareDesktopQuit(f.options)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.calls, ['page', 'discard'])
  allowDiscard(true)
  assert.equal(await quitting, true)
  assert.deepEqual(f.calls, ['page', 'discard', 'inspect', 'cancel-runs'])
})

test('declining cancellation releases the inspected activity freeze before returning', async () => {
  const f = fixture()
  let finishRelease
  const released = new Promise(resolve => { finishRelease = resolve })
  f.options.inspectActivity = async () => { f.calls.push('inspect'); return { busy: true } }
  f.options.confirmCancelRuns = async () => { f.calls.push('cancel-runs'); return false }
  f.options.releaseActivity = async () => { f.calls.push('release'); await released }
  let exited = false
  const quitting = prepareDesktopQuit(f.options).then(result => { exited = true; return result })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.calls, ['page', 'inspect', 'cancel-runs', 'release'])
  assert.equal(exited, false)
  finishRelease()
  assert.equal(await quitting, false)
})

test('idle activity allows quit while retaining the activity freeze', async () => {
  const f = fixture()
  assert.equal(await prepareDesktopQuit(f.options), true)
  assert.deepEqual(f.calls, ['page', 'inspect'])
})

test('approved cancellation retains the freeze for shutdown', async () => {
  const f = fixture()
  f.options.inspectActivity = async () => { f.calls.push('inspect'); return { busy: true } }
  assert.equal(await prepareDesktopQuit(f.options), true)
  assert.deepEqual(f.calls, ['page', 'inspect', 'cancel-runs'])
})

test('page-check failure propagates without activity inspection', async () => {
  const f = fixture(), failure = new Error('Page check failed')
  f.options.canLeave = async () => { f.calls.push('page'); throw failure }
  await assert.rejects(prepareDesktopQuit(f.options), error => error === failure)
  assert.deepEqual(f.calls, ['page'])
})

test('discard-dialog failure propagates without inspecting activity', async () => {
  const f = fixture(), failure = new Error('Discard dialog failed')
  f.options.canLeave = async () => { f.calls.push('page'); return false }
  f.options.confirmDiscard = async () => { f.calls.push('discard'); throw failure }
  await assert.rejects(prepareDesktopQuit(f.options), error => error === failure)
  assert.deepEqual(f.calls, ['page', 'discard'])
})

test('cancellation-dialog failure releases activity and propagates the original failure', async () => {
  const f = fixture(), failure = new Error('Cancellation dialog failed')
  f.options.inspectActivity = async () => { f.calls.push('inspect'); return { busy: true } }
  f.options.confirmCancelRuns = async () => { f.calls.push('cancel-runs'); throw failure }
  await assert.rejects(prepareDesktopQuit(f.options), error => error === failure)
  assert.deepEqual(f.calls, ['page', 'inspect', 'cancel-runs', 'release'])
})

test('failed activity release preserves both confirmation and cleanup failures', async () => {
  const f = fixture(), confirmation = new Error('Cancellation dialog failed'), release = new Error('Release failed')
  f.options.inspectActivity = async () => { f.calls.push('inspect'); return { busy: true } }
  f.options.confirmCancelRuns = async () => { f.calls.push('cancel-runs'); throw confirmation }
  f.options.releaseActivity = async () => { f.calls.push('release'); throw release }
  await assert.rejects(prepareDesktopQuit(f.options), error => error instanceof AggregateError &&
    error.errors.length === 2 && error.errors[0] === confirmation && error.errors[1] === release)
  assert.deepEqual(f.calls, ['page', 'inspect', 'cancel-runs', 'release'])
})

test('beforeunload probe returns true when the public event is not prevented', () => {
  const window = new EventTarget()
  let observed
  window.addEventListener('beforeunload', event => { observed = event })
  assert.equal(runInNewContext(desktopBeforeUnloadProbe, { window, Event }), true)
  assert.equal(observed.type, 'beforeunload')
  assert.equal(observed.cancelable, true)
})

test('beforeunload probe returns false when a public listener prevents the event', () => {
  const window = new EventTarget()
  window.addEventListener('beforeunload', event => event.preventDefault())
  assert.equal(runInNewContext(desktopBeforeUnloadProbe, { window, Event }), false)
})
