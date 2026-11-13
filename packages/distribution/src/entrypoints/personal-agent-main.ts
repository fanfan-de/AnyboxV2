import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createClientHost } from '@anybox/host/client'
import { personalAgentApplication } from '@anybox/app-personal-agent'
import { installProcessShutdown } from './process-shutdown.js'

/** Product-validation entry: the regular Anybox shell with only Personal Agent. */
export async function main(args: readonly string[] = process.argv.slice(2)) {
  if (args.length) throw new Error('Configure Personal Agent with ANYBOX_PERSONAL_AGENT_* and ANYBOX_WEB_PORT')
  const path = process.env.ANYBOX_PERSONAL_AGENT_DATABASE ?? './data/personal-agent.sqlite'
  const modelsPath = process.env.ANYBOX_PERSONAL_AGENT_MODELS_CONFIG ?? join(dirname(resolve(path)), 'personal-agent-models.json')
  const port = Number(process.env.ANYBOX_WEB_PORT ?? 3000)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid client port')
  const host = await createClientHost({ path, port, applications: [personalAgentApplication({ databasePath: path, modelsPath })] })
  try {
    const product = await host.products.open('personal-agent')
    if (product.state !== 'running') throw new Error(product.error?.code ?? 'Personal Agent is unavailable')
    process.stdout.write(`Personal Agent: ${host.url}/#/apps/personal-agent\n`)
    process.send?.({ type: 'ready', role: 'client', url: host.url }, () => {})
    installProcessShutdown(host.close, error => process.stderr.write(`Personal Agent shutdown failed: ${error instanceof Error ? error.message : 'unknown error'}\n`))
  } catch (error) { await host.close(); throw error }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch(error => {
  if (process.connected) process.disconnect()
  process.exitCode = 1
  process.stderr.write(`Personal Agent could not start: ${error instanceof Error ? error.message : 'startup failure'}\n`)
})
