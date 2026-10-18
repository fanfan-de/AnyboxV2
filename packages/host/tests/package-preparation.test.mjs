import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, rm, access, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApplicationArchive, verifyApplicationArchive } from '../dist/package-management/archive.js'
import { prepareApplicationArchive } from '../dist/package-management/preparation.js'
import { verifyPackageWebResources } from '../dist/package-management/preparation-static.js'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const target = { os: process.platform, arch: process.arch }
const nodeRuntime = { profile: 'anybox-node-runtime-1', sharedRuntime: 'nya-runtime-1', node: '>=22.15.0' }
const runtimeProfiles = Object.fromEntries(['client', 'execution', 'computerWorker'].map(role => [role, { ...nodeRuntime, node: process.versions.node }]))
const expected = code => error => error?.code === code
const prefix = '/apps/calculator/1.0.0'
function archive(input = {}) {
  const assets = input.assets ?? [{ path: `${prefix}/app.js`, file: 'payload/web/app.js', type: 'text/javascript; charset=utf-8' }]
  const manifest = { schemaVersion: 1, appId: 'calculator', version: '1.0.0', publisher: 'fixture', displayName: 'Calculator', applicationApi: '^0.1.0', target,
    ...(input.noWeb ? {} : { web: { entry: 'payload/web/app.js', assets: 'payload/assets.json', ...(input.styles ? { styles: input.styles } : {}) } }),
    ...(input.entries ? { entries: input.entries, runtimeRequirements: Object.fromEntries(Object.keys(input.entries).map(role => [role, input.requirements?.[role] ?? nodeRuntime])) } : {}),
    ...(input.capabilityRequirements ? { capabilityRequirements: input.capabilityRequirements } : {}) }
  const files = [{ path: 'licenses/LICENSE', bytes: Buffer.from('MIT fixture license') }, { path: 'payload/package.json', bytes: Buffer.from('{"type":"module"}') },
    ...(input.noWeb ? [] : [{ path: 'payload/web/app.js', bytes: Buffer.from(input.webSource ?? 'export async function mount() { return {setActive(){},canClose(){return true},async dispose(){}} }') }, { path: 'payload/assets.json', bytes: Buffer.from(input.indexSource ?? JSON.stringify({ schemaVersion: 1, assets })) }]),
    ...Object.entries(input.files ?? {}).map(([path, source]) => ({ path, bytes: Buffer.from(source) }))]
  return verifyApplicationArchive(createApplicationArchive({ manifest, files, keyId: 'fixture-key', privateKey }), {
    target, applicationApiVersion: '0.1.0', runtimeProfiles, trustedPublishers: [{ publisher: 'fixture', keyId: 'fixture-key', publicKey, appIds: ['calculator'] }],
  })
}
const clientFactory = (extra = '') => `export function createRegistration() { ${extra}; return { definition: { id: 'calculator', name: 'Calculator', icon: 'calculator', web: {entry: '${prefix}/app.js', styles: []} }, assets: [{path: '${prefix}/app.js',file: new URL('./web/app.js', import.meta.url).pathname,type: 'text/javascript; charset=utf-8'}] } }`
async function temporary(t) { const directory = await mkdtemp(join(tmpdir(), 'anybox-preparation-test-')); t.after(() => rm(directory, { recursive: true, force: true })); return directory }
const missing = async file => assert.rejects(access(file), error => error?.code === 'ENOENT')
const isUnixNode = process.platform !== 'win32' && !process.versions.electron && (Number(process.versions.node.split('.')[0]) > 22 || Number(process.versions.node.split('.')[0]) === 22 && Number(process.versions.node.split('.')[1]) >= 15)

test('pure UI preparation validates static graph and needs no Node registration, SQL, credentials or runtime', async () => {
  const prepared = await prepareApplicationArchive(archive({ webSource: "import {requireApplicationHttp} from '@anybox/application-api/web'; export const unused = requireApplicationHttp" }))
  assert.equal(prepared.roles.web.status, 'prepared')
  assert.deepEqual(Object.keys(prepared.roles), ['web'])
  assert.equal(prepared.web.entry, `${prefix}/app.js`)
  assert.equal(Object.isFrozen(prepared.web.assets), true)
})

test('preparation rejects caller-created proof objects before reading files or evaluating code', async () => {
  await assert.rejects(prepareApplicationArchive({ readFile() { throw Error('must not read') } }), expected('unverified-archive'))
  assert.throws(() => verifyPackageWebResources({ readFile() { throw Error('must not read') } }), expected('unverified-archive'))
})

test('missing JS imports, exports and dynamic literal imports are rejected, including unreachable assets', async () => {
  for (const webSource of ["import './missing.js'", "export * from './missing.js'", "export async function later(){ return import('./missing.js') }"]) {
    await assert.rejects(prepareApplicationArchive(archive({ webSource })), expected('package-resource-missing'))
  }
  const verified = archive({ assets: [{ path: `${prefix}/app.js`, file: 'payload/web/app.js', type: 'text/javascript' }, { path: `${prefix}/unused.js`, file: 'payload/web/unused.js', type: 'text/javascript' }], files: { 'payload/web/unused.js': "import './missing.js'" } })
  await assert.rejects(prepareApplicationArchive(verified), expected('package-resource-missing'))
})

test('browser imports use parsed syntax: string examples do not become imports; nonliteral and external imports fail', async () => {
  await prepareApplicationArchive(archive({ webSource: 'export const example = "import(\\\"./missing.js\\\")"; /* import "missing" */' }))
  for (const webSource of ["export function later(name){return import(name)}", "export const x = import(`./${name}.js`)"]) await assert.rejects(prepareApplicationArchive(archive({ webSource })), expected('package-dynamic-import-not-static'))
  for (const webSource of ["import 'https://example.invalid/app.js'", "import '@anybox/models'", "import 'node:fs'"]) await assert.rejects(prepareApplicationArchive(archive({ webSource })), expected('package-resource-reference-invalid'))
})

test('web graph validates new URL references, CSS imports and template resources without executing them', async () => {
  const extra = { assets: [{ path: `${prefix}/app.js`, file: 'payload/web/app.js', type: 'text/javascript' }, { path: `${prefix}/style.css`, file: 'payload/web/style.css', type: 'text/css' }], styles: ['payload/web/style.css'] }
  await assert.rejects(prepareApplicationArchive(archive({ webSource: "export const x = new URL('./missing.svg',import.meta.url)" })), expected('package-resource-missing'))
  await assert.rejects(prepareApplicationArchive(archive({ ...extra, files: { 'payload/web/style.css': '@import "./missing.css";' } })), expected('package-resource-missing'))
  await assert.rejects(prepareApplicationArchive(archive({ ...extra, files: { 'payload/web/style.css': 'a{background:url(https://example.invalid/a.svg)}' } })), expected('package-resource-reference-invalid'))
  const markup = { assets: [{ path: `${prefix}/app.js`, file: 'payload/web/app.js', type: 'text/javascript' }, { path: `${prefix}/template.html`, file: 'payload/web/template.html', type: 'text/html' }], files: { 'payload/web/template.html': '<img src="./missing.png">' } }
  await assert.rejects(prepareApplicationArchive(archive(markup)), expected('package-resource-missing'))
})

test('assets, MIME types and legacy paths must be explicitly owned by exact application policy', async () => {
  await assert.rejects(prepareApplicationArchive(archive({ assets: [{ path: '/applications/other/app.js', file: 'payload/web/app.js', type: 'text/javascript' }] })), expected('package-asset-invalid'))
  await assert.rejects(prepareApplicationArchive(archive({ assets: [{ path: `${prefix}/app.js`, file: 'payload/web/app.js', type: 'text/css' }] })), expected('package-web-entry-invalid'))
  const legacy = archive({ assets: [{ path: '/legacy/calculator/app.js', file: 'payload/web/app.js', type: 'text/javascript' }] })
  assert.equal((await prepareApplicationArchive(legacy, { trustedAliases: { calculator: { assetPrefixes: ['/legacy/calculator/'] } } })).web.entry, '/legacy/calculator/app.js')
  await assert.rejects(prepareApplicationArchive(legacy, { trustedAliases: { other: { assetPrefixes: ['/legacy/calculator/'] } } }), expected('package-asset-invalid'))
})

test('static conflicts with current catalog are rejected before Node factory import', { skip: !isUnixNode }, async t => {
  const directory = await temporary(t), marker = join(directory, 'marker')
  const verified = archive({ entries: { client: 'payload/client.js' }, files: { 'payload/client.js': `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'bad'); ${clientFactory()}` } })
  const existing = { definition: { id: 'other', name: 'Other', icon: 'other', web: { entry: `${prefix}/app.js` } }, assets: [{ path: `${prefix}/app.js`, file: '/not-read', type: 'text/javascript' }] }
  await assert.rejects(prepareApplicationArchive(verified, { existingApplications: [existing] }), /duplicate application asset/)
  await missing(marker)
})

test('pure factory preparation occurs in isolated process and never opens returned runtime', { skip: !isUnixNode }, async t => {
  const directory = await temporary(t), marker = join(directory, 'opened')
  const source = clientFactory().replace("assets: [", `createRuntime(){ throw Error('runtime must never open') }, assets: [`)
  const prepared = await prepareApplicationArchive(archive({ entries: { client: 'payload/client.js' }, files: { 'payload/client.js': `import {writeFileSync} from 'node:fs'; ${source}` } }))
  assert.equal(prepared.roles.client.status, 'prepared')
  assert.equal(prepared.roles.client.registration.hasRuntime, true)
  await missing(marker)
})

test('factory capabilities, exact assets, app identity and host services are checked before admission', { skip: !isUnixNode }, async () => {
  const inputs = [
    [clientFactory().replace("id: 'calculator'", "id: 'different'"), 'package-registration-id-mismatch'],
    [clientFactory().replace("name: 'Calculator'", "name: 'Different'"), 'package-registration-metadata-mismatch'],
    [clientFactory().replace('assets: [', "capabilityRequirements:{required:{'storage.sqlite':'^1.0.0'}}, assets: ["), 'package-registration-capability-mismatch'],
    [clientFactory().replace("type: 'text/javascript; charset=utf-8'", "type: 'text/javascript'"), 'package-registration-assets-mismatch'],
    [clientFactory().replace('assets: [', "createRuntime(){},http:{service:'not a service'},assets: ["), 'package-service-conflict'],
  ]
  for (const [source, code] of inputs) await assert.rejects(prepareApplicationArchive(archive({ entries: { client: 'payload/client.js' }, files: { 'payload/client.js': source } })), expected(code))
})

test('factory declaration getters are refused rather than evaluated during registration serialization', { skip: !isUnixNode }, async t => {
  const directory = await temporary(t), marker = join(directory, 'getter')
  const source = `import {writeFileSync} from 'node:fs'; export function createRegistration(){ return {get definition(){ writeFileSync(${JSON.stringify(marker)},'bad'); return {} } } }`
  await assert.rejects(prepareApplicationArchive(archive({ entries: { client: 'payload/client.js' }, files: { 'payload/client.js': source } })), expected('package-registration-accessor'))
  await missing(marker)
})

test('private duplicate shared runtime packages are not evaluated; canonical public exports are used', { skip: !isUnixNode }, async () => {
  const files = {
    'payload/client.js': `import {Context} from '@nya/core'; import {createApplicationRuntime} from '@anybox/application-api/nya'; import {createLocalSqliteComponent} from '@anybox/storage-sqlite'; if(!Context||!createApplicationRuntime||!createLocalSqliteComponent)throw Error('missing canonical'); ${clientFactory()}`,
    'payload/node_modules/@nya/core/package.json': '{"type":"module","exports":"./index.js"}',
    'payload/node_modules/@nya/core/index.js': 'throw Error("private Nya evaluated")',
    'payload/node_modules/@anybox/application-api/package.json': '{"type":"module","exports":{"./nya":"./index.js"}}',
    'payload/node_modules/@anybox/application-api/index.js': 'throw Error("private API evaluated")',
    'payload/node_modules/@anybox/storage-sqlite/package.json': '{"type":"module","exports":"./index.js"}',
    'payload/node_modules/@anybox/storage-sqlite/index.js': 'throw Error("private SQL evaluated")',
  }
  assert.equal((await prepareApplicationArchive(archive({ entries: { client: 'payload/client.js' }, files }))).roles.client.status, 'prepared')
})

test('incompatible worker stays unimported while supported client prepares normally', { skip: !isUnixNode }, async () => {
  const prepared = await prepareApplicationArchive(archive({ entries: { client: 'payload/client.js', computerWorker: 'payload/worker.js' }, requirements: { computerWorker: { ...nodeRuntime, node: '>=99.0.0' } }, files: { 'payload/client.js': clientFactory(), 'payload/worker.js': 'throw Error("worker must never import")' } }))
  assert.equal(prepared.roles.client.status, 'prepared')
  assert.equal(prepared.roles.computerWorker.status, 'unsupported')
})

test('even compatible raw worker CLI is checked statically without import or fake runtime', { skip: !isUnixNode }, async () => {
  const prepared = await prepareApplicationArchive(archive({ entries: { client: 'payload/client.js', computerWorker: 'payload/worker.js' }, files: { 'payload/client.js': clientFactory(), 'payload/worker.js': 'throw Error("worker must never import")' } }))
  assert.equal(prepared.roles.computerWorker.status, 'compatible')
  assert.equal(prepared.roles.client.status, 'prepared')
})

test('timeout and explicit cancellation wait for actual preparation process exit', { skip: !isUnixNode }, async t => {
  const directory = await temporary(t)
  for (const cancellation of [false, true]) {
    const marker = join(directory, cancellation ? 'cancel.pid' : 'timeout.pid')
    const source = `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},String(process.pid)); process.on('SIGTERM',()=>{}); export async function createRegistration(){ await new Promise(()=>{setInterval(()=>{},1000)}) }`
    const controller = new AbortController()
    if (cancellation) setTimeout(() => controller.abort(), 250)
    await assert.rejects(prepareApplicationArchive(archive({ noWeb: true, entries: { client: 'payload/client.js' }, files: { 'payload/client.js': source } }), { signal: controller.signal, timeoutMs: cancellation ? 5000 : 250 }), expected(cancellation ? 'package-preparation-cancelled' : 'package-preparation-timeout'))
    const pid = Number(await readFile(marker, 'utf8'))
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH')
  }
})

test('preparation cleanup waits for spawned descendants, including after factory result', { skip: !isUnixNode }, async t => {
  const directory = await temporary(t), marker = join(directory, 'descendant.pid')
  const source = `import {spawn} from 'node:child_process'; import {writeFileSync,renameSync} from 'node:fs'; const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(marker + '.tmp')},String(child.pid));renameSync(${JSON.stringify(marker + '.tmp')},${JSON.stringify(marker)});${clientFactory()}`
  const kill = process.kill
  let deniedProbes = 0, deniedSignals = 0, provedAbsent = false
  process.kill = (pid, signal) => {
    if (pid < 0 && signal === 0 && deniedProbes < 3) {
      deniedProbes++
      throw Object.assign(new Error('Test group probe denied'), { code: 'EPERM' })
    }
    if (pid < 0 && signal === 'SIGTERM' && deniedSignals === 0) {
      deniedSignals++
      throw Object.assign(new Error('Test group signal denied'), { code: 'EPERM' })
    }
    try { return kill(pid, signal) } catch (error) {
      if (pid < 0 && signal === 0 && error.code === 'ESRCH') provedAbsent = true
      throw error
    }
  }
  try {
    const prepared = await prepareApplicationArchive(archive({ entries: { client: 'payload/client.js' }, files: { 'payload/client.js': source } }))
    assert.equal(prepared.roles.client.status, 'prepared')
    assert.equal(deniedProbes, 3)
    assert.equal(deniedSignals, 1)
    assert.equal(provedAbsent, true, 'denied observations cannot replace an actual ESRCH proof')
  } finally { process.kill = kill }
  const pid = Number(await readFile(marker, 'utf8'))
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH')
})

test('permanently denied preparation group probes retain temporary bytes and report unconfirmed cleanup', { skip: !isUnixNode, timeout: 15_000 }, async t => {
  const kill = process.kill
  let retained, failure, denied = 0
  t.after(async () => { if (retained) await rm(retained, { recursive: true, force: true }) })
  process.kill = (pid, signal) => {
    if (pid < 0 && signal === 0) { denied++; throw Object.assign(new Error('Test group probe denied'), { code: 'EPERM' }) }
    return kill(pid, signal)
  }
  try {
    await prepareApplicationArchive(archive({ entries: { client: 'payload/client.js' }, files: { 'payload/client.js': clientFactory() } }))
  } catch (error) { failure = error; retained = error.temporaryDirectory }
  finally { process.kill = kill }
  assert.equal(failure?.code, 'package-preparation-cleanup-unconfirmed')
  assert.equal(failure?.cleanupUnconfirmed, true)
  assert.ok(denied > 3, 'cleanup retries denied observations before declaring uncertainty')
  assert.equal(typeof retained, 'string')
  await access(join(retained, 'application/payload/client.js'))
})


test('browser code refuses Node runtime calls while string examples and DTO properties remain data', async () => {
  for (const webSource of ["export const x = require('fs')", "export const x = process.env.HOME", "export const x = process['env'].HOME", "export const x = Buffer.from('a')"]) await assert.rejects(prepareApplicationArchive(archive({ webSource })), expected('package-browser-node-runtime'))
  await prepareApplicationArchive(archive({ webSource: "export const example = 'require(\\\"fs\\\"),process.env,Buffer.from'; export function data(record){return record.process.env}" }))
})

test('inline template CSS participates in resource closure and duplicate asset index members are refused', async () => {
  const assets = [{ path: `${prefix}/app.js`, file: 'payload/web/app.js', type: 'text/javascript' }, { path: `${prefix}/template.html`, file: 'payload/web/template.html', type: 'text/html' }]
  await assert.rejects(prepareApplicationArchive(archive({ assets, files: { 'payload/web/template.html': '<style>div{background:url(https://example.invalid/tracker.png)}</style>' } })), expected('package-resource-reference-invalid'))
  await assert.rejects(prepareApplicationArchive(archive({ indexSource: '{"schemaVersion":1,"assets":[],"assets":[]}' })), expected('package-assets-index-invalid'))
})


test('Node factory cannot import unindexed absolute URLs, data modules or bare dependency fallthrough', { skip: !isUnixNode }, async t => {
  const directory = await temporary(t), external = join(directory, 'external.mjs'), marker = join(directory, 'evaluated')
  await writeFile(external, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'bad');export const x=1`)
  const outside = `import ${JSON.stringify('file://' + external)}; ${clientFactory()}`
  await assert.rejects(prepareApplicationArchive(archive({ entries: { client: 'payload/client.js' }, files: { 'payload/client.js': outside } })), expected('package-preparation-module-outside-payload'))
  await missing(marker)
  const data = `import 'data:text/javascript,export default 1'; ${clientFactory()}`
  await assert.rejects(prepareApplicationArchive(archive({ entries: { client: 'payload/client.js' }, files: { 'payload/client.js': data } })), expected('package-preparation-module-not-indexed'))
  const fallback = `import {mkdirSync,writeFileSync} from 'node:fs'; import {resolve} from 'node:path'; export async function createRegistration(){const packagePath=resolve(import.meta.dirname,'../../node_modules/escape');mkdirSync(packagePath,{recursive:true});writeFileSync(resolve(packagePath,'package.json'),'{"type":"module","exports":"./index.js"}');writeFileSync(resolve(packagePath,'index.js'),${JSON.stringify(`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'bad');export const x=1`)});await import('escape');return {}}`
  await assert.rejects(prepareApplicationArchive(archive({ noWeb: true, entries: { client: 'payload/client.js' }, files: { 'payload/client.js': fallback } })), expected('package-preparation-module-outside-payload'))
  await missing(marker)
})


test('relative and absolute paths cannot load a second private shared runtime copy', { skip: !isUnixNode }, async () => {
  const files = {
    'payload/client.js': `import './node_modules/@nya/core/index.js'; ${clientFactory()}`,
    'payload/node_modules/@nya/core/package.json': '{"type":"module","exports":"./index.js"}',
    'payload/node_modules/@nya/core/index.js': 'throw Error("private Nya evaluated")',
  }
  await assert.rejects(prepareApplicationArchive(archive({ entries: { client: 'payload/client.js' }, files })), expected('package-preparation-private-shared-runtime'))
})


test('asset URLs preserve the exact HTTP map spelling instead of browser normalization', async () => {
  for (const path of [`${prefix}/raw space.js`, `${prefix}/raw\tname.js`, `${prefix}/中文.js`]) await assert.rejects(prepareApplicationArchive(archive({ assets: [{ path, file: 'payload/web/app.js', type: 'text/javascript' }] })), expected('package-asset-invalid'))
  assert.equal((await prepareApplicationArchive(archive({ assets: [{ path: `${prefix}/encoded%20space.js`, file: 'payload/web/app.js', type: 'text/javascript' }] }))).web.entry, `${prefix}/encoded%20space.js`)
})
