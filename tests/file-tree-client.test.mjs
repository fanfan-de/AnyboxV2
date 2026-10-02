import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFileTreeClient } from '../dist/applications/harness/web/file-tree-client.js'
import { deferred } from './helpers/controlled-models.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const entry = (name, kind = 'file', path = '') => ({ name, kind, path: path ? `${path}/${name}` : name })
const page = (cursorId, path = '', entries = [], index = 0, nextPage = null) => ({ cursorId, path, entries, page: index, nextPage })
const ref = id => ({ projectId: `p-${id}`, sessionId: id })

test('directory pages retain every loaded row and order directories before files without scoping opaque cursors', async () => {
  const calls = [], id = 'h:11111111-1111-4111-8111-111111111111:session'
  const client = createFileTreeClient(async (url, body) => {
    calls.push({ url, body })
    if (url.endsWith('/open')) return page('opaque:cursor', '', [entry('z.ts'), entry('a-dir', 'directory')], 0, 1)
    if (url.endsWith('/page')) return page('opaque:cursor', '', [entry('.hidden'), entry('z-dir', 'directory')], 1)
  }, ref(id), () => {})
  await client.open(''); await client.more('')
  assert.deepEqual(client.snapshot().get('').entries.map(row => row.name), ['a-dir', 'z-dir', '.hidden', 'z.ts'])
  assert.ok(calls.every(call => call.url.includes(encodeURIComponent(id))))
  assert.deepEqual(calls.find(call => call.url.endsWith('/page')).body, { cursorId: 'opaque:cursor', page: 1 })
  await client.dispose()
  assert.equal(calls.some(call => call.url.endsWith('/cancel')), false)
})

test('dispose cancels and joins a late cursor reservation and its cleanup before returning', async () => {
  const opened = deferred(), cleaned = deferred(), calls = []
  let publications = 0
  const client = createFileTreeClient(async (url, body, signal) => {
    calls.push({ url, body, signal })
    if (url.endsWith('/open')) return opened.promise
    if (url.endsWith('/close')) return cleaned.promise
  }, ref('first'), () => publications++)
  const reading = client.open(''); await tick()
  let exited = false
  const disposal = client.dispose(), exiting = disposal.then(() => { exited = true })
  assert.equal(calls[0].signal.aborted, true)
  const before = publications
  await tick(); assert.equal(exited, false)
  opened.resolve(page('late', '', [entry('late.ts')], 0, 1))
  await tick()
  assert.deepEqual(calls.at(-1).body, { cursorId: 'late' })
  assert.equal(exited, false)
  cleaned.resolve({})
  await Promise.all([reading, exiting])
  assert.equal(publications, before)
  assert.equal(exited, true)
  assert.equal(client.dispose(), disposal)
})

test('collapsing a branch joins its old read and permits a new generation without publishing late rows', async () => {
  const old = deferred(), calls = []
  let count = 0
  const client = createFileTreeClient(async (url, body, signal) => {
    calls.push({ url, body, signal })
    if (url.endsWith('/open') && !count++) return old.promise
    if (url.endsWith('/open')) return page('new', 'src', [entry('new.ts', 'file', 'src')])
  }, ref('s'), () => {})
  const previous = client.open('src'); await tick()
  const collapsed = client.close('src')
  await client.open('src')
  old.resolve(page('old', 'src', [entry('old.ts', 'file', 'src')], 0, 1))
  await Promise.all([previous, collapsed])
  assert.deepEqual(client.snapshot().get('src').entries.map(row => row.name), ['new.ts'])
  assert.equal(calls[0].signal.aborted, true)
  assert.ok(calls.some(call => call.url.endsWith('/close') && call.body.cursorId === 'old'))
  await client.dispose()
})

test('a malformed continuation preserves the known rows and releases the actual cursor', async () => {
  const calls = []
  const client = createFileTreeClient(async (url, body) => {
    calls.push({ url, body })
    if (url.endsWith('/open')) return page('first', '', [entry('kept.ts')], 0, 1)
    if (url.endsWith('/page')) return page('other', '', [entry('injected.ts')], 1)
  }, ref('s'), () => {})
  await client.open(''); await client.more('')
  assert.deepEqual(client.snapshot().get('').entries.map(row => row.name), ['kept.ts'])
  assert.ok(client.snapshot().get('').error)
  assert.ok(calls.some(call => call.url.endsWith('/close') && call.body.cursorId === 'first'))
  assert.equal(calls.filter(call => call.url.endsWith('/close') && call.body.cursorId === 'other').length, 1)
  await client.dispose()
})

test('cursor cleanup failure is observable only after all accepted reads exit', async () => {
  const client = createFileTreeClient(async url => {
    if (url.endsWith('/open')) return page('failed-close', '', [entry('file.ts')], 0, 1)
    throw new Error('close failed')
  }, ref('s'), () => {})
  await client.open('')
  await assert.rejects(client.dispose(), AggregateError)
})
