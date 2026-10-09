import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context, FiberState } from '@nya/core'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { createProductActivityComponent } from '../dist/host/applications/activity.js'
import { createApplicationRuntime } from '../dist/host/applications/runtime.js'
import { createHarnessServerRuntime } from '../dist/applications/harness/server-runtime.js'
import { parseHarnessServerConfig } from '../dist/applications/harness/server-config.js'
import { installHarnessServerCore } from '../dist/applications/harness/core/index.js'
import { createImageAssetsComponent } from '../dist/applications/harness/core/image/component.js'
import { runAdmissionServiceKey } from '../dist/applications/harness/core/run/component.js'
import { controlledModels, deferred } from './helpers/controlled-models.mjs'

const agents = [{ id: 'assistant', modelId: 'default', instructions: 'Test.' }]
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-product-runtime-'))
  const root = new Context()
  const config = parseHarnessServerConfig({ ANYBOX_HARNESS_DATABASE: join(directory, 'harness.sqlite'), ANYBOX_MODELS_DATABASE: join(directory, 'models.sqlite') })
  await root.installComponent(createLocalSqliteComponent(config.harnessDatabasePath))
  await root.installComponent(createProductActivityComponent())
  const secrets = new Map()
  const runtime = createHarnessServerRuntime(root, config, { authenticated: false, models: { catalogAutoRefresh: false, readLegacyCredential: async () => undefined,
    openEntry(namespace, id) { const key = `${namespace}:${id}`; return {
      getPassword: async () => secrets.get(key), setPassword: async value => { secrets.set(key, value) }, deleteCredential: async () => secrets.delete(key),
    } },
  } })
  t.after(async () => { runtime.closeAdmission(); await runtime.awaitIdle(); await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  return { root, config, runtime, directory }
}

test('harness server owns its full installation and reopening preserves data in the host database', async t => {
  const { root, config, runtime } = await fixture(t)
  assert.equal(runtime.inspect(), 'disabled')
  assert.equal(existsSync(config.modelsDatabasePath), false)
  await runtime.open()
  assert.equal(runtime.inspect(), 'active')
  for (const key of ['models', 'models.catalog', 'harness.prompts', 'harness.sessions', 'tools.bash', 'harness.http']) assert.ok(root.get(key), key)
  const models = root.get('models'), prompts = root.get('harness.prompts')
  const prompt = await prompts.createPrompt('owner', { name: 'Remember', kind: 'context', role: 'user', content: 'Keep this content' })
  await runtime.open(); assert.equal(root.get('models'), models)
  await runtime.stop()
  assert.equal(runtime.inspect(), 'disabled'); assert.equal(root.get('models'), undefined)
  assert.equal(root.get('harness.sessions'), undefined); assert.equal(root.get('harness.http'), undefined)
  assert.ok(root.get('local-storage')); assert.equal(root.fiber.state, FiberState.ACTIVE)
  await runtime.open()
  assert.notEqual(root.get('models'), models)
  assert.equal(root.get('harness.prompts').getPrompt('owner', prompt.id).draft.content, 'Keep this content')
})

test('Run admission protects preparation and real exit, and installation close leaves the root dependencies alive', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-run-admission-')), root = new Context()
  const entering = deferred(), releaseOpen = deferred()
  const models = controlledModels({ open: async () => { entering.resolve(); await releaseOpen.promise } })
  await root.installComponent(models.component())
  await root.installComponent(createLocalSqliteComponent(join(directory, 'harness.sqlite')))
  await root.installComponent(createImageAssetsComponent({ directory: join(directory, 'images') }))
  const installation = await installHarnessServerCore(root, { agents }), harness = installation.api
  t.after(async () => {
    releaseOpen.resolve()
    for (const call of models.calls) { call.result.resolve('done'); call.done.resolve() }
    await root.fiber.dispose(); await rm(directory, { recursive: true, force: true })
  })
  const project = await harness.openProject(directory), session = await harness.createSession(project.id, 'assistant')
  const control = root.get(runAdmissionServiceKey)
  const input = { sessionId: session.id, parentNodeId: null, input: 'hello', idempotencyKey: 'prepare' }
  const starting = harness.startRun(input)
  assert.equal(control.busy(), true)
  assert.equal(control.pauseIfIdle(), undefined)
  await entering.promise
  assert.equal(control.pauseIfIdle(), undefined)
  releaseOpen.resolve()
  const run = await starting
  assert.equal(control.pauseIfIdle(), undefined)
  models.calls[0].result.resolve('completed')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(control.pauseIfIdle(), undefined)
  models.calls[0].done.resolve()
  await harness.waitRun(run.id)
  await new Promise(resolve => setImmediate(resolve))
  const resume = control.pauseIfIdle(), nestedResume = control.pauseIfIdle()
  assert.equal(typeof resume, 'function'); assert.equal(typeof nestedResume, 'function')
  assert.throws(() => harness.startRun({ ...input, idempotencyKey: 'paused' }), /closing/)
  resume()
  assert.throws(() => harness.startRun({ ...input, idempotencyKey: 'still-paused' }), /closing/)
  nestedResume()
  assert.equal(control.busy(), false)
  assert.equal(harness.close, undefined)
  await installation.close()
  assert.ok(root.get('models')); assert.ok(root.get('harness.image-assets'))
  assert.equal(root.get('harness.runs'), undefined)
  assert.equal(root.fiber.state, FiberState.ACTIVE)
})

test('startup failure cleans every registered Fiber and effect, and requires explicit retry', async () => {
  const root = new Context(), shared = {}, release = root.provide('shared', shared)
  let broken = true, cleanups = 0, effects = 0
  const runtime = createApplicationRuntime(root, install => {
    install.effect(() => () => { effects++ }, 'fixture')
    install.install(ctx => { ctx.effect(() => () => { cleanups++ }); ctx.provide('app', {}) })
    install.install(() => { if (broken) throw new Error('startup failed') })
  })
  try {
    await assert.rejects(runtime.open(), /startup failed/)
    assert.equal(runtime.inspect(), 'failed'); assert.equal(root.get('app'), undefined)
    assert.equal(root.get('shared'), shared); assert.equal(cleanups, 1); assert.equal(effects, 1)
    broken = false
    await assert.rejects(runtime.open(), /startup failed/)
    await runtime.retry(); assert.equal(runtime.inspect(), 'active')
    await runtime.stop(); assert.equal(cleanups, 2); assert.equal(effects, 2)
  } finally { await release(); await root.fiber.dispose() }
})

test('cleanup failure retains ownership diagnostics and prevents same-process reinstallation', async () => {
  const root = new Context(); let installations = 0
  const runtime = createApplicationRuntime(root, install => {
    installations++
    install.install(ctx => { ctx.provide('app', {}); ctx.effect(() => () => { throw new Error('private cleanup failure') }) })
  })
  try {
    await runtime.open()
    await assert.rejects(runtime.stop(), error => error.phase === 'cleanup')
    assert.equal(runtime.inspect(), 'failed')
    await assert.rejects(runtime.retry(), error => error.phase === 'cleanup')
    await assert.rejects(runtime.open(), error => error.phase === 'cleanup')
    assert.equal(installations, 1); assert.equal(root.get('app'), undefined)
  } finally { await root.fiber.dispose().catch(() => {}) }
})

test('missing dependencies retain the original installation and recover through Nya', async () => {
  const root = new Context(); let installations = 0, fiber
  const runtime = createApplicationRuntime(root, install => {
    installations++; fiber = install.install({ inject: ['shared'], apply(ctx, _, deps) { ctx.provide('app', deps.shared) } })
  })
  try {
    await runtime.open(); assert.equal(runtime.inspect(), 'blocked')
    await runtime.open(); assert.equal(installations, 1)
    const shared = {}, release = root.provide('shared', shared)
    await fiber.awaitStable()
    assert.equal(runtime.inspect(), 'active'); assert.equal(root.get('app'), shared)
    await release(); await fiber.awaitStable(); assert.equal(runtime.inspect(), 'blocked')
  } finally { await root.fiber.dispose() }
})

test('host admission closes a pending assembly and joins its rollback before returning', async () => {
  const root = new Context(), entered = deferred(), release = deferred(); let cleaned = false, signal
  const runtime = createApplicationRuntime(root, async install => {
    signal = install.signal
    install.install(ctx => { ctx.effect(() => () => { cleaned = true }); ctx.provide('app', {}) })
    entered.resolve(); await release.promise
    install.install(ctx => ctx.provide('late', {}))
  })
  const opening = runtime.open(); void opening.catch(() => {})
  await entered.promise; runtime.closeAdmission()
  assert.equal(signal.aborted, true)
  let exited = false; const idle = runtime.awaitIdle().then(() => { exited = true })
  await Promise.resolve(); assert.equal(exited, false)
  release.resolve(); await assert.rejects(opening); await idle
  assert.equal(cleaned, true); assert.equal(root.get('app'), undefined); assert.equal(root.get('late'), undefined)
  await assert.rejects(runtime.open()); await root.fiber.dispose()
})
