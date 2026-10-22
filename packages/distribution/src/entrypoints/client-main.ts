import { createDirectoryPickerComponent, directoryPickerCapabilityId, directoryPickerCapabilityVersion, directoryPickerServiceKey, directoryPickerSupported } from '@anybox/directory-picker'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { createClientHost as createApplicationClientHost } from '@anybox/host/client'
import { readApplicationTrustPolicy } from '@anybox/host/package-management/policy'
import type { ApplicationTrustPolicy } from '@anybox/host/package-management/policy'
import type { DirectoryPickerOptions } from '@anybox/directory-picker'
import { harnessClientApplication } from '@anybox/app-harness/client/registration'
import { claudeAgentClientApplication } from '@anybox/app-claude-agent/client/registration'
import type { ClaudeAgentClientOptions } from '@anybox/app-claude-agent/client/registration'
import type { HarnessClientRuntimeOptions } from '@anybox/app-harness/client/runtime'
import type { ApplicationRegistration } from '@anybox/application-api/nya'
import { defaultModelsConfigPath } from '@anybox/app-harness/server-config'
import { describeError } from './error-report.js'
import { installProcessShutdown } from './process-shutdown.js'
import { createLocalPairingOptions, createProcessPairingTransport } from './local-pairing.js'

export interface DefaultClientHostOptions extends HarnessClientRuntimeOptions {
  readonly applications?: readonly ApplicationRegistration[]
  readonly picker?: DirectoryPickerOptions
  readonly path: string
  readonly port?: number
  readonly transportSecret?: string
  readonly packageDirectory?: string
  readonly packageTrustPolicy?: ApplicationTrustPolicy
  readonly claudeAgent?: ClaudeAgentClientOptions
}

/** The default composition selects applications and the native adapter; each application owns its business services. */
export async function createClientHost(options: DefaultClientHostOptions) {
  return createApplicationClientHost({ path: options.path, port: options.port, transportSecret: options.transportSecret, packageDirectory: options.packageDirectory, packageTrustPolicy: options.packageTrustPolicy,
    providers: [{ id: directoryPickerCapabilityId, version: directoryPickerCapabilityVersion, services: [directoryPickerServiceKey],
      supported: directoryPickerSupported(options.picker?.platform), create: () => createDirectoryPickerComponent(options.picker) }],
    applications: options.applications ?? [
      harnessClientApplication({ localInstanceId: options.localInstanceId, computer: options.computer, namespace: options.namespace, openEntry: options.openEntry, fetch: options.fetch, localPairing: options.localPairing }),
      claudeAgentClientApplication({ localInstanceId: options.localInstanceId, namespace: options.namespace, openEntry: options.openEntry, fetch: options.fetch, ...options.claudeAgent }),
    ] })
}

export async function main(args: readonly string[] = process.argv.slice(2)) {
  if (args.length) throw new Error('The client role takes no arguments; configure it with ANYBOX_CLIENT_* and ANYBOX_WEB_PORT')
  const path = process.env.ANYBOX_CLIENT_DATABASE ?? './data/client.sqlite'
  const legacyModelsPath = process.env.ANYBOX_MODELS_DATABASE ?? './data/models.sqlite'
  const forbidden = [process.env.ANYBOX_HARNESS_DATABASE ?? './data/harness.sqlite', legacyModelsPath,
    process.env.ANYBOX_MODELS_CONFIG ?? defaultModelsConfigPath(legacyModelsPath), process.env.ANYBOX_MODELS_CATALOG_DATABASE ?? './data/models-catalog.sqlite']
  if (forbidden.some(other => resolve(other) === resolve(path))) throw new Error('Client and execution databases must be different files')
  const port = Number(process.env.ANYBOX_WEB_PORT ?? 3000)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid client port')
  const pairing = createProcessPairingTransport()
  try {
    const host = await createClientHost({ path, port, packageDirectory: process.env.ANYBOX_APPLICATION_DIRECTORY ?? `${path}.applications`,
      packageTrustPolicy: process.env.ANYBOX_APPLICATION_TRUST ? await readApplicationTrustPolicy(process.env.ANYBOX_APPLICATION_TRUST) : undefined,
      namespace: process.env.ANYBOX_CLIENT_NAMESPACE, localInstanceId: process.env.ANYBOX_LOCAL_INSTANCE_ID,
      localPairing: pairing ? createLocalPairingOptions(pairing.rpc, 'agent') : undefined,
      claudeAgent: pairing ? { localPairing: createLocalPairingOptions(pairing.rpc, 'claude-agent') } : undefined,
      computer: { directory: process.env.ANYBOX_COMPUTER_WORKER_DIRECTORY ?? `${process.env.ANYBOX_HARNESS_DATABASE ?? './data/harness.sqlite'}.computer-worker` } })
    let closing: Promise<void> | undefined
    const close = () => closing ??= (async () => {
      pairing?.rpc.disconnect()
      try { await host.close() } finally { await pairing?.close() }
    })()
    const report = (error: unknown) => { process.stderr.write(`Client shutdown failed: ${describeError(error)}\n`) }
    pairing?.onDisconnect(() => { void close().catch(error => { process.exitCode = 1; report(error) }).finally(() => { if (process.connected) process.disconnect() }) })
    if (pairing?.disconnected) { await close(); if (process.connected) process.disconnect(); return }
    process.stdout.write(`Anybox Client: ${host.url}\n`)
    process.send?.({ type: 'ready', role: 'client', url: host.url }, () => {})
    installProcessShutdown(close, report)
  } catch (error) { await pairing?.close(); throw error }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch(error => {
  if (process.connected) process.disconnect()
  process.exitCode = 1; process.stderr.write(`Client could not start: ${error instanceof Error ? error.message : 'startup failure'}\n`)
})
