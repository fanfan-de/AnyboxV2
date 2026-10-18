import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { generateKeyPairSync, createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile, readFile, access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '@anybox/storage-sqlite/sqlite'
import { createPackageRegistryComponent } from '../dist/package-management/component.js'
import { createApplicationArchive, createApplicationDirectory } from '../dist/package-management/archive.js'
import { packageRegistryStorageServiceKey, packageRegistryServiceKey } from '../dist/package-management/port.js'

const { privateKey, publicKey } = generateKeyPairSync('ed25519'), target = { os: process.platform, arch: process.arch }
const commandModule = new URL('../dist/package-management/install-command.js', import.meta.url).href
const script = `import {runPackageManagementCommand} from ${JSON.stringify(commandModule)}; process.exitCode=await runPackageManagementCommand(process.argv.slice(1))`
function run(args, main = false) {
  const child = spawn(process.execPath, main ? [fileURLToPath(new URL('../dist/main.js', import.meta.url)), ...args] : ['--input-type=module', '-e', script, ...args], { cwd: fileURLToPath(new URL('../../..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => { stdout += bytes.toString() }); child.stderr.on('data', bytes => { stderr += bytes.toString() })
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr, json: stdout.trim() ? JSON.parse(stdout) : undefined })) })
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-install-cli-')), packages = join(directory, 'applications'), path = join(directory, 'calculator.anybox-app'), policy = join(directory, 'trust.json')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const input = { keyId: 'fixture-key', privateKey,
    manifest: { schemaVersion: 1, appId: 'calculator', version: '1.0.0', publisher: 'fixture', displayName: 'Calculator', applicationApi: '^0.1.0', target, web: { entry: 'payload/web/app.js', assets: 'payload/assets.json' } },
    files: [{ path: 'licenses/LICENSE', bytes: Buffer.from('MIT fixture') }, { path: 'payload/web/app.js', bytes: Buffer.from('export const value=1') }, { path: 'payload/assets.json', bytes: Buffer.from(JSON.stringify({ schemaVersion: 1, assets: [{ path: '/apps/calculator/1.0.0/app.js', file: 'payload/web/app.js', type: 'text/javascript' }] })) }],
  }
  const archive = Buffer.from(createApplicationArchive(input)), folder = join(directory, 'calculator')
  for (const entry of createApplicationDirectory(input)) {
    await mkdir(dirname(join(folder, entry.path)), { recursive: true }); await writeFile(join(folder, entry.path), entry.bytes, { mode: entry.mode ?? 0o644 })
  }
  await writeFile(path, archive); await writeFile(policy, JSON.stringify({ schemaVersion: 1, publishers: [{ publisher: 'fixture', keyId: 'fixture-key', publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), appIds: ['calculator'] }] }))
  return { directory, packages, path, policy, archive, folder }
}

test('offline install CLI verifies a local file and reports installation facts and operations as safe JSON', async t => {
  const env = await fixture(t)
  const installed = await run(['install', env.path, '--directory', env.packages, '--trust', env.policy, '--request-id', 'cli-request'])
  assert.equal(installed.code, 0, installed.stderr); assert.equal(installed.json.phase, 'installed')
  assert.equal(installed.json.workGuardIds, undefined); assert.equal(installed.json.receipt, undefined)
  const facts = await run(['installations', '--directory', env.packages])
  assert.equal(facts.code, 0, facts.stderr); assert.equal(facts.json.applications.length, 1); assert.equal(facts.json.applications[0].selected, null); assert.deepEqual(facts.json.actual, [])
  const operations = await run(['operations', '--directory', env.packages], true)
  assert.equal(operations.code, 0, operations.stderr); assert.equal(operations.json.installations.length, 1); assert.equal(operations.json.operations[0].phase, 'recovery-required')
  assert.equal(operations.json.installations[0].workGuardIds, undefined)
  const duplicate = await run(['install', env.path, '--directory', env.packages, '--trust', env.policy, '--request-id', 'cli-request'])
  assert.equal(duplicate.code, 0, duplicate.stderr); assert.equal(duplicate.json.id, installed.json.id)
})

test('offline install CLI snapshots a signed application directory and reuses its identity from optional ZIP distribution', async t => {
  const env = await fixture(t)
  const installed = await run(['install', env.folder, '--directory', env.packages, '--trust', env.policy, '--request-id', 'folder-request'])
  assert.equal(installed.code, 0, installed.stderr); assert.equal(installed.json.phase, 'installed'); assert.equal(installed.json.sourceFormat, 'directory')
  const duplicate = await run(['install', env.path, '--directory', env.packages, '--trust', env.policy, '--request-id', 'zip-request'])
  assert.equal(duplicate.code, 0, duplicate.stderr); assert.deepEqual(duplicate.json.identity, installed.json.identity); assert.equal(duplicate.json.existingInstallation, true)
  await writeFile(join(env.folder, 'payload/web/app.js'), 'export const value=2')
  const identity = installed.json.identity
  assert.equal(await readFile(join(env.packages, 'packages', identity.appId, identity.version, identity.digest, 'application/payload/web/app.js'), 'utf8'), 'export const value=1')
  const changed = await run(['install', env.folder, '--directory', env.packages, '--trust', env.policy, '--request-id', 'folder-request'])
  assert.equal(changed.code, 1); assert.match(changed.stderr, /request-conflict/)
})

test('explicit local trust installs an unsigned directory without executing its application code or accepting unsigned archives', async t => {
  const env = await fixture(t)
  await rm(join(env.folder, 'files.json')); await rm(join(env.folder, 'signature.json'))
  await writeFile(join(env.folder, 'payload/web/app.js'), 'throw new Error("application code must not execute during install")')
  const installed = await run(['install', env.folder, '--directory', env.packages, '--trust-local', '--request-id', 'local-folder'])
  assert.equal(installed.code, 0, installed.stderr); assert.equal(installed.json.phase, 'installed'); assert.equal(installed.json.localTrust, true)
  const resumed = await run(['recover', installed.json.id, '--action', 'resume', '--directory', env.packages])
  assert.equal(resumed.code, 0, resumed.stderr); assert.equal(resumed.json.phase, 'installed'); assert.equal(resumed.json.localTrust, true)
  const rejected = await run(['install', env.path, '--directory', env.packages, '--trust-local', '--request-id', 'local-archive'])
  assert.equal(rejected.code, 1); assert.match(rejected.stderr, /"code":"invalid-input"/)
  const unsigned = await run(['install', env.folder, '--directory', env.packages, '--trust', env.policy, '--request-id', 'no-local-trust'])
  assert.equal(unsigned.code, 1); assert.equal(unsigned.json.phase, 'failed')
})

test('read-only verify CLI accepts signed and explicitly trusted local directories without installing them', async t => {
  const env = await fixture(t)
  const signed = await run(['verify', env.folder, '--trust', env.policy], true)
  assert.equal(signed.code, 0, signed.stderr); assert.equal(signed.json.sourceFormat, 'directory'); assert.equal(signed.json.localTrust, false)
  await rm(join(env.folder, 'files.json')); await rm(join(env.folder, 'signature.json'))
  const local = await run(['verify', env.folder, '--trust-local'], true)
  assert.equal(local.code, 0, local.stderr); assert.equal(local.json.localTrust, true)
  const localPolicy = await run(['verify', env.folder, '--trust-local', '--trust', env.policy], true)
  assert.equal(localPolicy.code, 0, localPolicy.stderr); assert.deepEqual(localPolicy.json.identity, local.json.identity)
  await assert.rejects(access(env.packages), { code: 'ENOENT' })
  const rejected = await run(['verify', env.path, '--trust-local'], true)
  assert.equal(rejected.code, 1)
})

test('offline CLI refuses a package directory owned by a live host without deleting its writer lock', async t => {
  const env = await fixture(t), root = new Context()
  await root.installComponent(createLocalSqliteComponent(join(env.packages, 'registry.sqlite'), { serviceKey: packageRegistryStorageServiceKey }))
  await root.installComponent(createPackageRegistryComponent({ directory: env.packages }))
  t.after(() => root.fiber.dispose())
  const result = await run(['operations', '--directory', env.packages])
  assert.equal(result.code, 1); assert.match(result.stderr, /"code":"occupied"/)
  assert.deepEqual((await root.get(packageRegistryServiceKey).inspect()).applications, [])
  const again = await run(['installations', '--directory', env.packages])
  assert.equal(again.code, 1); assert.match(again.stderr, /"code":"occupied"/)
})

test('explicit offline inspection and discard settle an interrupted unreceived intent without any publisher trust', async t => {
  const env = await fixture(t), root = new Context()
  await root.installComponent(createLocalSqliteComponent(join(env.packages, 'registry.sqlite'), { serviceKey: packageRegistryStorageServiceKey }))
  await root.installComponent(createPackageRegistryComponent({ directory: env.packages }))
  const job = await root.get(packageRegistryServiceKey).acceptFileInstall({ requestId: 'interrupted', filename: 'calculator.anybox-app', archiveDigest: createHash('sha256').update(env.archive).digest('hex'), archiveSize: env.archive.length })
  await root.fiber.dispose()
  const inspected = await run(['recover', job.id, '--action', 'inspect', '--directory', env.packages])
  assert.equal(inspected.code, 0, inspected.stderr); assert.equal(inspected.json.phase, 'recovery-required')
  const discarded = await run(['recover', job.id, '--action', 'discard', '--directory', env.packages])
  assert.equal(discarded.code, 0, discarded.stderr); assert.equal(discarded.json.phase, 'cancelled')
  const cancelled = await run(['cancel', job.id, '--directory', env.packages])
  assert.equal(cancelled.code, 0, cancelled.stderr); assert.equal(cancelled.json.phase, 'cancelled')
})

test('invalid or untrusted offline commands cannot grant package trust or create installation facts', async t => {
  const env = await fixture(t), never = join(env.directory, 'never')
  const invalid = await run(['install', env.path, '--directory', never, '--request-id', 'missing-trust'])
  assert.equal(invalid.code, 1); assert.match(invalid.stderr, /"code":"invalid-input"/)
  await assert.rejects(access(never), error => error?.code === 'ENOENT')
  const duplicateOption = await run(['operations', '--directory', env.packages, '--directory', never])
  assert.equal(duplicateOption.code, 1); assert.match(duplicateOption.stderr, /"code":"invalid-input"/)
  await writeFile(env.policy, JSON.stringify({ schemaVersion: 1, publishers: [] }))
  const rejected = await run(['install', env.path, '--directory', env.packages, '--trust', env.policy, '--request-id', 'untrusted'])
  assert.equal(rejected.code, 1); assert.equal(rejected.json.phase, 'failed'); assert.equal(rejected.json.errorCode, 'publisher-not-authorized')
  const facts = await run(['installations', '--directory', env.packages])
  assert.deepEqual(facts.json.applications, [])
})
