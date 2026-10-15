import { readFile, writeFile } from 'node:fs/promises'
import { openComputerWorker } from '../../dist/applications/harness/core/computer/worker-server.js'

// A real Computer worker process for fault tests: the parent SIGKILLs it mid-command and starts a replacement on the same
// directory. Unit credentials live in a test-only JSON file so the replacement boot can read the attachment back; production
// workers only ever use the system credential service.
const settings = JSON.parse(process.argv[2])
const load = async () => { try { return JSON.parse(await readFile(settings.keyringFile, 'utf8')) } catch { return {} } }
const openEntry = (service, id) => {
  const key = `${service}:${id}`
  return {
    getPassword: async () => (await load())[key],
    setPassword: async value => { const map = await load(); map[key] = value; await writeFile(settings.keyringFile, JSON.stringify(map)) },
    deleteCredential: async () => { const map = await load(); const had = key in map; delete map[key]; await writeFile(settings.keyringFile, JSON.stringify(map)); return had },
  }
}
try {
  const worker = await openComputerWorker(settings.directory, { openEntry, dialout: settings.dialout })
  process.send?.({ event: 'ready', endpoint: { ...worker.endpoint, token: undefined } })
  process.on('message', async message => {
    if (message?.command !== 'shutdown') return
    try { await worker.close(); process.send?.({ event: 'closed' }) } catch (error) { process.send?.({ event: 'closed', error: { message: error.message, code: error.code } }) }
    process.disconnect()
  })
} catch (error) {
  process.send?.({ event: 'fixture-error', error: { name: error.name, message: error.message, code: error.code } })
  process.exitCode = 1
}
