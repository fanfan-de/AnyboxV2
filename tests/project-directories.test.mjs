import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { createProjectComponent } from '../dist/applications/harness/core/project/component.js'
import { createDirectoryBrowser } from '../dist/applications/harness/core/project/directory-browser.js'
import { createDirectoryAccessProvider } from '../dist/applications/harness/core/project/directory-access.js'
import { deferred } from './helpers/controlled-models.mjs'

async function joined(call) { try { return await call.result } finally { await call.done } }
const tick = () => new Promise(resolve => setImmediate(resolve))

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'anybox-directory-picker-'))
  const root = new Context()
  t.after(async () => { try { await root.fiber.dispose() } finally { await fs.rm(directory, { recursive: true, force: true }) } })
  await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
  await root.installComponent(createProjectComponent({ newId: randomUUID, now: () => new Date().toISOString() },
    { directoryHome: directory, ...options }))
  return { root, directory, projects: root.get('harness.projects') }
}

test('directory browsing reserves no handle, never registers a project, and canonical aliases retain project identity', async t => {
  const f = await fixture(t)
  await fs.mkdir(join(f.directory, 'empty'))
  await fs.mkdir(join(f.directory, 'visible'))
  await fs.mkdir(join(f.directory, '.hidden'))
  await fs.writeFile(join(f.directory, 'file.txt'), 'not a directory')
  await fs.symlink(join(f.directory, 'visible'), join(f.directory, 'alias'))
  await fs.symlink(join(f.directory, 'missing'), join(f.directory, 'broken'))
  await fs.symlink(join(f.directory, 'file.txt'), join(f.directory, 'file-link'))
  assert.equal(f.projects.directoryBrowsingSupported, true)
  const opened = await joined(f.projects.openDirectoryBrowse('owner', {}))
  assert.equal(opened.homePath, f.directory)
  const page = await joined(f.projects.readDirectoryPage('owner', opened.browseId, 0))
  assert.equal(page.path, await fs.realpath(f.directory))
  assert.equal(page.parentPath, await fs.realpath(tmpdir()))
  assert.equal(page.breadcrumbs.at(-1).path, page.path)
  assert.deepEqual(page.entries.map(entry => entry.name).sort(), ['alias', 'broken', 'empty', 'visible'])
  assert.equal(page.entries.find(entry => entry.name === 'alias').kind, 'symlink')
  assert.equal(page.entries.find(entry => entry.name === 'broken').reason, 'directory-missing')
  assert.equal(page.nextPage, null)
  assert.deepEqual(await f.projects.listProjects(), [])
  await f.projects.closeDirectoryBrowse('owner', opened.browseId)
  const aliases = await joined(f.projects.openDirectoryBrowse('owner', { path: join(f.directory, 'alias') }))
  const aliasPage = await joined(f.projects.readDirectoryPage('owner', aliases.browseId, 0))
  assert.equal(aliasPage.path, join(await fs.realpath(f.directory), 'visible'))
  assert.deepEqual(aliasPage.entries, [])
  await f.projects.closeDirectoryBrowse('owner', aliases.browseId)
  assert.deepEqual(await f.projects.listProjects(), [])
  const first = await f.projects.openProject(join(f.directory, 'visible'))
  assert.equal((await f.projects.openProject(join(f.directory, 'alias'))).id, first.id)
  const hidden = await joined(f.projects.openDirectoryBrowse('owner', { showHidden: true, query: 'HID' }))
  assert.deepEqual((await joined(f.projects.readDirectoryPage('owner', hidden.browseId, 0))).entries.map(entry => entry.name), ['.hidden'])
})

test('missing paths, ordinary files, invalid inputs, and missing host configuration give stable errors', async t => {
  const f = await fixture(t)
  for (const path of ['relative', '\0bad']) {
    await assert.rejects(joined(f.projects.openDirectoryBrowse('owner', { path })), { code: 'directory-browse-invalid' })
  }
  await assert.rejects(joined(f.projects.openDirectoryBrowse('owner', { query: 'x'.repeat(257) })), { code: 'directory-browse-invalid' })
  await fs.writeFile(join(f.directory, 'file'), 'text')
  for (const [path, code] of [['missing', 'directory-missing'], ['file', 'directory-not-directory']]) {
    const opened = await joined(f.projects.openDirectoryBrowse('owner', { path: join(f.directory, path) }))
    await assert.rejects(joined(f.projects.readDirectoryPage('owner', opened.browseId, 0)), { code })
    await assert.rejects(joined(f.projects.readDirectoryPage('owner', opened.browseId, 0)), { code: 'directory-browse-expired' })
  }
  const unsupported = createDirectoryBrowser()
  t.after(() => unsupported.close())
  assert.equal(unsupported.supported, false)
  await assert.rejects(joined(unsupported.open('owner', {})), { code: 'directory-browse-unsupported' })
})

test('invalid configured home does not prevent component startup or explicit absolute path recovery', async t => {
  for (const directoryHome of ['relative-home', '/invalid\0home']) {
    const f = await fixture(t, { directoryHome })
    assert.equal(f.projects.directoryBrowsingSupported, true)
    await assert.rejects(joined(f.projects.openDirectoryBrowse('owner', {})), { code: 'directory-browse-invalid' })
    const opened = await joined(f.projects.openDirectoryBrowse('owner', { path: f.directory }))
    const page = await joined(f.projects.readDirectoryPage('owner', opened.browseId, 0))
    assert.equal(page.path, await fs.realpath(f.directory))
    await f.projects.closeDirectoryBrowse('owner', opened.browseId)
  }
  const f = await fixture(t, { directoryHome: join(tmpdir(), `missing-home-${randomUUID()}`) })
  const opened = await joined(f.projects.openDirectoryBrowse('owner', {}))
  await assert.rejects(joined(f.projects.readDirectoryPage('owner', opened.browseId, 0)), { code: 'directory-missing' })
})

test('permission errors are fixed public codes and do not expose filesystem error text', async t => {
  let opens = 0
  const browser = createDirectoryBrowser({ homePath: tmpdir(), access: {
    async open() { opens++; throw Object.assign(new Error('private platform details'), { code: 'EACCES' }) },
  } })
  t.after(() => browser.close())
  const opened = await joined(browser.open('owner', {}))
  assert.equal(opens, 0)
  await assert.rejects(joined(browser.page('owner', opened.browseId, 0)), error => {
    assert.equal(error.code, 'directory-permission-denied')
    assert.equal(error.message, 'directory-permission-denied')
    return true
  })
})

test('real inaccessible directories and inaccessible links are not silently traversed', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const f = await fixture(t)
  const denied = join(f.directory, 'denied')
  await fs.mkdir(join(denied, 'inside'), { recursive: true })
  await fs.symlink(join(denied, 'inside'), join(f.directory, 'denied-link'))
  await fs.chmod(denied, 0)
  try {
    const opened = await joined(f.projects.openDirectoryBrowse('owner', { path: denied }))
    await assert.rejects(joined(f.projects.readDirectoryPage('owner', opened.browseId, 0)), { code: 'directory-permission-denied' })
    const parent = await joined(f.projects.openDirectoryBrowse('owner', {}))
    const page = await joined(f.projects.readDirectoryPage('owner', parent.browseId, 0))
    assert.equal(page.entries.find(entry => entry.name === 'denied-link').reason, 'directory-permission-denied')
  } finally { await fs.chmod(denied, 0o700) }
})

function sequenceAccess(total, entry = index => ({ name: `directory-${String(index).padStart(4, '0')}`, path: join(tmpdir(), `directory-${index}`), kind: 'directory' })) {
  const counts = { open: 0, read: 0, close: 0 }
  return { counts, access: { async open(path) {
    counts.open++; let index = 0
    return { path, async read() { counts.read++; return index < total ? entry(index++) : null }, async close() { counts.close++ } }
  } } }
}

test('pages bound returned entries and raw scan work, replay latest page, and filter across the directory', async t => {
  const fixture = sequenceAccess(1105)
  const browser = createDirectoryBrowser({ homePath: tmpdir(), access: fixture.access, scanTime: () => 0 })
  t.after(() => browser.close())
  const opened = await joined(browser.open('owner', {}))
  const first = await joined(browser.page('owner', opened.browseId, 0))
  assert.equal(first.entries.length, 100)
  assert.equal(first.nextPage, 1)
  assert.equal(fixture.counts.read, 100)
  assert.deepEqual(await joined(browser.page('owner', opened.browseId, 0)), first)
  assert.equal(fixture.counts.read, 100)
  assert.equal((await joined(browser.page('owner', opened.browseId, 1))).entries.length, 100)
  await assert.rejects(joined(browser.page('owner', opened.browseId, 0)), { code: 'directory-browse-conflict' })
  await browser.release('owner', opened.browseId)
  const filtered = await joined(browser.open('owner', { query: '1104' }))
  const before = fixture.counts.read
  const empty = await joined(browser.page('owner', filtered.browseId, 0))
  assert.deepEqual(empty.entries, [])
  assert.equal(empty.nextPage, 1)
  assert.equal(fixture.counts.read - before, 1000)
  const last = await joined(browser.page('owner', filtered.browseId, 1))
  assert.equal(last.entries[0].name, 'directory-1104')
  assert.equal(last.nextPage, null)
  assert.equal(fixture.counts.close, 2)
})

test('scan time budget yields a continuation without falsely declaring an empty directory', async t => {
  const fixture = sequenceAccess(100)
  let time = 0
  const browser = createDirectoryBrowser({ homePath: tmpdir(), access: fixture.access, scanTime: () => (time += 201) })
  t.after(() => browser.close())
  const opened = await joined(browser.open('owner', { query: 'absent' }))
  const page = await joined(browser.page('owner', opened.browseId, 0))
  assert.deepEqual(page.entries, [])
  assert.equal(page.nextPage, 1)
  assert.equal(fixture.counts.read, 1)
})

test('owners and independent services with identical paths cannot exchange cursor results', async t => {
  const a = sequenceAccess(1, () => ({ name: 'device-a', path: join(tmpdir(), 'a'), kind: 'directory' }))
  const b = sequenceAccess(1, () => ({ name: 'device-b', path: join(tmpdir(), 'b'), kind: 'directory' }))
  const one = createDirectoryBrowser({ homePath: tmpdir(), access: a.access })
  const two = createDirectoryBrowser({ homePath: tmpdir(), access: b.access })
  t.after(() => one.close()); t.after(() => two.close())
  const opened = await joined(one.open('owner-a', {}))
  await assert.rejects(joined(one.page('owner-b', opened.browseId, 0)), { code: 'directory-browse-expired' })
  await one.release('owner-b', opened.browseId)
  await assert.rejects(joined(two.page('owner-a', opened.browseId, 0)), { code: 'directory-browse-expired' })
  assert.equal((await joined(one.page('owner-a', opened.browseId, 0))).entries[0].name, 'device-a')
  const second = await joined(two.open('owner-a', {}))
  assert.equal((await joined(two.page('owner-a', second.browseId, 0))).entries[0].name, 'device-b')
})

test('reserve cap, expiry, and closing a reservation prevent delayed requests from opening handles', async t => {
  const fixture = sequenceAccess(200)
  let time = 0
  const browser = createDirectoryBrowser({ homePath: tmpdir(), access: fixture.access, now: () => time })
  t.after(() => browser.close())
  const reservations = await Promise.all(Array.from({ length: 16 }, () => joined(browser.open('owner', {}))))
  assert.equal(fixture.counts.open, 0)
  await assert.rejects(joined(browser.open('owner', {})), { code: 'directory-browse-busy' })
  await browser.release('owner', reservations[0].browseId)
  await assert.rejects(joined(browser.page('owner', reservations[0].browseId, 0)), { code: 'directory-browse-expired' })
  assert.equal(fixture.counts.open, 0)
  await joined(browser.page('owner', reservations[1].browseId, 0))
  assert.equal(fixture.counts.close, 0)
  time = 60_001
  await assert.rejects(joined(browser.page('owner', reservations[1].browseId, 1)), { code: 'directory-browse-expired' })
  await tick()
  assert.equal(fixture.counts.close, 1)
  await joined(browser.open('owner', {}))
})

test('cancel and close wait for a pending filesystem read and handle close before done', async t => {
  const reading = deferred(), finishRead = deferred(), closing = deferred(), finishClose = deferred()
  const browser = createDirectoryBrowser({ homePath: tmpdir(), access: { async open(path) {
    return { path, async read() { reading.resolve(); return finishRead.promise }, async close() { closing.resolve(); await finishClose.promise } }
  } } })
  t.after(() => browser.close())
  const opened = await joined(browser.open('owner', {}))
  const call = browser.page('owner', opened.browseId, 0)
  await reading.promise
  await assert.rejects(joined(browser.page('owner', opened.browseId, 0)), { code: 'directory-browse-busy' })
  let done = false, released = false
  void call.done.then(() => { done = true })
  const release = browser.release('owner', opened.browseId).then(() => { released = true })
  await assert.rejects(joined(browser.page('owner', opened.browseId, 0)), { code: 'directory-browse-expired' })
  await tick(); assert.equal(done, false); assert.equal(released, false)
  finishRead.resolve(null)
  await closing.promise
  await tick(); assert.equal(done, false); assert.equal(released, false)
  finishClose.resolve()
  await assert.rejects(call.result, { code: 'directory-browse-cancelled' })
  await call.done; await release
  assert.equal(done, true); assert.equal(released, true)
})

test('shutdown tracks removed cursors until cleanup exits and limits concurrent scans to two', async t => {
  const finishRead = deferred(), finishClose = deferred()
  let opens = 0, closes = 0
  const browser = createDirectoryBrowser({ homePath: tmpdir(), access: { async open(path) {
    opens++
    return { path, async read() { await finishRead.promise; return null }, async close() { closes++; await finishClose.promise } }
  } } })
  t.after(() => browser.close())
  const reservations = await Promise.all(Array.from({ length: 3 }, () => joined(browser.open('owner', {}))))
  const calls = reservations.map(value => browser.page('owner', value.browseId, 0))
  await tick(); assert.equal(opens, 2)
  const release = browser.release('owner', reservations[0].browseId)
  let exited = false
  const shutdown = browser.close().then(() => { exited = true })
  await tick(); assert.equal(exited, false); assert.equal(opens, 2)
  finishRead.resolve()
  await tick(); assert.equal(exited, false); assert.equal(closes, 2)
  finishClose.resolve()
  await release; await shutdown
  assert.equal(exited, true)
  for (const call of calls) { await assert.rejects(call.result, { code: 'directory-browse-cancelled' }); await call.done }
  assert.throws(() => browser.open('owner', {}), { code: 'directory-unavailable' })
})

test('pre-start cancellation never opens a handle and closed sessions cannot be resurrected', async t => {
  const fixture = sequenceAccess(100)
  const browser = createDirectoryBrowser({ homePath: tmpdir(), access: fixture.access })
  t.after(() => browser.close())
  const opened = await joined(browser.open('owner', {}))
  const abort = new AbortController()
  const call = browser.page('owner', opened.browseId, 0, abort.signal)
  abort.abort()
  await assert.rejects(joined(call), { code: 'directory-browse-cancelled' })
  assert.equal(fixture.counts.open, 0)
  await assert.rejects(joined(browser.page('owner', opened.browseId, 0)), { code: 'directory-browse-expired' })
})

test('directory deletion between pages is reported and the real directory handle is closed', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'anybox-directory-delete-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  await Promise.all(Array.from({ length: 110 }, (_, index) => fs.mkdir(join(directory, `child-${index}`))))
  let closes = 0
  const filesystem = createDirectoryAccessProvider()
  const browser = createDirectoryBrowser({ homePath: directory, access: { async open(path, signal) {
    const cursor = await filesystem.open(path, signal)
    return { ...cursor, async close() { closes++; await cursor.close() } }
  } } })
  t.after(() => browser.close())
  const opened = await joined(browser.open('owner', {}))
  assert.equal((await joined(browser.page('owner', opened.browseId, 0))).nextPage, 1)
  await fs.rm(directory, { recursive: true })
  await assert.rejects(joined(browser.page('owner', opened.browseId, 1)), { code: 'directory-missing' })
  assert.equal(closes, 1)
})

test('cleanup failure rejects page done and the eventual service shutdown', async () => {
  const browser = createDirectoryBrowser({ homePath: tmpdir(), access: { async open(path) {
    return { path, async read() { return null }, async close() { throw new Error('close failed') } }
  } } })
  const opened = await joined(browser.open('owner', {}))
  const call = browser.page('owner', opened.browseId, 0)
  await assert.rejects(call.result, { code: 'directory-browse-cleanup-failed' })
  await assert.rejects(call.done, { code: 'directory-browse-cleanup-failed' })
  assert.throws(() => browser.open('owner', {}), { code: 'directory-unavailable' })
  await assert.rejects(browser.close(), /cleanup failed/)
})

test('retirement notifications follow cleanup, include idle reservations, and occur once per browse', async t => {
  const closeStarted = deferred(), finishClose = deferred()
  let time = 0
  const retired = []
  const browser = createDirectoryBrowser({ homePath: tmpdir(), now: () => time, access: { async open(path) {
    return { path, async read() { return { name: 'child', path: join(path, 'child'), kind: 'directory' } },
      async close() { closeStarted.resolve(); await finishClose.promise } }
  } } })
  t.after(() => browser.close())
  browser.onRetired(id => retired.push(id))
  const idle = await joined(browser.open('owner', {}))
  const live = await joined(browser.open('owner', {}))
  await joined(browser.page('owner', live.browseId, 0))
  time = 60_001
  await assert.rejects(joined(browser.page('owner', live.browseId, 1)), { code: 'directory-browse-expired' })
  await closeStarted.promise
  assert.deepEqual(retired, [idle.browseId])
  let closed = false
  const shutdown = browser.close().then(() => { closed = true })
  await tick(); assert.equal(closed, false); assert.deepEqual(retired, [idle.browseId])
  finishClose.resolve()
  await shutdown
  assert.deepEqual(retired, [idle.browseId, live.browseId])
  await browser.release('owner', live.browseId)
  assert.equal(retired.length, 2)
})

test('cancellation during pending opendir closes the subsequently acquired handle before done', async t => {
  const opening = deferred(), finishOpen = deferred(), closeStarted = deferred(), finishClose = deferred()
  const browser = createDirectoryBrowser({ homePath: tmpdir(), access: { async open(path) {
    opening.resolve(); await finishOpen.promise
    return { path, async read() { throw new Error('cancelled operation must not read') },
      async close() { closeStarted.resolve(); await finishClose.promise } }
  } } })
  t.after(() => browser.close())
  const opened = await joined(browser.open('owner', {}))
  const call = browser.page('owner', opened.browseId, 0)
  await opening.promise
  call.cancel('changed directory')
  let done = false
  void call.done.then(() => { done = true })
  await tick(); assert.equal(done, false)
  finishOpen.resolve()
  await closeStarted.promise
  await tick(); assert.equal(done, false)
  finishClose.resolve()
  await assert.rejects(joined(call), { code: 'directory-browse-cancelled' })
  assert.equal(done, true)
})
