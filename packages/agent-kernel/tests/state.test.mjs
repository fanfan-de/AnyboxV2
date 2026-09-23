import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryState, createSQLiteState } from '../dist/index.js'
import { deferred, isCode } from './helpers.mjs'

const providers = [
  ['memory', async () => createMemoryState()],
  ['sqlite', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'anybox-state-contract-'))
    const owned = await createSQLiteState({ path: join(directory, 'state.sqlite') })
    t.after(async () => { await owned.close(); await rm(directory, { recursive: true, force: true }) })
    return owned
  }],
]

for (const [name, create] of providers) {
test(`${name}: transactions roll back every collection and isolate retained references`, async t => {
  const owned = await create(t)
  t.after(() => owned.close())
  const state = owned.service
  await assert.rejects(state.transaction('broken', draft => {
    draft.sessions.set('s', { id: 's', agentId: 'a', version: 1, createdAt: 'now' })
    draft.messages.set('m', { id: 'm' })
    draft.runs.set('r', { id: 'r' })
    draft.requests.set('k', { fingerprint: 'x' })
    draft.steps.set('step', { id: 'step' })
    draft.attempts.set('attempt', { id: 'attempt' })
    draft.toolCalls.set('tool', { id: 'tool' })
    draft.events.set('r', [{ seq: 1 }])
    throw new Error('rollback')
  }), /rollback/)
  const empty = await state.readSnapshot()
  for (const name of ['sessions', 'messages', 'runs', 'requests', 'steps', 'attempts', 'toolCalls', 'events']) assert.equal(empty[name].size, 0)
  let retained
  const returned = await state.transaction('valid', draft => {
    retained = draft
    const session = { id: 's', agentId: 'a', version: 1, createdAt: 'now' }
    draft.sessions.set('s', session)
    return session
  })
  returned.version = 999
  retained.sessions.clear()
  const snapshot = await state.readSnapshot()
  snapshot.sessions.get('s').version = 888
  assert.equal((await state.readSnapshot()).sessions.get('s').version, 1)
  await owned.close()
  await assert.rejects(state.readSnapshot(), isCode('CLOSED'))
})

test(`${name}: asynchronous callbacks cannot commit or leak later changes`, async t => {
  const owned = await create(t)
  t.after(() => owned.close())
  const gate = deferred()
  await assert.rejects(owned.service.transaction('async', async draft => {
    await gate.promise
    draft.sessions.set('late', {})
  }), isCode('INVALID_ARGUMENT'))
  gate.resolve()
  assert.equal((await owned.service.readSnapshot()).sessions.size, 0)
  const closing = owned.close()
  assert.strictEqual(owned.close(), closing)
  await closing
})
}
