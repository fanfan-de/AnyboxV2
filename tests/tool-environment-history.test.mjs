import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computerCleanupReceipt, environmentCleanupObservationResult, newEnvironmentCleanup, resolveEnvironmentCleanup } from '../packages/app-harness/dist/core/tool-environments/history.js'

const receipt = { cleanup: 'completed', processes: [{ session_id: 1, output: 'final output' }] }
const report = { environments: [{ environmentId: 'notes', result: { closed: true } }, { environmentId: 'computer', result: receipt }] }

test('Computer cleanup readers accept old receipts and only the explicitly identified environment member', () => {
  assert.equal(computerCleanupReceipt(receipt), receipt)
  assert.equal(computerCleanupReceipt(report), receipt)
  assert.equal(computerCleanupReceipt({ environments: [{ environmentId: 'notes', result: receipt }] }), undefined)
  assert.equal(computerCleanupReceipt({ environments: [{ environmentId: 'computer', result: receipt }, { environmentId: 'computer', result: receipt }] }), undefined)
  assert.equal(computerCleanupReceipt({ environments: [{ environmentId: 'computer', result: { closed: true } }] }), undefined)
  for (const value of [undefined, null, [], {}, { processes: 'invalid' }]) assert.equal(computerCleanupReceipt(value), undefined)
})

test('new environment cleanup operations use a uniform identity and preserve the full report', async () => {
  const queries = []
  const records = { async getRunOperation(runId, operationId) { queries.push([runId, operationId]); return undefined } }
  const operation = await resolveEnvironmentCleanup(records, 'run', false)
  assert.deepEqual(operation, newEnvironmentCleanup('run'))
  assert.deepEqual(operation.start, { id: 'run:tool-environment-scope-close', kind: 'operation', cleanup: true, intent: { kind: 'tool-environment-cleanup' } })
  assert.deepEqual(queries, [['run', 'run:tool-environment-scope-close']])
  assert.equal(environmentCleanupObservationResult(report, operation), report)
})

test('takeover reuses the original Computer cleanup identity, intent, and receipt representation', async () => {
  for (const observation of [undefined, { kind: 'value', result: receipt }]) {
    const prior = { start: { id: 'run:computer-scope-close', kind: 'operation', cleanup: true, intent: { kind: 'tool-process-cleanup' } },
      ...(observation ? { observation } : {}) }
    const records = { async getRunOperation(_runId, operationId) { return operationId === prior.start.id ? prior : undefined } }
    const operation = await resolveEnvironmentCleanup(records, 'run', true)
    assert.equal(operation.start, prior.start)
    assert.equal(operation.prior, prior)
    assert.equal(operation.legacyComputerReceipt, true)
    assert.equal(environmentCleanupObservationResult(report, operation), receipt)
    assert.throws(() => environmentCleanupObservationResult({ environments: [] }, operation), /receipt is unavailable/)
  }
})

test('takeover keeps a pre-existing generic cleanup intent and observation unchanged', async () => {
  const prior = { start: { id: 'run:tool-environment-scope-close', kind: 'operation', cleanup: true, intent: { kind: 'tool-process-cleanup' } },
    observation: { kind: 'cleanup-failed', result: report, errorCategory: 'tool-cleanup-failure' } }
  const queries = []
  const records = { async getRunOperation(_runId, operationId) { queries.push(operationId); return prior } }
  const operation = await resolveEnvironmentCleanup(records, 'run', true)
  assert.equal(operation.start, prior.start)
  assert.equal(operation.prior.observation, prior.observation)
  assert.equal(operation.legacyComputerReceipt, false)
  assert.equal(environmentCleanupObservationResult(report, operation), report)
  assert.deepEqual(queries, [prior.start.id])
})
