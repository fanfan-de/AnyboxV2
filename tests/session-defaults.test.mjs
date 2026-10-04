import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { localStorageServiceKey } from '../dist/storage/port.js'
import { createImageAssetsComponent } from '../dist/applications/harness/core/image/component.js'
import { sessionServiceKey } from '../dist/applications/harness/core/session/port.js'
import { projectServiceKey } from '../dist/applications/harness/core/project/component.js'
import { createTestHarnessServerCore } from './helpers/harness-server-core.mjs'
import { installManagedModels } from './helpers/managed-models.mjs'
import { deferred } from './helpers/controlled-models.mjs'

const agents = [
  { id: 'assistant', modelId: 'default', instructions: 'Answer briefly.' },
  { id: 'reviewer', modelId: 'alternate', instructions: 'Review carefully.' },
  { id: 'unconfigured', instructions: 'Answer briefly.' },
]

async function openHost(directory, definitions = agents) {
  const root = new Context()
  try {
    const { controlled } = await installManagedModels(root, directory)
    const settings = root.get('models.settings'), original = settings.configurations().find(value => value.id === 'default')
    for (const id of ['alternate', 'explicit']) {
      if (!settings.configurations().some(value => value.id === id)) {
        await settings.createConfiguration({ id, name: id, modelDefinitionId: original.modelDefinitionId,
          connectionId: original.connectionId, enabled: true, capabilities: original.capabilities,
          parameters: original.parameters, baseline: false })
      }
    }
    await root.installComponent(createLocalSqliteComponent(join(directory, 'harness.sqlite')))
    await root.installComponent(createImageAssetsComponent({ directory: `${join(directory, 'harness.sqlite')}.images` }))
    const harness = await createTestHarnessServerCore(root, { agents: definitions })
    const project = await harness.openProject(directory)
    return { root, harness, project, settings, controlled, async close() {
      for (const call of controlled.calls) { call.result.resolve('Cleanup'); call.done.resolve() }
      await harness.close()
    } }
  } catch (error) { await root.fiber.dispose(); throw error }
}

async function fixture(definitions) {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-session-defaults-'))
  try {
    const host = await openHost(directory, definitions)
    return { ...host, directory, async close() { try { await host.close() } finally { rmSync(directory, { recursive: true, force: true }) } } }
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error }
}

test('new sessions copy saved Agent defaults while explicit creation wins and protocol remains unbound', async () => {
  const f = await fixture()
  try {
    assert.deepEqual(await f.harness.getSessionDefaults('assistant'), {
      agentId: 'assistant', modelId: null, fallbackModelId: 'default', effectiveModelId: 'default', revision: 0,
    })
    assert.equal((await f.harness.createSession(f.project.id, 'assistant')).modelId, 'default')
    const saved = await f.harness.setSessionDefaults('assistant', 'alternate', 0)
    assert.deepEqual(saved, { agentId: 'assistant', modelId: 'alternate', fallbackModelId: 'default', effectiveModelId: 'alternate', revision: 1 })
    const inherited = await f.harness.createSession(f.project.id, 'assistant')
    assert.equal(inherited.modelId, 'alternate')
    assert.equal(inherited.protocolId, null)
    const explicit = await f.harness.createSession(f.project.id, 'assistant', 'explicit')
    assert.equal(explicit.modelId, 'explicit')
    assert.equal(explicit.protocolId, null)
    assert.deepEqual(await f.harness.getSessionDefaults('assistant'), saved)
  } finally { await f.close() }
})

test('defaults are isolated by Agent and clearing an override restores the immutable startup fallback', async () => {
  const f = await fixture()
  try {
    const saved = await f.harness.setSessionDefaults('assistant', 'explicit', 0)
    assert.equal((await f.harness.createSession(f.project.id, 'reviewer')).modelId, 'alternate')
    assert.equal((await f.harness.getSessionDefaults('reviewer')).revision, 0)
    assert.equal((await f.harness.createSession(f.project.id, 'unconfigured')).modelId, null)
    const cleared = await f.harness.setSessionDefaults('assistant', null, saved.revision)
    assert.deepEqual(cleared, { agentId: 'assistant', modelId: null, fallbackModelId: 'default', effectiveModelId: 'default', revision: 2 })
    assert.equal((await f.harness.createSession(f.project.id, 'assistant')).modelId, 'default')
    assert.equal(agents[0].modelId, 'default')
  } finally { await f.close() }
})

test('changing new-session defaults leaves existing sessions and their explicit selections independent', async () => {
  const f = await fixture()
  try {
    const original = await f.harness.createSession(f.project.id, 'assistant')
    const saved = await f.harness.setSessionDefaults('assistant', 'alternate', 0)
    assert.deepEqual(await f.harness.getSession(original.id), original)
    await f.harness.selectSessionModel(original.id, 'explicit')
    assert.deepEqual(await f.harness.getSessionDefaults('assistant'), saved)
    assert.equal((await f.harness.createSession(f.project.id, 'assistant')).modelId, 'alternate')
    const cleared = await f.harness.setSessionDefaults('assistant', null, saved.revision)
    assert.equal(cleared.effectiveModelId, 'default')
    assert.equal((await f.harness.getSession(original.id)).modelId, 'explicit')
  } finally { await f.close() }
})

test('default selection and CAS revision survive a full root restart without rewriting historical sessions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-session-default-restart-'))
  let f = await openHost(directory)
  try {
    const old = await f.harness.createSession(f.project.id, 'assistant')
    const saved = await f.harness.setSessionDefaults('assistant', 'alternate', 0)
    const inherited = await f.harness.createSession(f.project.id, 'assistant')
    await f.close()
    f = await openHost(directory)
    assert.deepEqual(await f.harness.getSessionDefaults('assistant'), saved)
    assert.deepEqual(await f.harness.getSession(old.id), old)
    assert.deepEqual(await f.harness.getSession(inherited.id), inherited)
    assert.equal((await f.harness.createSession(f.project.id, 'assistant')).modelId, 'alternate')
    const cleared = await f.harness.setSessionDefaults('assistant', null, saved.revision)
    await f.close()
    f = await openHost(directory)
    assert.deepEqual(await f.harness.getSessionDefaults('assistant'), cleared)
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('concurrent stale default edits conflict and never overwrite the winning setting', async () => {
  const f = await fixture()
  try {
    const results = await Promise.allSettled([
      f.harness.setSessionDefaults('assistant', 'alternate', 0),
      f.harness.setSessionDefaults('assistant', 'explicit', 0),
    ])
    const successes = results.filter(value => value.status === 'fulfilled')
    const failures = results.filter(value => value.status === 'rejected')
    assert.equal(successes.length, 1)
    assert.equal(failures.length, 1)
    assert.equal(failures[0].reason.code, 'session-defaults-conflict')
    assert.deepEqual(await f.harness.getSessionDefaults('assistant'), successes[0].value)
    await assert.rejects(f.harness.setSessionDefaults('assistant', null, 0), { code: 'session-defaults-conflict' })
    assert.equal((await f.harness.createSession(f.project.id, 'assistant')).modelId, successes[0].value.modelId)
  } finally { await f.close() }
})

test('unavailable saved defaults remain selected and never silently switch to startup or other models', async () => {
  const f = await fixture()
  try {
    const saved = await f.harness.setSessionDefaults('assistant', 'alternate', 0)
    const config = f.settings.configurations().find(value => value.id === 'alternate')
    await f.settings.updateConfiguration(config.id, { enabled: false }, config.revision)
    assert.deepEqual(await f.harness.getSessionDefaults('assistant'), saved)
    assert.equal((await f.harness.createSession(f.project.id, 'assistant')).modelId, 'alternate')
    await assert.rejects(async () => f.harness.setSessionDefaults('reviewer', 'alternate', 0))
    await assert.rejects(async () => f.harness.setSessionDefaults('reviewer', 'missing', 0))
    assert.equal((await f.harness.getSessionDefaults('reviewer')).revision, 0)
    const connection = f.settings.connections().find(value => value.id === 'default')
    await f.settings.deleteConnection(connection.id, connection.revision)
    assert.deepEqual(await f.harness.getSessionDefaults('assistant'), saved)
    assert.equal((await f.harness.createSession(f.project.id, 'assistant')).modelId, 'alternate')
    await f.harness.setSessionDefaults('assistant', null, saved.revision)
    assert.equal((await f.harness.getSessionDefaults('assistant')).effectiveModelId, 'default')
  } finally { await f.close() }
})

test('Session resolves the default in its creation transaction after project validation completes', { timeout: 5000 }, async () => {
  const f = await fixture(), entered = deferred(), release = deferred()
  const projects = f.root.get(projectServiceKey), requireAvailable = projects.requireAvailable.bind(projects)
  try {
    projects.requireAvailable = async id => { entered.resolve(); await release.promise; return requireAvailable(id) }
    const creating = f.harness.createSession(f.project.id, 'assistant')
    await entered.promise
    await f.harness.setSessionDefaults('assistant', 'alternate', 0)
    release.resolve()
    assert.equal((await creating).modelId, 'alternate')
  } finally { release.resolve(); projects.requireAvailable = requireAvailable; await f.close() }
})

test('Session shutdown waits for an accepted default write and rejects new calls on its old service', { timeout: 5000 }, async () => {
  const f = await fixture(), entered = deferred(), release = deferred()
  const db = f.root.get(localStorageServiceKey), transaction = db.transaction.bind(db)
  try {
    const sessions = f.root.get(sessionServiceKey)
    db.transaction = async work => { entered.resolve(); await release.promise; return transaction(work) }
    const saving = sessions.setSessionDefaults('assistant', 'alternate', 0)
    await entered.promise
    let stopped = false
    const stopping = f.root.fiber.dispose().then(() => { stopped = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(stopped, false)
    await assert.rejects(sessions.getSessionDefaults('assistant'), /closing/)
    release.resolve()
    assert.equal((await saving).modelId, 'alternate')
    await stopping
    db.transaction = transaction
    const restored = await openHost(f.directory)
    try { assert.equal((await restored.harness.getSessionDefaults('assistant')).modelId, 'alternate') }
    finally { await restored.close() }
  } finally { release.resolve(); db.transaction = transaction; await f.close() }
})
