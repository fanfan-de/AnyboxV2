import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fork } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const tick = () => new Promise(resolve => setTimeout(resolve, 20))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function bounded(promise, label) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded 10 seconds`)), 10000) })])
    .finally(() => clearTimeout(timer))
}
async function until(read, accept) {
  const end = Date.now() + 10000
  let value
  do { value = await read(); if (accept(value)) return value; await tick() } while (Date.now() < end)
  assert.fail(`Local pairing did not settle: ${JSON.stringify(value)}`)
}
async function vaultFixture() {
  const values = new Map(), entered = deferred(), release = deferred(), startupEntered = deferred(), startupRelease = deferred()
  const state = { values, unavailable: false, block: false, writes: 0, entered, release, startupGate: false, startupEntered, startupRelease }
  const server = createServer(async (request, response) => {
    if (request.url === '/client-start') {
      startupEntered.resolve(); await startupRelease.promise; response.end('{}'); return
    }
    const chunks = []; for await (const part of request) chunks.push(part)
    const input = JSON.parse(Buffer.concat(chunks).toString()), key = `${input.namespace}:${input.id}`
    if (state.block) { entered.resolve(); await release.promise }
    if (state.unavailable) { response.writeHead(503); response.end('{}'); return }
    let value
    if (input.method === 'read') value = values.get(key)
    if (input.method === 'write') { state.writes++; values.set(key, input.value) }
    if (input.method === 'delete') values.delete(key)
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ value }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return Object.assign(state, { url: `http://127.0.0.1:${server.address().port}`,
    async close() { release.resolve(); startupRelease.resolve(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } })
}
function launch(directory, vault) {
  const child = fork(fileURLToPath(new URL('../packages/distribution/dist/entrypoints/serve.js', import.meta.url)), [], {
    cwd: directory, execArgv: ['--import', new URL('./helpers/web-local-preload.mjs', import.meta.url).href], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, ANYBOX_TEST_VAULT_URL: vault.url, ANYBOX_CLIENT_DATABASE: join(directory, 'client.sqlite'), ANYBOX_CLIENT_NAMESPACE: 'anybox.client',
      ...(vault.startupGate ? { ANYBOX_TEST_CLIENT_START_GATE_URL: `${vault.url}/client-start` } : {}),
      ANYBOX_APPLICATION_DIRECTORY: join(directory, 'applications'), ANYBOX_HARNESS_BIND: '127.0.0.1',
      ANYBOX_HARNESS_DATABASE: join(directory, 'harness.sqlite'), ANYBOX_MODELS_CONFIG: join(directory, 'models.json'),
      ANYBOX_MODELS_DATABASE: join(directory, 'models.sqlite'), ANYBOX_MODELS_CATALOG_DATABASE: join(directory, 'catalog.sqlite'),
      ANYBOX_IMAGE_ASSETS_DIRECTORY: join(directory, 'images'), ANYBOX_PROJECTS: '[]', ANYBOX_WEB_PORT: '0', ANYBOX_HARNESS_PORT: '0' },
  })
  let output = '', readyResolve
  const ready = new Promise(resolve => { readyResolve = resolve })
  const collect = bytes => { output += bytes; const url = /Anybox Client: (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1]; if (url) readyResolve(url) }
  child.stdout.on('data', collect); child.stderr.on('data', collect)
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })) })
  let stopping
  return { child, exited, output: () => output,
    ready: bounded(Promise.race([ready, exited.then(() => { throw new Error(output || 'Launcher exited before ready') })]), 'Launcher startup'),
    stop() {
      if (child.exitCode !== null) return exited
      return stopping ??= bounded((async () => { child.send({ type: 'anybox-role-stop' }); return exited })(), 'Launcher shutdown')
    },
  }
}
async function cleanup(process, directory, vault) {
  // Release an injected stalled native operation before requesting normal role shutdown.
  vault.release.resolve()
  vault.startupRelease.resolve()
  try {
    if (process?.child.exitCode === null) await process.stop()
  } catch (error) {
    // Only a failed, bounded test shutdown reaches this fallback. The roles handle lost parent IPC themselves.
    if (process?.child.exitCode === null) { process.child.kill('SIGKILL'); await process.exited }
    throw error
  } finally {
    await vault.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}
async function request(url, path, body) {
  const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { Origin: url, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const result = await response.json()
  assert.equal(response.status, 200, JSON.stringify(result))
  return result
}
const base = app => `/api/client/v1/apps/${app}`
const open = (url, app) => request(url, `/api/client/v1/products/${app}/open`, {})
const readyLocal = (url, app) => until(() => request(url, base(app) + '/local'), state => state.status?.state === 'ready')

test('web:local automatically pairs both applications and retains their independent credentials across restart', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-web-local-')), vault = await vaultFixture()
  let process
  t.after(() => cleanup(process, directory, vault))
  const saved = new Map()
  for (let pass = 0; pass < 2; pass++) {
    process = launch(directory, vault); const url = await process.ready
    for (const app of ['agent', 'claude-agent']) {
      await open(url, app)
      const status = await readyLocal(url, app), listing = await request(url, base(app) + '/connections')
      const rows = Array.isArray(listing) ? listing : listing.connections
      assert.equal(rows.length, 1)
      const connection = rows[0]
      assert.equal(connection.name, '本机'); assert.equal(connection.id, status.status.connectionId)
      assert.equal((await request(url, `${base(app)}/connections/${connection.id}/check`, {})).instanceId, connection.instanceId)
      if (pass === 0) saved.set(app, connection)
      else { assert.equal(connection.id, saved.get(app).id); assert.equal(connection.instanceId, saved.get(app).instanceId) }
    }
    assert.equal(vault.values.size, 2, 'applications each own a Vault entry')
    assert.equal(vault.writes, 2, 'restarting reuses retained credentials')
    const credentials = [...vault.values.values()]
    assert.notEqual(credentials[0], credentials[1])
    assert.ok([...vault.values.keys()].some(key => key.startsWith('anybox.client.agent:')))
    assert.ok([...vault.values.keys()].some(key => key.startsWith('anybox.client.claude-agent:')))
    for (const token of credentials) assert.equal(process.output().includes(token), false)
    if (pass === 1) {
      const harness = (await request(url, base('agent') + '/connections'))[0]
      await request(url, `${base('agent')}/connections/${harness.id}/delete`, { expectedRevision: harness.revision })
      const claude = saved.get('claude-agent')
      assert.equal((await request(url, `${base('claude-agent')}/connections/${claude.id}/check`, {})).instanceId, claude.instanceId)
      assert.equal(vault.values.size, 1, 'removing Harness leaves Claude Agent credentials intact')
    }
    assert.equal((await process.stop()).code, 0, process.output())
    await assert.rejects(fetch(url))
    for (const token of credentials) assert.equal((await readFile(join(directory, 'client.sqlite'))).includes(Buffer.from(token)), false)
  }
})

test('web:local reports a locked Vault, permits explicit retry and waits for an accepted pairing write during close', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-web-local-vault-')), vault = await vaultFixture()
  let process
  t.after(() => cleanup(process, directory, vault))
  vault.unavailable = true
  process = launch(directory, vault); const url = await process.ready
  await open(url, 'agent')
  const failed = await until(() => request(url, base('agent') + '/local'), state => state.status?.state === 'failed')
  assert.equal(failed.status.error.code, 'credential-unavailable')
  assert.deepEqual(await request(url, base('agent') + '/connections'), [])
  vault.unavailable = false
  assert.equal((await request(url, base('agent') + '/local/retry', {})).state, 'ready')
  assert.equal((await request(url, base('agent') + '/connections')).length, 1)
  vault.block = true
  await open(url, 'claude-agent')
  await vault.entered.promise
  let stopped = false
  const stopping = process.stop().then(result => { stopped = true; return result })
  await tick(); await tick()
  assert.equal(stopped, false, 'shutdown joins the accepted Vault operation rather than abandoning it')
  vault.release.resolve()
  assert.equal((await stopping).code, 0, process.output())
  await assert.rejects(fetch(url))
})

test('web:local retains a stop request received before the client host finishes starting', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-web-local-start-stop-')), vault = await vaultFixture()
  vault.startupGate = true
  const process = launch(directory, vault)
  // A successful startup is deliberately prevented, so an early-exit readiness rejection is expected.
  void process.ready.catch(() => {})
  t.after(() => cleanup(process, directory, vault))
  await bounded(vault.startupEntered.promise, 'Client startup gate')
  let stopped = false
  const stopping = process.stop().then(result => { stopped = true; return result })
  await tick(); await tick()
  assert.equal(stopped, false, 'the parent waits for its starting client rather than exiting early')
  vault.startupRelease.resolve()
  assert.equal((await stopping).code, 0, process.output())
})
