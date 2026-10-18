import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, rm, symlink, link } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { runOnlinePackageInstallCommand } from '../dist/package-management/online-install-command.js'
import { readApplicationDirectory } from '../dist/package-management/directory.js'
import { decodeApplicationDirectory } from '../dist/package-management/directory-format.js'
import { createMinimumHost } from '../dist/main.js'

const base = '/api/client/v1/app-packages', endpoint = 'http://127.0.0.1:3000'
const time = '2026-10-18T00:00:00.000Z'
const job = (intent, phase = 'accepted', extra = {}) => ({ ...intent, id: 'install-one', revision: 1, phase, identity: null, operationId: null, existingInstallation: false, error: null, recovery: phase === 'recovery-required' ? { from: 'verifying', reason: 'outcome-unconfirmed' } : null, createdAt: time, updatedAt: time, ...extra })
const args = (path, changes = []) => ['install', path, '--endpoint', endpoint, '--request-id', 'request-one', ...changes]
async function run(input, io = {}) {
  let stdout = '', stderr = ''
  const code = await runOnlinePackageInstallCommand(input, { stdout: value => { stdout += value }, stderr: value => { stderr += value }, pollIntervalMs: 1, ...io })
  return { code, output: stdout ? JSON.parse(stdout) : undefined, error: stderr ? JSON.parse(stderr).error : undefined }
}
async function files(t) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-online-install-')), folder = join(directory, 'calculator'), archive = join(directory, 'calculator.anybox-app')
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(folder, 'payload'), { recursive: true }); await mkdir(join(folder, 'licenses'))
  const manifest = { schemaVersion: 1, appId: 'calculator', version: '1.0.0', displayName: 'Calculator', publisher: 'local-agent', applicationApi: '^0.1.0', target: { os: process.platform, arch: process.arch }, web: { entry: 'payload/app.js', assets: 'payload/assets.json' } }
  await writeFile(join(folder, 'manifest.json'), JSON.stringify(manifest))
  await writeFile(join(folder, 'payload', 'package.json'), '{"type":"module"}')
  await writeFile(join(folder, 'payload', 'app.js'), 'export async function mount(){throw Error("must stay closed")}')
  await writeFile(join(folder, 'payload', 'assets.json'), JSON.stringify({ schemaVersion: 1, assets: [{ path: '/apps/calculator/1.0.0/app.js', file: 'payload/app.js', type: 'text/javascript' }] }))
  await writeFile(join(folder, 'licenses', 'LICENSE'), 'MIT'); await writeFile(archive, 'signed zip bytes')
  return { directory, folder, archive }
}
async function directoryIntent(folder) { const bytes = await readApplicationDirectory(folder); return { requestId: 'request-one', filename: 'calculator', sourceFormat: 'directory', localTrust: true, archiveDigest: createHash('sha256').update(bytes).digest('hex'), archiveSize: bytes.length } }

test('online install sends a local folder snapshot once through the lifecycle API without opening it', async t => {
  const env = await files(t), calls = []; let intent
  const result = await run(args(env.folder, ['--trust-local']), { fetch: async (url, init) => {
    calls.push({ url, init }); const path = new URL(url).pathname
    if (init.method === 'GET') return Response.json({ operations: [] })
    if (init.method === 'POST') { intent = JSON.parse(init.body); return Response.json(job(intent)) }
    assert.equal(path, base + '/operations/install-one/archive')
    const bytes = new Uint8Array(init.body), entries = decodeApplicationDirectory(bytes)
    assert.equal(intent.archiveDigest, createHash('sha256').update(bytes).digest('hex')); assert.equal(intent.archiveSize, bytes.length)
    assert.equal(intent.filename, 'calculator'); assert.equal(intent.sourceFormat, 'directory'); assert.equal(intent.localTrust, true)
    assert.ok(entries.some(file => file.path === 'manifest.json')); assert.ok(!entries.some(file => file.path === 'signature.json'))
    return Response.json(job(intent, 'installed', { receipt: { token: 'PRIVATE_SECRET' }, path: '/private/server/path' }))
  } })
  assert.equal(result.code, 0); assert.equal(result.output.phase, 'installed'); assert.equal(result.error, undefined)
  assert.deepEqual(calls.map(call => call.init.method), ['GET', 'POST', 'PUT'])
  assert.ok(calls.every(call => call.init.redirect === 'error' && call.init.headers.Origin === endpoint && call.url.startsWith(endpoint + base)))
  assert.doesNotMatch(JSON.stringify(result.output), /PRIVATE_SECRET|\/private\/|receipt/)
})

test('a signed distribution file remains raw bytes and cannot use local directory trust', async t => {
  const env = await files(t), calls = []; let intent
  const result = await run(args(env.archive), { fetch: async (_url, init) => {
    calls.push(init)
    if (init.method === 'GET') return Response.json({ operations: [] })
    if (init.method === 'POST') { intent = JSON.parse(init.body); return Response.json(job(intent)) }
    assert.equal(Buffer.from(init.body).toString(), 'signed zip bytes'); return Response.json(job(intent, 'installed'))
  } })
  assert.equal(result.code, 0); assert.equal(intent.sourceFormat, 'archive'); assert.equal(intent.localTrust, false)
  const rejected = await run(args(env.archive, ['--trust-local']), { fetch: async () => assert.fail('must reject before HTTP') })
  assert.equal(rejected.error.code, 'invalid-input'); assert.equal(calls.length, 3)
})

test('only an explicit HTTP loopback origin is accepted and offline policy flags cannot be mixed', async t => {
  const env = await files(t); let requests = 0
  for (const address of ['https://127.0.0.1:3000', 'http://example.com:3000', 'http://localhost:3000', 'http://127.1:3000', 'http://2130706433:3000', 'http://127.0.0.1', 'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:3000/path', 'http://127.0.0.1:3000?secret=x', 'http://user:password@127.0.0.1:3000', 'http://127.0.0.1:3000/#fragment']) {
    const input = args(env.archive); input[input.indexOf('--endpoint') + 1] = address
    const result = await run(input, { fetch: async () => { requests++; assert.fail('invalid origin must never fetch') } }); assert.equal(result.error.code, 'invalid-endpoint', address)
  }
  for (const extra of [['--directory', env.directory], ['--trust', '/private/policy.json'], ['--trust-local', '--trust-local'], ['--request-id', 'duplicate'], ['--url', 'https://example.invalid/package'], ['--endpoint', endpoint]]) {
    const result = await run(args(env.folder, extra), { fetch: async () => { requests++; assert.fail('invalid flags must never fetch') } }); assert.equal(result.error.code, 'invalid-input')
  }
  assert.equal(requests, 0)
})

test('local source symlinks and hard-linked package files are rejected before HTTP', async t => {
  const env = await files(t), linked = join(env.directory, 'linked.anybox-app'), symbolic = join(env.directory, 'symbolic.anybox-app')
  await symlink(env.archive, symbolic)
  let result = await run(args(symbolic), { fetch: async () => assert.fail('must not send linked content') }); assert.equal(result.error.code, 'unsafe-file-kind')
  await link(env.archive, linked)
  result = await run(args(linked), { fetch: async () => assert.fail('must not send linked content') }); assert.equal(result.error.code, 'unsafe-file-kind')
})

test('lost acceptance only observes the original request and reports an upload requirement without uploading', async t => {
  const env = await files(t), calls = []; let intent
  const result = await run(args(env.folder, ['--trust-local']), { fetch: async (url, init) => {
    calls.push({ url, init })
    if (init.method === 'POST') { intent = JSON.parse(init.body); throw new TypeError('response lost') }
    assert.equal(init.method, 'GET'); return Response.json({ operations: intent ? [job(intent)] : [] })
  } })
  assert.equal(result.code, 1); assert.equal(result.output.phase, 'accepted'); assert.equal(result.error.code, 'installation-upload-required')
  assert.deepEqual(calls.map(call => call.init.method), ['GET', 'POST', 'GET'])
})

test('lost upload response is followed only by reads of the original job until its actual installed receipt', async t => {
  const env = await files(t), calls = []; let intent, polls = 0
  const result = await run(args(env.folder, ['--trust-local']), { fetch: async (url, init) => {
    calls.push({ url, init })
    if (init.method === 'POST') { intent = JSON.parse(init.body); return Response.json(job(intent)) }
    if (init.method === 'PUT') throw new TypeError('response lost')
    if (!intent) return Response.json({ operations: [] })
    assert.equal(new URL(url).pathname, base + '/operations/install-one'); return Response.json(job(intent, ++polls === 1 ? 'verifying' : 'installed'))
  } })
  assert.equal(result.code, 0); assert.equal(result.output.phase, 'installed')
  assert.deepEqual(calls.map(call => call.init.method), ['GET', 'POST', 'PUT', 'GET', 'GET'])
})

test('an existing completed request is read once while a changed content request conflicts without mutation', async t => {
  const env = await files(t), intent = await directoryIntent(env.folder); let calls = 0
  const fetch = async (_url, init) => { calls++; assert.equal(init.method, 'GET'); return Response.json({ operations: [job(intent, 'installed')] }) }
  const result = await run(args(env.folder, ['--trust-local']), { fetch }); assert.equal(result.code, 0); assert.equal(result.output.phase, 'installed'); assert.equal(calls, 1)
  await writeFile(join(env.folder, 'payload', 'app.js'), 'changed content')
  const conflict = await run(args(env.folder, ['--trust-local']), { fetch }); assert.equal(conflict.code, 1); assert.equal(conflict.error.code, 'request-conflict'); assert.equal(calls, 2)
})

test('existing accepted and recovery jobs preserve their facts without receiving or recovering again', async t => {
  const env = await files(t), intent = await directoryIntent(env.folder)
  for (const phase of ['accepted', 'recovery-required']) {
    let count = 0
    const result = await run(args(env.folder, ['--trust-local']), { fetch: async (_url, init) => { count++; assert.equal(init.method, 'GET'); return Response.json({ operations: [job(intent, phase)] }) } })
    assert.equal(result.code, 1); assert.equal(result.output.phase, phase); assert.equal(count, 1)
    assert.equal(result.error?.code, phase === 'accepted' ? 'installation-upload-required' : undefined)
  }
})

test('unknown acceptance remains bounded and never repeats POST or starts PUT', async t => {
  const env = await files(t), calls = []; let clock = 0
  const result = await run(args(env.folder, ['--trust-local']), { timeoutMs: 20, pollIntervalMs: 5, now: () => clock, sleep: async ms => { clock += ms }, fetch: async (_url, init) => {
    calls.push(init.method); if (init.method === 'POST') throw new TypeError('response lost'); return Response.json({ operations: [] })
  } })
  assert.equal(result.code, 1); assert.equal(result.error.code, 'installation-observation-timeout'); assert.equal(result.output, undefined)
  assert.equal(calls.filter(value => value === 'POST').length, 1); assert.equal(calls.filter(value => value === 'PUT').length, 0); assert.equal(clock, 20)
})

test('observation cancellation during upload stops observation and never cancels the accepted server job', async t => {
  const env = await files(t), calls = []; let intent
  const result = await run(args(env.folder, ['--trust-local']), { fetch: async (url, init) => {
    calls.push({ url, init })
    if (init.method === 'GET') return Response.json({ operations: [] })
    if (init.method === 'POST') { intent = JSON.parse(init.body); return Response.json(job(intent)) }
    process.emit('SIGINT'); throw new TypeError('request observer closed')
  } })
  assert.equal(result.code, 130); assert.equal(result.error.code, 'installation-observation-cancelled'); assert.equal(result.output.phase, 'accepted')
  assert.deepEqual(calls.map(call => call.init.method), ['GET', 'POST', 'PUT']); assert.ok(calls.every(call => !call.url.endsWith('/cancel')))
})

test('management rejection codes and installed failures remain safe without an upload retry', async t => {
  const env = await files(t)
  for (const rejectAt of ['POST', 'PUT']) {
    const methods = []; let intent
    const result = await run(args(env.folder, ['--trust-local']), { fetch: async (_url, init) => {
      methods.push(init.method)
      if (init.method === 'GET') return Response.json({ operations: [] })
      if (init.method === rejectAt) return Response.json({ error: { code: 'request-conflict', detail: '/private/SECRET' } }, { status: 409 })
      intent = JSON.parse(init.body); return Response.json(job(intent))
    } })
    assert.equal(result.code, 1); assert.equal(result.error.code, 'request-conflict'); assert.equal(methods.filter(method => method === rejectAt).length, 1)
    assert.doesNotMatch(JSON.stringify(result), /SECRET|\/private\//)
  }
})

test('online install works against a running minimum host with the registry already owned', { timeout: 10000 }, async t => {
  let host; t.after(() => host?.close())
  const env = await files(t), applicationDirectory = join(env.directory, 'applications')
  host = await createMinimumHost({ path: join(env.directory, 'client.sqlite'), packageDirectory: applicationDirectory, port: 0 })
  const input = args(env.folder, ['--trust-local']); input[input.indexOf('--endpoint') + 1] = host.url
  const result = await run(input)
  assert.equal(result.code, 0); assert.equal(result.output.phase, 'installed'); assert.equal(result.output.identity.appId, 'calculator')
  assert.deepEqual(host.products.list(), []); assert.deepEqual((await host.packages.inspect()).actual, [])
  const repeated = await run(input); assert.equal(repeated.code, 0); assert.equal(repeated.output.id, result.output.id)
})

test('the distributed install entry dispatches online before it can open an offline registry', async t => {
  const env = await files(t), execute = promisify(execFile), input = args(env.folder, ['--trust-local'])
  input[input.indexOf('--endpoint') + 1] = 'http://example.com:3000'
  await assert.rejects(execute(process.execPath, [fileURLToPath(new URL('../dist/main.js', import.meta.url)), ...input]), failure => failure.code === 1 && JSON.parse(failure.stderr).error.code === 'invalid-endpoint')
})
