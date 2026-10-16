import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@nya/core'
import { createClaudeAgentSdkComponent } from '../dist/applications/claude-agent/core/sdk/adapter.js'
import { claudeAgentSdkServiceKey } from '../dist/applications/claude-agent/core/sdk/port.js'
import { createExecutionHost } from '../dist/host/execution.js'
import { createClientHost } from '../dist/entrypoints/client-main.js'
import { claudeAgentServerApplication } from '../dist/applications/claude-agent/registration.js'

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
  const info = await sdk.readSessionInfo(init.init.nativeSessionId, directory)
  assert.ok(info && typeof info.title === 'string' && info.title.length > 0, `the environment names the session: ${JSON.stringify(info)}`)
  const projects = await sdk.listSessionProjects()
  assert.ok(Array.isArray(projects) && projects.every(project => typeof project.path === 'string' && /^\d{4}-/.test(project.lastUsedAt)), 'session projects are directories with ISO times')
  const real = await realpath(directory)
  assert.ok(projects.some(project => project.path === real), `the project directory of the completed run is listed: ${real}`)

  const streamed = []
  const second = sdk.openRun({ cwd: directory, prompt: 'Without using any tools, write the numbers from 1 to 400 one per line, slowly and completely.', resume: init.init.nativeSessionId },
    { onEvent: event => streamed.push(event), canUseTool: async () => ({ behavior: 'deny', message: 'Tools are not allowed in this test.' }) })
  await until(() => streamed.some(event => event.type === 'text-delta' || event.type === 'assistant'), 180_000, 'first streamed text')
  assert.equal(streamed.find(event => event.type === 'init')?.init.nativeSessionId, init.init.nativeSessionId, 'the second run resumed the same session')
  await second.interrupt()
  assert.ok(await settles(second.result, 60_000), 'an interrupted turn still reports a result')
  assert.ok(await settles(second.done, 30_000), 'the process exits once the input ends after the interrupt')
})

test('a browser-shaped client reaches the installed claude through the client gateway and the execution host end to end', { skip, timeout: 300_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-claude-agent-e2e-')), project = join(directory, 'project'), secrets = new Map()
  await mkdir(project)
  const openEntry = (namespace, id) => { const key = `${namespace}:${id}`; return { getPassword: async () => secrets.get(key), setPassword: async value => { secrets.set(key, value) }, deleteCredential: async () => secrets.delete(key) } }
  let execution, client
  t.after(async () => { await client?.close(); await execution?.close(); await rm(directory, { recursive: true, force: true }) })
  execution = await createExecutionHost({ databasePath: join(directory, 'execution.sqlite'), applications: [claudeAgentServerApplication({})] })
  await execution.ready
  client = await createClientHost({ path: join(directory, 'client.sqlite'), openEntry, localInstanceId: execution.instance.instanceId })
  const request = async (path, body, expected = 200) => {
    const response = await fetch(client.url + path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { Origin: client.url, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const data = await response.json(); assert.equal(response.status, expected, `${path}: ${JSON.stringify(data)}`); return data
  }
  const token = await execution.root.get('host.access').issue('browser')
  const saved = await client.root.get('client.connections').save({ name: 'This Mac', endpoint: execution.url, token: token.token })
  await request('/api/client/v1/products/claude-agent/open', {})
  const device = `/api/client/v1/apps/claude-agent/connections/${saved.id}/v1`
  assert.equal((await request(device + '/products/claude-agent/open', {})).state, 'running')
  const environment = await request(device + '/apps/claude-agent/environment')
  assert.ok(environment.executable.path, JSON.stringify(environment))
  const thread = await request(device + '/apps/claude-agent/threads', { projectPath: project }, 201)
  const run = await request(device + `/apps/claude-agent/threads/${thread.id}/runs`, { prompt: 'Reply with exactly the single word pong and nothing else. Do not use any tools.', idempotencyKey: 'e2e-1' }, 202)
  let waited
  do { waited = await request(device + `/apps/claude-agent/runs/${run.id}/wait`) } while (!waited.done)
  assert.equal(waited.run.status, 'completed', JSON.stringify(waited.run))
  assert.match(waited.run.result.text, /pong/i)
  const messages = await request(device + `/apps/claude-agent/threads/${thread.id}/messages`)
  assert.equal(messages.nativeSessionId, waited.run.nativeSessionId)
  assert.ok(messages.messages.some(message => message.role === 'assistant'))
  const view = await request(device + `/apps/claude-agent/runs/${run.id}/view`)
  assert.equal(view.result.text, waited.run.result.text)
})
