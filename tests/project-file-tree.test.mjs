import { installComputerServices } from './helpers/computer-services.mjs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { syncBuiltinESMExports } from 'node:module'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { createProjectComponent } from '../dist/applications/harness/core/project/component.js'
import { createProjectFilesComponent } from '../dist/applications/harness/core/project-files/component.js'
import { createFileTreeBrowser } from '../dist/applications/harness/core/project-files/tree-browser.js'
import { createSessionComponent } from '../dist/applications/harness/core/session/component.js'
import { createImageAssetsComponent } from '../dist/applications/harness/core/image/component.js'
import { deferred } from './helpers/controlled-models.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
async function joined(call) { try { return await call.result } finally { await call.done } }
function browser(options = {}) { return createFileTreeBrowser(async () => '/project', async (_signal, work) => work(), { scanTime: () => 0, ...options }) }
function sequenceAccess(total, value = index => ({ name: `file-${index}`, path: `file-${index}`, kind: 'file' })) {
  const counts = { open: 0, read: 0, close: 0 }
  return { counts, access: { async open() {
    counts.open++; let index = 0
    return { async verify() {}, async read() { counts.read++; return index < total ? value(index++) : null }, async close() { counts.close++ } }
  } } }
}
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'anybox-file-tree-')), root = new Context()
  const inputs = { now: () => new Date().toISOString(), newId: randomUUID }
  t.after(async () => { try { await root.fiber.dispose() } finally { await fs.rm(directory, { recursive: true, force: true }) } })
  await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
  await root.installComponent(createProjectComponent(inputs))
  const filesFiber = root.installComponent(createProjectFilesComponent(options)); await filesFiber
  const project = await root.get('harness.projects').openProject(directory)
  return { directory, root, project, filesFiber, files: root.get('harness.project-files'), inputs }
}

test('project trees expose complete lazy relative contents including hidden/ignored files and no links/dependencies', async t => {
  const f = await fixture(t)
  for (const path of ['nested', '.git', 'node_modules/pkg', '.yarn/cache', '.yarn/allowed']) await fs.mkdir(join(f.directory, path), { recursive: true })
  await Promise.all(Array.from({ length: 170 }, (_, i) => fs.writeFile(join(f.directory, `file-${i}`), 'text')))
  for (const path of ['.hidden', '.gitignore', 'ignored', 'nested/inside', '.git/config', 'node_modules/pkg/hidden']) await fs.writeFile(join(f.directory, path), 'text')
  await fs.writeFile(join(f.directory, '.gitignore'), 'ignored\n')
  await fs.symlink(join(f.directory, 'nested'), join(f.directory, 'link'))
  const pages = [], open = await joined(f.files.openTree('session', f.project.id, '', 'actor'))
  pages.push(open)
  while (pages.at(-1).nextPage !== null) pages.push(await joined(f.files.readTreePage('session', 'actor', open.cursorId, pages.at(-1).nextPage)))
  assert.ok(pages.length >= 2); assert.ok(pages.every(page => page.entries.length <= 100))
  const paths = pages.flatMap(page => page.entries.map(entry => entry.path))
  assert.equal(paths.filter(path => path.startsWith('file-')).length, 170)
  assert.ok(paths.includes('.hidden')); assert.ok(paths.includes('ignored')); assert.ok(paths.includes('nested'))
  assert.ok(!paths.some(path => /^(link|node_modules|\.git$)/.test(path)))
  assert.ok(!JSON.stringify(pages).includes(f.directory))
  assert.deepEqual((await joined(f.files.openTree('session', f.project.id, 'nested', 'actor'))).entries, [{ name: 'inside', path: 'nested/inside', kind: 'file' }])
  for (const path of ['../outside', '/absolute', 'C:/file', 'nested/../nested', 'node_modules/pkg', '.git', '.yarn/cache', 'link', 'link/sub']) {
    await assert.rejects(joined(f.files.openTree('session', f.project.id, path, 'actor')), { code: 'file-invalid' })
  }
  await assert.rejects(joined(f.files.readTreePage('session', 'actor', open.cursorId, 0)), { code: 'file-tree-expired' })
})

test('tree scan budgets preserve empty continuations and sort directories before files', async t => {
  const f = sequenceAccess(1102, i => i < 1000 ? 'other' : { name: String(i), path: String(i), kind: i === 1101 ? 'directory' : 'file' })
  const tree = browser({ access: f.access }); t.after(() => tree.close())
  const first = await joined(tree.open('s', 'p', '', 'a'))
  assert.deepEqual(first.entries, []); assert.equal(first.nextPage, 1); assert.equal(f.counts.read, 1000)
  assert.deepEqual(await joined(tree.page('s', 'a', first.cursorId, 0)), first); assert.equal(f.counts.read, 1000)
  const second = await joined(tree.page('s', 'a', first.cursorId, 1))
  assert.equal(second.entries.length, 100); assert.equal(second.nextPage, 2)
  await assert.rejects(joined(tree.page('s', 'a', first.cursorId, 0)), { code: 'file-tree-conflict' })
  const final = await joined(tree.page('s', 'a', first.cursorId, 2))
  assert.equal(final.entries[0].kind, 'directory'); assert.equal(final.nextPage, null); assert.equal(f.counts.close, 1)
  const timed = sequenceAccess(10); let scanTime = 0
  const slow = browser({ access: timed.access, scanTime: () => scanTime += 201 }); t.after(() => slow.close())
  const page = await joined(slow.open('s', 'p', '', 'a'))
  assert.equal(page.entries.length, 1); assert.equal(page.nextPage, 1); assert.equal(timed.counts.read, 1)
})

test('tree cursors bind session and actor, enforce cap and expiry, and release completed cursors', async t => {
  const f = sequenceAccess(101); let time = 0
  const tree = browser({ access: f.access, now: () => time }); t.after(() => tree.close())
  const pages = await Promise.all(Array.from({ length: 16 }, () => joined(tree.open('session', 'project', '', 'actor'))))
  await assert.rejects(joined(tree.open('session', 'project', '', 'actor')), { code: 'file-tree-busy' })
  for (const [scope, actor] of [['other', 'actor'], ['session', 'other']]) {
    await assert.rejects(joined(tree.page(scope, actor, pages[0].cursorId, 1)), { code: 'file-tree-expired' })
    await tree.release(scope, actor, pages[0].cursorId)
  }
  assert.equal((await joined(tree.page('session', 'actor', pages[0].cursorId, 1))).nextPage, null)
  await joined(tree.open('session', 'project', '', 'actor'))
  time = 60_001
  await assert.rejects(joined(tree.page('session', 'actor', pages[1].cursorId, 1)), { code: 'file-tree-expired' })
  await tick(); assert.equal(f.counts.close, 17)
  await joined(tree.open('session', 'project', '', 'actor'))
  const replacement = browser({ access: sequenceAccess(101).access }); t.after(() => replacement.close())
  await assert.rejects(joined(replacement.page('session', 'actor', pages[1].cursorId, 1)), { code: 'file-tree-expired' })
})

test('tree cancellation and explicit close wait for pending open/read and actual handle cleanup', async t => {
  const opening = deferred(), finishOpen = deferred(), closing = deferred(), finishClose = deferred()
  const tree = browser({ access: { async open() {
    opening.resolve(); await finishOpen.promise
    return { async verify() {}, async read() { throw new Error('cancelled open must not read') }, async close() { closing.resolve(); await finishClose.promise } }
  } } }); t.after(() => tree.close())
  const call = tree.open('s', 'p', '', 'a'); await opening.promise; call.cancel('changed thread')
  let exited = false; void call.done.then(() => exited = true)
  await tick(); assert.equal(exited, false)
  finishOpen.resolve(); await closing.promise; await tick(); assert.equal(exited, false)
  finishClose.resolve(); await assert.rejects(joined(call), { code: 'file-cancelled' }); assert.equal(exited, true)
  const reading = deferred(), finishRead = deferred(), handleClose = deferred(), exitClose = deferred()
  const live = browser({ access: { async open() {
    let count = 0
    return { async verify() {}, async read() { if (++count <= 100) return { name: String(count), path: String(count), kind: 'file' }; reading.resolve(); return finishRead.promise },
      async close() { handleClose.resolve(); await exitClose.promise } }
  } } }); t.after(() => live.close())
  const page = await joined(live.open('s', 'p', '', 'a')), next = live.page('s', 'a', page.cursorId, 1)
  await reading.promise
  await assert.rejects(joined(live.page('s', 'a', page.cursorId, 1)), { code: 'file-tree-busy' })
  let released = false
  const release = live.release('s', 'a', page.cursorId).then(() => released = true)
  await tick(); assert.equal(released, false)
  finishRead.resolve(null); await handleClose.promise; await tick(); assert.equal(released, false)
  exitClose.resolve(); await assert.rejects(joined(next), { code: 'file-cancelled' }); await release
})

test('prestart cancellation and a lost open result release cursor reservations', async t => {
  const f = sequenceAccess(101), tree = browser({ access: f.access }); t.after(() => tree.close())
  const abort = new AbortController(), cancelled = tree.open('s', 'p', '', 'a', abort.signal); abort.abort()
  await assert.rejects(joined(cancelled), { code: 'file-cancelled' }); assert.equal(f.counts.open, 0)
  const call = tree.open('s', 'p', '', 'a'), page = await joined(call)
  call.cancel('unreceived response'); await tick()
  await assert.rejects(joined(tree.page('s', 'a', page.cursorId, 1)), { code: 'file-tree-expired' }); assert.equal(f.counts.close, 1)
})

test('tree scans share the file-operation concurrency bound and shutdown joins queued work', async t => {
  const opened = deferred(), finish = deferred(), closeStarted = deferred(), exit = deferred()
  let opens = 0, closes = 0
  const f = await fixture(t, { treeBrowser: { access: { async open() {
    if (++opens === 2) opened.resolve()
    return { async verify() {}, async read() { await finish.promise; return null }, async close() { if (++closes === 2) closeStarted.resolve(); await exit.promise } }
  } } } })
  const calls = Array.from({ length: 3 }, () => f.files.openTree('s', f.project.id, '', 'a'))
  await opened.promise
  await fs.writeFile(join(f.directory, 'preview'), 'content')
  const original = fs.open; let previewOpened = false
  t.after(() => { fs.open = original; syncBuiltinESMExports() })
  fs.open = async (...args) => { if (args[0] === join(await fs.realpath(f.directory), 'preview')) previewOpened = true; return original(...args) }
  syncBuiltinESMExports()
  const preview = f.files.preview(f.project.id, { kind: 'project-file', path: 'preview' })
  await tick(); assert.equal(previewOpened, false)
  let closed = false; const shutdown = f.filesFiber.dispose().then(() => closed = true)
  await tick(); assert.equal(closed, false); assert.equal(opens, 2)
  finish.resolve(); await closeStarted.promise; await tick(); assert.equal(closed, false)
  exit.resolve(); await shutdown
  for (const call of calls) await assert.rejects(joined(call), { code: 'file-cancelled' })
  await assert.rejects(joined(preview), { code: 'file-cancelled' })
  fs.open = original; syncBuiltinESMExports()
  assert.equal(previewOpened, false)
  assert.equal(opens, 2); assert.equal(closes, 2)
})

test('directory replacement between pages retires the handle and never follows a new symlink', async t => {
  const f = await fixture(t), target = join(f.directory, 'browse')
  await fs.mkdir(target)
  await Promise.all(Array.from({ length: 110 }, (_, i) => fs.writeFile(join(target, String(i)), 'text')))
  const first = await joined(f.files.openTree('s', f.project.id, 'browse', 'a'))
  await fs.rename(target, join(f.directory, 'old'))
  await fs.symlink(join(f.directory, 'old'), target)
  await assert.rejects(joined(f.files.readTreePage('s', 'a', first.cursorId, 1)), { code: 'file-invalid' })
  await assert.rejects(joined(f.files.readTreePage('s', 'a', first.cursorId, 1)), { code: 'file-tree-expired' })
})

test('cleanup failure rejects result/done, stops new tree admission and surfaces at shutdown', async () => {
  const tree = browser({ access: { async open() {
    return { async verify() {}, async read() { return null }, async close() { throw new Error('private details') } }
  } } })
  const call = tree.open('s', 'p', '', 'a')
  await assert.rejects(call.result, { code: 'file-cleanup-failed' }); await assert.rejects(call.done, { code: 'file-cleanup-failed' })
  assert.throws(() => tree.open('s', 'p', '', 'a'), { code: 'file-unavailable' })
  await assert.rejects(tree.close(), /cleanup failed/)
})

test('a provider cleanup failure during open also closes admission and remains a shutdown failure', async () => {
  const tree = browser({ access: { async open() { throw Object.assign(new Error('cleanup'), { name: 'ProjectFileError', code: 'file-cleanup-failed' }) } } })
  const call = tree.open('s', 'p', '', 'a')
  await assert.rejects(call.result, { code: 'file-cleanup-failed' }); await assert.rejects(call.done, { code: 'file-cleanup-failed' })
  assert.throws(() => tree.open('s', 'p', '', 'a'), { code: 'file-unavailable' })
  await assert.rejects(tree.close(), /cleanup failed/)
})

test('Session restart retires accepted idle tree cursors while captured close remains cleanup-capable', async t => {
  const closing = deferred(), exit = deferred()
  const f = await fixture(t, { treeBrowser: { access: { async open() {
    return { async verify() {}, async read() { return { name: 'file', path: 'file', kind: 'file' } }, async close() { closing.resolve(); await exit.promise } }
  } } } })
  await f.root.installComponent(createImageAssetsComponent({ directory: join(f.directory, 'images') }))
  await installComputerServices(f.root, f.inputs)
  const sessionFiber = f.root.installComponent(createSessionComponent(f.inputs, [{ id: 'assistant' }])); await sessionFiber
  const sessions = f.root.get('harness.sessions'), session = await sessions.createSession(f.project.id, 'assistant')
  const page = await joined(sessions.openProjectFileTree(session.id, '', 'actor'))
  await sessions.archiveSession(session.id)
  assert.equal((await joined(sessions.readProjectFileTreePage(session.id, 'actor', page.cursorId, 1))).page, 1)
  let disposed = false; const disposing = sessionFiber.dispose().then(() => disposed = true)
  await closing.promise; await tick(); assert.equal(disposed, false)
  const capturedClose = sessions.closeProjectFileTree(session.id, 'actor', page.cursorId)
  exit.resolve(); await disposing; await capturedClose
  await assert.rejects(joined(f.files.readTreePage(session.id, 'actor', page.cursorId, 2)), { code: 'file-tree-expired' })
})
