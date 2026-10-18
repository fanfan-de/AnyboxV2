import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '@anybox/storage-sqlite/sqlite'
import type { ClaudeAgentServerConfig } from './server-config.js'
import { createClaudeAgentAccessComponent, hostAccessServiceKey } from './server-access.js'
import type { HostAccessPort } from './server-access.js'
import { createClaudeAgentRuntime } from './server-runtime.js'
import type { ClaudeAgentServerOptions } from './server-runtime.js'
import { claudeAgentListenerServiceKey, createClaudeAgentListenerComponent } from './server-http.js'
import type { ClaudeAgentHttpServer } from './server-http.js'

/** Standalone business server. Anybox integrations reuse the business assembly in their existing root. */
export async function createClaudeAgentServer(config: ClaudeAgentServerConfig, options: ClaudeAgentServerOptions = {}) {
  const root = new Context(), runtime = createClaudeAgentRuntime(root, config, options)
  let web: ClaudeAgentHttpServer | undefined, preparing: Promise<void> | undefined, closing: Promise<void> | undefined, draining: Promise<void> | undefined
  let admissionClosed = false
  const prepareClose = () => {
    if (preparing) return preparing
    admissionClosed = true
    const errors: unknown[] = []
    try { runtime.closeAdmission() } catch (error) { errors.push(error) }
    // Accepted Runs retain HTTP tasks until actual SDK exit. Begin draining now, then cancel Runs during root disposal.
    try { draining = root.get<ClaudeAgentHttpServer>(claudeAgentListenerServiceKey)?.close() } catch (error) { errors.push(error) }
    void draining?.catch(() => {})
    return preparing = runtime.awaitIdle().then(() => { if (errors.length) throw new AggregateError(errors, 'Claude Agent admission shutdown failed') })
  }
  const close = () => closing ??= (async () => {
    const errors: unknown[] = []
    try { await prepareClose() } catch (error) { errors.push(error) }
    const results = await Promise.allSettled([root.fiber.dispose(), draining])
    errors.push(...results.flatMap(result => result.status === 'rejected' ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, 'Claude Agent shutdown failed')
  })()
  try {
    await root.installComponent(createLocalSqliteComponent(config.databasePath))
    await root.installComponent(createClaudeAgentAccessComponent(config.name))
    const access = root.get<HostAccessPort>(hostAccessServiceKey)!
    // Nya disposes business resources before the listener's retained tasks, preventing a Run/drain wait cycle.
    await root.installComponent(createClaudeAgentListenerComponent(root, { port: config.port, host: config.host }))
    web = root.get<ClaudeAgentHttpServer>(claudeAgentListenerServiceKey)!
    await runtime.open()
    return { root, ready: Promise.resolve(), get url() { return root.get<ClaudeAgentHttpServer>(claudeAgentListenerServiceKey)?.url ?? web!.url },
      get instance() { return root.get<HostAccessPort>(hostAccessServiceKey)?.instance ?? access.instance }, get closing() { return admissionClosed }, prepareClose, close }
  } catch (error) {
    try { await close() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Claude Agent startup and cleanup failed') }
    throw error
  }
}
