import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { projectServiceKey } from '../dist/project/component.js'
import { applyPatchServiceKey, createApplyPatchComponent, isApplyPatchFailure } from '../dist/tool/apply-patch-component.js'

function deferred() {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}

function ioError(code) {
  return Object.assign(new Error('private filesystem details must not escape'), { code })
}

function patch(...operations) {
  return ['*** Begin Patch', ...operations, '*** End Patch'].join('\n')
}

function update(path, before = 'old', after = 'new') {
  return `*** Update File: ${path}\n@@\n-${before}\n+${after}`
}

async function fixture(filesystem = {}, onLookup) {
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'anybox-patch-')))
  const project = join(directory, 'project')
  const other = join(directory, 'other')
  await fs.mkdir(project)
  await fs.mkdir(other)
  const root = new Context()
  await root.installComponent({
    name: 'patch-test-projects',
    apply(ctx) {
      ctx.provide(projectServiceKey, {
        async requireAvailable(id) {
          if (onLookup) await onLookup(id)
          if (id !== 'project-1' && id !== 'project-2') throw new Error('private missing project')
          return { id, path: id === 'project-1' ? project : other, name: 'test', available: true, createdAt: 'now' }
        },
      })
    },
  })
  await root.installComponent(createApplyPatchComponent({ filesystem }))
  const service = root.get(applyPatchServiceKey)
  return {
    directory, project, other, root, service,
    call(text, projectId = 'project-1') { return service.execute({ projectId, patch: text }) },
    async apply(text, projectId = 'project-1') {
      const call = service.execute({ projectId, patch: text })
      const result = await call.result
      await call.done
      return result
    },
    async close() {
      try { await root.fiber.dispose() }
      finally { await fs.rm(directory, { recursive: true, force: true }) }
    },
  }
}

async function assertNoTemporaryFiles(directory) {
  const paths = await fs.readdir(directory, { recursive: true })
  assert.deepEqual(paths.filter(path => basename(path).startsWith('.anybox-patch-')), [])
}

test('patch creates parent directories, updates, moves, deletes, and preserves executable permissions', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.apply(patch('*** Add File: nested/start.txt\n+old'))).status, 'applied')
    await fs.chmod(join(f.project, 'nested/start.txt'), 0o751)
    assert.equal((await f.apply(patch(update('nested/start.txt')))).status, 'applied')
    assert.equal((await fs.stat(join(f.project, 'nested/start.txt'))).mode & 0o777, 0o751)
    const moved = await f.apply(patch('*** Update File: nested/start.txt\n*** Move to: moved/end.txt\n@@\n-new\n+final'))
    assert.equal(moved.status, 'applied')
    assert.deepEqual(moved.changes, [{ kind: 'added', path: 'moved/end.txt' }, { kind: 'deleted', path: 'nested/start.txt' }])
    assert.equal(await fs.readFile(join(f.project, 'moved/end.txt'), 'utf8'), 'final\n')
    assert.equal((await fs.stat(join(f.project, 'moved/end.txt'))).mode & 0o777, 0o751)
    await assert.rejects(fs.stat(join(f.project, 'nested/start.txt')), error => error.code === 'ENOENT')
    assert.equal((await f.apply(patch('*** Delete File: moved/end.txt'))).status, 'applied')
    await assertNoTemporaryFiles(f.project)
  } finally { await f.close() }
})

test('whole-patch preflight rejects a later conflict before any file or parent directory changes', async () => {
  const f = await fixture()
  try {
    await fs.writeFile(join(f.project, 'existing.txt'), 'old\n')
    const result = await f.apply(patch('*** Add File: new/first.txt\n+first', update('existing.txt', 'missing')))
    assert.equal(result.status, 'rejected')
    assert.deepEqual(result.changes, [])
    assert.equal(result.pending.length, 2)
    assert.equal(await fs.readFile(join(f.project, 'existing.txt'), 'utf8'), 'old\n')
    await assert.rejects(fs.stat(join(f.project, 'new')), error => error.code === 'ENOENT')
  } finally { await f.close() }
})

test('patch reports syntax and known filesystem failures as observations with fixed diagnostics', async () => {
  const f = await fixture()
  try {
    const malformed = await f.apply('not a patch')
    assert.equal(malformed.status, 'rejected')
    assert.ok(malformed.diagnostic.code)
    assert.equal((await f.apply(patch('*** Delete File: missing.txt'))).diagnostic.code, 'file-not-found')
    await fs.writeFile(join(f.project, 'exists'), 'old')
    const exists = await f.apply(patch('*** Add File: exists\n+new'))
    assert.equal(exists.diagnostic.code, 'target-exists')
    assert.equal(await fs.readFile(join(f.project, 'exists'), 'utf8'), 'old')
  } finally { await f.close() }
})

test('patch permits absolute paths, parent paths and parent-directory links outside the project', async () => {
  const f = await fixture()
  try {
    await fs.symlink(f.other, join(f.project, 'outside'), 'dir')
    const result = await f.apply(patch(
      `*** Add File: ${join(f.other, 'absolute.txt')}\n+absolute`,
      '*** Add File: ../other/relative.txt\n+relative',
      '*** Add File: outside/linked.txt\n+linked',
    ))
    assert.equal(result.status, 'applied')
    assert.equal(await fs.readFile(join(f.other, 'absolute.txt'), 'utf8'), 'absolute\n')
    assert.equal(await fs.readFile(join(f.other, 'relative.txt'), 'utf8'), 'relative\n')
    assert.equal(await fs.readFile(join(f.other, 'linked.txt'), 'utf8'), 'linked\n')
  } finally { await f.close() }
})

test('patch rejects final symlinks, hard links and non-file targets without touching them', async () => {
  const f = await fixture()
  try {
    await fs.writeFile(join(f.project, 'original'), 'old\n')
    await fs.symlink('original', join(f.project, 'symbolic'))
    assert.equal((await f.apply(patch(update('symbolic')))).diagnostic.code, 'symbolic-link')
    await fs.link(join(f.project, 'original'), join(f.project, 'hard'))
    assert.equal((await f.apply(patch(update('hard')))).diagnostic.code, 'hard-link')
    await fs.mkdir(join(f.project, 'directory'))
    assert.equal((await f.apply(patch('*** Delete File: directory'))).diagnostic.code, 'unsupported-file')
    assert.equal(await fs.readFile(join(f.project, 'original'), 'utf8'), 'old\n')
  } finally { await f.close() }
})

test('preflight rejects duplicate aliases and parent-child targets', async () => {
  const f = await fixture()
  try {
    await fs.mkdir(join(f.project, 'real'))
    await fs.symlink('real', join(f.project, 'alias'), 'dir')
    const duplicate = await f.apply(patch('*** Add File: real/file\n+one', '*** Add File: alias/file\n+two'))
    assert.equal(duplicate.diagnostic.code, 'overlapping-paths')
    const overlapping = await f.apply(patch('*** Add File: parent\n+one', '*** Add File: parent/child\n+two'))
    assert.equal(overlapping.diagnostic.code, 'overlapping-paths')
    await assert.rejects(fs.stat(join(f.project, 'parent')), error => error.code === 'ENOENT')
    if (process.platform === 'darwin' || process.platform === 'win32') {
      assert.equal((await f.apply(patch('*** Add File: Name\n+one', '*** Add File: name\n+two'))).diagnostic.code, 'overlapping-paths')
    }
  } finally { await f.close() }
})

test('preflight rejects binary files and component replacement preserves CRLF and missing final newline', async () => {
  const f = await fixture()
  try {
    await fs.writeFile(join(f.project, 'binary'), Buffer.from([0, 255]))
    assert.equal((await f.apply(patch('*** Delete File: binary'))).status, 'rejected')
    await fs.writeFile(join(f.project, 'crlf'), 'first\r\nold')
    assert.equal((await f.apply(patch(update('crlf')))).status, 'applied')
    assert.equal(await fs.readFile(join(f.project, 'crlf'), 'utf8'), 'first\r\nnew')
  } finally { await f.close() }
})

test('macOS preflight rejects Unicode-normalized aliases before creating either file', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture()
  try {
    const result = await f.apply(patch('*** Add File: caf\u00e9.txt\n+one', '*** Add File: cafe\u0301.txt\n+two'))
    assert.equal(result.status, 'rejected')
    assert.equal(result.diagnostic.code, 'overlapping-paths')
    assert.deepEqual(result.changes, [])
    assert.deepEqual(await fs.readdir(f.project), [])
  } finally { await f.close() }
})

test('macOS preflight rejects Unicode case-fold aliases before creating either file', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture()
  try {
    for (const [first, second] of [['σ.txt', 'ς.txt'], ['ſ.txt', 's.txt'], ['ß.txt', 'ss.txt']]) {
      const result = await f.apply(patch(`*** Add File: ${first}\n+one`, `*** Add File: ${second}\n+two`))
      assert.equal(result.status, 'rejected', `${first} and ${second}`)
      assert.equal(result.diagnostic.code, 'overlapping-paths')
      assert.deepEqual(result.changes, [])
      assert.deepEqual(await fs.readdir(f.project), [])
    }
  } finally { await f.close() }
})

test('a later preflight read changing an earlier file rejects the whole patch before mutation', async () => {
  let first
  let changed = false
  const f = await fixture({
    async readFile(path) {
      const bytes = await fs.readFile(path)
      if (basename(path) === 'second' && !changed) {
        changed = true
        await fs.writeFile(first, 'external\n')
      }
      return bytes
    },
  })
  first = join(f.project, 'first')
  try {
    await fs.writeFile(first, 'old\n')
    await fs.writeFile(join(f.project, 'second'), 'old\n')
    const result = await f.apply(patch(update('first'), update('second')))
    assert.equal(result.status, 'rejected')
    assert.equal(result.diagnostic.code, 'file-changed')
    assert.equal(await fs.readFile(first, 'utf8'), 'external\n')
    assert.equal(await fs.readFile(join(f.project, 'second'), 'utf8'), 'old\n')
  } finally { await f.close() }
})

test('source recheck after staging preserves a concurrent external edit', async () => {
  let source
  const f = await fixture({
    async writeFile(path, bytes, options) {
      await fs.writeFile(path, bytes, options)
      await fs.writeFile(source, 'external\n')
    },
  })
  source = join(f.project, 'file')
  try {
    await fs.writeFile(source, 'old\n')
    const result = await f.apply(patch(update('file')))
    assert.equal(result.status, 'rejected')
    assert.equal(result.diagnostic.code, 'file-changed')
    assert.equal(await fs.readFile(source, 'utf8'), 'external\n')
    await assertNoTemporaryFiles(f.project)
  } finally { await f.close() }
})

test('no-clobber publication preserves a destination created after preflight', async () => {
  const f = await fixture({
    async link(source, target) {
      await fs.writeFile(target, 'concurrent\n', { flag: 'wx' })
      await fs.link(source, target)
    },
  })
  try {
    const result = await f.apply(patch('*** Add File: file\n+patch'))
    assert.equal(result.status, 'rejected')
    assert.equal(result.diagnostic.code, 'target-exists')
    assert.equal(await fs.readFile(join(f.project, 'file'), 'utf8'), 'concurrent\n')
    await assertNoTemporaryFiles(f.project)
  } finally { await f.close() }
})

test('a second-file filesystem failure reports completed and pending changes without rollback', async () => {
  const f = await fixture({
    async link(source, target) {
      if (basename(target) === 'second') throw ioError('ENOSPC')
      await fs.link(source, target)
    },
  })
  try {
    const result = await f.apply(patch('*** Add File: first\n+first', '*** Add File: new/second\n+second'))
    assert.equal(result.status, 'partial')
    assert.deepEqual(result.changes, [{ kind: 'added', path: 'first' }])
    assert.deepEqual(result.pending, [{ kind: 'add', path: 'new/second' }])
    assert.equal(result.diagnostic.code, 'filesystem-error')
    assert.ok(!JSON.stringify(result).includes('private'))
    assert.equal(await fs.readFile(join(f.project, 'first'), 'utf8'), 'first\n')
    await assert.rejects(fs.stat(join(f.project, 'new')), error => error.code === 'ENOENT')
    await assertNoTemporaryFiles(f.project)
  } finally { await f.close() }
})

test('Move reports the created destination when deleting its source fails', async () => {
  let sourcePath
  const f = await fixture({
    async unlink(path) {
      if (path === sourcePath) throw ioError('EACCES')
      await fs.unlink(path)
    },
  })
  sourcePath = join(f.project, 'source')
  try {
    await fs.writeFile(sourcePath, 'old\n')
    const result = await f.apply(patch('*** Update File: source\n*** Move to: target\n@@\n-old\n+new'))
    assert.equal(result.status, 'partial')
    assert.equal(result.diagnostic.code, 'move-source-not-deleted')
    assert.deepEqual(result.changes, [{ kind: 'added', path: 'target' }])
    assert.deepEqual(result.pending, [{ kind: 'update', path: 'source', moveTo: 'target' }])
    assert.equal(await fs.readFile(sourcePath, 'utf8'), 'old\n')
    assert.equal(await fs.readFile(join(f.project, 'target'), 'utf8'), 'new\n')
    await assertNoTemporaryFiles(f.project)
  } finally { await f.close() }
})

test('one component queue serializes calls across projects and queued cancellation makes no changes', async () => {
  const entered = deferred()
  const release = deferred()
  const lookups = []
  let first = true
  const f = await fixture({
    async writeFile(path, bytes, options) {
      if (first) { first = false; entered.resolve(); await release.promise }
      await fs.writeFile(path, bytes, options)
    },
  }, id => { lookups.push(id) })
  try {
    const a = f.call(patch('*** Add File: first\n+first'))
    await entered.promise
    const b = f.call(patch('*** Add File: second\n+second'), 'project-2')
    b.cancel('user-requested')
    const c = f.call(patch('*** Add File: third\n+third'), 'project-2')
    await Promise.resolve()
    assert.deepEqual(lookups, ['project-1'])
    release.resolve()
    assert.equal((await a.result).status, 'applied')
    const cancelled = await b.result
    assert.equal(cancelled.status, 'cancelled')
    assert.deepEqual(cancelled.pending, [{ kind: 'add', path: 'second' }])
    assert.equal((await c.result).status, 'applied')
    await Promise.all([a.done, b.done, c.done])
    assert.deepEqual(lookups, ['project-1', 'project-2'])
    await assert.rejects(fs.stat(join(f.other, 'second')), error => error.code === 'ENOENT')
    assert.equal(await fs.readFile(join(f.other, 'third'), 'utf8'), 'third\n')
  } finally { release.resolve(); await f.close() }
})

test('cancellation during preflight waits for the read and makes no changes', async () => {
  const entered = deferred()
  const release = deferred()
  const f = await fixture({
    async readFile(path) {
      entered.resolve()
      await release.promise
      return fs.readFile(path)
    },
  })
  try {
    await fs.writeFile(join(f.project, 'file'), 'old\n')
    const call = f.call(patch(update('file')))
    await entered.promise
    call.cancel('user-requested')
    let done = false
    void call.done.then(() => { done = true })
    await Promise.resolve()
    assert.equal(done, false)
    release.resolve()
    assert.equal((await call.result).status, 'cancelled')
    await call.done
    assert.equal(await fs.readFile(join(f.project, 'file'), 'utf8'), 'old\n')
    await assertNoTemporaryFiles(f.project)
  } finally { release.resolve(); await f.close() }
})

test('cancellation during commit finishes the current file and leaves later files pending', async () => {
  const entered = deferred()
  const release = deferred()
  const f = await fixture({
    async link(source, target) {
      await fs.link(source, target)
      entered.resolve()
      await release.promise
    },
  })
  try {
    const call = f.call(patch('*** Add File: first\n+first', '*** Add File: second\n+second'))
    await entered.promise
    call.cancel('user-requested')
    release.resolve()
    const result = await call.result
    assert.equal(result.status, 'cancelled')
    assert.deepEqual(result.changes, [{ kind: 'added', path: 'first' }])
    assert.deepEqual(result.pending, [{ kind: 'add', path: 'second' }])
    await call.done
    assert.equal(await fs.readFile(join(f.project, 'first'), 'utf8'), 'first\n')
    await assert.rejects(fs.stat(join(f.project, 'second')), error => error.code === 'ENOENT')
  } finally { release.resolve(); await f.close() }
})

test('cancellation during Move still completes source deletion and reports both facts', async () => {
  const entered = deferred()
  const release = deferred()
  const f = await fixture({
    async link(source, target) {
      await fs.link(source, target)
      entered.resolve()
      await release.promise
    },
  })
  try {
    await fs.writeFile(join(f.project, 'source'), 'old\n')
    const call = f.call(patch('*** Update File: source\n*** Move to: target'))
    await entered.promise
    call.cancel('user-requested')
    release.resolve()
    const result = await call.result
    assert.equal(result.status, 'cancelled')
    assert.deepEqual(result.changes, [{ kind: 'added', path: 'target' }, { kind: 'deleted', path: 'source' }])
    assert.deepEqual(result.pending, [])
    await call.done
    await assert.rejects(fs.stat(join(f.project, 'source')), error => error.code === 'ENOENT')
    assert.equal(await fs.readFile(join(f.project, 'target'), 'utf8'), 'old\n')
  } finally { release.resolve(); await f.close() }
})

test('result precedes temporary-file cleanup, while done and component disposal wait for it', async () => {
  const cleaning = deferred()
  const release = deferred()
  const f = await fixture({
    async unlink(path) {
      if (basename(path) === 'content') { cleaning.resolve(); await release.promise }
      await fs.unlink(path)
    },
  })
  try {
    const call = f.call(patch('*** Add File: file\n+text'))
    assert.equal((await call.result).status, 'applied')
    await cleaning.promise
    let exited = false
    void call.done.then(() => { exited = true })
    const closing = f.root.fiber.dispose()
    let closed = false
    void closing.then(() => { closed = true })
    await Promise.resolve()
    assert.equal(exited, false)
    assert.equal(closed, false)
    release.resolve()
    await call.done
    await closing
    assert.equal(exited, true)
    assert.equal(closed, true)
    assert.throws(() => f.call(patch('*** Add File: other\n+other')), error => isApplyPatchFailure(error) && error.category === 'unavailable')
  } finally { release.resolve(); await f.close() }
})

test('cleanup failure rejects done and remains visible when the component closes', async () => {
  const f = await fixture({
    async unlink(path) {
      if (basename(path) === 'content') throw ioError('EPERM')
      await fs.unlink(path)
    },
  })
  try {
    const call = f.call(patch('*** Add File: file\n+text'))
    assert.equal((await call.result).status, 'applied')
    await assert.rejects(call.done, error => isApplyPatchFailure(error) && error.category === 'cleanup-failure')
    await assert.rejects(f.root.fiber.dispose(), error => error.message.includes('cleanup'))
  } finally { await f.close().catch(() => {}) }
})

test('invalid requests and unavailable or unexpected executor failures use fixed infrastructure errors', async () => {
  const f = await fixture({ async link() { throw new Error('private unexpected implementation failure') } })
  try {
    assert.throws(() => f.call(null), error => isApplyPatchFailure(error) && error.category === 'invalid-request')
    assert.equal((await f.apply('  ')).status, 'rejected')
    assert.equal((await f.apply('nul\0')).status, 'rejected')
    const missing = f.call(patch('*** Add File: file\n+text'), 'missing')
    await assert.rejects(missing.result, error => isApplyPatchFailure(error) && error.category === 'unavailable' && !error.message.includes('private'))
    await missing.done
    const unexpected = f.call(patch('*** Add File: file\n+text'))
    await assert.rejects(unexpected.result, error => isApplyPatchFailure(error) && error.category === 'unavailable' && !error.message.includes('private'))
    await unexpected.done
    await assertNoTemporaryFiles(f.project)
  } finally { await f.close() }
})

test('component disposal waits for an accepted project lookup and prevents later file creation', async () => {
  const entered = deferred()
  const release = deferred()
  const f = await fixture({}, async () => { entered.resolve(); await release.promise })
  try {
    const call = f.call(patch('*** Add File: file\n+text'))
    await entered.promise
    const closing = f.root.fiber.dispose()
    let closed = false
    void closing.then(() => { closed = true })
    await Promise.resolve()
    assert.equal(closed, false)
    release.resolve()
    assert.equal((await call.result).status, 'cancelled')
    await call.done
    await closing
    await assert.rejects(fs.stat(join(f.project, 'file')), error => error.code === 'ENOENT')
  } finally { release.resolve(); await f.close() }
})
