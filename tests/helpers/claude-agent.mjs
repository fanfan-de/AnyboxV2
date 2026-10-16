import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../../dist/storage/sqlite.js'
import { createClaudeAgentStoreComponent, claudeAgentStoreServiceKey } from '../../dist/applications/claude-agent/core/store/component.js'
import { claudeAgentSdkServiceKey } from '../../dist/applications/claude-agent/core/sdk/port.js'
import { createClaudeAgentRunsComponent, claudeAgentRunsServiceKey, claudeAgentRunAdmissionServiceKey } from '../../dist/applications/claude-agent/core/runs/component.js'

export const tick = () => new Promise(resolve => setImmediate(resolve))
export async function waitFor(condition, attempts = 200) {
  for (let i = 0; i < attempts; i++) { if (condition()) return; await tick() }
  throw new Error('condition not met')
}
export function clock() {
  let second = 0, id = 0
  return { now: () => new Date(Date.UTC(2026, 9, 16, 0, 0, second++)).toISOString(), newId: () => `id-${++id}` }
}
export const fakeEnvironment = Object.freeze({ schemaVersion: 1, platform: 'darwin', executable: { path: '/fake/bin/claude', source: 'path' } })
export const sampleResult = (overrides = {}) => ({ subtype: 'success', isError: false, durationMs: 1200, durationApiMs: 900, numTurns: 1, totalCostUsd: 0.01, stopReason: 'end_turn',
  usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, text: 'done', ...overrides })
/** In-memory replacement for the SDK adapter: tests drive events, results, approvals and exits explicitly. */
export function fakeSdk(options = {}) {
  const runs = []
  const port = {
    environment: () => options.environment ?? fakeEnvironment,
    openRun(request, hooks) {
      if (options.failOpen) throw options.failOpen
      let finish, exit
      const result = new Promise(resolve => { finish = resolve }), done = new Promise(resolve => { exit = resolve })
      const run = { request, hooks, interrupts: 0, closed: false, finish, exit, result, done }
      run.handle = {
        result, done,
        async interrupt() { run.interrupts++; await options.onInterrupt?.(run) },
        close() { run.closed = true; options.onClose?.(run) },
      }
      runs.push(run)
      return run.handle
    },
    async readSessionMessages(sessionId, dir, signal) { return options.history ? options.history(sessionId, dir, signal) : [] },
  }
  return { port, runs }
}
export async function createRunsFixture(path, options = {}) {
  const root = new Context()
  try {
    await root.installComponent(createLocalSqliteComponent(path))
    await root.installComponent(createClaudeAgentStoreComponent(options.store))
    const sdk = options.sdk ?? fakeSdk(options.sdkOptions)
    root.provide(claudeAgentSdkServiceKey, sdk.port)
    await root.installComponent(createClaudeAgentRunsComponent({ clock: options.clock ?? clock(), directoryExists: options.directoryExists ?? (async () => true), cancel: options.cancel, retainedViews: options.retainedViews }))
    const runs = root.get(claudeAgentRunsServiceKey)
    if (!runs) throw new Error('claude-agent.runs did not become active')
    return { root, sdk, runs, admission: root.get(claudeAgentRunAdmissionServiceKey), store: root.get(claudeAgentStoreServiceKey), close: () => root.fiber.dispose() }
  } catch (error) { await root.fiber.dispose(); throw error }
}
