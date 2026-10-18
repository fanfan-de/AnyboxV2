#!/usr/bin/env node
import { Context } from '@nya/core'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createLocalSqliteComponent } from '@anybox/storage-sqlite/sqlite'
import { createClaudeAgentAccessComponent, hostAccessServiceKey } from './server-access.js'
import type { HostAccessPort } from './server-access.js'
import { parseClaudeAgentServerConfig } from './server-config.js'
import { createClaudeAgentServer } from './server.js'

export async function main(args: readonly string[] = process.argv.slice(2)) {
  const command = args[0] ?? 'serve'
  if (command === '--help' || command === '-h') {
    if (args.length !== 1) throw new Error('Too many Claude Agent arguments')
    process.stdout.write('Usage: anybox-claude-agent [serve | init [name] | recover-access [name] | new-identity [name]]\n')
    return
  }
  if (!['serve', 'init', 'recover-access', 'new-identity'].includes(command)) throw new Error('Use serve, init, recover-access or new-identity')
  if (args.length > (command === 'serve' ? 1 : 2)) throw new Error('Too many Claude Agent arguments')
  const config = parseClaudeAgentServerConfig({ ...process.env, ANYBOX_CLAUDE_AGENT_PORT: process.env.ANYBOX_CLAUDE_AGENT_PORT ?? process.env.ANYBOX_HARNESS_PORT ?? process.env.ANYBOX_WEB_PORT ?? '3002' })
  if (['init', 'recover-access', 'new-identity'].includes(command)) {
    const root = new Context()
    try {
      await root.installComponent(createLocalSqliteComponent(config.databasePath))
      await root.installComponent(createClaudeAgentAccessComponent(config.name))
      const access = root.get<HostAccessPort>(hostAccessServiceKey)!
      if (command === 'init' && (await access.list()).length) throw new Error('Already initialized; use recover-access with the daemon stopped')
      if (command === 'new-identity') await access.resetIdentity()
      const issued = await access.issue(args[1] ?? 'Owner device')
      process.stdout.write(`Instance: ${access.instance.instanceId}\nAccess token (shown once): ${issued.token}\n`)
    } finally { await root.fiber.dispose() }
    return
  }
  const server = await createClaudeAgentServer(config)
  process.stdout.write(`Claude Agent: ${server.url} (${server.instance.instanceId})\n`)
  process.send?.({ type: 'ready', instanceId: server.instance.instanceId, url: server.url })
  const stop = () => {
    process.off('SIGINT', stop); process.off('SIGTERM', stop)
    void server.close().finally(() => { if (process.connected) process.disconnect() }).catch((error: unknown) => {
      process.exitCode = 1; process.stderr.write(`Claude Agent shutdown failed: ${error instanceof Error ? error.message : 'shutdown failure'}\n`)
    })
  }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) void main().catch(error => {
  if (process.connected) process.disconnect()
  process.exitCode = 1
  process.stderr.write(`Claude Agent could not start: ${error instanceof Error ? error.message : 'startup failure'}\n`)
})
