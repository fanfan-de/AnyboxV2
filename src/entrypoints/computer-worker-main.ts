import { pathToFileURL } from 'node:url'
import { openComputerWorker } from '../applications/harness/core/computer/worker-server.js'

export async function main(): Promise<void> {
  const directory = process.argv[2]
  if (!directory) throw new Error('computer worker directory is required')
  const worker = await openComputerWorker(directory)
  const stop = () => { void worker.close().catch(() => { process.exitCode = 1 }) }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  process.send?.({ type: 'ready', ...worker.endpoint, token: undefined })
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch(error => {
  process.exitCode = 1
  process.stderr.write(`computer worker could not start: ${error instanceof Error ? error.message : 'startup failure'}\n`)
})
