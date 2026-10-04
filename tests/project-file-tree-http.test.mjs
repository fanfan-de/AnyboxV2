import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { createHostAccessComponent } from '../dist/host/access.js'
import { createFileTreeBrowser } from '../dist/applications/harness/core/project-files/tree-browser.js'
import { startHarnessServerHttp } from './helpers/harness-server-http.mjs'
import { deferred } from './helpers/controlled-models.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const treeCommands = tree => ({
  openProjectFileTree: (session, path, actor, signal) => tree.open(session, 'project', path, actor, signal),
  readProjectFileTreePage: (session, actor, id, page, signal) => tree.page(session, actor, id, page, signal),
  closeProjectFileTree: (session, actor, id) => tree.release(session, actor, id),
  onProjectFileTreeRetired: listener => tree.onRetired(listener),
})
async function request(server, action, body, { session = 'session', signal, headers = {} } = {}) {
  const response = await fetch(`${server.url}/api/v1/sessions/${session}/project-files/tree/${action}`, {
    method: 'POST', headers: { Origin: server.url, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal,
  })
  return { status: response.status, data: await response.json() }
}

test('tree HTTP pins cursor commands to their original service generation, retires leases and validates exact input', async () => {
  let opens = 0, closes = 0, leases = 0
  const tree = createFileTreeBrowser(async () => '/private/project', async (_signal, work) => work(), { scanTime: () => 0,
    access: { async open() {
      opens++; let index = 0
      return { async verify() {}, async read() { return index < 101 ? { name: String(index), path: String(index++), kind: 'file' } : null }, async close() { closes++ } }
    } } })
  let current = treeCommands(tree)
  const activity = { enter(_id, options) {
    if (options?.blocking !== false) return { release() {} }
    leases++; let active = true
    return { release() { if (active) { active = false; leases-- } } }
  } }
  const server = await startHarnessServerHttp(current, 0, { currentCommands: () => current, activity })
  try {
    for (const [action, body] of [['open', { path: '', owner: 'untrusted' }], ['open', { path: '../private' }],
      ['page', { cursorId: 'id', page: -1 }], ['page', { cursorId: 'id', page: 0, path: '' }], ['close', { cursorId: 'id', page: 0 }]]) {
      assert.equal((await request(server, action, body)).status, 400)
    }
    const first = await request(server, 'open', { path: '' })
    assert.equal(first.status, 200); assert.equal(first.data.nextPage, 1); assert.equal(leases, 1)
    current = { readProjectFileTreePage() { throw new Error('replacement must not read the original cursor') },
      closeProjectFileTree() { throw new Error('replacement must not close the original cursor') } }
    const final = await request(server, 'page', { cursorId: first.data.cursorId, page: 1 })
    assert.equal(final.status, 200); assert.equal(final.data.nextPage, null); assert.equal(closes, 1); assert.equal(leases, 0)
    current = treeCommands(tree)
    const next = await request(server, 'open', { path: '' }); assert.equal(leases, 1)
    current = { closeProjectFileTree() { throw new Error('replacement must not close the original cursor') } }
    assert.equal((await request(server, 'close', { cursorId: next.data.cursorId })).status, 200)
    assert.equal(closes, 2); assert.equal(leases, 0); assert.equal(opens, 2)
  } finally { await server.close(); await tree.close() }
})

for (const stop of ['disconnect', 'shutdown', 'revoke']) test(`tree HTTP ${stop} cancels page reads and waits actual cursor cleanup`, { timeout: 8000 }, async () => {
  const reading = deferred(), finishRead = deferred(), closing = deferred(), finishClose = deferred()
  const tree = createFileTreeBrowser(async () => '/private/project', async (_signal, work) => work(), { scanTime: () => 0,
    access: { async open() {
      let index = 0
      return { async verify() {}, async read() {
        if (index++ < 100) return { name: String(index), path: String(index), kind: 'file' }
        reading.resolve(); return finishRead.promise
      }, async close() { closing.resolve(); await finishClose.promise } }
    } } })
  const revoked = new Set(), instance = { instanceId: randomUUID(), name: 'device', apiVersion: 1, capabilities: [] }
  const access = { instance, authenticate() { return 'actor' }, onRevoked(listener) { revoked.add(listener); return () => revoked.delete(listener) } }
  const headers = { Authorization: 'Bearer trusted', 'X-Anybox-Instance-Id': instance.instanceId }
  const server = await startHarnessServerHttp(treeCommands(tree), 0, stop === 'revoke' ? { access } : {}), abort = new AbortController()
  try {
    const first = await request(server, 'open', { path: '' }, { headers })
    const pending = request(server, 'page', { cursorId: first.data.cursorId, page: 1 }, { headers, signal: abort.signal }).catch(error => ({ error }))
    await reading.promise
    if (stop === 'disconnect') abort.abort()
    if (stop === 'revoke') for (const observer of revoked) observer('actor')
    let closed = false
    const shutdown = server.close().then(() => closed = true)
    await tick(); assert.equal(closed, false)
    finishRead.resolve(null); await closing.promise; await tick(); assert.equal(closed, false)
    finishClose.resolve(); await shutdown; assert.equal(closed, true)
    const response = await pending
    if (stop === 'shutdown') { assert.equal(response.status, 503); assert.equal(response.data.error.code, 'file-cancelled') }
    else assert.ok(response.error)
  } finally { abort.abort(); finishRead.resolve(null); finishClose.resolve(); await server.close(); await tree.close() }
})

test('tree HTTP cleanup failure terminates a permanently pending provider result without exposing errors', async () => {
  let cancellations = 0
  const server = await startHarnessServerHttp({ readProjectFileTreePage() {
    return { result: new Promise(() => {}), done: Promise.reject(new Error('/private/path failed to close')), cancel() { cancellations++ } }
  } })
  try {
    const response = await request(server, 'page', { cursorId: 'id', page: 0 })
    assert.equal(response.status, 503); assert.deepEqual(response.data, { error: { code: 'file-cleanup-failed' } }); assert.ok(cancellations > 0)
  } finally { await server.close() }
})

test('committed token revocation awaits the tree HTTP observer through the actual directory close', { timeout: 8000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-tree-revoke-')), root = new Context()
  const closing = deferred(), finishClose = deferred()
  const tree = createFileTreeBrowser(async () => '/project', async (_signal, work) => work(), { scanTime: () => 0,
    access: { async open() {
      return { async verify() {}, async read() { return { name: 'file', path: 'file', kind: 'file' } },
        async close() { closing.resolve(); await finishClose.promise } }
    } } })
  let server
  try {
    await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
    await root.installComponent(createHostAccessComponent('device'))
    const access = root.get('host.access'), issued = await access.issue('owner')
    const headers = { Authorization: `Bearer ${issued.token}`, 'X-Anybox-Instance-Id': access.instance.instanceId }
    server = await startHarnessServerHttp(treeCommands(tree), 0, { access })
    const first = await request(server, 'open', { path: '' }, { headers }); assert.equal(first.status, 200)
    let revoked = false; const revoking = access.revoke(issued.record.id).then(() => revoked = true)
    await closing.promise
    assert.throws(() => access.authenticate(`Bearer ${issued.token}`), { code: 'authentication-failed' })
    assert.notEqual((await access.list())[0].revokedAt, null)
    await tick(); assert.equal(revoked, false)
    finishClose.resolve(); await revoking; assert.equal(revoked, true)
    assert.equal((await request(server, 'page', { cursorId: first.data.cursorId, page: 1 }, { headers })).status, 401)
  } finally { finishClose.resolve(); await server?.close(); await tree.close(); await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
})
