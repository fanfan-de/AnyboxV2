#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { createClientHost } from './client.js'
import { readApplicationTrustPolicy } from './package-management/policy.js'
import type { ApplicationTrustPolicy } from './package-management/policy.js'

export interface MinimumHostOptions {
  readonly path: string
  readonly packageDirectory: string
  readonly port?: number
  readonly transportSecret?: string
  readonly packageTrustPolicy?: ApplicationTrustPolicy
}

/** The distributable host chooses no applications or optional business providers. */
export function createMinimumHost(options: MinimumHostOptions) {
  return createClientHost({ path: options.path, packageDirectory: options.packageDirectory,
    port: options.port, transportSecret: options.transportSecret, packageTrustPolicy: options.packageTrustPolicy, applications: [] })
}

const usage = `Usage: anybox-host [serve]
       anybox-host verify <folder|file> [--trust <policy>] [--trust-local]
       anybox-host install <folder|file> --directory <root> [--trust <policy>] [--trust-local] --request-id <id>
       anybox-host install <folder> --endpoint <loopback-origin> --trust-local --request-id <id>
       anybox-host installations|operations --directory <root>
       anybox-host cancel <id> --directory <root>
       anybox-host recover <id> --action inspect|resume|discard --directory <root> [--trust <policy>]
       anybox-host apply --endpoint <loopback-origin> --request-id <id> [--app <appId>]
       anybox-host uninstall <appId> --endpoint <loopback-origin> --request-id <id>
       anybox-host activation <id> --endpoint <loopback-origin> [--action inspect|resume|cancel]

serve   Start the managed lifecycle host. Configure ANYBOX_CLIENT_DATABASE,
        ANYBOX_APPLICATION_DIRECTORY, ANYBOX_APPLICATION_TRUST and ANYBOX_WEB_PORT.
        ANYBOX_HOST_ROLES selects client,execution; ANYBOX_APPLICATION_CONFIG
        passes application-owned role configuration from a local JSON file.
verify  Check a signed package or explicitly trusted local directory without installation.
install Snapshot a folder or optional ZIP; installation remains pending until apply.
        --trust-local explicitly trusts a local folder without publisher signing.
        --endpoint installs through the running manager; --directory requires an idle root.
recover Resume retains stored local trust; signed package recovery requires --trust.
apply   Activate through the running manager, preserving role/page guards and origin.
uninstall Remove installed code through the running manager; application data is preserved.
`

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { process.stdout.write(usage); return }
  if (args[0] === 'verify') {
    const { verifyCommand } = await import('./package-management/verify-command.js')
    await verifyCommand(args.slice(1))
    return
  }
  if (args[0] && ['apply', 'activation', 'uninstall'].includes(args[0])) {
    const { runPackageActivationCommand } = await import('./package-management/activation-command.js')
    process.exitCode = await runPackageActivationCommand(args)
    return
  }
  if (args[0] && ['install', 'installations', 'operations', 'cancel', 'recover'].includes(args[0])) {
    const { runPackageManagementCommand } = await import('./package-management/install-command.js')
    process.exitCode = await runPackageManagementCommand(args)
    return
  }
  if (args.length && (args.length !== 1 || args[0] !== 'serve')) throw new Error(usage)
  const path = process.env.ANYBOX_CLIENT_DATABASE ?? './data/client.sqlite'
  const port = Number(process.env.ANYBOX_WEB_PORT ?? 3000)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid client port')
  const { startManagedApplicationHost } = await import('./package-management/managed-process.js')
  const roles = (process.env.ANYBOX_HOST_ROLES ?? 'client,execution').split(',')
  if (roles.some(role => role !== 'client' && role !== 'execution')) throw new Error('Invalid host role selection')
  const host = await startManagedApplicationHost({ path, packageDirectory: process.env.ANYBOX_APPLICATION_DIRECTORY ?? `${path}.applications`, port,
    trustPolicyPath: process.env.ANYBOX_APPLICATION_TRUST, roles: roles as ('client' | 'execution')[],
    executionPath: process.env.ANYBOX_EXECUTION_DATABASE, roleConfigPath: process.env.ANYBOX_APPLICATION_CONFIG })
  const stop = () => { void host.close().finally(() => {
    if (process.connected) process.disconnect()
  }).catch(() => { process.exitCode = 1; process.stderr.write('Anybox host shutdown failed\n') }) }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  process.stdout.write(`Anybox Host: ${host.url}\n`)
  process.send?.({ type: 'ready', role: 'client', url: host.url })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(error => {
    if (process.connected) process.disconnect()
    process.exitCode = 1
    process.stderr.write(`Anybox host could not start: ${error instanceof Error ? error.message : 'startup failure'}\n`)
  })
}
