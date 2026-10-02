import { Context } from '@nya/core'
import { pathToFileURL } from 'node:url'
import { createLocalSqliteComponent } from '../storage/sqlite.js'
import { createHostAccessComponent, hostAccessServiceKey } from '../host/access.js'
import type { HostAccessPort } from '../host/access.js'
import { parseWebStartupConfig } from '../applications/harness/startup-config.js'
import { createHarnessHost } from '../applications/harness/host.js'
export { createHarnessHost }

async function main() {
  const config = parseWebStartupConfig({ ...process.env, ANYBOX_WEB_PORT: process.env.ANYBOX_HARNESS_PORT ?? '3001' })
  const command = process.argv[2] ?? 'serve'
  if (['init', 'recover-access', 'new-identity'].includes(command)) {
    const root = new Context()
    try {
      await root.installComponent(createLocalSqliteComponent(config.harnessDatabasePath))
      await root.installComponent(createHostAccessComponent(process.env.ANYBOX_HARNESS_NAME))
      const access = root.get<HostAccessPort>(hostAccessServiceKey)!
      if (command === 'init' && (await access.list()).length) throw new Error('Already initialized; use recover-access with the daemon stopped')
      if (command === 'new-identity') await access.resetIdentity()
      const result = await access.issue(process.argv[3] ?? 'Owner device')
      process.stdout.write(`Instance: ${access.instance.instanceId}\nAccess token (shown once): ${result.token}\n`)
    } finally { await root.fiber.dispose() }
    return
  }
  if (command !== 'serve') throw new Error('Use serve, init, recover-access or new-identity')
  const projects: unknown = JSON.parse(process.env.ANYBOX_PROJECTS ?? '[]')
  if (!Array.isArray(projects) || projects.some(path => typeof path !== 'string')) throw new Error('ANYBOX_PROJECTS must be a JSON array of absolute paths')
  const host = await createHarnessHost(config, { name: process.env.ANYBOX_HARNESS_NAME, host: process.env.ANYBOX_HARNESS_BIND ?? '127.0.0.1', projects })
  process.stdout.write(`Anybox Harness: ${host.url} (${host.instance.instanceId})\n`)
  process.send?.({ type: 'ready', instanceId: host.instance.instanceId, url: host.url })
  const stop = () => { void host.close().finally(() => { if (process.connected) process.disconnect() }).catch(() => { process.exitCode = 1; process.stderr.write('Harness shutdown failed\n') }) }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch(error => {
  if (process.connected) process.disconnect()
  process.exitCode = 1
  process.stderr.write(`Harness could not start: ${error instanceof Error ? error.message : 'startup failure'}\n`)
})
