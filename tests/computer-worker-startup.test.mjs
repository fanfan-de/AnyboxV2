import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectLocalComputerWorker } from '../dist/applications/harness/core/computer/worker-client.js'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await wait(10) }
  throw new Error('startup test condition did not become true')
}
function live(pid) { try { process.kill(pid, 0); return true } catch { return false } }
function killWorker(pid) { try { process.kill(-pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error } }
async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'anybox-worker-startup-')))
  const workerDirectory = join(directory, 'worker'), gate = join(directory, 'gate')
  await fs.mkdir(gate)
  const client = connectLocalComputerWorker({ directory: workerDirectory, autoStart: false, startupTimeoutMs: 5000 })
  const managers = [], workers = new Set()
  t.after(async () => {
    for (const manager of managers) if (manager.child.exitCode === null && manager.child.signalCode === null) manager.child.kill('SIGKILL')
    await Promise.allSettled(managers.map(manager => manager.done))
    await client.shutdown().catch(() => {})
    for (const pid of workers) if (live(pid)) killWorker(pid)
    await client.closeObserver()
    await fs.rm(directory, { recursive: true, force: true })
  })
  const launch = mode => {
    const child = childProcess.fork(fileURLToPath(new URL('./helpers/computer-worker-startup-process.mjs', import.meta.url)), [mode, workerDirectory], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${new URL('./helpers/computer-worker-startup-gate.mjs', import.meta.url).href}`,
        ANYBOX_TEST_WORKER_STARTUP_GATE: gate },
    })
    const messages = []
    let out = '', err = ''
    child.on('message', message => { messages.push(message); if (message.type === 'spawned' && message.pid) workers.add(message.pid) })
    child.stdout.on('data', value => { out += value }); child.stderr.on('data', value => { err += value })
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve({ code, out, err })) })
    const manager = { child, messages, done }
    managers.push(manager)
    return manager
  }
  return { directory, workerDirectory, gate, client, launch, workers }
}

test('a passive connect cannot consume the same observer explicit start', { timeout: 10000, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(), readFile = fs.readFile
  let first = true
  fs.readFile = async (path, ...args) => {
    if (first && path === join(f.workerDirectory, 'endpoint.json')) { first = false; entered.resolve(); await release.promise }
    return readFile(path, ...args)
  }
  syncBuiltinESMExports()
  let reading, starting
  try {
    reading = f.client.control.listAttachments(); void reading.catch(() => {})
    await entered.promise
    starting = f.client.start(); void starting.catch(() => {})
    release.resolve()
    const results = await Promise.allSettled([reading, starting])
    assert.equal(results[0].status, 'rejected'); assert.equal(results[0].reason.code, 'worker-not-running')
    assert.equal(results[1].status, 'fulfilled', results[1].reason?.message)
    const status = await f.client.status()
    assert.equal(status.state, 'running')
    await f.client.closeObserver()
    const observer = connectLocalComputerWorker({ directory: f.workerDirectory, autoStart: false })
    try { assert.equal((await observer.status()).bootId, status.bootId); await observer.shutdown() }
    finally { await observer.closeObserver() }
  } finally { release.resolve(); fs.readFile = readFile; syncBuiltinESMExports(); await Promise.allSettled([reading, starting]) }
})

test('real CLI and observer starters serialize before spawning and reuse one worker', { timeout: 15000, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), cli = f.launch('cli'), observer = f.launch('observer')
  await until(() => [cli, observer].every(manager => manager.messages.some(message => message.type === 'reading')))
  cli.child.send('read'); observer.child.send('read')
  // The first worker cannot publish an endpoint: both contenders must reach startup coordination.
  await until(() => f.workers.size === 2 || (f.workers.size === 1 && [cli, observer].every(manager => manager.messages.some(message => message.type === 'coordinating'))))
  assert.equal(f.workers.size, 1, 'only the startup lock owner may spawn while no endpoint exists')
  await until(async () => (await fs.readdir(f.gate)).some(name => name.endsWith('.ready')))
  await fs.writeFile(join(f.gate, 'release'), '')
  const results = await Promise.all([cli.done, observer.done])
  for (const result of results) assert.equal(result.code, 0, result.err)
  const states = results.map(result => JSON.parse(result.out))
  assert.equal(states[0].state, 'running'); assert.equal(states[1].state, 'running')
  assert.equal(states[0].pid, states[1].pid); assert.equal(states[0].bootId, states[1].bootId)
  assert.equal(f.workers.size, 1)
})

test('a killed startup lock owner leaves a reusable OS lock', { timeout: 15000, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  await fs.mkdir(f.workerDirectory)
  const holder = f.launch('lock')
  await until(() => holder.messages.some(message => message.type === 'locked'))
  const manager = f.launch('observer')
  await until(() => manager.messages.some(message => message.type === 'reading'))
  manager.child.send('read')
  await until(() => manager.messages.some(message => message.type === 'coordinating'))
  assert.equal(f.workers.size, 0)
  assert.equal(holder.child.exitCode, null); assert.equal(holder.child.signalCode, null)
  holder.child.kill('SIGKILL'); await holder.done
  await until(() => f.workers.size === 1)
  await fs.writeFile(join(f.gate, 'release'), '')
  const result = await manager.done
  assert.equal(result.code, 0, result.err); assert.equal(JSON.parse(result.out).state, 'running')
})

test('observer close cancels startup lock waiting without spawning or stopping another owner', { timeout: 5000, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  await fs.mkdir(f.workerDirectory)
  const db = new DatabaseSync(join(f.workerDirectory, 'startup.sqlite'))
  db.exec('BEGIN EXCLUSIVE')
  const entered = deferred(), open = fs.open
  fs.open = async (path, ...args) => { const file = await open(path, ...args); if (path === join(f.workerDirectory, 'startup.sqlite')) entered.resolve(); return file }
  syncBuiltinESMExports()
  let starting
  try {
    starting = f.client.start(); const rejected = assert.rejects(starting, { code: 'worker-observer-closed' })
    await entered.promise
    await f.client.closeObserver(); await rejected
    assert.deepEqual((await fs.readdir(f.workerDirectory)).filter(name => name === 'worker.sqlite' || name === 'endpoint.json'), [])
  } finally { db.close(); fs.open = open; syncBuiltinESMExports(); await Promise.allSettled([starting]) }
})

test('startup timeout joins its unpublished child before releasing the startup lock', { timeout: 10000, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), spawn = childProcess.spawn, previous = process.env.NODE_OPTIONS
  const client = connectLocalComputerWorker({ directory: f.workerDirectory, autoStart: false, startupTimeoutMs: 1000 })
  let child
  childProcess.spawn = (...args) => { child = spawn(...args); if (child.pid) f.workers.add(child.pid); return child }
  process.env.NODE_OPTIONS = `${previous ?? ''} --import=${new URL('./helpers/computer-worker-startup-gate.mjs', import.meta.url).href}`
  process.env.ANYBOX_TEST_WORKER_STARTUP_GATE = f.gate
  syncBuiltinESMExports()
  try {
    const starting = client.start(), rejected = assert.rejects(starting, { code: 'worker-startup-timeout' })
    await until(async () => (await fs.readdir(f.gate)).some(name => name.endsWith('.ready')))
    await rejected
    assert.equal(live(child.pid), false, 'failed startup must wait for the actual child exit')
    const db = new DatabaseSync(join(f.workerDirectory, 'startup.sqlite'))
    try { db.exec('BEGIN EXCLUSIVE') } finally { db.close() }
    await fs.writeFile(join(f.gate, 'release'), '')
    await f.client.start()
    assert.equal((await f.client.status()).state, 'running')
  } finally {
    childProcess.spawn = spawn; syncBuiltinESMExports()
    if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous
    delete process.env.ANYBOX_TEST_WORKER_STARTUP_GATE
    await client.closeObserver()
  }
})

test('observer close joins a spawned startup handoff and leaves the published worker running', { timeout: 10000, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), previous = process.env.NODE_OPTIONS
  process.env.NODE_OPTIONS = `${previous ?? ''} --import=${new URL('./helpers/computer-worker-startup-gate.mjs', import.meta.url).href}`
  process.env.ANYBOX_TEST_WORKER_STARTUP_GATE = f.gate
  let starting
  try {
    starting = f.client.start(); const rejected = assert.rejects(starting, { code: 'worker-observer-closed' })
    const pid = await until(async () => {
      const name = (await fs.readdir(f.gate)).find(name => name.endsWith('.ready'))
      return name && Number.parseInt(name)
    })
    f.workers.add(pid)
    let closed = false
    const closing = f.client.closeObserver().then(() => { closed = true })
    await wait(50); assert.equal(closed, false, 'observer close must not unlock an unconfirmed startup')
    const db = new DatabaseSync(join(f.workerDirectory, 'startup.sqlite'))
    try { assert.throws(() => db.exec('BEGIN EXCLUSIVE'), /locked|busy/) } finally { db.close() }
    await fs.writeFile(join(f.gate, 'release'), '')
    await closing; await rejected
    const observer = connectLocalComputerWorker({ directory: f.workerDirectory, autoStart: false })
    try { const status = await observer.status(); assert.equal(status.state, 'running'); assert.equal(status.pid, pid); await observer.shutdown() }
    finally { await observer.closeObserver() }
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous
    delete process.env.ANYBOX_TEST_WORKER_STARTUP_GATE
    await fs.writeFile(join(f.gate, 'release'), '')
    await Promise.allSettled([starting])
  }
})

test('a failed executable releases startup coordination and reports failure promptly', { timeout: 5000, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  const client = connectLocalComputerWorker({ directory: f.workerDirectory, autoStart: false, executable: join(f.directory, 'missing-node'), startupTimeoutMs: 4000 })
  try {
    const started = Date.now()
    await assert.rejects(client.start(), { code: 'worker-startup-failed' })
    assert.ok(Date.now() - started < 2000, 'spawn failure must not wait for the startup timeout')
    const db = new DatabaseSync(join(f.workerDirectory, 'startup.sqlite'))
    try { db.exec('BEGIN EXCLUSIVE') } finally { db.close() }
  } finally { await client.closeObserver() }
})
