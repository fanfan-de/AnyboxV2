import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { startManagedApplicationHost } from '../dist/package-management/managed-process.js'

test('the minimal host CLI opens an empty lifecycle shell, persists only host domains and exits on SIGTERM', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-minimum-cli-'))
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/main.js', import.meta.url)), 'serve'], {
    cwd: directory, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', ANYBOX_WEB_PORT: '0',
      ANYBOX_CLIENT_DATABASE: join(directory, 'control.sqlite'), ANYBOX_APPLICATION_DIRECTORY: join(directory, 'applications') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = '', exited = false
  const done = once(child, 'exit').then(result => { exited = true; return result })
  t.after(async () => { if (!exited) { child.kill('SIGKILL'); await done } await rm(directory, { recursive: true, force: true }) })
  child.stderr.on('data', bytes => { stderr += bytes })
  const ready = new Promise((resolve, reject) => {
    let output = ''
    child.stdout.on('data', bytes => {
      output += bytes
      const url = /Anybox Host: (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1]
      if (url) resolve(url)
    })
    child.once('error', reject)
    void done.then(() => reject(new Error(`Minimal host exited before ready: ${stderr}`)))
  })
  const url = await ready
  assert.equal((await fetch(url)).status, 200)
  assert.deepEqual(await (await fetch(url + '/api/client/v1/products')).json(), [])
  assert.equal((await fetch(url + '/api/client/v1/apps/agent/projects')).status, 404)
  assert.equal((await stat(join(directory, 'applications', 'registry.sqlite'))).isFile(), true)
  child.kill('SIGTERM')
  assert.deepEqual(await done, [0, null], stderr)
  for (const [path, expected] of [[join(directory, 'control.sqlite'), 'app-products'], [join(directory, 'applications', 'registry.sqlite'), 'host-package-registry']]) {
    const db = new DatabaseSync(path, { readOnly: true })
    try { assert.deepEqual(db.prepare('SELECT DISTINCT domain FROM schema_migrations').all().map(row => row.domain), [expected]) }
    finally { db.close() }
  }
  await assert.rejects(fetch(url))
})

test('the managed minimal host keeps its stable desktop proxy private and owns only an empty client role', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-minimum-managed-'))
  let host
  t.after(async () => { try { await host?.close() } finally { await rm(directory, { recursive: true, force: true }) } })
  host = await startManagedApplicationHost({ path: join(directory, 'client.sqlite'), packageDirectory: join(directory, 'applications'), port: 0,
    roles: ['client', 'execution'], incomingTransportSecret: 'minimum-desktop-test-secret' })
  assert.deepEqual(await host.inspectForQuit(), { busy: false }); await host.releaseQuit()
  assert.deepEqual(host.state.roles.map(role => role.role), ['client'])
  const response = await fetch(host.url + '/api/client/v1/products')
  assert.equal(response.status, 403)
  const authorized = await fetch(host.url + '/api/client/v1/products', { headers: { 'X-Anybox-Desktop-Transport': 'minimum-desktop-test-secret' } })
  assert.equal(authorized.status, 200); assert.deepEqual(await authorized.json(), [])
  assert.equal((await stat(join(directory, 'applications', 'registry.sqlite'))).isFile(), true)
  await host.close(); await assert.rejects(fetch(host.url))
})
