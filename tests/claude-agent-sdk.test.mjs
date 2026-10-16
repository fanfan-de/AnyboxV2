import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@nya/core'
import { createClaudeAgentSdkComponent } from '../dist/applications/claude-agent/core/sdk/adapter.js'
import { claudeAgentSdkServiceKey } from '../dist/applications/claude-agent/core/sdk/port.js'

/**
 * Exercises the user's own installed and logged-in `claude` executable through the real SDK adapter.
 * Opt in with ANYBOX_CLAUDE_AGENT_TESTS=1; a skip here is not an acceptance of the adapter.
 */
const enabled = process.env.ANYBOX_CLAUDE_AGENT_TESTS === '1'
const skip = enabled ? false : 'set ANYBOX_CLAUDE_AGENT_TESTS=1 on a machine where `claude` is installed and logged in'
const until = async (condition, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs
  while (!condition()) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`); await new Promise(resolve => setTimeout(resolve, 100)) }
}
const settles = (promise, ms) => Promise.race([promise.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), ms))])

test('the installed claude executable completes a turn, pins a resumable session, streams events and exits before done settles', { skip, timeout: 300_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-claude-agent-real-'))
  const root = new Context()
  t.after(async () => { await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  await root.installComponent(createClaudeAgentSdkComponent())
  const sdk = root.get(claudeAgentSdkServiceKey)
  const environment = sdk.environment()
  assert.ok(environment.executable.path, JSON.stringify(environment))
  const events = []
  const handle = sdk.openRun({ cwd: directory, prompt: 'Reply with exactly the single word pong and nothing else. Do not use any tools.', resume: null },
    { onEvent: event => events.push(event), canUseTool: async () => ({ behavior: 'deny', message: 'Tools are not allowed in this test.' }) })
  const outcome = await handle.result
  assert.equal(outcome.kind, 'result', JSON.stringify(outcome))
  assert.equal(outcome.result.isError, false, JSON.stringify(outcome.result))
  assert.match(outcome.result.text, /pong/i)
  const init = events.find(event => event.type === 'init')
  assert.ok(init?.init.nativeSessionId, 'init carries the native session id')
  assert.ok(events.some(event => event.type === 'assistant'), 'completed assistant blocks are translated')
  assert.ok(events.some(event => event.type === 'result'))
  await handle.done
  assert.ok(events.some(event => event.type === 'exit'), 'the owned process exit is observed')
  const history = await sdk.readSessionMessages(init.init.nativeSessionId, directory)
  assert.ok(history.some(message => message.role === 'user'), 'the prompt is in the transcript')
  assert.ok(history.some(message => message.role === 'assistant' && message.blocks.some(block => block.kind === 'text' && /pong/i.test(block.text))), 'the reply is in the transcript')

  const streamed = []
  const second = sdk.openRun({ cwd: directory, prompt: 'Without using any tools, write the numbers from 1 to 400 one per line, slowly and completely.', resume: init.init.nativeSessionId },
    { onEvent: event => streamed.push(event), canUseTool: async () => ({ behavior: 'deny', message: 'Tools are not allowed in this test.' }) })
  await until(() => streamed.some(event => event.type === 'text-delta' || event.type === 'assistant'), 180_000, 'first streamed text')
  assert.equal(streamed.find(event => event.type === 'init')?.init.nativeSessionId, init.init.nativeSessionId, 'the second run resumed the same session')
  await second.interrupt()
  assert.ok(await settles(second.result, 60_000), 'an interrupted turn still reports a result')
  assert.ok(await settles(second.done, 30_000), 'the process exits once the input ends after the interrupt')
})
