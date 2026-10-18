import { Context } from '@nya/core'
import { pathToFileURL } from 'node:url'
import { createLocalSqliteComponent } from '@anybox/storage-sqlite/sqlite'
import { createHostAccessComponent, hostAccessServiceKey } from '@anybox/host/access'
import type { HostAccessPort } from '@anybox/host/access'
import { parseHarnessServerConfig } from '@anybox/app-harness/server-config'
import { createHarnessServer } from '../composition/harness-server.js'
import { parseClaudeAgentConfig } from '@anybox/app-claude-agent/config'
import { claudeAgentServerApplication } from '@anybox/app-claude-agent/registration'
import { describeError } from './error-report.js'
export { createHarnessServer }

export async function main(args: readonly string[] = process.argv.slice(2)) {
  const config = parseHarnessServerConfig({ ...process.env, ANYBOX_HARNESS_PORT: process.env.ANYBOX_HARNESS_PORT ?? '3001' })
  const command = args[0] ?? 'serve'
  if (args.length > (command === 'serve' ? 1 : 2)) throw new Error('Too many harness server arguments')
  if (['init', 'recover-access', 'new-identity'].includes(command)) {
    const root = new Context()
    try {
      await root.installComponent(createLocalSqliteComponent(config.harnessDatabasePath))
      await root.installComponent(createHostAccessComponent(process.env.ANYBOX_HARNESS_NAME ?? 'harness server'))
      const access = root.get<HostAccessPort>(hostAccessServiceKey)!
      if (command === 'init' && (await access.list()).length) throw new Error('Already initialized; use recover-access with the daemon stopped')
      if (command === 'new-identity') await access.resetIdentity()
      const result = await access.issue(args[1] ?? 'Owner device')
      process.stdout.write(`Instance: ${access.instance.instanceId}\nAccess token (shown once): ${result.token}\n`)
    } finally { await root.fiber.dispose() }
    return
  }
  if (command !== 'serve') throw new Error('Use serve, init, recover-access or new-identity')
  const projects: unknown = JSON.parse(process.env.ANYBOX_PROJECTS ?? '[]')
  if (!Array.isArray(projects) || projects.some(path => typeof path !== 'string')) throw new Error('ANYBOX_PROJECTS must be a JSON array of absolute paths')
  const host = await createHarnessServer(config, { name: process.env.ANYBOX_HARNESS_NAME, host: process.env.ANYBOX_HARNESS_BIND ?? '127.0.0.1', projects,
    additionalApplications: [claudeAgentServerApplication(parseClaudeAgentConfig(process.env))] })
  process.stdout.write(`harness server: ${host.url} (${host.instance.instanceId})\n`)
  process.send?.({ type: 'ready', instanceId: host.instance.instanceId, url: host.url })
  const stop = () => { void host.close().finally(() => { if (process.connected) process.disconnect() }).catch((error: unknown) => { process.exitCode = 1; process.stderr.write(`harness server shutdown failed: ${describeError(error)}\n`) }) }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch(error => {
  if (process.connected) process.disconnect()
  process.exitCode = 1
  process.stderr.write(`harness server could not start: ${error instanceof Error ? error.message : 'startup failure'}\n`)
})
