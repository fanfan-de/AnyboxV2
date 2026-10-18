import fs from 'node:fs/promises'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'

const [mode, directory] = process.argv.slice(2)
if (mode === 'lock') {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(directory, 'startup.sqlite'))
  db.exec('BEGIN EXCLUSIVE')
  process.on('message', () => {})
  process.send({ type: 'locked' })
  // A SIGKILL must release this lock without a cleanup handler or a stale-lock deletion.
  await new Promise(() => {})
} else {
  const readFile = fs.readFile, open = fs.open, spawn = childProcess.spawn
  let firstRead = true
  fs.readFile = async (path, ...args) => {
    if (firstRead && path === join(directory, 'endpoint.json')) {
      firstRead = false
      process.send({ type: 'reading' })
      await new Promise(resolve => process.once('message', resolve))
    }
    return readFile(path, ...args)
  }
  fs.open = async (path, ...args) => {
    if (path === join(directory, 'startup.sqlite')) process.send({ type: 'coordinating' })
    return open(path, ...args)
  }
  childProcess.spawn = (...args) => {
    const child = spawn(...args)
    process.send({ type: 'spawned', pid: child.pid })
    return child
  }
  syncBuiltinESMExports()
  try {
    if (mode === 'cli') {
      const { main } = await import('../../packages/distribution/dist/entrypoints/computer-worker-main.js')
      await main(['start', directory])
    } else {
      const { connectLocalComputerWorker } = await import('../../packages/app-harness/dist/core/computer/worker-client.js')
      const client = connectLocalComputerWorker({ directory, autoStart: false, startupTimeoutMs: 10_000 })
      try { await client.start(); process.stdout.write(JSON.stringify(await client.status())) }
      finally { await client.closeObserver() }
    }
  } catch (error) { process.stderr.write(`${error.code ?? error.message}\n`); process.exitCode = 1 }
  finally { process.disconnect() }
}
