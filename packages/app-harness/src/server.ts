import { homedir } from 'node:os'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '@anybox/storage-sqlite/sqlite'
import { createHarnessServerAccessComponent, harnessServerAccessServiceKey } from './server-access.js'
import type { HarnessServerAccessPort } from './server-access.js'
import { createHarnessServerRuntime } from './server-runtime.js'
import type { HarnessServerRuntimeOptions } from './server-runtime.js'
import type { HarnessServerConfig } from './server-config.js'
import { createHarnessServerApi } from './core/index.js'
import { createHarnessServerListenerComponent, harnessServerListenerServiceKey } from './http/server.js'
import type { HarnessServerListener } from './http/server.js'

export interface StandaloneHarnessServerOptions extends HarnessServerRuntimeOptions {
  readonly name?: string
  readonly host?: string
}

/** One application root and one existing business database; no Anybox host is installed. */
export async function createStandaloneHarnessServer(config: HarnessServerConfig, options: StandaloneHarnessServerOptions = {}) {
  const root = new Context()
  let closing = false, preparing: Promise<void> | undefined, shutdown: Promise<void> | undefined
  let listener: HarnessServerListener | undefined, draining: Promise<void> | undefined
  let access: HarnessServerAccessPort | undefined
  const runtime = createHarnessServerRuntime(root, config, { ...options, projectDirectoryHome: options.projectDirectoryHome ?? homedir() }, {
    http: { inject: [harnessServerAccessServiceKey], resolve: deps => {
      const current = deps[harnessServerAccessServiceKey] as HarnessServerAccessPort
      return { instanceId: () => current.instance.instanceId, onRevoked: listener => current.onRevoked(listener) }
    } },
  })
  const prepareClose = () => {
    if (preparing) return preparing
    closing = true
    const errors: unknown[] = []
    try { runtime.closeAdmission() } catch (error) { errors.push(error) }
    try { draining = root.get<HarnessServerListener>(harnessServerListenerServiceKey)?.close(); void draining?.catch(() => {}) } catch (error) { errors.push(error) }
    preparing = runtime.awaitIdle().then(() => { if (errors.length) throw new AggregateError(errors, 'harness server admission shutdown failed') })
    return preparing
  }
  const close = () => shutdown ??= (async () => {
    const errors: unknown[] = []
    try { await prepareClose() } catch (error) { errors.push(error) }
    // A response can retain an accepted Run until it exits. Start both joins together.
    const results = await Promise.allSettled([root.fiber.dispose(), draining])
    errors.push(...results.flatMap(result => result.status === 'rejected' ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, 'harness server shutdown failed')
  })()
  try {
    await root.installComponent(createLocalSqliteComponent(config.harnessDatabasePath))
    await root.installComponent(createHarnessServerAccessComponent(options.name))
    access = root.get<HarnessServerAccessPort>(harnessServerAccessServiceKey)!
    // Install transport before business resources so root LIFO cleanup cancels Runs
    // before joining retained request tasks. Business handlers resolve per request.
    await root.installComponent(createHarnessServerListenerComponent(root, { port: config.port, host: options.host }))
    listener = root.get<HarnessServerListener>(harnessServerListenerServiceKey)!
    await runtime.open()
    const api = createHarnessServerApi(root, { ...options, agents: options.agents ?? [{ id: 'assistant', instructions: 'You are a helpful assistant.' }] }, { isClosing: () => closing })
    return { root, api, get url() { return root.get<HarnessServerListener>(harnessServerListenerServiceKey)?.url ?? listener!.url },
      get access() { const current = root.get<HarnessServerAccessPort>(harnessServerAccessServiceKey); if (!current) throw new Error('harness access is unavailable'); return current },
      ready: Promise.resolve(), get instance() { return root.get<HarnessServerAccessPort>(harnessServerAccessServiceKey)?.instance ?? access!.instance }, get closing() { return closing }, prepareClose, close }
  } catch (error) {
    try { await close() } catch (cleanup) { throw new AggregateError([error, cleanup], 'harness server startup and cleanup failed') }
    throw error
  }
}
