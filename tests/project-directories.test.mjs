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
import { isDirectoryNameValid } from '../dist/applications/harness/core/project/directories.js'
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

test('creation uses the successfully browsed canonical parent, preserves conflicts, and never registers a project', async t => {
  const f = await fixture(t)
  const parent = join(f.directory, 'parent')
  await fs.mkdir(parent)
  const alias = join(f.directory, 'alias')
  await fs.symlink(parent, alias)
  assert.equal(f.projects.directoryCreationSupported, true)
  const opened = await joined(f.projects.openDirectoryBrowse('owner', { path: alias }))
  const page = await joined(f.projects.readDirectoryPage('owner', opened.browseId, 0))
  assert.deepEqual(page.entries, [])
  assert.equal(page.nextPage, null)
  const created = await joined(f.projects.createDirectory('owner', opened.browseId, '新文件夹'))
  assert.deepEqual(created, { path: join(await fs.realpath(parent), '新文件夹') })
  assert.equal((await fs.lstat(created.path)).isDirectory(), true)
  await fs.writeFile(join(parent, 'file'), 'keep me')
  await fs.symlink(created.path, join(parent, 'link'))
  for (const name of ['新文件夹', 'file', 'link']) {
    await assert.rejects(joined(f.projects.createDirectory('owner', opened.browseId, name)), { code: 'directory-exists' })
  }
  assert.equal(await fs.readFile(join(parent, 'file'), 'utf8'), 'keep me')
  assert.equal((await fs.lstat(join(parent, 'link'))).isSymbolicLink(), true)
  assert.equal((await joined(f.projects.createDirectory('owner', opened.browseId, 'after-conflict'))).path, join(await fs.realpath(parent), 'after-conflict'))
  assert.deepEqual(await f.projects.listProjects(), [])
})

test('creation requires an owner-bound active browse with a successful page and validates a direct child name', async t => {
  const f = await fixture(t)
  const opened = await joined(f.projects.openDirectoryBrowse('owner', {}))
  await assert.rejects(joined(f.projects.createDirectory('owner', opened.browseId, 'before-page')), { code: 'directory-browse-conflict' })
  await joined(f.projects.readDirectoryPage('owner', opened.browseId, 0))
  await assert.rejects(joined(f.projects.createDirectory('other-owner', opened.browseId, 'wrong-owner')), { code: 'directory-browse-expired' })
  for (const name of ['', ' ', '.', '..', '../outside', 'parent/child', 'parent\\child', '\0bad', 'line\nbreak', '\u007f', '\u0085']) {
    await assert.rejects(joined(f.projects.createDirectory('owner', opened.browseId, name)), { code: 'directory-name-invalid' })
  }
  assert.deepEqual((await fs.readdir(f.directory)).filter(name => ['before-page', 'wrong-owner', 'parent'].includes(name)), [])
  await f.projects.closeDirectoryBrowse('owner', opened.browseId)
  await assert.rejects(joined(f.projects.createDirectory('owner', opened.browseId, 'after-close')), { code: 'directory-browse-expired' })
  const unsupported = createDirectoryBrowser({ homePath: f.directory, access: sequenceAccess(0).access })
  t.after(() => unsupported.close())
  assert.equal(unsupported.creationSupported, false)
  const readOnly = await joined(unsupported.open('owner', {}))
  await joined(unsupported.page('owner', readOnly.browseId, 0))
  await assert.rejects(joined(unsupported.create('owner', readOnly.browseId, 'child')), { code: 'directory-create-unsupported' })
})

test('Windows child name validation rejects reserved device names and platform path aliases', () => {
  for (const name of ['CON', 'nul.txt', 'COM9.log', 'LPT¹.txt', 'name.', 'name ', 'a:b', 'a?b', 'a|b', 'a"b', 'a<b']) {
    assert.equal(isDirectoryNameValid(name, true), false, name)
  }
  for (const name of ['folder', '.hidden', 'COM10', 'conifer', '新文件夹']) assert.equal(isDirectoryNameValid(name, true), true, name)
  assert.equal(isDirectoryNameValid('CON', false), true)
  assert.equal(isDirectoryNameValid('name.', false), true)
})

test('creation verifies the original parent identity after an exhausted scan closes its handle', async t => {
  const f = await fixture(t)
  const parent = join(f.directory, 'parent')
  await fs.mkdir(parent)
  const opened = await joined(f.projects.openDirectoryBrowse('owner', { path: parent }))
  assert.equal((await joined(f.projects.readDirectoryPage('owner', opened.browseId, 0))).nextPage, null)
  await fs.rename(parent, join(f.directory, 'original'))
  await fs.mkdir(parent)
  await assert.rejects(joined(f.projects.createDirectory('owner', opened.browseId, 'child')), { code: 'directory-unavailable' })
  assert.deepEqual(await fs.readdir(parent), [])
  await fs.rm(parent, { recursive: true })
  await fs.symlink(join(f.directory, 'original'), parent)
  await assert.rejects(joined(f.projects.createDirectory('owner', opened.browseId, 'child')), { code: 'directory-not-directory' })
  assert.deepEqual(await fs.readdir(join(f.directory, 'original')), [])
})

test('release and cancellation join a pending create and handle cleanup without rolling back its filesystem change', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'anybox-directory-create-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const creating = deferred(), finishCreate = deferred(), closing = deferred(), finishClose = deferred()
  const browser = createDirectoryBrowser({ homePath: directory, access: { creationSupported: true, async open(path) {
    return { path, async read() { return { name: 'child', path: join(path, 'child'), kind: 'directory' } },
      async create(name) { const created = join(path, name); await fs.mkdir(created); creating.resolve(); await finishCreate.promise; return created },
      async close() { closing.resolve(); await finishClose.promise } }
  } } })
  t.after(() => { finishCreate.resolve(); finishClose.resolve(); return browser.close() })
  const opened = await joined(browser.open('owner', {}))
  await joined(browser.page('owner', opened.browseId, 0))
  const call = browser.create('owner', opened.browseId, 'created')
  await creating.promise
  await assert.rejects(joined(browser.page('owner', opened.browseId, 1)), { code: 'directory-browse-busy' })
  await assert.rejects(joined(browser.create('owner', opened.browseId, 'second')), { code: 'directory-browse-busy' })
  let done = false, released = false
  void call.done.then(() => { done = true })
  const release = browser.release('owner', opened.browseId).then(() => { released = true })
  await tick(); assert.equal(done, false); assert.equal(released, false)
  finishCreate.resolve()
  await closing.promise
  await tick(); assert.equal(done, false); assert.equal(released, false)
  finishClose.resolve()
  await assert.rejects(call.result, { code: 'directory-browse-cancelled' })
  await call.done; await release
  assert.equal((await fs.lstat(join(directory, 'created'))).isDirectory(), true)
  await assert.rejects(joined(browser.create('owner', opened.browseId, 'after-release')), { code: 'directory-browse-expired' })
})

test('shutdown joins creates in two shared filesystem slots and cancels queued creation before it starts', async t => {
  const finishCreate = deferred(), started = []
  const browser = createDirectoryBrowser({ homePath: tmpdir(), access: { creationSupported: true, async open(path) {
    return { path, async read() { return null }, async create(name) { started.push(name); await finishCreate.promise; return join(path, name) }, async close() {} }
  } } })
  t.after(() => { finishCreate.resolve(); return browser.close() })
  const reservations = await Promise.all(Array.from({ length: 3 }, () => joined(browser.open('owner', {}))))
  await Promise.all(reservations.map(value => joined(browser.page('owner', value.browseId, 0))))
  const calls = reservations.map((value, index) => browser.create('owner', value.browseId, `child-${index}`))
  await tick(); assert.equal(started.length, 2)
  let closed = false
  const close = browser.close().then(() => { closed = true })
  await tick(); assert.equal(closed, false)
  finishCreate.resolve()
  await close
  assert.equal(started.length, 2)
  for (const call of calls) await assert.rejects(joined(call), { code: 'directory-browse-cancelled' })
  assert.throws(() => browser.create('owner', reservations[0].browseId, 'later'), { code: 'directory-unavailable' })
})

test('idle expiry and pre-start creation cancellation prevent delayed filesystem writes', async t => {
  let time = 0, creates = 0
  const browser = createDirectoryBrowser({ homePath: tmpdir(), now: () => time, access: { creationSupported: true, async open(path) {
    return { path, async read() { return null }, async create(name) { creates++; return join(path, name) }, async close() {} }
  } } })
  t.after(() => browser.close())
  const idle = await joined(browser.open('owner', {}))
  await joined(browser.page('owner', idle.browseId, 0))
  time = 60_001
  await assert.rejects(joined(browser.create('owner', idle.browseId, 'after-expiry')), { code: 'directory-browse-expired' })
  const opened = await joined(browser.open('owner', {}))
  await joined(browser.page('owner', opened.browseId, 0))
  const abort = new AbortController()
  const call = browser.create('owner', opened.browseId, 'cancelled', abort.signal)
  abort.abort()
  await assert.rejects(joined(call), { code: 'directory-browse-cancelled' })
  await assert.rejects(joined(browser.create('owner', opened.browseId, 'later')), { code: 'directory-browse-expired' })
  assert.equal(creates, 0)
})
