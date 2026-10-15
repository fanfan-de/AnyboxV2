import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { createClientHost } from '../dist/entrypoints/client-main.js'
import { connectLocalComputerWorker } from '../dist/applications/harness/core/computer/worker-client.js'
const cwd = resolve('.')
const code = `import { Context } from '@nya/core'; import { createLocalSqliteComponent } from './dist/storage/sqlite.js'; const root=new Context(); await root.installComponent(createLocalSqliteComponent(process.argv[1])); process.send('ready'); setInterval(()=>{},1000);`

test('SQLite ownership persists between transactions, releases on SIGKILL, and old ownerless locks remain untouched', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anybox-crash-')), path = join(dir, 'harness.sqlite'); let child, root
  try {
    child = spawn(process.execPath, ['--input-type=module', '-e', code, path], { cwd, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    await once(child, 'message')
    root = new Context(); await assert.rejects(async () => { await root.installComponent(createLocalSqliteComponent(path)) }, { code: 'occupied' }); await root.fiber.dispose()
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
    root = new Context(); await root.installComponent(createLocalSqliteComponent(path)); await root.fiber.dispose()
    await mkdir(`${path}.lock`)
    root = new Context(); await assert.rejects(async () => { await root.installComponent(createLocalSqliteComponent(path)) }, error => error.code === 'occupied' && /offline/i.test(error.message))
    assert.equal((await stat(`${path}.lock`)).isDirectory(), true)
  } finally { child?.kill('SIGKILL'); await root?.fiber.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('client has its own root without Models or Harness services and cleans up failed listener startup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anybox-client-only-')); let a, b
  try {
    a = await createClientHost({ path: join(dir, 'a') })
    assert.equal(a.root.get('harness.runs'), undefined); assert.equal(a.root.get('models'), undefined)
    const port = Number(new URL(a.url).port)
    await assert.rejects(createClientHost({ path: join(dir, 'b'), port }))
    b = await createClientHost({ path: join(dir, 'b') })
    const page = await fetch(b.url); assert.equal(page.status, 200)
    assert.equal((await fetch(b.url + '/api/client/v1/connections')).status, 503)
    await b.products.open('agent')
    assert.equal((await fetch(b.url + '/api/client/v1/connections')).status, 200)
    await Promise.all([a.close(), a.close(), b.close()])
  } finally { await b?.close(); await a?.close(); await rm(dir, { recursive: true, force: true }) }
})

test('combined launcher still starts the client when local Harness startup fails and joins its child on stop', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anybox-launcher-')); let child
  try {
    child = spawn(process.execPath, ['dist/entrypoints/serve.js'], { cwd, env: { ...process.env, ANYBOX_LLM_API: 'invalid-for-test', ANYBOX_WEB_PORT: '0', ANYBOX_CLIENT_DATABASE: join(dir, 'client.sqlite') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    let output = ''
    const ready = new Promise((resolve, reject) => {
      child.stdout.on('data', bytes => { output += bytes; const url = /Anybox Client: (http:\/\/127.0.0.1:\d+)/.exec(output)?.[1]; if (url) resolve(url) })
      child.once('error', reject); child.once('exit', () => reject(new Error('launcher exited before client started')))
    })
    const url = await ready
    assert.equal((await fetch(url + '/api/client/v1/connections')).status, 503)
    const response = await fetch(url + '/api/client/v1/products/agent/open', { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(response.status, 200)
    assert.equal((await fetch(url + '/api/client/v1/connections')).status, 200)
    const exited = once(child, 'exit'); child.send({ type: 'anybox-stop' }); assert.equal((await exited)[0], 0)
    await assert.rejects(fetch(url))
    const root = new Context(); await root.installComponent(createLocalSqliteComponent(join(dir, 'client.sqlite'))); await root.fiber.dispose()
  } finally { child?.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }) }
})

test('losing the launcher parent IPC drains owned roles while an independent idle worker survives', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-launcher-owner-'))
  const worker = connectLocalComputerWorker({ directory: join(directory, 'worker') })
  let child
  try {
    const identity = await worker.info()
    child = spawn(process.execPath, ['dist/entrypoints/serve.js'], { cwd,
      env: { ...process.env, ANYBOX_LLM_API: 'invalid-for-test', ANYBOX_WEB_PORT: '0', ANYBOX_CLIENT_DATABASE: join(directory, 'client.sqlite'),
        ANYBOX_COMPUTER_WORKER_DIRECTORY: join(directory, 'worker') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    let output = ''
    const ready = new Promise((yes, no) => {
      child.stdout.on('data', bytes => { output += bytes; const url = /Anybox Client: (http:\/\/127.0.0.1:\d+)/.exec(output)?.[1]; if (url) yes(url) })
      child.once('error', no); child.once('exit', () => no(new Error('launcher exited before readiness')))
    })
    const url = await ready, exited = once(child, 'exit')
    child.disconnect()
    assert.equal((await exited)[0], 0)
    await assert.rejects(fetch(url))
    assert.deepEqual(await worker.info(), identity)
    const root = new Context(); await root.installComponent(createLocalSqliteComponent(join(directory, 'client.sqlite'))); await root.fiber.dispose()
  } finally {
    if (child?.exitCode === null) child.kill('SIGKILL')
    await worker.shutdown(); await worker.closeObserver(); await rm(directory, { recursive: true, force: true })
  }
})
