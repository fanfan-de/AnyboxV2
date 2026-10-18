#!/usr/bin/env node
import { Context } from '@nya/core'
import { pathToFileURL } from 'node:url'
import { realpathSync } from 'node:fs'
import { createLocalSqliteComponent } from '@anybox/storage-sqlite/sqlite'
import { createHarnessServerAccessComponent, harnessServerAccessServiceKey } from '../server-access.js'
import type { HarnessServerAccessPort } from '../server-access.js'
import { parseHarnessServerConfig } from '../server-config.js'
import { createStandaloneHarnessServer } from '../server.js'
export { createStandaloneHarnessServer } from '../server.js'

export async function main(args: readonly string[] = process.argv.slice(2)) {
  const command = args[0] ?? 'serve'
  if (command === '--help' || command === '-h') {
    if (args.length !== 1) throw new Error('Too many harness server arguments')
    process.stdout.write('Usage: anybox-harness-server [serve | init [name] | recover-access [name] | new-identity [name]]\n')
    return
  }
  if (!['serve', 'init', 'recover-access', 'new-identity'].includes(command)) throw new Error('Use serve, init, recover-access or new-identity')
  if (args.length > (command === 'serve' ? 1 : 2)) throw new Error('Too many harness server arguments')
  const config = parseHarnessServerConfig({ ...process.env, ANYBOX_HARNESS_PORT: process.env.ANYBOX_HARNESS_PORT ?? process.env.ANYBOX_WEB_PORT ?? '3001' })
  if (['init', 'recover-access', 'new-identity'].includes(command)) {
    const root = new Context()
    try {
      await root.installComponent(createLocalSqliteComponent(config.harnessDatabasePath))
      await root.installComponent(createHarnessServerAccessComponent(process.env.ANYBOX_HARNESS_NAME))
      const access = root.get<HarnessServerAccessPort>(harnessServerAccessServiceKey)!
      if (command === 'init' && (await access.list()).length) throw new Error('Already initialized; use recover-access with the daemon stopped')
      if (command === 'new-identity') await access.resetIdentity()
      const result = await access.issue(args[1] ?? 'Owner device')
      process.stdout.write(`Instance: ${access.instance.instanceId}\nAccess token (shown once): ${result.token}\n`)
    } finally { await root.fiber.dispose() }
    return
  }
  const projects: unknown = JSON.parse(process.env.ANYBOX_PROJECTS ?? '[]')
  if (!Array.isArray(projects) || projects.some(path => typeof path !== 'string')) throw new Error('ANYBOX_PROJECTS must be a JSON array of absolute paths')
  const server = await createStandaloneHarnessServer(config, { name: process.env.ANYBOX_HARNESS_NAME, host: process.env.ANYBOX_HARNESS_BIND ?? '127.0.0.1', projects })
  process.stdout.write(`harness server: ${server.url} (${server.instance.instanceId})\n`)
  process.send?.({ type: 'ready', instanceId: server.instance.instanceId, url: server.url })
  const stop = () => { void server.close().finally(() => { if (process.connected) process.disconnect() }).catch((error: unknown) => {
    process.exitCode = 1; process.stderr.write(`harness server shutdown failed: ${error instanceof Error ? error.message : 'shutdown failure'}\n`)
  }) }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) void main().catch(error => {
  if (process.connected) process.disconnect()
  process.exitCode = 1
  process.stderr.write(`harness server could not start: ${error instanceof Error ? error.message : 'startup failure'}\n`)
})
