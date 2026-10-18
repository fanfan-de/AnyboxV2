import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClientHost } from '../packages/host/dist/client.js'
import { testApplication } from './helpers/test-application.mjs'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-capability-host-'))
  const hosts = []
  t.after(async () => {
    try { for (const host of hosts.reverse()) await host.close() }
    finally { await rm(directory, { recursive: true, force: true }) }
  })
  return async (applications, providers = []) => {
    const host = await createClientHost({ path: join(directory, 'control.sqlite'), applications, providers })
    hosts.push(host)
    return host
  }
}

test('a missing required capability blocks only its application before business initialization and restores its saved target', async t => {
  const start = await fixture(t)
  let created = 0, initialized = 0
  const notes = { ...testApplication('notes', { created: () => created++ }), capabilityRequirements: { required: { 'test.required': '^1.0.0' } } }
  let host = await start([notes, testApplication('other')])
  const blocked = await host.products.open('notes')
  assert.equal(blocked.state, 'blocked')
  assert.equal(blocked.desiredEnabled, true)
  assert.deepEqual(blocked.capabilities, [{ id: 'test.required', range: '^1.0.0', required: true, status: 'missing' }])
  assert.equal(created, 0)
  assert.equal(host.root.get('test.notes'), undefined)
  assert.equal((await host.products.open('other')).state, 'running')
  const response = await fetch(host.url + '/api/client/v1/products/notes')
  assert.deepEqual((await response.json()).capabilities, blocked.capabilities)
  await host.close()

  host = await start([notes], [{ id: 'test.required', version: '1.2.0', services: ['test.required-service'], create: () => ({
    name: 'test-required-provider', apply(ctx) { initialized++; ctx.provide('test.required-service', {}) },
  }) }])
  assert.equal(host.products.get('notes').state, 'running')
  assert.equal(created, 1)
  assert.equal(initialized, 1)
  assert.equal(host.products.get('notes').capabilities[0].status, 'ready')
  await host.products.disable('notes')
  assert.equal(host.root.get('test.required-service'), undefined)
})

test('a pure interface with missing requirements is blocked without a fabricated background target or provider initialization', async t => {
  const start = await fixture(t), full = testApplication('calculator')
  let initialized = 0
  const application = { definition: full.definition, assets: full.assets,
    capabilityRequirements: { required: { 'test.absent': '^1.0.0' } } }
  const host = await start([application], [{ id: 'test.unused', version: '1.0.0', services: ['test.unused-service'], create: () => ({
    apply(ctx) { initialized++; ctx.provide('test.unused-service', {}) },
  }) }])
  const view = await host.products.open('calculator')
  assert.equal(view.definition.runtime, false)
  assert.equal(view.state, 'blocked')
  assert.equal(view.desiredEnabled, false)
  assert.equal(initialized, 0)
  assert.equal(host.root.get('test.calculator'), undefined)
  const row = await host.root.get('local-storage').read(reader => reader.get('SELECT id FROM app_product_targets WHERE id=?', ['calculator']))
  assert.equal(row, undefined)
})

test('host control storage remains owned by the host while applications consume or conflict with its pinned capability', async t => {
  const start = await fixture(t)
  let alternativeCreated = 0
  const application = { ...testApplication('notes'), capabilityRequirements: { required: { 'storage.sqlite': '^1.0.0' } } }
  const incompatible = { ...testApplication('future'), capabilityRequirements: { required: { 'storage.sqlite': '^2.0.0' } } }
  const host = await start([application, incompatible], [{ id: 'storage.sqlite', version: '2.0.0', services: ['local-storage'], create: () => {
    alternativeCreated++
    throw new Error('a second owner must never be created')
  } }])
  const storage = host.root.get('local-storage')
  assert.equal((await host.products.open('notes')).state, 'running')
  const blocked = await host.products.open('future')
  assert.equal(blocked.state, 'blocked')
  assert.equal(blocked.capabilities[0].status, 'conflict')
  assert.equal(alternativeCreated, 0)
  await host.products.disable('notes')
  assert.equal(host.root.get('local-storage'), storage)
  assert.deepEqual(await storage.read(reader => reader.all('SELECT id FROM app_product_targets WHERE id IN (?, ?) ORDER BY id', ['future', 'notes']).map(row => row.id)), ['future', 'notes'])
})

test('loss of a required capability closes new HTTP admission while optional consumers remain usable', async t => {
  const start = await fixture(t)
  let withdraw
  const required = { ...testApplication('required'), capabilityRequirements: { required: { 'test.platform': '^1.0.0' } } }
  const optional = { ...testApplication('optional'), capabilityRequirements: { optional: { 'test.platform': '^1.0.0' } } }
  const host = await start([required, optional], [{ id: 'test.platform', version: '1.0.0', services: ['test.platform-service'], create: () => ({
    apply(ctx) { withdraw = ctx.provide('test.platform-service', {}) },
  }) }])
  await host.products.open('required'); await host.products.open('optional')
  await withdraw()
  assert.equal(host.products.get('required').state, 'blocked')
  assert.equal(host.products.get('optional').state, 'running')
  assert.equal(host.products.get('required').capabilities[0].status, 'failed')
  assert.equal((await fetch(host.url + '/api/client/v1/apps/required/value')).status, 503)
  assert.equal((await fetch(host.url + '/api/client/v1/apps/optional/value')).status, 200)
})
