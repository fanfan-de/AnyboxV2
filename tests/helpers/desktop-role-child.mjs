import { pathToFileURL } from 'node:url'
import { register } from 'node:module'
const entry = process.argv[2]
if (entry.endsWith('desktop-client.js')) register('./role-import-guard.mjs', import.meta.url, { data: { mode: 'client', mockKeyring: true } })
process.parentPort = { postMessage: value => process.send(value), on: (_event, listener) => process.on('message', data => listener({ data })) }
process.on('disconnect', () => process.exit(1))
process.argv = [process.execPath, entry]
await import(pathToFileURL(entry).href)
