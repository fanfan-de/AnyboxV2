import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Pause the real detached worker before it can open its ledger or publish an endpoint.
// Management processes also inherit NODE_OPTIONS, but only this entry owns the gate.
if (process.env.ANYBOX_TEST_WORKER_STARTUP_GATE && process.argv[1]?.replaceAll('\\', '/')?.endsWith('/computer-worker-main.js')) {
  const directory = process.env.ANYBOX_TEST_WORKER_STARTUP_GATE
  await writeFile(join(directory, `${process.pid}.ready`), '')
  for (;;) {
    try { await access(join(directory, 'release')); break }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
