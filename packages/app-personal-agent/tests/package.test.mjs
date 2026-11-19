import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { createApplicationCatalog } from '@anybox/host/applications/registration'
import { shellAssets } from '@anybox/host/assets'
import { verifyApplicationDirectory } from '@anybox/host/package-management/archive'
import { verifyPackageWebResources } from '@anybox/host/package-management/preparation-static'
import { personalAgentAssets } from '../dist/assets.js'
import { createRegistration } from '../dist/package/client.js'
import { createRegistration as createExecutionRegistration } from '../dist/package/execution.js'
import { parsePersonalAgentServerConfig } from '../dist/server-config.js'
import { verifyWebAssets } from '../../../scripts/verify-web-assets.mjs'

test('Personal Agent client registration can be discovered without loading either application execution', async () => {
  const guard = new URL('../../../tests/helpers/role-import-guard.mjs', import.meta.url).href
  const entry = new URL('../dist/package/client.js', import.meta.url).href
  const code = `
    import { register } from 'node:module';
    register(${JSON.stringify(guard)}, import.meta.url, { data: { mode: 'client' } });
    const { createRegistration } = await import(${JSON.stringify(entry)});
    if (createRegistration({ phase: 'prepare', role: 'client', appId: 'personal-agent' }).definition.id !== 'personal-agent') throw new Error('incorrect application');
    process.stdout.write('personal-agent');
  `
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', code], { timeout: 10000 })
  assert.equal(result.stdout, 'personal-agent')
})

test('Personal Agent owns all browser assets and declares independent client, execution and worker entries', async () => {
  const source = fileURLToPath(new URL('..', import.meta.url))
  const recipe = JSON.parse(await readFile(new URL('../anybox.app.json', import.meta.url), 'utf8'))
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const registration = createRegistration({ phase: 'prepare', role: 'client', appId: recipe.appId })
  const execution = createExecutionRegistration({ phase: 'prepare', role: 'execution', appId: recipe.appId })
  assert.equal(recipe.version, metadata.version)
  assert.equal(execution.definition.id, 'personal-agent')
  assert.equal(registration.definition.id, 'personal-agent')
  assert.equal(execution.definition.web, undefined)
  assert.notEqual(execution.http.service, registration.http.service)
  assert.deepEqual(execution.capabilityRequirements, recipe.capabilityRequirements.execution)
  assert.deepEqual(registration.capabilityRequirements, recipe.capabilityRequirements.client)
  assert.equal(metadata.dependencies['@anybox/app-harness'], undefined)
  assert.equal(metadata.dependencies['@anybox/host'], undefined)
  assert.equal(recipe.lifecycleVersion, 1)
  assert.deepEqual(Object.keys(recipe.entries).sort(), ['client', 'computerWorker', 'execution'])
  await Promise.all(Object.values(recipe.entries).map(file => readFile(new URL('../' + file, import.meta.url))))
  await verifyWebAssets(createApplicationCatalog([registration], shellAssets))

  const assets = personalAgentAssets.map(asset => {
    assert.ok(asset.path.startsWith('/apps/' + recipe.appId + '/' + recipe.version + '/'))
    const local = relative(source, asset.file)
    assert.ok(!local.startsWith('..'), 'application browser assets are inside its package')
    return { ...asset, file: 'payload/' + local.split(sep).join('/') }
  })
  const target = { os: process.platform, arch: process.arch }
  const manifest = {
    schemaVersion: 1, appId: recipe.appId, version: recipe.version, publisher: recipe.publisher,
    displayName: recipe.displayName, applicationApi: recipe.applicationApi, target,
    web: { entry: 'payload/' + recipe.web.entry, styles: recipe.web.styles.map(file => 'payload/' + file), assets: 'payload/assets.json' },
  }
  const entries = [
    { path: 'manifest.json', bytes: Buffer.from(JSON.stringify(manifest)) },
    { path: 'payload/assets.json', bytes: Buffer.from(JSON.stringify({ schemaVersion: 1, assets })) },
    ...await Promise.all(personalAgentAssets.map(async (asset, index) => ({ path: assets[index].file, bytes: await readFile(asset.file) }))),
  ]
  const directory = verifyApplicationDirectory(entries, { target, trustedPublishers: [], allowUnsignedLocal: true, applicationApiVersion: '0.1.0' })
  assert.equal(verifyPackageWebResources(directory).entry, registration.definition.web.entry)
})

test('Personal Agent configuration keeps the existing Models location and isolates execution data', () => {
  const clientPath = fileURLToPath(new URL('./fixtures/client.sqlite', import.meta.url))
  const modelsPath = fileURLToPath(new URL('./fixtures/personal-agent-models.json', import.meta.url))
  const executionPath = fileURLToPath(new URL('./fixtures/personal-agent-execution.sqlite', import.meta.url))
  const config = parsePersonalAgentServerConfig({}, clientPath)
  assert.equal(config.modelsConfigPath, modelsPath)
  assert.equal(config.credentialNamespace, 'anybox.personal-agent.models')
  assert.equal(config.harnessDatabasePath, executionPath)
  assert.throws(() => parsePersonalAgentServerConfig({ ANYBOX_PERSONAL_AGENT_EXECUTION_DATABASE: clientPath }, clientPath), /must be distinct/)
})
