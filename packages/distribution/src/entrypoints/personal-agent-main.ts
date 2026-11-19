import { pathToFileURL } from 'node:url'
import { personalAgentId } from '@anybox/app-personal-agent'
import { personalAgentServerApplication } from '@anybox/app-personal-agent/registration'
import { parsePersonalAgentServerConfig } from '@anybox/app-personal-agent/server-config'
import { createLocalWebHost } from '../composition/local-web.js'
import { describeError } from './error-report.js'
import { installProcessShutdown } from './process-shutdown.js'

/** Product-validation entry: the regular Anybox shell with only Personal Agent. */
export async function main(args: readonly string[] = process.argv.slice(2)) {
  if (args.length) throw new Error('Configure Personal Agent with ANYBOX_PERSONAL_AGENT_* and ANYBOX_WEB_PORT')
  const path = process.env.ANYBOX_PERSONAL_AGENT_DATABASE ?? './data/personal-agent.sqlite'
  const config = parsePersonalAgentServerConfig(process.env, path)
  const port = Number(process.env.ANYBOX_WEB_PORT ?? 3000)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid client port')
  let host: Awaited<ReturnType<typeof createLocalWebHost>> | undefined
  let stopping = false
  let startupFinished!: () => void
  const startup = new Promise<void>(resolve => { startupFinished = resolve })
  installProcessShutdown(async () => { stopping = true; await startup; await host?.close() },
    error => process.stderr.write(`Personal Agent shutdown failed: ${describeError(error)}\n`))
  try {
    host = await createLocalWebHost({ client: { path, port, personalAgentOnly: true, personalAgent: { computer: { directory: `${config.harnessDatabasePath}.computer-worker` } } },
      execution: { config: { ...config, harnessDatabasePath: `${path}.execution-host.sqlite` }, options: {
        applications: [personalAgentServerApplication(config)], name: '本机 Personal Agent', host: '127.0.0.1',
      } }, onExecutionError(error) { throw error } })
    if (stopping) return
    const execution = await host.execution?.products.open(personalAgentId)
    if (execution?.state !== 'running') throw new Error(execution?.error?.code ?? 'Personal Agent execution is unavailable')
    const client = await host.client.products.open(personalAgentId)
    if (client.state !== 'running') throw new Error(client.error?.code ?? 'Personal Agent client is unavailable')
    if (stopping) return
    process.stdout.write(`Personal Agent: ${host.url}/#/apps/${personalAgentId}\n`)
    process.send?.({ type: 'ready', role: 'local', url: host.url, executionUrl: host.execution?.url, pid: process.pid }, () => {})
  } catch (error) { await host?.close(); throw error }
  finally { startupFinished() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch(error => {
  if (process.connected) process.disconnect()
  process.exitCode = 1
  process.stderr.write(`Personal Agent could not start: ${error instanceof Error ? error.message : 'startup failure'}\n`)
})
