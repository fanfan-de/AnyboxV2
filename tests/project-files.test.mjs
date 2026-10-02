import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { createProjectComponent } from '../dist/applications/harness/core/project/component.js'
import { createProjectFilesComponent } from '../dist/applications/harness/core/project-files/component.js'
import { fileLimits } from '../dist/applications/harness/core/project-files/domain.js'
import { deferred } from './helpers/controlled-models.mjs'

async function joinCall(call) { try { return await call.result } finally { await call.done } }
async function fixture(directory, options = {}) {
  const root = new Context()
  await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
  await root.installComponent(createProjectComponent({ newId: () => 'project', now: () => new Date().toISOString() }))
  await root.installComponent(createProjectFilesComponent(options))
  const project = await root.get('harness.projects').openProject(directory)
  const files = root.get('harness.project-files'), db = root.get('local-storage')
  return { root, files, db, project, close: () => root.fiber.dispose(),
    prepare: (key, selections, scope = 'session') => joinCall(files.prepare(scope, project.id, key, selections)),
    read: (id, scope = 'session') => joinCall(files.read(scope, [id])) }
}
const source = (path, range) => ({ kind: 'project-file', path, ...(range ? { range } : {}) })

test('project search includes hidden and ignored paths, excludes dependencies and symlinks', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'anybox-files-')); t.after(() => fs.rm(directory, { recursive: true, force: true }))
  for (const path of ['node_modules/pkg', '.git', '.yarn/cache', 'src']) await fs.mkdir(join(directory, path), { recursive: true })
  for (const path of ['.env', '.gitignore', 'ignored.txt', 'src/code.ts', 'code.ts', 'node_modules/pkg/code.ts', '.git/config', '.yarn/cache/data']) await fs.writeFile(join(directory, path), 'text')
  await fs.writeFile(join(directory, '.gitignore'), 'ignored.txt\n')
  await fs.symlink(join(directory, 'src'), join(directory, 'linked'))
  const f = await fixture(directory); t.after(f.close)
  const found = await joinCall(f.files.search(f.project.id, ''))
  assert.ok(found.paths.includes('.env')); assert.ok(found.paths.includes('ignored.txt'))
  assert.ok(!found.paths.some(path => /node_modules|\.git\/|\.yarn\/cache|linked/.test(path)))
  assert.deepEqual((await joinCall(f.files.search(f.project.id, 'code.ts'))).paths, ['code.ts', 'src/code.ts'])
  for (const path of ['../outside', '/etc/passwd', 'node_modules/pkg/code.ts', 'linked/code.ts', 'src/../code.ts', 'C:/file']) {
    await assert.rejects(f.prepare(path, [source(path)]), { code: 'file-invalid' })
  }
})

test('snapshots preserve UTF-8 BOM, CRLF, line ranges, empty content and batch ordering', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'anybox-files-')); t.after(() => fs.rm(directory, { recursive: true, force: true }))
  await fs.writeFile(join(directory, 'text'), '\ufeff你好\r\nsecond\r\nlast')
  await fs.writeFile(join(directory, 'empty'), '')
  const f = await fixture(directory); t.after(f.close)
  const refs = await f.prepare('batch', [source('text'), source('text', { start: 2, end: 3 }), source('empty')])
  assert.equal((await f.read(refs[0].snapshotId))[0].text, '\ufeff你好\r\nsecond\r\nlast')
  assert.equal((await f.read(refs[1].snapshotId))[0].text, 'second\r\nlast')
  assert.equal((await f.read(refs[2].snapshotId))[0].text, '')
  assert.deepEqual(refs[0].actualRange, { start: 1, end: 3 }); assert.equal(refs[2].actualRange, null)
  await assert.rejects(f.prepare('bad-range', [source('text', { start: 2, end: 4 })]), { code: 'file-range-invalid' })
})

test('prepared batches replay after edits, deletion and restart and reject changed identity', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'anybox-files-')); t.after(() => fs.rm(directory, { recursive: true, force: true }))
  await fs.writeFile(join(directory, 'text'), 'selected')
  let f = await fixture(directory); t.after(() => f.close())
  await fs.writeFile(join(directory, 'text'), 'sent')
  const [ref] = await f.prepare('key', [source('text')])
  await fs.unlink(join(directory, 'text'))
  assert.equal((await f.prepare('key', [source('text')]))[0].snapshotId, ref.snapshotId)
  await assert.rejects(f.prepare('key', [source('different')]), { code: 'file-preparation-conflict' })
  await assert.rejects(f.read(ref.snapshotId, 'different-session'), { code: 'file-missing' })
  await f.close(); f = await fixture(directory)
  assert.equal((await f.prepare('key', [source('text')]))[0].snapshotId, ref.snapshotId)
  assert.equal((await f.read(ref.snapshotId))[0].text, 'sent')
})

test('validation failure creates no partial snapshots, rejects binary and enforces selected sizes', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'anybox-files-')); t.after(() => fs.rm(directory, { recursive: true, force: true }))
  await fs.writeFile(join(directory, 'ok'), 'ok')
  await fs.writeFile(join(directory, 'invalid'), Buffer.from([0xff, 0xfe]))
  await fs.writeFile(join(directory, 'binary'), 'a\0b')
  await fs.writeFile(join(directory, 'big'), 'small\n' + 'x'.repeat(fileLimits.maxBytes))
  const f = await fixture(directory); t.after(f.close)
  for (const path of ['invalid', 'binary']) await assert.rejects(f.prepare(path, [source('ok'), source(path)]), { code: 'file-unsupported' })
  assert.equal(await f.db.read(db => db.get('SELECT COUNT(*) AS n FROM harness_file_snapshots').n), 0)
  const preview = await joinCall(f.files.preview(f.project.id, source('big')))
  assert.equal(preview.canReference, false); assert.ok(Buffer.byteLength(preview.text) <= fileLimits.maxBytes)
  await assert.rejects(f.prepare('big', [source('big')]), { code: 'file-too-large' })
  assert.equal((await f.read((await f.prepare('range', [source('big', { start: 1, end: 1 })]))[0].snapshotId))[0].text, 'small\n')
  await assert.rejects(f.prepare('count', Array.from({ length: 9 }, () => source('ok'))), { code: 'file-invalid' })
  await fs.writeFile(join(directory, 'full'), 'x'.repeat(fileLimits.maxBytes))
  await assert.rejects(f.prepare('sum', Array.from({ length: 5 }, () => source('full'))), { code: 'file-too-large' })
})

test('retention rolls back atomically and expiry tombstones never recapture sources', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'anybox-files-')); t.after(() => fs.rm(directory, { recursive: true, force: true }))
  let time = Date.parse('2026-09-29T00:00:00Z')
  await fs.writeFile(join(directory, 'text'), 'original')
  let f = await fixture(directory, { now: () => new Date(time).toISOString() }); t.after(() => f.close())
  const [kept] = await f.prepare('kept', [source('text')]), [lost] = await f.prepare('lost', [source('text')])
  await f.db.transaction(tx => f.files.retainIn(tx, 'session', 'run:kept', [kept]))
  await assert.rejects(f.db.transaction(tx => { f.files.retainIn(tx, 'session', 'run:lost', [lost]); throw new Error('rollback') }))
  time += fileLimits.draftLifetimeMs + 1
  assert.equal((await f.read(kept.snapshotId))[0].file.expiresAt, undefined)
  await assert.rejects(f.read(lost.snapshotId), { code: 'file-expired' })
  await f.close(); f = await fixture(directory, { now: () => new Date(time).toISOString() })
  await assert.rejects(f.prepare('lost', [source('text')]), { code: 'file-expired' })
  assert.equal((await f.read(kept.snapshotId))[0].text, 'original')
  await f.db.transaction(tx => tx.execute('UPDATE harness_file_snapshots SET bytes=? WHERE id=?', [Buffer.from('broken'), kept.snapshotId]))
  await assert.rejects(f.read(kept.snapshotId), { code: 'file-corrupt' })
})

test('cancellation and component shutdown wait for actual file close; queued reads stay bounded', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'anybox-files-')); t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const target = join(directory, 'text'); await fs.writeFile(target, 'text')
  const f = await fixture(directory), opened = deferred(), release = deferred(), original = fs.open
  let count = 0
  fs.open = async (...args) => {
    const handle = await original(...args)
    if (args[0] === await fs.realpath(target)) {
      count++; if (count === 2) opened.resolve()
      const close = handle.close.bind(handle)
      handle.close = async () => { await release.promise; await close() }
    }
    return handle
  }; syncBuiltinESMExports()
  const calls = Array.from({ length: 3 }, () => f.files.preview(f.project.id, source('text')))
  try {
    await opened.promise
    calls[0].cancel('test'); calls[2].cancel('queued')
    let closed = false; const closing = f.close().then(() => { closed = true })
    await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false); assert.equal(count, 2)
    release.resolve(); await closing
    for (const call of calls) { await assert.rejects(call.result, { code: 'file-cancelled' }); await call.done }
    assert.equal(count, 2)
  } finally { release.resolve(); fs.open = original; syncBuiltinESMExports(); await f.close() }
})

test('a file changed during a read is rejected before snapshot commit', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'anybox-files-')); t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const target = join(directory, 'text'); await fs.writeFile(target, 'text')
  const f = await fixture(directory); t.after(f.close)
  const original = fs.open
  fs.open = async (...args) => {
    const handle = await original(...args)
    if (args[0] === await fs.realpath(target)) {
      const read = handle.read.bind(handle); let changed = false
      handle.read = async (...args) => { const result = await read(...args); if (!changed) { changed = true; await fs.appendFile(target, 'changed') } return result }
    }
    return handle
  }; syncBuiltinESMExports()
  try { await assert.rejects(f.prepare('changed', [source('text')]), { code: 'file-changed' }) }
  finally { fs.open = original; syncBuiltinESMExports() }
})
