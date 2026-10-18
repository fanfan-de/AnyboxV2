import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPairSync, createHash, randomUUID } from 'node:crypto'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, readFile, writeFile, chmod, symlink, link, access } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { createApplicationArchive, verifyApplicationArchive } from '../dist/package-management/archive.js'
import { isInstalledPackageCorruption } from '../dist/package-management/loader.js'
import { currentApplicationRuntimeProfile } from '../dist/package-management/policy.js'
import { prepareUsageLock, tryAcquirePackageUsageExitLock } from '../dist/package-management/usage-locks.js'

const keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString()
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const target = { os: process.platform, arch: process.arch }, profile = currentApplicationRuntimeProfile()
const supported = Number(process.versions.node.split('.')[0]) > 22 || Number(process.versions.node.split('.')[0]) === 22 && Number(process.versions.node.split('.')[1]) >= 15
const verification = { target, applicationApiVersion: '0.1.0', trustedPublishers: [{ publisher: 'fixture', keyId: 'fixture', publicKey, appIds: ['calculator', 'second'] }], runtimeProfiles: { client: profile, execution: profile, computerWorker: profile } }
function factory(id = 'calculator', { extra = '', name = 'Calculator', web = true, requirements = {}, before = '', runtime = true } = {}) {
  const prefix = `/apps/${id}/1.0.0`
  return `${before}\nexport async function createRegistration(context,config) { ${extra}; return { definition: { id: '${id}', name: '${name}', icon: '${id}', description: typeof config?.label === 'string' ? config.label : 'fixture', ${web ? `web: {entry: '${prefix}/app.js', styles: []}` : ''} }, capabilityRequirements: ${JSON.stringify(requirements)}, ${runtime ? "createRuntime(){throw new Error('business-must-not-initialize')}," : ''} assets: ${web ? `[{path: '${prefix}/app.js',file: new URL('./web/app.js', import.meta.url).pathname,type: 'text/javascript'}]` : '[]'} } }`
}
function archive({ lifecycleVersion = 1, id = 'calculator', version = '1.0.0', entries, files = {}, requirements, web = true, profiles, code } = {}) {
  const prefix = `/apps/${id}/${version}`
  const payload = { 'licenses/LICENSE': 'MIT test fixture', 'payload/package.json': '{"type":"module"}',
    ...(web ? { 'payload/web/app.js': 'export function mount(){return {setActive(){},canClose(){return true},async dispose(){}}}', 'payload/assets.json': JSON.stringify({ schemaVersion: 1, assets: [{ path: `${prefix}/app.js`, file: 'payload/web/app.js', type: 'text/javascript' }] }) } : {}),
    ...(code ? { 'payload/registration.js': code } : {}), ...files }
  const bytes = Buffer.from(createApplicationArchive({ keyId: 'fixture', privateKey: keys.privateKey,
    manifest: { schemaVersion: 1, ...(lifecycleVersion === null ? {} : { lifecycleVersion }), appId: id, version, publisher: 'fixture', displayName: 'Calculator', applicationApi: '^0.1.0', target,
      ...(web ? { web: { entry: 'payload/web/app.js', assets: 'payload/assets.json' } } : {}),
      ...(entries ? { entries, runtimeRequirements: Object.fromEntries(Object.keys(entries).map(role => [role, profiles?.[role] ?? { profile: 'anybox-node-runtime-1', sharedRuntime: 'nya-runtime-1', node: '>=22.15.0' }])) } : {}), ...(requirements ? { capabilityRequirements: requirements } : {}) },
    files: Object.entries(payload).map(([path, bytes]) => ({ path, bytes: typeof bytes === 'string' ? Buffer.from(bytes) : bytes })) }))
  return { bytes, archive: verifyApplicationArchive(bytes, verification) }
}
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-loader-')), children = []
  t.after(async () => { for (const child of children) if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done } await rm(directory, { recursive: true, force: true }) })
  async function materialize(bundle) {
    const { archive } = bundle, container = join(directory, 'packages', archive.identity.appId, archive.identity.version, archive.identity.digest), application = join(container, 'application')
    await mkdir(application, { recursive: true, mode: 0o700 })
    for (const file of [...archive.files, ...['manifest.json', 'files.json', 'signature.json'].map(path => ({ path, mode: 420 }))]) {
      const path = join(application, file.path); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, archive.readFile(file.path), { mode: file.mode }); await chmod(path, file.mode)
    }
    await writeFile(join(container, 'archive.anybox-app'), bundle.bytes)
    await writeFile(join(container, 'receipt.json'), JSON.stringify({ schemaVersion: 1, identity: archive.identity, archiveDigest: archive.archiveDigest, archiveSize: archive.archiveSize }))
    return { container, application, identity: archive.identity }
  }
  async function role(entries, { role = 'client', capabilities = [], options = {}, worker = false, onClaim } = {}) {
    const usageId = randomUUID(), secret = randomUUID(), snapshot = { id: randomUUID(), revision: 0, registryRevision: 1, ownerEpoch: 1, role, entries, capabilities, revoked: false }
    prepareUsageLock(directory, usageId, hash(secret))
    const credential = { usageId, secret, snapshot }, child = fork(new URL('./helpers/package-loader-role.mjs', import.meta.url), [], { cwd: directory, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    children.push(child)
    const messages = [], waiters = [], errors = []
    child.stderr.on('data', bytes => errors.push(bytes.toString()))
    function dispatch(message) { const index = waiters.findIndex(item => item.type === message.type); if (index >= 0) waiters.splice(index, 1)[0].resolve(message); else messages.push(message) }
    child.on('message', async message => {
      if (message.type === 'claim' || message.type === 'ready') {
        try {
          const exclusive = tryAcquirePackageUsageExitLock(directory, usageId)
          if (exclusive) { await exclusive.release(); throw Error('claim must hold actual SHARED') }
          if (message.type === 'claim') await onClaim?.()
          child.send({ type: 'reply', id: message.id, value: message.type === 'claim' ? snapshot : { snapshot, usage: { id: usageId, snapshotId: snapshot.id, holderId: 'test-role', generation: 'test-generation', parentId: null, state: 'ready', createdAt: new Date().toISOString() } } })
        } catch (error) { dispatch({ type: 'test-error', error }); child.kill('SIGKILL') }
      } else dispatch(message)
    })
    const wait = type => { const found = messages.findIndex(item => item.type === type); if (found >= 0) return Promise.resolve(messages.splice(found, 1)[0]); return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error(`Timed out ${type}: ${JSON.stringify(messages)} ${errors.join('')}`)), 15000); waiters.push({ type, resolve(value) { clearTimeout(timer); resolve(value) } }) }) }
    await wait('booted')
    child.send({ type: 'load', worker, options: { directory, credential, verification, ...options } })
    return { child, credential, snapshot, wait, send: value => child.send(value), async exit() { const done = once(child, 'exit'); child.send({ type: 'exit' }); await done }, pinned() { return tryAcquirePackageUsageExitLock(directory, usageId) === undefined }, async exited() { const lock = tryAcquirePackageUsageExitLock(directory, usageId); assert.ok(lock); lock.revoke(); await lock.release() } }
  }
  return { directory, materialize, role }
}
const nodeFixture = options => archive({ entries: { client: 'payload/registration.js' }, code: factory('calculator', options), ...options })

test('pure interface loads with the real usage lock before claim, does not invent a backend, and stays pinned through close', async t => {
  const env = await setup(t), installed = await env.materialize(archive()), role = await env.role([{ package: installed.identity, entry: 'web' }])
  const loaded = await role.wait('loaded')
  assert.equal(loaded.applications[0].hasRuntime, false); assert.equal(loaded.applications[0].definition.web.entry, '/apps/calculator/1.0.0/app.js')
  role.send({ type: 'ready' }); assert.equal((await role.wait('ready-result')).actual.usage.state, 'ready')
  role.send({ type: 'close' }); await role.wait('closed'); assert.equal(role.pinned(), true)
  role.send({ type: 'ready' }); assert.equal((await role.wait('failed')).code, 'package-loader-closing')
  await role.exit(); await role.exited()
})

test('runtime construction uses only the exact role and app-owned config, without opening business resources', { skip: !supported }, async t => {
  const env = await setup(t), marker = join(env.directory, 'evaluated'), installed = await env.materialize(nodeFixture({ extra: `if(context.phase!=='runtime'||context.role!=='client'||context.appId!=='calculator')throw Error('wrong context');globalThis.__loaderValues=[config.label]`, before: `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'yes')` }))
  const role = await env.role([{ package: installed.identity, entry: 'client', desiredEnabled: false }], { options: { roleConfig: { calculator: { label: 'application-owned' } } }, async onClaim() { await assert.rejects(access(marker), error => error.code === 'ENOENT') } })
  const loaded = await role.wait('loaded'); assert.equal(loaded.applications[0].hasRuntime, true); assert.deepEqual(loaded.values, ['application-owned']); assert.equal(loaded.applications[0].definition.description, 'application-owned')
  assert.equal(await readFile(marker, 'utf8'), 'yes')
})

test('installed payload resolves public Nya, API and SQLite to the host module identities', { skip: !supported }, async t => {
  const env = await setup(t), installed = await env.materialize(nodeFixture({ before: `import {Context} from '@nya/core';import {createApplicationRuntime} from '@anybox/application-api/nya';import {createLocalSqliteComponent} from '@anybox/storage-sqlite';`, extra: "globalThis.__loaderValues=[Context===globalThis.__loaderPublic.Context,createApplicationRuntime===globalThis.__loaderPublic.createApplicationRuntime,createLocalSqliteComponent===globalThis.__loaderPublic.createLocalSqliteComponent]", files: {
    // Complete standalone production closures carry these physical dependencies.
    // Hosted bare imports must always bypass them for the canonical host modules.
    'payload/node_modules/@nya/core/package.json': '{"type":"module","exports":"./index.js"}',
    'payload/node_modules/@nya/core/index.js': "throw Error('private Nya must not load')",
    'payload/node_modules/@anybox/application-api/package.json': '{"type":"module","exports":{"./nya":"./nya.js"}}',
    'payload/node_modules/@anybox/application-api/nya.js': "throw Error('private API must not load')",
    'payload/node_modules/@anybox/storage-sqlite/package.json': '{"type":"module","exports":"./index.js"}',
    'payload/node_modules/@anybox/storage-sqlite/index.js': "throw Error('private SQL must not load')",
  } }))
  const role = await env.role([{ package: installed.identity, entry: 'client', desiredEnabled: false }]); assert.deepEqual((await role.wait('loaded')).values, [true, true, true])
})

test('different applications keep independent production dependency graphs outside the repository', { skip: !supported }, async t => {
  const env = await setup(t), one = await env.materialize(nodeFixture({ before: "import value from 'local-value'", extra: '(globalThis.__loaderValues??=[]).push(value)', files: { 'payload/node_modules/local-value/package.json': '{"type":"module","exports":"./index.js"}', 'payload/node_modules/local-value/index.js': 'export default "first"' } })), two = await env.materialize(archive({ id: 'second', entries: { client: 'payload/registration.js' }, code: factory('second', { before: "import value from 'local-value'", extra: '(globalThis.__loaderValues??=[]).push(value)' }), files: { 'payload/node_modules/local-value/package.json': '{"type":"module","exports":"./index.js"}', 'payload/node_modules/local-value/index.js': 'export default "second"' } }))
  const role = await env.role([{ package: one.identity, entry: 'client' }, { package: two.identity, entry: 'client' }]); assert.deepEqual((await role.wait('loaded')).values, ['first', 'second']); assert.equal((await readFile(join(one.application, 'payload/node_modules/local-value/index.js'), 'utf8')), 'export default "first"')
})

test('indexed CommonJS dependencies and actual target native addons load without running credential operations', { skip: !supported || process.platform !== 'darwin' || process.arch !== 'arm64' }, async t => {
  const env = await setup(t), native = await readFile(new URL('../../../node_modules/@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node', import.meta.url))
  const installed = await env.materialize(nodeFixture({ before: "import value from './value.cjs'", extra: 'globalThis.__loaderValues=[value]', files: { 'payload/value.cjs': "const native=require('./native.node');module.exports=typeof native.Entry", 'payload/native.node': native } }))
  const role = await env.role([{ package: installed.identity, entry: 'client' }]); assert.deepEqual((await role.wait('loaded')).values, ['function'])
})

test('lazy imports remain checked after load and after the host handle closes', { skip: !supported }, async t => {
  const env = await setup(t), installed = await env.materialize(nodeFixture({ extra: "globalThis.__loaderLazy=async()=> (await import('./lazy.js')).value", files: { 'payload/lazy.js': 'export const value=1' } })), role = await env.role([{ package: installed.identity, entry: 'client' }])
  await role.wait('loaded'); role.send({ type: 'close' }); await role.wait('closed')
  await writeFile(join(installed.application, 'payload/lazy.js'), 'export const value=2')
  role.send({ type: 'lazy' }); assert.equal((await role.wait('failed')).code, 'package-loader-module-changed'); assert.equal(role.pinned(), true)
})

test('raw metadata, unimported payload and extra files are revalidated before any module import', async t => {
  for (const mutation of ['manifest', 'unimported', 'extra']) {
    const env = await setup(t), installed = await env.materialize(archive({ files: { 'payload/unused.txt': 'original' } }))
    if (mutation === 'manifest') await writeFile(join(installed.application, 'manifest.json'), '{}')
    if (mutation === 'unimported') await writeFile(join(installed.application, 'payload/unused.txt'), 'modified')
    if (mutation === 'extra') await writeFile(join(installed.application, 'payload/extra.txt'), 'outside-index')
    const role = await env.role([{ package: installed.identity, entry: 'web' }]); assert.match((await role.wait('failed')).code, /^package-loader-(content-changed|unindexed-content)$/); assert.equal(role.pinned(), true)
  }
})

test('symlinks and hardlinked payload replacements cannot be imported', async t => {
  for (const mutation of ['symlink', 'hardlink']) {
    const env = await setup(t), installed = await env.materialize(archive()), file = join(installed.application, 'payload/web/app.js'), outside = join(env.directory, 'outside.js')
    await writeFile(outside, await readFile(file)); await rm(file)
    if (mutation === 'symlink') await symlink(outside, file); else await link(outside, file)
    const role = await env.role([{ package: installed.identity, entry: 'web' }]); assert.match((await role.wait('failed')).code, /^package-loader-(file-unsafe|content-changed)$/)
  }
})

test('role, entry, registration identity and selected capability version mismatches never become ready', { skip: !supported }, async t => {
  for (const variant of ['role', 'identity', 'capability', 'runtime']) {
    const env = await setup(t), requirements = { required: { 'storage.sqlite': '^1.0.0' } }, installed = await env.materialize(nodeFixture({ requirements: variant === 'capability' ? { client: requirements } : undefined, ...(variant === 'identity' ? { code: factory('second') } : {}), ...(variant === 'capability' ? { code: factory('calculator', { requirements }) } : {}), ...(variant === 'runtime' ? { profiles: { client: { profile: 'future-runtime' } } } : {}) }))
    const role = await env.role([{ package: installed.identity, entry: variant === 'role' ? 'execution' : 'client' }], { capabilities: variant === 'capability' ? [{ id: 'storage.sqlite', version: '2.0.0', package: null }] : [] })
    assert.equal((await role.wait('failed')).code, { role: 'package-loader-entry-mismatch', identity: 'package-registration-metadata-mismatch', capability: 'package-loader-capability-mismatch', runtime: 'package-loader-runtime-incompatible' }[variant])
  }
})

test('an import escaping the production closure or reaching a private shared runtime is rejected and keeps its process pin', { skip: !supported }, async t => {
  for (const variant of ['outside', 'private']) {
    const env = await setup(t), outside = join(env.directory, 'outside.mjs'); await writeFile(outside, 'export const value=1')
    const installed = await env.materialize(nodeFixture({ before: variant === 'outside' ? `import ${JSON.stringify(outside)}` : "import './node_modules/@nya/core/index.js'", ...(variant === 'private' ? { files: { 'payload/node_modules/@nya/core/index.js': 'export const value=1' } } : {}) }))
    const role = await env.role([{ package: installed.identity, entry: 'client' }]); assert.equal((await role.wait('failed')).code, variant === 'outside' ? 'package-loader-module-outside-payload' : 'package-loader-private-shared-runtime'); assert.equal(role.pinned(), true)
    await role.exit(); await role.exited()
  }
})

test('worker bootstrap imports only its exact signed main and invokes it explicitly without a registration or business open', { skip: !supported }, async t => {
  const env = await setup(t), installed = await env.materialize(archive({ web: false, entries: { computerWorker: 'payload/worker.js' }, files: { 'payload/worker.js': "export async function main(args){globalThis.__loaderValues=[...args]}" } })), role = await env.role([{ package: installed.identity, entry: 'computer-worker' }], { role: 'computer-worker', worker: true })
  assert.equal((await role.wait('loaded')).values, undefined)
  role.send({ type: 'main', args: ['--help'] }); assert.deepEqual((await role.wait('main-result')).values, ['--help']); role.send({ type: 'ready' }); assert.equal((await role.wait('ready-result')).actual.snapshot.role, 'computer-worker')
})


test('load failures identify only the affected package and distinguish actual corruption from runtime incompatibility', async t => {
  const env = await setup(t), first = await env.materialize(archive()), second = await env.materialize(archive({ id: 'second' }))
  await writeFile(join(second.application, 'payload/web/app.js'), 'damaged')
  const role = await env.role([{ package: first.identity, entry: 'web' }, { package: second.identity, entry: 'web' }]), error = await role.wait('failed')
  assert.equal(error.corruption, true); assert.deepEqual(error.packageIdentity, second.identity); assert.notDeepEqual(error.packageIdentity, first.identity)
})

test('quarantine classification excludes policy changes, stale reservations, unavailable runtimes and ABI errors', () => {
  const packageIdentity = archive().archive.identity
  for (const code of ['snapshot-stale', 'snapshot-revoked', 'publisher-not-authorized', 'application-api-incompatible', 'target-incompatible', 'invalid-limits', 'archive-size-limit', 'package-loader-runtime-incompatible', 'package-loader-capability-mismatch', 'ERR_DLOPEN_FAILED']) {
    assert.equal(isInstalledPackageCorruption(Object.assign(new Error(code), { code, packageIdentity })), false, code)
  }
  for (const code of ['ENOENT', 'ENOTDIR', 'ELOOP']) assert.equal(isInstalledPackageCorruption(Object.assign(new Error('application-owned path missing'), { code, packageIdentity })), false)
  assert.equal(isInstalledPackageCorruption(Object.assign(new Error('other file'), { code: 'ENOENT' })), false)
  assert.equal(isInstalledPackageCorruption(Object.assign(new Error('unsafe identity'), { code: 'ENOENT', packageIdentity: { appId: '../outside' } })), false)
})


test('optional independent role launch is app-scoped and gated by the actual application runtime lifecycle', { skip: !supported }, async t => {
  const env = await setup(t), code = `export function createRegistration(context){globalThis.__loaderStart=context.startRole;return {definition:{id:'calculator',name:'Calculator',icon:'calculator',web:{entry:'/apps/calculator/1.0.0/app.js',styles:[]}},assets:[{path:'/apps/calculator/1.0.0/app.js',file:new URL('./web/app.js',import.meta.url).pathname,type:'text/javascript'}],createRuntime(){return {async open(){await context.startRole('computer-worker',{ownership:'independent',args:['serve','opaque-directory']})},async stop(){},async retry(){},inspect(){return 'active'},closeAdmission(){},async awaitIdle(){}}}}}`
  const installed = await env.materialize(archive({ entries: { client: 'payload/registration.js', computerWorker: 'payload/worker.js' }, code, files: { 'payload/worker.js': 'export async function main(){}' } })), role = await env.role([{ package: installed.identity, entry: 'client' }], { options: { enableStartRole: true } })
  await role.wait('loaded'); role.send({ type: 'invoke-role' }); assert.equal((await role.wait('failed')).code, 'package-role-inactive')
  role.send({ type: 'open' }); const opened = await role.wait('opened'); assert.equal(opened.launched.length, 1); assert.deepEqual(opened.launched[0], { identity: installed.identity, role: 'computer-worker', ownership: 'independent', args: ['serve', 'opaque-directory'] })
  role.send({ type: 'stop' }); await role.wait('stopped'); role.send({ type: 'invoke-role' }); assert.equal((await role.wait('failed')).code, 'package-role-inactive')
  role.send({ type: 'close' }); await role.wait('closed'); role.send({ type: 'invoke-role' }); assert.equal((await role.wait('failed')).code, 'package-role-inactive')
})

test('a package factory cannot start an independent role during registration construction', { skip: !supported }, async t => {
  const env = await setup(t), installed = await env.materialize(archive({ entries: { client: 'payload/registration.js', computerWorker: 'payload/worker.js' }, code: `export async function createRegistration(context){await context.startRole('computer-worker',{ownership:'independent',args:[]})}`, files: { 'payload/worker.js': 'export async function main(){}' } })), role = await env.role([{ package: installed.identity, entry: 'client' }], { options: { enableStartRole: true } })
  const error = await role.wait('failed'); assert.equal(error.code, 'package-role-inactive'); assert.equal(error.corruption, false)
})

test('private runtime channel is bound to one installed identity and closes with the client application', { skip: !supported }, async t => {
  const env = await setup(t), code = `export function createRegistration(context){globalThis.__loaderChannel=context.channel;return {definition:{id:'calculator',name:'Calculator',icon:'calculator',web:{entry:'/apps/calculator/1.0.0/app.js',styles:[]}},assets:[{path:'/apps/calculator/1.0.0/app.js',file:new URL('./web/app.js',import.meta.url).pathname,type:'text/javascript'}],createRuntime(){return {async open(){},async stop(){},async retry(){},inspect(){return 'active'},closeAdmission(){},async awaitIdle(){}}}}}`
  const installed = await env.materialize(archive({ entries: { client: 'payload/registration.js' }, code })), role = await env.role([{ package: installed.identity, entry: 'client' }], { options: { enableChannel: true } })
  await role.wait('loaded')
  role.send({ type: 'invoke-channel', payload: { op: 'echo' } }); assert.equal((await role.wait('failed')).code, 'package-role-inactive')
  role.send({ type: 'open' }); await role.wait('opened')
  role.send({ type: 'invoke-channel', payload: { op: 'echo' } }); assert.deepEqual((await role.wait('channel-result')).value, { identity: installed.identity, payload: { op: 'echo' }, aborted: false })
  role.send({ type: 'stop' }); await role.wait('stopped')
  role.send({ type: 'invoke-channel', payload: null }); assert.equal((await role.wait('failed')).code, 'package-role-inactive')
  role.send({ type: 'close' }); await role.wait('closed')
})

test('execution registration never receives a client channel even when a transport hook is supplied', { skip: !supported }, async t => {
  const env = await setup(t), installed = await env.materialize(archive({ web: false, entries: { execution: 'payload/registration.js' }, code: factory('calculator', { web: false, extra: 'globalThis.__loaderValues=[context.channel===undefined]' }) }))
  const role = await env.role([{ package: installed.identity, entry: 'execution' }], { role: 'execution', options: { enableChannel: true } })
  assert.deepEqual((await role.wait('loaded')).values, [true])
})


test('legacy signed worker packages remain readable but cannot load roles before a lifecycle-aware update', { skip: !supported }, async t => {
  const env = await setup(t), bundle = archive({ lifecycleVersion: null, entries: { client: 'payload/registration.js', computerWorker: 'payload/worker.js' }, code: factory(), files: { 'payload/worker.js': 'export async function main(){}' } }), installed = await env.materialize(bundle)
  assert.equal(bundle.archive.manifest.lifecycleVersion, undefined)
  const role = await env.role([{ package: installed.identity, entry: 'client' }], { options: { enableStartRole: true } }), error = await role.wait('failed')
  assert.equal(error.code, 'package-lifecycle-upgrade-required'); assert.equal(error.corruption, false); assert.deepEqual(error.packageIdentity, installed.identity)
})


test('application factory missing configuration is not quarantined while a missing installed container is corruption', { skip: !supported }, async t => {
  const config = await setup(t), installed = await config.materialize(nodeFixture({ extra: "throw Object.assign(new Error('app configuration missing'),{code:'ENOENT'})" })), role = await config.role([{ package: installed.identity, entry: 'client' }])
  const failure = await role.wait('failed'); assert.equal(failure.code, 'ENOENT'); assert.equal(failure.corruption, false); assert.deepEqual(failure.packageIdentity, installed.identity)
  const missing = await setup(t), absent = await missing.materialize(archive())
  await rm(absent.container, { recursive: true })
  const broken = await missing.role([{ package: absent.identity, entry: 'web' }]), error = await broken.wait('failed')
  assert.equal(error.code, 'package-loader-content-missing'); assert.equal(error.corruption, true); assert.deepEqual(error.packageIdentity, absent.identity)
})
