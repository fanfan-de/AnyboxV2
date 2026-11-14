import { parseHarnessServerConfig } from '@anybox/app-harness/server-config'
import { parseClaudeAgentConfig } from '@anybox/app-claude-agent/config'
import { claudeAgentServerApplication } from '@anybox/app-claude-agent/registration'
import { readApplicationTrustPolicy } from '@anybox/host/package-management/policy'
import { createLocalWebHost } from '../composition/local-web.js'
import { installProcessShutdown } from './process-shutdown.js'
import { describeError } from './error-report.js'

let host: Awaited<ReturnType<typeof createLocalWebHost>> | undefined, stopping = false
let started!: () => void
const startup = new Promise<void>(resolve => { started = resolve })
// Register before any asynchronous startup so a stop cannot be lost while opening storage.
installProcessShutdown(async () => { stopping = true; await startup; await host?.close() },
  error => process.stderr.write(`Anybox Web shutdown failed: ${describeError(error)}\n`))

async function main() {
  try {
    let config: ReturnType<typeof parseHarnessServerConfig> | undefined
    try { config = parseHarnessServerConfig({ ...process.env, ANYBOX_HARNESS_PORT: process.env.ANYBOX_HARNESS_PORT ?? '3001' }) }
    catch (error) { process.stderr.write(`harness server could not start: ${describeError(error)}\n`) }
    const path = process.env.ANYBOX_CLIENT_DATABASE ?? './data/client.sqlite'
    const port = Number(process.env.ANYBOX_WEB_PORT ?? 3000)
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid client port')
    const projects: unknown = JSON.parse(process.env.ANYBOX_PROJECTS ?? '[]')
    if (!Array.isArray(projects) || projects.some(path => typeof path !== 'string')) throw new Error('ANYBOX_PROJECTS must be a JSON array of absolute paths')
    host = await createLocalWebHost({ onExecutionError: error => process.stderr.write(`harness server could not start: ${describeError(error)}\n`), client: { path, port,
      packageDirectory: process.env.ANYBOX_APPLICATION_DIRECTORY ?? `${path}.applications`,
      packageTrustPolicy: process.env.ANYBOX_APPLICATION_TRUST ? await readApplicationTrustPolicy(process.env.ANYBOX_APPLICATION_TRUST) : undefined,
      namespace: process.env.ANYBOX_CLIENT_NAMESPACE,
      computer: { directory: process.env.ANYBOX_COMPUTER_WORKER_DIRECTORY ?? `${config?.harnessDatabasePath ?? './data/harness.sqlite'}.computer-worker` } },
      ...(config ? { execution: { config, options: { name: process.env.ANYBOX_HARNESS_NAME,
        host: process.env.ANYBOX_HARNESS_BIND ?? '127.0.0.1', projects,
        additionalApplications: [claudeAgentServerApplication(parseClaudeAgentConfig(process.env))] } } } : {}),
    })
    if (stopping) { await host.close(); return }
    if (host.execution) process.stdout.write(`harness server: ${host.execution.url} (${host.execution.instance.instanceId})\n`)
    process.stdout.write(`Anybox Client: ${host.url}\n`)
    process.send?.({ type: 'ready', role: 'local', url: host.url, executionUrl: host.execution?.url, pid: process.pid }, () => {})
  } finally { started() }
}
void main().catch(error => {
  process.exitCode = 1
  process.stderr.write(`Anybox Web could not start: ${describeError(error)}\n`)
  if (process.connected) process.disconnect()
})
