/** Explicit cleanup of a stopped, isolated desktop smoke's remaining pairing credentials. */
import { createHash } from 'node:crypto'
import { access, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createClientHost } from '../dist/entrypoints/client-main.js'
import { connectLocalComputerWorker } from '../dist/applications/harness/core/computer/worker-client.js'

const directory = resolve(process.argv[2] ?? '')
if (!process.argv[2] || !/desktop-smoke[-\\/]/.test(directory)) throw new Error('Pass an isolated desktop-smoke directory')
await access(join(directory, 'smoke-report.json'))
const namespace = `anybox.desktop.smoke.${createHash('sha256').update(directory).digest('hex').slice(0, 24)}.client`
// Opening the same DB fails if the desktop still owns it. No user namespace or
// unrelated credential is enumerated; deletion uses the original connection API.
const host = await createClientHost({ path: join(directory, 'data/client.sqlite'), port: 0, namespace })
let count = 0
try {
  await host.products.open('agent')
  const connections = host.root.get('client.connections')
  for (const connection of await connections.list()) { await connections.remove(connection.id, connection.revision); count++ }
} finally { await host.close() }
const homes = [directory, ...(await readdir(directory, { withFileTypes: true })).filter(item => item.isDirectory() && item.name.startsWith('smoke-remote-')).map(item => join(directory, item.name))]
for (const home of homes) {
  const worker = connectLocalComputerWorker({ directory: join(home, 'data/harness.sqlite.computer-worker'), autoStart: false })
  try { await worker.shutdown() } finally { await worker.closeObserver() }
}
console.log(JSON.stringify({ pairingCredentialsRemoved: count, workerObserversClosed: homes.length }))
