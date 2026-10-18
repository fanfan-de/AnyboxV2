// Copied into an isolated installation; imports only the selected application's public package entries.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const application = process.env.STANDALONE_APPLICATION
for (const name of ['@anybox/host', '@anybox/distribution', application === 'agent' ? '@anybox/app-claude-agent' : '@anybox/app-harness']) {
  assert.throws(() => import.meta.resolve(name), { code: 'ERR_MODULE_NOT_FOUND' })
}
const projectPath = resolve('project'); await mkdir(projectPath, { recursive: true })
let server, access
try {
  if (application === 'agent') {
    const { createStandaloneHarnessServer } = await import('@anybox/app-harness/server')
    const { parseHarnessServerConfig } = await import('@anybox/app-harness/server-config')
    const secrets = new Map()
    server = await createStandaloneHarnessServer(parseHarnessServerConfig({ ANYBOX_HARNESS_DATABASE: './business.sqlite', ANYBOX_MODELS_DATABASE: './models.sqlite' }), {
      models: { catalogAutoRefresh: false, readLegacyCredential: async () => 'isolated-fixture-key',
        openEntry(namespace, id) { const key = `${namespace}:${id}`; return {
          getPassword: async () => secrets.get(key), setPassword: async value => { secrets.set(key, value) }, deleteCredential: async () => secrets.delete(key),
        } },
        async fetch(_url, init) {
          if (String(init.body).includes('fixture-hold')) {
            if (!init.signal.aborted) await new Promise(resolve => init.signal.addEventListener('abort', resolve, { once: true }))
            await new Promise(resolve => setTimeout(resolve, 25))
            throw new DOMException('Fixture cancelled', 'AbortError')
          }
          return new Response('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Isolated answer"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
        },
      },
    })
    await server.api.setAgentTools('assistant', { toolIds: [], expectedRevision: 0 })
    access = server.access
  } else {
    const { createClaudeAgentServer } = await import('@anybox/app-claude-agent/server')
    const { parseClaudeAgentServerConfig } = await import('@anybox/app-claude-agent/server-config')
    const { hostAccessServiceKey } = await import('@anybox/app-claude-agent/server-access')
    const sdkComponent = { name: 'isolated-fixture-sdk', apply(ctx) {
      ctx.provide('claude-agent.sdk', {
        environment: () => ({ schemaVersion: 1, platform: process.platform, executable: { path: '/fixture/claude', source: 'override' } }),
        openRun(request, hooks) {
          let result, done, settled = false
          const output = new Promise(resolve => { result = resolve }), exited = new Promise(resolve => { done = resolve })
          const finish = cancelled => {
            if (settled) return; settled = true
            clearTimeout(timer)
            result(cancelled ? { kind: 'failed', error: { code: 'cancelled', message: 'Cancelled' } } : { kind: 'result', result: {
              subtype: 'success', isError: false, durationMs: 20, durationApiMs: 10, numTurns: 1, totalCostUsd: 0,
              stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, text: 'Isolated answer',
            } })
            setTimeout(done, 25)
          }
          const timer = setTimeout(() => {
            hooks.onEvent({ type: 'message-start', messageId: 'fixture-message' })
            hooks.onEvent({ type: 'block-start', messageId: 'fixture-message', index: 0, block: 'text' })
            hooks.onEvent({ type: 'text-delta', messageId: 'fixture-message', index: 0, text: 'Isolated answer' })
            if (!request.prompt.includes('fixture-hold')) finish(false)
          }, 10)
          return { result: output, done: exited, interrupt: async () => finish(true), close: () => finish(true) }
        },
        readSessionMessages: async () => [], listSessionProjects: async () => [], readSessionInfo: async () => undefined,
      })
    } }
    server = await createClaudeAgentServer(parseClaudeAgentServerConfig({ ANYBOX_HARNESS_DATABASE: './business.sqlite' }), {
      sdkComponent, runs: { cancel: { interruptTimeoutMs: 100, resultTimeoutMs: 100, exitTimeoutMs: 100 } },
    })
    access = server.root.get(hostAccessServiceKey)
  }
  assert.equal(server.root.get('app.activity'), undefined)
  assert.equal(server.root.get('app.products'), undefined)
  const { token } = await access.issue('Isolated device')
  process.send({ type: 'ready', url: server.url, instanceId: server.instance.instanceId, token, projectPath })
  const stop = () => {
    process.off('SIGINT', stop); process.off('SIGTERM', stop)
    void server.close().then(() => { process.send({ type: 'closed' }); process.disconnect() }, error => { console.error(error); process.exitCode = 1; process.disconnect() })
  }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
} catch (error) {
  console.error(error); await server?.close(); process.exitCode = 1
  if (process.connected) process.disconnect()
}
