import { pathToFileURL } from 'node:url'
import { main } from '@anybox/app-harness/entrypoints/computer-worker-main'
export { main, computerWorkerUsage } from '@anybox/app-harness/entrypoints/computer-worker-main'
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch(error => {
  process.exitCode = 1; process.stderr.write(`computer worker could not start: ${error instanceof Error ? error.message : 'startup failure'}\n`)
})
