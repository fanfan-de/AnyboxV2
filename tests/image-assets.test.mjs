import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import sharp from 'sharp'
import { Context, FiberState } from '@nya/core'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { localStorageServiceKey } from '../dist/storage/port.js'
import { createImageAssetsComponent } from '../dist/applications/harness/core/image/component.js'
import { imageAssetsServiceKey } from '../dist/applications/harness/core/image/port.js'
import { imageLimits, validateImageBatch } from '../dist/applications/harness/core/image/limits.js'
import { acquireImageDirectoryLock } from '../dist/applications/harness/core/image/directory-lock.js'

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const bytes = value => (async function* () { yield value })()
const picture = (format = 'png', width = 3, height = 2) => sharp({ create: { width, height, channels: 3, background: '#7b46cd' } }).toFormat(format).toBuffer()
async function openHost(directory, options = {}) {
  const root = new Context()
  await root.installComponent(createLocalSqliteComponent(join(directory, options.database ?? 'data.sqlite')))
  try {
    const fiber = root.installComponent(createImageAssetsComponent({ directory: join(directory, 'images'), ...options }))
    await fiber
    assert.equal(fiber.state, FiberState.ACTIVE)
    return { root, fiber, images: root.get(imageAssetsServiceKey), db: root.get(localStorageServiceKey) }
  } catch (error) { await root.fiber.dispose(); throw error }
}
async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-images-'))
  const host = await openHost(directory, options)
  t.after(async () => { await host.root.fiber.dispose(); rmSync(directory, { recursive: true, force: true }) })
  return { directory, ...host }
}
async function upload(f, value, scopeId = 'session-a') {
  const call = f.images.importImage({ scopeId, bytes: bytes(value) })
  const ref = await call.result
  await call.done
  return ref
}
async function eventually(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await sleep(5) }
  assert.fail('condition did not become true')
}

test('static JPEG, PNG and WebP preserve original bytes and server-verified identity', async t => {
  const f = await fixture(t)
  for (const format of ['jpeg', 'png', 'webp']) {
    const original = await picture(format), ref = await upload(f, original)
    assert.equal(ref.mediaType, `image/${format}`)
    assert.equal(ref.width, 3); assert.equal(ref.height, 2); assert.equal(ref.byteLength, original.length)
    assert.match(ref.sha256, /^[0-9a-f]{64}$/)
    assert.ok(ref.expiresAt)
    const read = f.images.readImage('session-a', ref.assetId)
    assert.deepEqual(await read.result, original)
    await read.done
    assert.deepEqual(await f.images.describe('session-a', [ref.assetId]), [ref])
    assert.equal(existsSync(join(f.directory, 'images', `${ref.assetId}.part`)), false)
  }
  const rows = await f.db.read(reader => reader.all('SELECT * FROM harness_image_assets'))
  assert.equal(rows.length, 3)
  assert.ok(rows.every(row => row.status === 'ready' && !Object.values(row).some(value => value instanceof Uint8Array)))
})

test('full decoding rejects truncated, animated, oversized and unsupported inputs and removes staging files', async t => {
  const f = await fixture(t), png = await picture()
  const apng = Buffer.concat([png.subarray(0, 8), Buffer.from([0, 0, 0, 0]), Buffer.from('acTL'), Buffer.alloc(4), png.subarray(8)])
  const animatedWebp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([12, 0, 0, 0]), Buffer.from('WEBPANIM'), Buffer.alloc(4)])
  for (const [value, code] of [
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'asset-unsupported'],
    [Buffer.from('GIF89a'), 'asset-unsupported'], [apng, 'asset-unsupported'], [animatedWebp, 'asset-unsupported'],
    [png.subarray(0, png.length - 15), 'asset-invalid'], [Buffer.alloc(0), 'asset-invalid'],
    [Buffer.alloc(imageLimits.maxBytes + 1), 'asset-too-large'], [await picture('png', 4097, 1), 'asset-too-large'],
  ]) {
    const call = f.images.importImage({ scopeId: 'session-a', bytes: bytes(value) })
    await assert.rejects(call.result, { code }); await call.done
  }
  assert.equal((await f.db.read(reader => reader.all('SELECT id FROM harness_image_assets'))).length, 0)
  assert.deepEqual(readdirSync(join(f.directory, 'images')), [])
})

test('retention and caller-owned Run insertion commit or roll back together without cross-domain SQL', async t => {
  let instant = '2026-09-29T00:00:00.000Z'
  const f = await fixture(t, { now: () => instant }), ref = await upload(f, await picture())
  await f.db.migrate('test-run-owner', [{ version: 1, up(tx) { tx.execute('CREATE TABLE test_runs (id TEXT PRIMARY KEY)') } }])
  await assert.rejects(f.db.transaction(tx => {
    f.images.retainIn(tx, 'session-a', 'run-input:aborted', [ref])
    tx.execute("INSERT INTO test_runs VALUES ('aborted')")
    throw new Error('reject admission')
  }), /reject admission/)
  assert.equal((await f.db.read(reader => reader.all('SELECT * FROM harness_image_retentions'))).length, 0)
  assert.equal((await f.db.read(reader => reader.all('SELECT * FROM test_runs'))).length, 0)
  await assert.rejects(f.db.transaction(tx => f.images.retainIn(tx, 'session-a', 'forged', [{ ...ref, sha256: 'x' }])), { code: 'asset-invalid' })
  await assert.rejects(f.db.transaction(tx => f.images.retainIn(tx, 'other-session', 'wrong-scope', [ref])), { code: 'asset-missing' })
  await Promise.all(['branch-a', 'branch-b'].map(id => f.db.transaction(tx => {
    const retained = f.images.retainIn(tx, 'session-a', `run-input:${id}`, [ref])
    assert.equal(retained[0].expiresAt, undefined)
    tx.execute('INSERT INTO test_runs VALUES (?)', [id])
  })))
  instant = '2026-10-02T00:00:00.000Z'
  assert.equal((await f.images.describe('session-a', [ref.assetId]))[0].expiresAt, undefined)
  await f.db.transaction(tx => f.images.retainIn(tx, 'session-a', 'run-input:regenerated', [ref]))
  assert.equal((await f.db.read(reader => reader.all('SELECT * FROM harness_image_retentions'))).length, 3)
})

test('renew extends live drafts, never revives expired drafts, and GC cannot collect retained input', async t => {
  let instant = '2026-09-29T00:00:00.000Z'
  const f = await fixture(t, { now: () => instant, collectionIntervalMs: 5 })
  const image = await picture(), kept = await upload(f, image), renewed = await upload(f, image), expired = await upload(f, image)
  await f.db.transaction(tx => f.images.retainIn(tx, 'session-a', 'run-input:saved', [kept]))
  instant = '2026-09-29T23:00:00.000Z'
  const result = await f.images.renew('session-a', [renewed.assetId, kept.assetId, 'missing'])
  assert.equal(result.valid[0].expiresAt, '2026-09-30T23:00:00.000Z')
  assert.equal(result.valid[1].expiresAt, undefined)
  assert.deepEqual(result.invalid, ['missing'])
  instant = '2026-09-30T00:00:00.000Z'
  await assert.rejects(f.db.transaction(tx => f.images.retainIn(tx, 'session-a', 'run-input:late', [expired])), error => ['asset-expired', 'asset-missing'].includes(error.code))
  assert.deepEqual((await f.images.renew('session-a', [expired.assetId])).invalid, [expired.assetId])
  await eventually(async () => !(await f.db.read(reader => reader.get('SELECT id FROM harness_image_assets WHERE id = ?', [expired.assetId]))))
  assert.equal(existsSync(join(f.directory, 'images', `${expired.assetId}.image`)), false)
  assert.equal((await f.images.describe('session-a', [kept.assetId, renewed.assetId])).length, 2)
})

test('read enforces scope and reports missing or corrupted retained bytes without rewriting history', async t => {
  const f = await fixture(t), first = await upload(f, await picture()), second = await upload(f, await picture())
  await f.db.transaction(tx => f.images.retainIn(tx, 'session-a', 'run-input:kept', [first, second]))
  await assert.rejects(f.images.readImage('session-b', first.assetId).result, { code: 'asset-missing' })
  writeFileSync(join(f.directory, 'images', `${first.assetId}.image`), Buffer.alloc(first.byteLength))
  await assert.rejects(f.images.readImage('session-a', first.assetId).result, { code: 'asset-corrupt' })
  unlinkSync(join(f.directory, 'images', `${second.assetId}.image`))
  await assert.rejects(f.images.readImage('session-a', second.assetId).result, { code: 'asset-missing' })
  assert.equal((await f.db.read(reader => reader.all('SELECT * FROM harness_image_retentions'))).length, 2)
})

test('a read lease protects an expiring draft from GC until cancellation actually exits', async t => {
  let instant = '2026-09-29T00:00:00.000Z'
  const f = await fixture(t, { now: () => instant, collectionIntervalMs: 5 }), ref = await upload(f, await picture())
  const entered = deferred(), release = deferred(), originalRead = f.db.read
  let intercept = true, settled = false
  // Delay delivery after the underlying serialized read has completed. GC can run while the read owns its lease.
  f.db.read = (work, signal) => {
    const result = originalRead(work, signal)
    if (!intercept) return result
    intercept = false
    return result.then(async value => { entered.resolve(); await release.promise; return value })
  }
  const call = f.images.readImage('session-a', ref.assetId)
  void call.done.then(() => { settled = true })
  try {
    await entered.promise
    instant = '2026-10-01T00:00:00.000Z'
    call.cancel('test')
    await sleep(20)
    assert.equal(settled, false)
    assert.equal((await originalRead(reader => reader.get('SELECT status FROM harness_image_assets WHERE id = ?', [ref.assetId]))).status, 'ready')
    assert.equal(existsSync(join(f.directory, 'images', `${ref.assetId}.image`)), true)
  } finally { f.db.read = originalRead; release.resolve() }
  await assert.rejects(call.result, { code: 'asset-cancelled' }); await call.done
  await eventually(async () => !(await f.db.read(reader => reader.get('SELECT id FROM harness_image_assets WHERE id = ?', [ref.assetId]))))
})

test('cancellation during the final file close waits for exit and cannot return successful bytes', { timeout: 5000 }, async t => {
  const f = await fixture(t), ref = await upload(f, await picture()), path = await fsPromises.realpath(join(f.directory, 'images', `${ref.assetId}.image`))
  const closing = deferred(), release = deferred(), originalOpen = fsPromises.open
  fsPromises.open = async (...args) => {
    const handle = await originalOpen(...args)
    if (args[0] === path) {
      const originalClose = handle.close.bind(handle)
      handle.close = async () => { closing.resolve(); await release.promise; return originalClose() }
    }
    return handle
  }
  syncBuiltinESMExports()
  const call = f.images.readImage('session-a', ref.assetId)
  let exited = false
  void call.done.then(() => { exited = true })
  try {
    await closing.promise
    call.cancel('after-byte-read')
    await sleep(5)
    assert.equal(exited, false)
  } finally {
    fsPromises.open = originalOpen; syncBuiltinESMExports(); release.resolve()
  }
  await assert.rejects(call.result, { code: 'asset-cancelled' })
  await call.done
})

test('admission before a queued GC retains input atomically across the expiry boundary', async t => {
  let instant = '2026-09-29T00:00:00.000Z'
  const f = await fixture(t, { now: () => instant, collectionIntervalMs: 5 }), ref = await upload(f, await picture())
  const retained = deferred(), commit = deferred()
  const acceptance = f.db.transaction(async tx => {
    f.images.retainIn(tx, 'session-a', 'run-input:winning-admission', [ref])
    retained.resolve(); await commit.promise
  })
  await retained.promise
  instant = '2026-10-01T00:00:00.000Z'
  await sleep(15) // A collection is queued behind the acceptance transaction.
  commit.resolve(); await acceptance
  await sleep(15)
  assert.equal((await f.images.describe('session-a', [ref.assetId]))[0].expiresAt, undefined)
  assert.ok(await f.images.readImage('session-a', ref.assetId).result)
})

test('GC marking wins admission and renewal even when physical deletion needs a retry', async t => {
  let instant = '2026-09-29T00:00:00.000Z'
  const f = await fixture(t, { now: () => instant, collectionIntervalMs: 5 }), ref = await upload(f, await picture())
  const file = join(f.directory, 'images', `${ref.assetId}.image`)
  unlinkSync(file); mkdirSync(file); writeFileSync(join(file, 'obstacle'), 'force unlink to fail')
  instant = '2026-10-01T00:00:00.000Z'
  await eventually(async () => (await f.db.read(reader => reader.get('SELECT status FROM harness_image_assets WHERE id = ?', [ref.assetId])))?.status === 'deleting')
  await assert.rejects(f.db.transaction(tx => f.images.retainIn(tx, 'session-a', 'run-input:losing-admission', [ref])), { code: 'asset-expired' })
  assert.deepEqual((await f.images.renew('session-a', [ref.assetId])).invalid, [ref.assetId])
  assert.equal(existsSync(file), true)
  rmSync(file, { recursive: true })
  await eventually(async () => !(await f.db.read(reader => reader.get('SELECT id FROM harness_image_assets WHERE id = ?', [ref.assetId]))))
})

test('cancellation and owner shutdown wait for the upload iterator actual exit before releasing its directory', async t => {
  const f = await fixture(t), waiting = deferred(), exit = deferred(), original = await picture()
  let delivered = false, returned = false, settled = false, closed = false
  const stream = { [Symbol.asyncIterator]() { return {
    async next() {
      if (!delivered) { delivered = true; return { done: false, value: original } }
      waiting.resolve(); await exit.promise; return { done: true }
    },
    async return() { returned = true; await exit.promise; return { done: true } },
  } } }
  const call = f.images.importImage({ scopeId: 'session-a', bytes: stream })
  void call.done.then(() => { settled = true })
  await waiting.promise
  call.cancel('test')
  const closing = f.root.fiber.dispose().then(() => { closed = true })
  await sleep(10)
  assert.equal(returned, true); assert.equal(settled, false); assert.equal(closed, false)
  assert.equal(existsSync(join(f.directory, 'images.lock')), true)
  exit.resolve()
  await assert.rejects(call.result, { code: 'asset-cancelled' })
  await call.done; await closing
  assert.equal(existsSync(join(f.directory, 'images.lock')), false)
  assert.deepEqual(readdirSync(join(f.directory, 'images')), [])
})

test('directory ownership is exclusive even across different business databases', async t => {
  const f = await fixture(t)
  await assert.rejects(openHost(f.directory, { database: 'other.sqlite' }), { code: 'asset-occupied' })
  assert.equal(existsSync(join(f.directory, 'images.lock')), true)
  assert.ok(await upload(f, await picture()))
})

test('only two imports consume input concurrently, and a cancelled queued import closes its iterator', async t => {
  const f = await fixture(t), original = await picture(), entered = [deferred(), deferred()], finish = deferred()
  const blocking = index => ({ [Symbol.asyncIterator]() { let first = true; return {
    async next() { if (first) { first = false; entered[index].resolve(); await finish.promise; return { done: false, value: original } } return { done: true } },
    async return() { await finish.promise; return { done: true } },
  } } })
  const first = f.images.importImage({ scopeId: 'session-a', bytes: blocking(0) })
  const second = f.images.importImage({ scopeId: 'session-a', bytes: blocking(1) })
  await Promise.all(entered.map(value => value.promise))
  let consumed = false, returned = false
  const queued = f.images.importImage({ scopeId: 'session-a', bytes: { [Symbol.asyncIterator]() { return {
    async next() { consumed = true; return { done: true } }, async return() { returned = true; return { done: true } },
  } } } })
  await sleep(10)
  assert.equal(consumed, false)
  queued.cancel('queued-cancellation')
  await assert.rejects(queued.result, { code: 'asset-cancelled' }); await queued.done
  assert.equal(returned, true); assert.equal(consumed, false)
  finish.resolve()
  await Promise.all([first.result, second.result, first.done, second.done])
})

test('a dead process directory lock is recovered and competing reclaimers never remove the winner', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-image-lock-')), assets = join(directory, 'images')
  const lockModule = new URL('../dist/applications/harness/core/image/directory-lock.js', import.meta.url).href
  const script = `import { acquireImageDirectoryLock } from ${JSON.stringify(lockModule)}; await acquireImageDirectoryLock(process.argv[1]); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, assets], { stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = new Promise(resolve => child.once('exit', resolve))
  t.after(async () => { child.kill('SIGKILL'); await exited; rmSync(directory, { recursive: true, force: true }) })
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve)
    child.once('error', reject)
    child.once('exit', () => reject(new Error('lock owner exited before readiness')))
  })
  await assert.rejects(acquireImageDirectoryLock(assets), { code: 'asset-occupied' })
  child.kill('SIGKILL'); await exited
  const raced = await Promise.allSettled(Array.from({ length: 4 }, () => acquireImageDirectoryLock(assets)))
  const winner = raced.filter(result => result.status === 'fulfilled')
  assert.equal(winner.length, 1)
  assert.ok(raced.filter(result => result.status === 'rejected').every(result => result.reason.code === 'asset-occupied'))
  assert.equal(existsSync(`${assets}.lock`), true)
  await assert.rejects(acquireImageDirectoryLock(assets), { code: 'asset-occupied' })
  await winner[0].value()
  assert.equal(existsSync(`${assets}.lock`), false)
  assert.deepEqual(readdirSync(directory), [])
})

test('startup finishes staged/deleting crash debris but preserves ready retained images', async t => {
  let instant = '2026-09-29T00:00:00.000Z'
  const f = await fixture(t, { now: () => instant }), original = await picture(), ref = await upload(f, original)
  await f.db.transaction(tx => {
    f.images.retainIn(tx, 'session-a', 'run-input:durable', [ref])
    for (const [id, status] of [['staged', 'staging'], ['staged-empty', 'staging'], ['staged-part', 'staging'], ['staged-final', 'staging'], ['deleted', 'deleting'], ['deleted-missing', 'deleting']]) {
      tx.execute('INSERT INTO harness_image_assets (id, scope_id, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', [id, 'session-a', status, instant, '2099-01-01T00:00:00.000Z'])
    }
  })
  const expired = await upload(f, original)
  instant = '2026-10-02T00:00:00.000Z'
  const liveDraft = await upload(f, original)
  for (const filename of ['staged.part', 'staged.image', 'staged-part.part', 'staged-final.image', 'deleted.image']) writeFileSync(join(f.directory, 'images', filename), original)
  await f.root.fiber.dispose()
  instant = '2026-10-02T01:00:00.000Z'
  const restarted = await openHost(f.directory, { now: () => instant })
  try {
    const restored = (await restarted.images.describe('session-a', [ref.assetId]))[0]
    assert.equal(restored.expiresAt, undefined)
    assert.deepEqual(await restarted.images.readImage('session-a', ref.assetId).result, original)
    assert.equal((await restarted.images.describe('session-a', [liveDraft.assetId]))[0].expiresAt, liveDraft.expiresAt)
    await assert.rejects(restarted.images.describe('session-a', [expired.assetId]), { code: 'asset-missing' })
    assert.deepEqual(readdirSync(join(f.directory, 'images')).sort(), [`${ref.assetId}.image`, `${liveDraft.assetId}.image`].sort())
  } finally { await restarted.root.fiber.dispose() }
})

test('shared batch validation counts repeated images and bounds aggregate bytes', () => {
  validateImageBatch([])
  validateImageBatch([{ byteLength: imageLimits.maxBytes }, { byteLength: imageLimits.maxBytes }])
  assert.throws(() => validateImageBatch(Array.from({ length: 9 }, () => ({ byteLength: 1 }))), { code: 'asset-too-large' })
  assert.throws(() => validateImageBatch([{ byteLength: imageLimits.maxBytes }, { byteLength: imageLimits.maxBytes }, { byteLength: 1 }]), { code: 'asset-too-large' })
  assert.throws(() => validateImageBatch([{ byteLength: NaN }]), { code: 'asset-invalid' })
})
