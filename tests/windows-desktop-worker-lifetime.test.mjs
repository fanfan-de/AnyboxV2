import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { connectLocalComputerWorker } from '../dist/applications/harness/core/computer/worker-client.js'

const require = createRequire(import.meta.url)
function live(pid) {
  try { process.kill(pid, 0); return true }
  catch (error) { return error.code === 'EPERM' }
}

test('a Windows idle Computer worker outlives both its Electron utility launcher and Electron main', { skip: process.platform !== 'win32', timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-electron-worker-lifetime-'))
  const workerDirectory = join(directory, 'worker')
  const env = { ...process.env, ANYBOX_DEVELOPMENT_NODE_EXECUTABLE: process.execPath }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  delete env.ANYBOX_RUNTIME_DIRECTORY
  delete env.ANYBOX_SYSTEM_SERVICE_ROLE
  const child = spawn(require('electron'), [fileURLToPath(new URL('./helpers/windows-worker-electron.mjs', import.meta.url)), directory], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let diagnostic = ''
  const collect = chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-65536) }
  child.stdout.on('data', collect); child.stderr.on('data', collect)
  const observer = connectLocalComputerWorker({ directory: workerDirectory, autoStart: false })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill(); await exit }
    try { await observer.shutdown() }
    finally {
      await observer.closeObserver()
      await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    }
  })
  const [code] = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Electron fixture did not exit: ${diagnostic}`)), 30_000)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', (...result) => { clearTimeout(timeout); resolve(result) })
  })
  assert.equal(code, 0, diagnostic)
  const report = JSON.parse(await readFile(join(directory, 'electron-exit.json'), 'utf8'))
  assert.equal(report.mainPid, child.pid)
  assert.equal(report.utilityExitCode, 0)
  assert.equal(live(report.mainPid), false)
  assert.equal(live(report.utilityPid), false)
  // Run outside Electron after both launchers have exited, so an outer Chromium
  // Job cannot silently kill the service while a main-process assertion passes.
  await delay(500)
  assert.equal(live(report.worker.pid), true, 'the independent worker must survive Electron main exit')
  const endpoint = JSON.parse(await readFile(join(workerDirectory, 'endpoint.json'), 'utf8'))
  assert.equal(endpoint.pid, report.worker.pid)
  assert.equal(endpoint.bootId, report.worker.bootId)
  const status = await observer.status()
  assert.equal(status.state, 'running')
  assert.equal(status.pid, report.worker.pid)
  assert.equal(status.bootId, report.worker.bootId, 'verification must not restart the worker')
  assert.equal(status.workerId, report.worker.workerId)
  t.diagnostic(JSON.stringify({ mainPid: report.mainPid, utilityPid: report.utilityPid, workerPid: report.worker.pid, bootId: report.worker.bootId, survivedBothLaunchers: true }))
  await observer.shutdown()
  // The service writes its shutdown receipt before its host leaves the event
  // loop. Observe the real OS exit as well as that successful service cleanup.
  const exitDeadline = Date.now() + 5000
  while (live(report.worker.pid) && Date.now() < exitDeadline) await delay(25)
  assert.equal(live(report.worker.pid), false, 'explicit shutdown joins the independent worker')
  assert.equal((await observer.status()).state, 'stopped')
})
