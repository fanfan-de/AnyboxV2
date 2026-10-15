import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { validateServiceConfiguration } from '../platform/services.js'

/** Join accepted startup before closing. A stop during startup never abandons its resources. */
export function managedServiceLifetime(open: () => Promise<{ close(): Promise<void> }>) {
  let stopping = false
  const started = Promise.resolve().then(open)
  let closing: Promise<void> | undefined
  return {
    started,
    get stopping() { return stopping },
    stop() { stopping = true; return closing ??= started.then(host => host.close()) },
  }
}
export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (args.length < 1 || args.length > 2 || (args[1] !== undefined && args[1] !== '--stdio-control')) throw new Error('Usage: service-runner <configuration> [--stdio-control]')
  const config = validateServiceConfiguration(JSON.parse(await readFile(args[0]!, 'utf8')))
  process.chdir(config.workingDirectory)
  Object.assign(process.env, config.environment)
  // A service manager owns this process tree. The harness must reuse an
  // independently started worker, never create one inside its own stop scope.
  process.env.ANYBOX_SYSTEM_SERVICE_ROLE = config.role
  const lifetime = managedServiceLifetime(async () => {
    switch (config.role) {
      case 'client': return (await import('./client-main.js')).openClientFromEnvironment()
      case 'harness-server': return (await import('./harness-server-main.js')).openHarnessServerFromEnvironment()
      case 'computer-worker': return (await import('../applications/harness/core/computer/worker-server.js')).openComputerWorker(config.workerDirectory!, { credentialNamespace: process.env.ANYBOX_COMPUTER_WORKER_NAMESPACE })
    }
  })
  const stop = () => {
    void lifetime.stop().then(() => {
      process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
      if (args[1]) process.stdin.destroy()
    }).catch(() => { process.exitCode = 1; process.stderr.write('Anybox service cleanup failed\n'); if (args[1]) process.stdin.destroy() })
  }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  if (args[1]) {
    let input = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (part: string) => {
      input += part
      if (input.length > 1024 || input.includes('\n')) {
        try { if (JSON.parse(input.trim()).type !== 'stop') throw new Error('invalid') } catch { process.exitCode = 1 }
        stop()
      }
    })
    process.stdin.once('end', stop)
  }
  try { await lifetime.started; if (!lifetime.stopping) process.stdout.write('ANYBOX_SERVICE_READY\n') }
  catch (error) { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); if (args[1]) process.stdin.destroy(); throw error }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch(() => {
  process.exitCode = 1; process.stderr.write('Anybox service could not start; verify configuration, account, Vault and data ownership\n')
})
