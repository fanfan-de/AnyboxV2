import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeRecentProjects, normalizeProjectPath } from '../dist/applications/claude-agent/core/projects.js'
import { listDirectory, parseDirectoryRequest } from '../dist/applications/claude-agent/core/directories.js'
import { sessionInfo, sessionProjects } from '../dist/applications/claude-agent/core/sdk/translate.js'

test('recent projects merge thread and Claude sources by directory, newest first, bounded, with trailing separators ignored', () => {
  assert.equal(normalizeProjectPath('/a/b/'), '/a/b'); assert.equal(normalizeProjectPath('/'), '/'); assert.equal(normalizeProjectPath('/a//b/./c'), '/a/b/c')
  const merged = mergeRecentProjects([
    { path: '/p/one', lastUsedAt: '2026-10-16T00:00:01.000Z', source: 'threads' },
    { path: '/p/two/', lastUsedAt: '2026-10-16T00:00:05.000Z', source: 'threads' },
    { path: '/p/two', lastUsedAt: '2026-10-16T00:00:03.000Z', source: 'claude' },
    { path: '/p/three', lastUsedAt: '2026-10-16T00:00:04.000Z', source: 'claude' },
    { path: '   ', lastUsedAt: '2026-10-16T00:00:09.000Z', source: 'claude' },
  ], 2)
  assert.deepEqual(merged, [
    { path: '/p/two', name: 'two', lastUsedAt: '2026-10-16T00:00:05.000Z', source: 'both' },
    { path: '/p/three', name: 'three', lastUsedAt: '2026-10-16T00:00:04.000Z', source: 'claude' },
  ])
  assert.equal(mergeRecentProjects([{ path: '/', lastUsedAt: 'x', source: 'threads' }], 5)[0].name, '/')
})
test('the worker session list projects to distinct directories and session info to one bounded title line', () => {
  assert.deepEqual(sessionProjects([
    { sessionId: 'a', cwd: '/p/x', lastModified: 1000 }, { sessionId: 'b', cwd: '/p/y', lastModified: 3000 }, { sessionId: 'c', cwd: '/p/x', lastModified: 2000 },
    { sessionId: 'd', cwd: null, lastModified: 9000 }, { sessionId: 'e', cwd: '/p/z' }, 'junk',
  ]), [{ path: '/p/y', lastUsedAt: '1970-01-01T00:00:03.000Z' }, { path: '/p/x', lastUsedAt: '1970-01-01T00:00:02.000Z' }, { path: '/p/z', lastUsedAt: '1970-01-01T00:00:00.000Z' }])
  assert.deepEqual(sessionProjects(null), [])
  assert.equal(sessionInfo(null), undefined)
  assert.deepEqual(sessionInfo({ customTitle: '  My   title \n second line', summary: 'ignored', firstPrompt: 'ignored' }), { title: 'My title' })
  assert.deepEqual(sessionInfo({ customTitle: null, summary: 'Summary here', firstPrompt: 'x' }), { title: 'Summary here' })
  assert.deepEqual(sessionInfo({ customTitle: '', summary: '', firstPrompt: '\n\nfirst prompt line\nmore' }), { title: 'first prompt line' })
  assert.deepEqual(sessionInfo({ customTitle: '', summary: '', firstPrompt: '' }), { title: null })
  assert.equal(sessionInfo({ customTitle: 'x'.repeat(300) }).title.length, 200)
})
test('directory requests expand ~, require absolute paths and validate showHidden', () => {
  assert.deepEqual(parseDirectoryRequest({ path: '~', showHidden: null }, '/home/me'), { path: '/home/me', showHidden: false })
  assert.deepEqual(parseDirectoryRequest({ path: '~/code/', showHidden: '1' }, '/home/me'), { path: '/home/me/code', showHidden: true })
  assert.deepEqual(parseDirectoryRequest({ path: ' /tmp/x ', showHidden: '0' }, '/home/me'), { path: '/tmp/x', showHidden: false })
  assert.throws(() => parseDirectoryRequest({ path: null, showHidden: null }, '/home/me'), { code: 'project-path-invalid', status: 400 })
  assert.throws(() => parseDirectoryRequest({ path: 'relative', showHidden: null }, '/home/me'), { code: 'project-path-invalid' })
  assert.throws(() => parseDirectoryRequest({ path: '~user', showHidden: null }, '/home/me'), { code: 'project-path-invalid' })
  assert.throws(() => parseDirectoryRequest({ path: '/tmp', showHidden: 'yes' }, '/home/me'), { code: 'invalid-input' })
})
test('directory listing returns sorted subdirectories only, hides dot directories by default, skips symbolic links and is bounded', async t => {
  const root = await mkdtemp(join(tmpdir(), 'anybox-claude-agent-dirs-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const name of ['beta', 'Alpha', 'gamma10', 'gamma2', '.hidden']) await mkdir(join(root, name))
  await writeFile(join(root, 'file.txt'), 'x')
  await symlink(join(root, 'beta'), join(root, 'link-to-beta'))
  const listing = await listDirectory({ path: root, showHidden: false })
  assert.deepEqual(listing, { schemaVersion: 1, path: root, parent: join(root, '..').replace(/\/$/, '') === root ? null : join(root, '..'), truncated: false,
    entries: ['Alpha', 'beta', 'gamma2', 'gamma10'].map(name => ({ name, path: join(root, name) })) })
  assert.deepEqual((await listDirectory({ path: root, showHidden: true })).entries.map(entry => entry.name), ['.hidden', 'Alpha', 'beta', 'gamma2', 'gamma10'])
  const bounded = await listDirectory({ path: root, showHidden: false }, { limit: 2 })
  assert.equal(bounded.truncated, true); assert.deepEqual(bounded.entries.map(entry => entry.name), ['Alpha', 'beta'])
  assert.equal((await listDirectory({ path: '/', showHidden: false })).parent, null)
  await assert.rejects(listDirectory({ path: join(root, 'missing'), showHidden: false }), { code: 'project-path-missing', status: 404 })
  await assert.rejects(listDirectory({ path: join(root, 'file.txt'), showHidden: false }), { code: 'project-path-missing', status: 404 })
  await assert.rejects(listDirectory({ path: root, showHidden: false }, { signal: AbortSignal.abort() }), { code: 'cancelled' })
  await assert.rejects(listDirectory({ path: root, showHidden: false }, { readdir: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) } }), { code: 'directory-unreadable', status: 403 })
})
