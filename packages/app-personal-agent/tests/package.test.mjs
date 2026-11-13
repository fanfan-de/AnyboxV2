import assert from 'node:assert/strict'
import test from 'node:test'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { Context } from '@nya/core'
import { createRegistration } from '../dist/package/client.js'
import { personalAgentAssets } from '../dist/assets.js'
import { createApplicationCatalog } from '@anybox/host/applications/registration'
import { shellAssets } from '@anybox/host/assets'
import { verifyApplicationDirectory } from '@anybox/host/package-management/archive'
import { verifyPackageWebResources } from '@anybox/host/package-management/preparation-static'
import { verifyWebAssets } from '../../../scripts/verify-web-assets.mjs'

const execFile = promisify(execFileCallback)

test('discovering the application in a client process does not import model execution', async () => {
  const guard = new URL('../../../tests/helpers/role-import-guard.mjs', import.meta.url).href
  const entry = new URL('../dist/package/client.js', import.meta.url).href
  const code = `
    import { register } from 'node:module';
    register(${JSON.stringify(guard)}, import.meta.url, { data: { mode: 'client' } });
    const { createRegistration } = await import(${JSON.stringify(entry)});
    if (createRegistration({ phase: 'prepare', role: 'client', appId: 'personal-agent' }).definition.id !== 'personal-agent') throw new Error('incorrect application');
    process.stdout.write('discovered-without-models');
  `
  const result = await execFile(process.execPath, ['--input-type=module', '--eval', code], { timeout: 10_000 })
  assert.equal(result.stdout, 'discovered-without-models')
})

test('Personal Agent publishes a complete browser graph and only its own client package entry', async () => {
  const registration = createRegistration({ phase: 'prepare', role: 'client', appId: 'personal-agent' })
  assert.equal(registration.definition.id, 'personal-agent')
  assert.equal(registration.definition.web.entry, '/apps/personal-agent/0.1.0/web/app.js')
  assert.equal(new Set(personalAgentAssets.map(asset => asset.path)).size, personalAgentAssets.length)
  await verifyWebAssets(createApplicationCatalog([registration], shellAssets))
  const recipe = JSON.parse(await readFile(new URL('../anybox.app.json', import.meta.url), 'utf8'))
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(recipe.version, metadata.version)
  for (const asset of personalAgentAssets) assert.ok(asset.path.startsWith(`/apps/${recipe.appId}/${recipe.version}/`), 'installable resources must use their default version-owned namespace')
  assert.deepEqual(recipe.entries, { client: 'dist/package/client.js' })
  for (const name of ['@anybox/host', '@anybox/app-harness', '@anybox/app-claude-agent', '@anybox/distribution']) {
    assert.equal(metadata.dependencies[name], undefined, `${name} must stay outside the independent application`)
  }
  const target = { os: process.platform, arch: process.arch }
  const assets = personalAgentAssets.map(asset => ({ ...asset, file: `payload/web/${basename(asset.file)}` }))
  const manifest = {
    schemaVersion: 1, appId: recipe.appId, version: recipe.version, publisher: recipe.publisher,
    displayName: recipe.displayName, applicationApi: recipe.applicationApi, target,
    web: { entry: 'payload/web/app.js', styles: ['payload/web/style.css'], assets: 'payload/assets.json' },
  }
  const entries = [
    { path: 'manifest.json', bytes: Buffer.from(JSON.stringify(manifest)) },
    { path: 'payload/assets.json', bytes: Buffer.from(JSON.stringify({ schemaVersion: 1, assets })) },
    ...await Promise.all(personalAgentAssets.map(async (asset, index) => ({ path: assets[index].file, bytes: await readFile(asset.file) }))),
  ]
  const directory = verifyApplicationDirectory(entries, { target, trustedPublishers: [], allowUnsignedLocal: true, applicationApiVersion: '0.1.0' })
  assert.equal(verifyPackageWebResources(directory).entry, registration.definition.web.entry, 'local installation must prepare with no extra asset alias policy')
})

test('package preparation and un-opened runtime construction never initialize storage, Vault or model requests', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-prepare-')), root = new Context()
  t.after(async () => { await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  const modelsPath = join(directory, 'models.json'), databasePath = join(directory, 'business.sqlite')
  let vaultCalls = 0, requests = 0
  const registration = createRegistration({ phase: 'prepare', role: 'client', appId: 'personal-agent' }, {
    modelsPath, databasePath,
    openEntry() { vaultCalls++; throw new Error('preparation must not open credentials') },
    async fetch() { requests++; throw new Error('preparation must not request a model') },
  })
  const runtime = registration.createRuntime(root, { capabilities: { 'storage.sqlite': '1.0.0' } })
  assert.equal(runtime.inspect(), 'disabled')
  for (const name of ['models', 'models.settings', 'models.vault', 'personal-agent.workspace', 'personal-agent.http']) assert.equal(root.get(name), undefined)
  assert.equal(vaultCalls, 0)
  assert.equal(requests, 0)
  await assert.rejects(access(modelsPath), { code: 'ENOENT' })
  await assert.rejects(access(databasePath), { code: 'ENOENT' })
})
