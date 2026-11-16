#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { cliExit, cliFailure, registerApplicationClis } from '@anybox/application-api/cli'
import type { ApplicationCliRegistration } from '@anybox/application-api/cli'
import { runNodeCli } from '@anybox/application-api/cli-node'
import { harnessCliRegistration } from '@anybox/app-harness/cli/registration'

const usage = `Usage: anybox <role> [arguments]
  client                         Start only the client service
  harness-server [serve]         Start only the harness server
  harness-server init [name]     Initialize server access
  computer-worker <directory>    Start only the Computer worker
  computer-worker <command> ...  serve/start/status/attach/permissions/revoke/stop
Use --help after a role to show this help without starting services.
`

export const legacyRoles = ['client', 'harness-server', 'computer-worker'] as const
/** Explicit composition only. Installed package CLI discovery requires durable usage ownership. */
export const applicationClis = registerApplicationClis([harnessCliRegistration], legacyRoles)
const roleMetadata: readonly ApplicationCliRegistration[] = legacyRoles.map(name => ({ contractVersion: 1, appId: `anybox-role-${name}`,
  command: { name, description: `Compatibility role; run anybox ${name} --help` },
  load: async () => ({ async execute() { throw cliFailure('invalid-arguments', 'Place the compatibility role first, followed by its original arguments', cliExit.usage) } }),
}))

/** Select a role before importing its runtime or any native dependencies. */
export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const [role, ...rest] = args
  if (!legacyRoles.includes(role as typeof legacyRoles[number])) {
    const version = (createRequire(import.meta.url)('../../package.json') as { version: string }).version
    process.exitCode = await runNodeCli(args, [...roleMetadata, ...applicationClis], { version, description: `Anybox application CLI.\n\nLegacy roles:\n${usage}` })
    return
  }
  if (role !== 'computer-worker' && rest.length === 1 && ['--help', '-h'].includes(rest[0]!)) { process.stdout.write(usage); return }
  switch (role) {
    case 'client': return (await import('./client-main.js')).main(rest)
    case 'harness-server': return (await import('./harness-server-main.js')).main(rest)
    case 'computer-worker': return (await import('./computer-worker-main.js')).main(rest)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) void main().catch(error => {
  if (process.connected) process.disconnect()
  process.exitCode = 1
  process.stderr.write(`Anybox could not start: ${error instanceof Error ? error.message : 'startup failure'}\n`)
})
