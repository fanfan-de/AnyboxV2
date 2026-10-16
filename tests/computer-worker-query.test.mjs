import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { createComputerWorkerExecutorComponent } from '../dist/applications/harness/core/computer/worker-component.js'
import { createProjectFilesComponent } from '../dist/applications/harness/core/project-files/component.js'
import { deferred } from './helpers/controlled-models.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
async function joined(call) { try { return await call.result } finally { await call.done } }
const hasCode = (error, code) => !!error && (error.code === code || error.errors?.some(item => hasCode(item, code)) || hasCode(error.cause, code))
async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'anybox-worker-query-')))
  const project = join(directory, 'project'), root = new Context()
  await fs.mkdir(project)
  let cleanupFailureExpected = false
  t.after(async () => {
    try { await root.fiber.dispose() }
    catch (error) { if (!cleanupFailureExpected || !hasCode(error, 'worker-cleanup-failed')) throw error }
    finally { await fs.rm(directory, { recursive: true, force: true }) }
  })
  await root.installComponent(createLocalSqliteComponent(join(directory, 'worker.sqlite')))
  for (const key of ['tools.bash', 'tools.apply-patch', 'tools.processes', 'tools.files', 'harness.image-assets']) root.provide(key, {})
  let ceiling = { kind: 'computer', projects: [project], tools: 'all' }, scope = ceiling
  let changed
  root.provide('computer.worker-attachments', {
    requireApprovedIn: () => ({ attachmentId: 'remote', state: 'approved', ceiling, scope }),
    onChanged: listener => { changed = listener; return () => { changed = undefined } },
  })
  const fiber = root.installComponent(createComputerWorkerExecutorComponent({ workerId: 'worker', bootId: 'boot' })); await fiber
  const worker = root.get('computer.worker')
  return { directory, project, root, fiber, worker,
    query: (query, signal) => worker.query({ attachmentId: 'remote', query }, signal),
    revoke: () => changed({ attachmentId: 'remote', state: 'revoked' }),
    expectCleanupFailure() { cleanupFailureExpected = true },
    scopes(nextCeiling, nextScope = nextCeiling) { ceiling = nextCeiling; scope = nextScope },
  }
}

for (const mode of ['shutdown', 'dispose']) test(`worker ${mode} cancels stat and waits for its real filesystem exit`, { timeout: 5_000 }, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(), original = fs.stat
  let queryExited = false, closed = false, closing
  fs.stat = async (path, ...args) => { if (path === f.project) { entered.resolve(); await release.promise } return original(path, ...args) }
  syncBuiltinESMExports()
  const query = f.query({ kind: 'stat', path: f.project }).finally(() => { queryExited = true }); void query.catch(() => {})
  try {
    await entered.promise
    closing = (mode === 'shutdown' ? f.worker.shutdown() : f.fiber.dispose()).then(() => { closed = true })
    await tick(); await tick()
    assert.equal(closed, false, 'closing waits for the actual stat call')
    assert.equal(queryExited, false)
    await assert.rejects(f.query({ kind: 'stat', path: f.project }), { code: 'worker-closing' })
    release.resolve(); await closing
    await assert.rejects(query, { code: 'worker-closing' })
  } finally {
    release.resolve(); await Promise.allSettled([query, closing].filter(Boolean))
    fs.stat = original; syncBuiltinESMExports()
  }
})

test('worker disposal waits for a real open file and its close before releasing the executor', { timeout: 5_000 }, async t => {
  const f = await fixture(t), entered = deferred(), releaseOpen = deferred(), closingHandle = deferred(), releaseClose = deferred()
  const target = join(f.project, 'held.txt'), original = fs.open
  await fs.writeFile(target, 'held content')
  let handle, handleClosed = false, disposed = false, closing
  fs.open = async (path, ...args) => {
    const opened = await original(path, ...args)
    if (path !== target) return opened
    handle = opened; entered.resolve(); await releaseOpen.promise
    return { stat: (...args) => opened.stat(...args), read: (...args) => opened.read(...args),
      async close() { closingHandle.resolve(); await releaseClose.promise; await opened.close(); handleClosed = true } }
  }
  syncBuiltinESMExports()
  const query = f.query({ kind: 'read', root: f.project, path: 'held.txt' }); void query.catch(() => {})
  try {
    await entered.promise
    closing = f.fiber.dispose().then(() => { disposed = true })
    await tick(); await tick()
    assert.equal(disposed, false, 'a cancelled open still owns a real file handle')
    assert.equal((await handle.stat()).isFile(), true)
    releaseOpen.resolve(); await closingHandle.promise
    assert.equal(disposed, false, 'file close must also actually finish')
    assert.equal(handleClosed, false)
    releaseClose.resolve(); await closing
    assert.equal(handleClosed, true)
    await assert.rejects(query, { code: 'worker-closing' })
    await assert.rejects(handle.stat(), { code: 'EBADF' })
  } finally {
    releaseOpen.resolve(); releaseClose.resolve(); await Promise.allSettled([query, closing].filter(Boolean))
    fs.open = original; syncBuiltinESMExports()
  }
})

test('cancelling one query joins its real stat exit and keeps other queries available', { timeout: 5_000 }, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(), original = fs.stat, abort = new AbortController()
  let exited = false
  fs.stat = async (path, ...args) => { if (path === f.project) { entered.resolve(); await release.promise } return original(path, ...args) }
  syncBuiltinESMExports()
  const query = f.query({ kind: 'stat', path: f.project }, abort.signal).finally(() => { exited = true }); void query.catch(() => {})
  try {
    await entered.promise; abort.abort(new Error('cancel one query')); await tick()
    assert.equal(exited, false, 'caller cancellation cannot report exit before stat exits')
    release.resolve(); await assert.rejects(query, /cancel one query/)
    assert.deepEqual(await f.query({ kind: 'stat', path: f.project }), { kind: 'stat', directory: true, canonical: f.project })
  } finally {
    release.resolve(); await Promise.allSettled([query]); fs.stat = original; syncBuiltinESMExports()
  }
})

test('remote preview adapter forwards cancellation and joins an in-process worker file handle', { timeout: 5_000 }, async t => {
  const f = await fixture(t), entered = deferred(), releaseOpen = deferred(), closingHandle = deferred(), releaseClose = deferred(), original = fs.open
  const target = join(f.project, 'held.txt')
  await fs.writeFile(target, 'content')
  f.root.provide('harness.projects', { requireAvailable: async () => ({ id: 'project', path: f.project, computerAttachmentId: 'remote' }) })
  await f.root.installComponent(createProjectFilesComponent())
  let closed = false, exited = false, reads = 0
  fs.open = async (path, ...args) => {
    const handle = await original(path, ...args)
    if (path !== target) return handle
    entered.resolve(); await releaseOpen.promise
    return { stat: (...args) => handle.stat(...args), read: (...args) => { reads++; return handle.read(...args) },
      async close() { closingHandle.resolve(); await releaseClose.promise; await handle.close(); closed = true } }
  }
  syncBuiltinESMExports()
  const call = f.root.get('harness.project-files').preview('project', { kind: 'project-file', path: 'held.txt' })
  const done = call.done.finally(() => { exited = true }); void call.result.catch(() => {})
  try {
    await entered.promise; call.cancel('cancel preview'); await tick()
    assert.equal(exited, false)
    releaseOpen.resolve(); await closingHandle.promise
    assert.equal(exited, false); assert.equal(closed, false)
    releaseClose.resolve(); await done
    assert.equal(closed, true); assert.equal(reads, 0, 'the cancelled worker query does not start reading the opened file')
    await assert.rejects(call.result, { code: 'file-cancelled' })
  } finally {
    releaseOpen.resolve(); releaseClose.resolve(); await Promise.allSettled([call.result, done]); fs.open = original; syncBuiltinESMExports()
  }
})

test('query handle cleanup failure stops admission and fails worker cleanup', { timeout: 5_000 }, async t => {
  const f = await fixture(t), target = join(f.project, 'cleanup.txt'), original = fs.open
  await fs.writeFile(target, 'content')
  let closed = false
  fs.open = async (path, ...args) => {
    const handle = await original(path, ...args)
    if (path !== target) return handle
    return { stat: (...args) => handle.stat(...args), read: (...args) => handle.read(...args),
      async close() { await handle.close(); closed = true; throw new Error('injected close failure') } }
  }
  syncBuiltinESMExports()
  try {
    await assert.rejects(f.query({ kind: 'read', root: f.project, path: 'cleanup.txt' }), { code: 'file-cleanup-failed' })
    assert.equal(closed, true)
    await assert.rejects(f.query({ kind: 'stat', path: f.project }), { code: 'worker-closing' })
    f.expectCleanupFailure()
    await assert.rejects(f.fiber.dispose(), error => hasCode(error, 'worker-cleanup-failed'))
  } finally { fs.open = original; syncBuiltinESMExports() }
})

test('revoking an attachment cancels and joins its outstanding stat query', { timeout: 5_000 }, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(), original = fs.stat
  let revoked = false, revoking
  fs.stat = async (path, ...args) => { if (path === f.project) { entered.resolve(); await release.promise } return original(path, ...args) }
  syncBuiltinESMExports()
  const query = f.query({ kind: 'stat', path: f.project }); void query.catch(() => {})
  try {
    await entered.promise; revoking = f.revoke().then(() => { revoked = true }); await tick(); await tick()
    assert.equal(revoked, false, 'revocation waits for query resources as well as Run scopes')
    release.resolve(); await revoking
    await assert.rejects(query, { code: 'worker-attachment-rejected' })
  } finally {
    release.resolve(); await Promise.allSettled([query, revoking].filter(Boolean)); fs.stat = original; syncBuiltinESMExports()
  }
})

for (const restriction of ['ceiling', 'approved scope']) test(`worker queries check canonical roots against the ${restriction}`, { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), outside = join(f.directory, 'outside'), alias = join(f.project, 'alias')
  await fs.mkdir(outside); await fs.writeFile(join(outside, 'outside-secret-name.txt'), 'secret'); await fs.symlink(outside, alias)
  const limited = { kind: 'computer', projects: [f.project], tools: [] }, all = { kind: 'computer', projects: 'all', tools: 'all' }
  f.scopes(restriction === 'ceiling' ? limited : all, restriction === 'ceiling' ? all : limited)
  for (const query of [{ kind: 'stat', path: alias }, { kind: 'search', root: alias, query: '' }, { kind: 'list', root: alias, path: '' }]) {
    await assert.rejects(f.query(query), { code: 'worker-scope-rejected' })
  }
  assert.deepEqual(await f.query({ kind: 'stat', path: f.project }), { kind: 'stat', directory: true, canonical: f.project })
  assert.deepEqual(await f.query({ kind: 'stat', path: join(f.project, 'missing') }), { kind: 'stat', directory: false, canonical: null })
  assert.deepEqual((await f.query({ kind: 'search', root: f.project, query: '' })).search.paths, [])
})

test('explicitly granted directory aliases use their worker-local canonical identity', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), alias = join(f.directory, 'alias')
  await fs.symlink(f.project, alias)
  f.scopes({ kind: 'computer', projects: [alias], tools: [] })
  assert.deepEqual(await f.query({ kind: 'stat', path: alias }), { kind: 'stat', directory: true, canonical: f.project })
  assert.deepEqual(await f.query({ kind: 'stat', path: f.project }), { kind: 'stat', directory: true, canonical: f.project })
  await fs.writeFile(join(f.project, 'inside.txt'), 'inside')
  assert.deepEqual((await f.query({ kind: 'search', root: alias, query: '' })).search.paths, ['inside.txt'])
})

test('remote tree lists exactly 1000 entries completely', { timeout: 15_000 }, async t => {
  const f = await fixture(t)
  await Promise.all(Array.from({ length: 1_000 }, (_, i) => fs.writeFile(join(f.project, `file-${i}`), 'content')))
  f.root.provide('harness.projects', { requireAvailable: async () => ({ id: 'project', path: f.project, computerAttachmentId: 'remote' }) })
  await f.root.installComponent(createProjectFilesComponent())
  const files = f.root.get('harness.project-files')
  const listing = await f.query({ kind: 'list', root: f.project, path: '' })
  assert.equal(listing.truncated, false, 'an exactly full directory is still complete')
  const pages = [await joined(files.openTree('session', 'project', '', 'actor'))]
  while (pages.at(-1).nextPage !== null) pages.push(await joined(files.readTreePage('session', 'actor', pages[0].cursorId, pages.at(-1).nextPage)))
  assert.equal(pages.flatMap(page => page.entries).length, 1_000)
})

test('remote tree reports more than 1000 entries explicitly while search and manual file reads remain available', { timeout: 15_000 }, async t => {
  const f = await fixture(t)
  await Promise.all(Array.from({ length: 1_000 }, (_, i) => fs.writeFile(join(f.project, `file-${i}`), 'content')))
  await fs.writeFile(join(f.project, 'last-file.txt'), 'last content')
  f.root.provide('harness.projects', { requireAvailable: async () => ({ id: 'project', path: f.project, computerAttachmentId: 'remote' }) })
  await f.root.installComponent(createProjectFilesComponent())
  const files = f.root.get('harness.project-files')
  assert.equal((await f.query({ kind: 'list', root: f.project, path: '' })).truncated, true)
  await assert.rejects(joined(files.openTree('session', 'project', '', 'actor')), { code: 'file-tree-truncated' })
  assert.equal((await joined(files.search('project', 'last-file'))).paths.includes('last-file.txt'), true)
  assert.equal((await joined(files.preview('project', { kind: 'project-file', path: 'last-file.txt' }))).text, 'last content')
})
