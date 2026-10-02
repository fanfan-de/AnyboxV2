import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@nya/core'
import { createModelsStoreComponent } from '../dist/store.js'
import { createModelsComponent } from '../dist/component.js'
import { immutable } from '../dist/domain.js'
import { normalizeModelsDevCatalog, validateCatalogSnapshot } from '../dist/catalog-domain.js'
import { memoryVault } from './helpers.mjs'

function snapshot(count = 512) {
  return normalizeModelsDevCatalog({ p: { id: 'p', name: 'Provider', models: Object.fromEntries(Array.from({ length: count }, (_, index) => {
    const id = `m${index}`
    return [id, { id, name: id, modalities: { input: ['text'], output: ['text'] } }]
  })) } }, 'fairness', 1)
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'models-catalog-fairness-')), root = new Context()
  await root.installComponent(createModelsStoreComponent({ path: join(directory, 'models.sqlite') }))
  root.provide('models.vault', memoryVault())
  await root.installComponent(createModelsComponent())
  t.after(async () => { await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  return { root, store: root.get('models.store'), source: root.get('models.source-data') }
}

test('source preparation yields to host work while SQLite readers see only whole source commits', async t => {
  const { store, source } = await fixture(t), candidate = snapshot(), observations = []
  let observing = true, timer
  const observe = () => {
    observations.push([store.models().length, store.sources().length])
    if (observing) timer = setImmediate(observe)
  }
  timer = setImmediate(observe)
  try {
    await source.accept(candidate)
    observing = false
    clearImmediate(timer)
    assert.ok(observations.length > 0, 'the host must receive an event-loop turn before source acceptance completes')
    assert.ok(observations.every(([models, sources]) => models === 0 && sources === 0 || models === candidate.models.length && sources === 1))
    assert.equal(store.models().length, candidate.models.length)
    assert.equal(store.sources()[0].snapshotVersion, candidate.snapshotVersion)
  } finally { observing = false; clearImmediate(timer) }
})

test('reused SQLite statements preserve whole-batch rollback and remain usable after a late record fails', async t => {
  const { store } = await fixture(t), candidate = snapshot()
  const change = {
    providers: candidate.providers.map(record => ({ record, expectedRevision: null })),
    models: candidate.models.map(record => ({ record, expectedRevision: null })),
    sources: [{ sourceId: candidate.sourceId, snapshotVersion: candidate.snapshotVersion, fetchedAt: candidate.fetchedAt }],
  }
  const broken = structuredClone(change)
  broken.models.at(-1).record.providerId = 'missing'
  await assert.rejects(store.commit(broken), { code: 'not-found' })
  assert.deepEqual(store.providers(), []); assert.deepEqual(store.models(), []); assert.deepEqual(store.sources(), [])
  await store.commit(change)
  assert.equal(store.models().length, candidate.models.length)
  assert.equal(store.modelHistory(candidate.models[0].id).length, 1)
})

test('immutable snapshot reuse never trusts caller-frozen nested data or bypasses validation after mutation', () => {
  const input = Object.freeze({ nested: { value: 1 } }), copy = immutable(input)
  input.nested.value = 2
  assert.equal(copy.nested.value, 1)
  assert.equal(immutable(copy), copy)
  assert.throws(() => { copy.nested.value = 3 }, TypeError)
  const candidate = structuredClone(snapshot(1))
  validateCatalogSnapshot(candidate)
  candidate.models[0].name = 'tampered'
  assert.throws(() => validateCatalogSnapshot(candidate), { code: 'invalid-response' })
  const frozen = immutable(snapshot(1))
  validateCatalogSnapshot(frozen); validateCatalogSnapshot(frozen)
})
