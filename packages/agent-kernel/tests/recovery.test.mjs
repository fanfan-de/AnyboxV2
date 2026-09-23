import assert from 'node:assert/strict'
import test from 'node:test'
import { planRecovery } from '../dist/domain/recovery.js'
import { fixture } from './helpers.mjs'

test('recovery is a deterministic, isolated and idempotent pure state transition', async t => {
  const f = await fixture(t, { config: { maxConcurrent: 1 } })
  const active = await f.kernel.runs.start(f.request(f.session))
  await f.model.nextCall()
  const queued = await f.kernel.runs.start(f.request(await f.kernel.sessions.create()))
  const source = await f.memory.service.readSnapshot(), original = structuredClone(source)
  const time = '2026-09-22T00:00:00.000Z'
  const planned = planRecovery(source, time)
  assert.deepEqual(source, original)
  assert.deepEqual(planRecovery(source, time), planned)
  assert.deepEqual(new Set(planned.interruptedRunIds), new Set([active.runId, queued.runId]))
  for (const id of planned.interruptedRunIds) assert.equal(planned.state.runs.get(id).status, 'interrupted')
  assert.deepEqual(planRecovery(planned.state, time).state, planned.state)
  assert.deepEqual(planRecovery(planned.state, time).interruptedRunIds, [])
  planned.state.sessions.clear()
  assert.equal(source.sessions.size, 2)
  await f.kernel.runs.cancel({ runId: active.runId })
  await f.kernel.runs.cancel({ runId: queued.runId })
  await Promise.all([active, queued].map(run => f.kernel.runs.wait({ runId: run.runId })))
})
