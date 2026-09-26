import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { createHarness } from '../dist/harness.js'
import { LLMFailure } from '../dist/llm/port.js'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { createWebFrontendComponent, webFrontendServiceKey } from '../dist/web/component.js'
import { createDirectoryPickerComponent } from '../dist/web/directory-picker.js'
import { controlledLLM, deferred } from './helpers/controlled-llm.mjs'
import { promptServiceKey } from '../dist/prompt/component.js'
import { createApiKeyServiceComponent } from '../dist/credentials/settings.js'
import { deepSeekCredentialId } from '../dist/llm/deepseek-chat-completions/component.js'

const videoCredentialId = 'video/example/default'
const managed = [
  { id: deepSeekCredentialId, label: 'DeepSeek Chat', category: '大语言模型' },
  { id: videoCredentialId, label: 'Video API', category: '视频模型' },
]
const credentialPath = id => `/credentials/${encodeURIComponent(id)}`

async function fixture(directory, pickerOptions = {}) {
  const root = new Context()
  const llm = controlledLLM()
  const secrets = new Map()
  try {
    const keyFiber = root.installComponent(createApiKeyServiceComponent({ namespace: 'web-test', definitions: managed, openEntry(_namespace, id) {
      return {
        async getPassword() { return secrets.get(id) },
        async setPassword(secret) { secrets.set(id, secret) },
        async deleteCredential() { return secrets.delete(id) },
      }
    } }))
    await keyFiber
    const apiFiber = root.installComponent(llm.component())
    await apiFiber
    await root.installComponent(createLocalSqliteComponent(join(directory, 'harness.sqlite')))
    const harness = await createHarness(root, {
      agents: [{ id: 'assistant', modelProfileId: 'default', instructions: 'Private instructions.' }],
    })
    const project = await harness.openProject(directory)
    const pickerFiber = root.installComponent(createDirectoryPickerComponent({
      platform: 'darwin', runDialog: async () => undefined, ...pickerOptions,
    }))
    await pickerFiber
    const webFiber = root.installComponent(createWebFrontendComponent(harness.listAgents()))
    await webFiber
    const web = root.get(webFrontendServiceKey)
    assert.ok(web)
    return { root, keyFiber, apiFiber, pickerFiber, webFiber, harness, project, llm, web, secrets, close: () => harness.close() }
  } catch (error) { await root.fiber.dispose(); throw error }
}

async function request(web, method, path, body, origin = web.url) {
  const response = await fetch(`${web.url}/api/v1${path}`, {
    method,
    headers: method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : undefined,
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  })
  return { response, data: await response.json() }
}

async function serviceReady(root, name) {
  let ready
  const started = new Promise(resolve => { ready = resolve })
  const probe = root.inject([name], () => ready())
  await started
  await probe.dispose()
}

test('Web credential settings manage registered LLM and video keys without exposing values', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-key-'))
  const f = await fixture(directory)
  try {
    assert.deepEqual(f.keyFiber.inspect().dependencies, [])
    assert.deepEqual((await request(f.web, 'GET', '/credentials')).data, managed.map(item => ({ ...item, configured: false })))
    const saved = await request(f.web, 'POST', credentialPath(deepSeekCredentialId), { key: 'sk-private-value' })
    assert.deepEqual(saved.data, { ...managed[0], configured: true })
    assert.equal(f.secrets.get(deepSeekCredentialId), 'sk-private-value')
    const video = await request(f.web, 'POST', credentialPath(videoCredentialId), { key: 'video-private-value' })
    assert.deepEqual(video.data, { ...managed[1], configured: true })
    assert.equal(f.secrets.get(videoCredentialId), 'video-private-value')
    assert.deepEqual((await request(f.web, 'GET', '/credentials')).data, managed.map(item => ({ ...item, configured: true })))
    assert.equal(f.root.get(webFrontendServiceKey), f.web)
    assert.equal((await request(f.web, 'POST', credentialPath(videoCredentialId), { key: '' })).response.status, 400)
    assert.equal((await request(f.web, 'POST', credentialPath(videoCredentialId), { key: 'different', id: 'other' })).response.status, 400)
    assert.equal((await request(f.web, 'POST', credentialPath('other/service'), { key: 'unmanaged' })).response.status, 404)
    assert.equal(f.secrets.has('other/service'), false)
    const deleted = await request(f.web, 'POST', `${credentialPath(deepSeekCredentialId)}/delete`, {})
    assert.deepEqual(deleted.data, { ...managed[0], configured: false })
    assert.equal(f.secrets.has(deepSeekCredentialId), false)
    assert.equal(f.secrets.get(videoCredentialId), 'video-private-value')
    for (const data of [saved.data, video.data, deleted.data]) assert.doesNotMatch(JSON.stringify(data), /private-value/)
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('Web edits, publishes and binds Prompt versions while accepted Runs keep their snapshots', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-prompts-'))
  let f = await fixture(directory)
  try {
    const defaults = await request(f.web, 'GET', '/agents/assistant/prompts')
    assert.equal(defaults.data[0].content, 'Private instructions.')
    assert.deepEqual((await request(f.web, 'GET', '/prompts')).data, [])
    const created = await request(f.web, 'POST', '/prompts', {
      name: 'Assistant instructions', description: 'Shared across projects',
      kind: 'agent-instruction', role: 'system', content: 'First instruction.',
    })
    assert.equal(created.response.status, 200)
    const id = created.data.id
    assert.equal(created.data.draft.revision, 1)
    assert.equal(created.data.ownerId, undefined)
    const published = await request(f.web, 'POST', `/prompts/${id}/publish`, { expectedRevision: 1 })
    assert.equal(published.response.status, 200)
    const v1 = published.data.id
    assert.equal((await request(f.web, 'POST', '/agents/assistant/prompts', { versionId: v1 })).response.status, 200)
    const session = await f.harness.createSession(f.project.id, 'assistant')
    const first = await request(f.web, 'POST', `/sessions/${session.id}/runs`, { parentNodeId: null, input: 'First', idempotencyKey: 'one' })
    assert.equal(f.llm.calls[0].input.messages[0].content, 'First instruction.')
    const edited = await request(f.web, 'POST', `/prompts/${id}`, { expectedRevision: 1, content: 'Second instruction.' })
    assert.equal(edited.data.draft.revision, 2)
    assert.equal((await request(f.web, 'GET', '/agents/assistant/prompts')).data[0].content, 'First instruction.')
    const v2 = (await request(f.web, 'POST', `/prompts/${id}/publish`, { expectedRevision: 2 })).data.id
    // Publication alone does not change the selected Agent version.
    assert.equal((await request(f.web, 'GET', '/agents/assistant/prompts')).data[0].versionId, v1)
    await request(f.web, 'POST', '/agents/assistant/prompts', { versionId: v2 })
    assert.equal(f.llm.calls[0].input.messages[0].content, 'First instruction.')
    f.llm.calls[0].result.resolve('First answer')
    f.llm.calls[0].done.resolve()
    await f.harness.waitRun(first.data.id)
    const second = await request(f.web, 'POST', `/sessions/${session.id}/runs`, { parentNodeId: null, input: 'Second', idempotencyKey: 'two' })
    assert.equal(f.llm.calls[1].input.messages[0].content, 'Second instruction.')
    f.llm.calls[1].result.resolve('Second answer')
    f.llm.calls[1].done.resolve()
    await f.harness.waitRun(second.data.id)
    assert.deepEqual((await request(f.web, 'GET', `/prompts/${id}/versions`)).data.map(item => item.content),
      ['First instruction.', 'Second instruction.'])
    await f.close()
    f = await fixture(directory)
    assert.equal((await request(f.web, 'GET', '/prompts')).data[0].id, id)
    assert.equal((await request(f.web, 'GET', `/prompts/${id}`)).data.draft.revision, 2)
    assert.equal((await request(f.web, 'GET', '/agents/assistant/prompts')).data[0].versionId, v2)
    // Selecting an older immutable version rolls back the binding, not the draft.
    await request(f.web, 'POST', '/agents/assistant/prompts', { versionId: v1 })
    assert.equal((await request(f.web, 'GET', '/agents/assistant/prompts')).data[0].content, 'First instruction.')
    assert.equal((await request(f.web, 'GET', `/prompts/${id}`)).data.draft.content, 'Second instruction.')
  } finally {
    for (const call of f.llm.calls) { call.result.resolve('Done'); call.done.resolve() }
    await f.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Web Prompt writes enforce host identity, origin, revisions and domain validation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-prompt-validation-'))
  const f = await fixture(directory)
  const input = { name: 'Context', kind: 'context', role: 'user', content: '文'.repeat(30_000) }
  try {
    assert.equal((await request(f.web, 'POST', '/prompts', input, 'https://example.com')).response.status, 403)
    assert.equal((await request(f.web, 'POST', '/prompts', { ...input, actorId: 'someone' })).response.status, 400)
    assert.equal((await request(f.web, 'POST', '/prompts', { ...input, role: 'system' })).response.status, 400)
    assert.equal((await request(f.web, 'POST', '/prompts', { ...input, kind: 'task-template' })).response.status, 400)
    assert.deepEqual((await request(f.web, 'GET', '/prompts')).data, [])
    // Prompt's character limit is independent of the smaller general HTTP body limit.
    const created = await request(f.web, 'POST', '/prompts', input)
    assert.equal(created.response.status, 200)
    assert.equal(created.data.draft.content, input.content)
    const id = created.data.id
    assert.equal((await request(f.web, 'POST', `/prompts/${id}`, { content: 'No revision' })).response.status, 400)
    const edits = await Promise.all(['a', 'b'].map(content => request(f.web, 'POST', `/prompts/${id}`, { expectedRevision: 1, content })))
    assert.deepEqual(edits.map(item => item.response.status).sort(), [200, 409])
    assert.equal(edits.find(item => item.response.status === 409).data.error.code, 'prompt-conflict')
    assert.equal((await request(f.web, 'POST', `/prompts/${id}/publish`, { expectedRevision: 1 })).data.error.code, 'prompt-conflict')
    assert.deepEqual((await request(f.web, 'GET', `/prompts/${id}/versions`)).data, [])
    assert.equal((await request(f.web, 'POST', `/prompts/${id}/publish`, { expectedRevision: 2 })).response.status, 200)
    assert.equal((await request(f.web, 'POST', `/prompts/${id}/publish`, { expectedRevision: 2 })).data.error.code, 'prompt-publication-conflict')
    assert.equal((await request(f.web, 'GET', '/prompts/missing')).response.status, 404)
    assert.equal((await request(f.web, 'GET', '/agents/missing/prompts')).response.status, 404)
    const foreign = await f.harness.createPrompt('another-owner', { ...input, content: 'Private other user content' })
    const foreignVersion = await f.harness.publishPrompt('another-owner', foreign.id)
    for (const suffix of ['', '/versions']) {
      const denied = await request(f.web, 'GET', `/prompts/${foreign.id}${suffix}`)
      assert.equal(denied.response.status, 403)
      assert.doesNotMatch(JSON.stringify(denied.data), /Private other user content/)
    }
    assert.equal((await request(f.web, 'POST', '/agents/assistant/prompts', { versionId: foreignVersion.id })).response.status, 403)
    assert.equal((await request(f.web, 'GET', '/prompts')).data.length, 1)
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('Web shutdown joins an accepted Prompt write before its dependencies close', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-prompt-close-'))
  const f = await fixture(directory)
  const entered = deferred()
  const release = deferred()
  const prompts = f.root.get(promptServiceKey)
  const original = prompts.createPrompt
  prompts.createPrompt = async (...args) => { entered.resolve(); await release.promise; return original(...args) }
  try {
    const saving = request(f.web, 'POST', '/prompts', { name: 'Held', kind: 'context', role: 'user', content: 'Keep this.' })
    await entered.promise
    let closed = false
    const closing = f.close().then(() => { closed = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(closed, false)
    release.resolve()
    assert.equal((await saving).response.status, 200)
    await closing
    const restored = await fixture(directory)
    try { assert.equal((await request(restored.web, 'GET', '/prompts')).data[0].draft.content, 'Keep this.') }
    finally { await restored.close() }
  } finally { release.resolve(); await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('Web client contract serves assets and completes one idempotent Harness Run', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-'))
  const f = await fixture(directory)
  try {
    const html = await fetch(f.web.url)
    assert.equal(html.status, 200)
    assert.match(await html.text(), /Anybox/)
    const client = await fetch(`${f.web.url}/client.js`)
    assert.equal(client.status, 200)
    const clientSource = await client.text()
    assert.match(clientSource, /\/api\/v1/)
    assert.doesNotMatch(clientSource, /@nya\/core|deepseek-chat-completions/)
    for (const asset of ['workspace-client', 'workspace-layout', 'session-client', 'session-view', 'prompt-client']) {
      const response = await fetch(`${f.web.url}/${asset}.js`)
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type'), /javascript/)
      assert.doesNotMatch(await response.text(), /from ['"]@nya\/core/)
    }
    assert.equal((await fetch(`${f.web.url}/harness.js`)).status, 404)


    const agents = await request(f.web, 'GET', '/agents')
    assert.deepEqual(agents.data, [{ id: 'assistant' }])
    assert.doesNotMatch(JSON.stringify(agents.data), /Private instructions/)
    const created = await request(f.web, 'POST', '/sessions', { projectId: f.project.id, agentId: 'assistant' })
    assert.equal(created.response.status, 200)
    const sessionId = created.data.id
    const body = { parentNodeId: null, input: 'Hello', idempotencyKey: 'send-1' }
    const first = await request(f.web, 'POST', `/sessions/${sessionId}/runs`, body)
    const replay = await request(f.web, 'POST', `/sessions/${sessionId}/runs`, body)
    assert.equal(first.response.status, 200)
    assert.equal(replay.data.id, first.data.id)
    assert.equal(f.llm.calls.length, 1)
    assert.deepEqual(Object.keys(first.data).sort(), ['createdAt', 'history', 'id', 'input', 'revision', 'sessionId', 'status', 'updatedAt'])
    assert.doesNotMatch(JSON.stringify(first.data), /Private instructions|llmSnapshot|promptVersionIds|idempotencyKey/)
    const inFlight = await request(f.web, 'GET', `/runs/${first.data.id}`)
    assert.equal(inFlight.data.status, 'running')
    f.llm.calls[0].result.resolve('Hello back')
    f.llm.calls[0].done.resolve()
    await f.harness.waitRun(first.data.id)
    const final = await request(f.web, 'GET', `/runs/${first.data.id}`)
    assert.equal(final.data.status, 'completed')
    assert.equal(final.data.output, 'Hello back')
    const session = await request(f.web, 'GET', `/sessions/${sessionId}`)
    assert.equal('turns' in session.data, false)
    const nodes = await request(f.web, 'GET', `/sessions/${sessionId}/nodes?parentNodeId=root`)
    assert.deepEqual(nodes.data.nodes.map(({input, output}) => ({input, output})), [{ input: 'Hello', output: 'Hello back' }])
  } finally {
    for (const call of f.llm.calls) call.done.resolve()
    await f.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Web serves bounded Run events for an active Bash loop and its completed history', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-events-'))
  const f = await fixture(directory)
  try {
    const created = await request(f.web, 'POST', '/sessions', { projectId: f.project.id, agentId: 'assistant' })
    const accepted = await request(f.web, 'POST', `/sessions/${created.data.id}/runs`,
      { parentNodeId: null, input: 'Inspect output', idempotencyKey: 'events' })
    assert.equal((await request(f.web, 'GET', '/runs/missing/events')).response.status, 404)
    assert.deepEqual((await request(f.web, 'GET', `/runs/${accepted.data.id}/events`)).data.map(event => event.kind),
      ['model-started'])
    f.llm.calls[0].result.resolve({ kind: 'tool-calls', calls: [{
      id: 'call-1', name: 'bash', arguments: { command: "printf '%*s' 5000 '' | tr ' ' a" },
    }] })
    f.llm.calls[0].done.resolve()
    for (let attempt = 0; attempt < 100 && f.llm.calls.length < 2; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(f.llm.calls.length, 2)
    f.llm.calls[1].result.resolve('Done')
    f.llm.calls[1].done.resolve()
    assert.equal((await f.harness.waitRun(accepted.data.id)).status, 'completed')
    const events = await request(f.web, 'GET', `/runs/${accepted.data.id}/events`)
    assert.equal(events.response.status, 200)
    assert.deepEqual(events.data.map(event => event.kind), [
      'model-started', 'model-tool-calls', 'bash-started', 'bash-observed', 'model-started', 'terminal',
    ])
    assert.equal(events.data[1].calls[0].command, "printf '%*s' 5000 '' | tr ' ' a")
    assert.equal(events.data[2].requestId, 'call-1')
    assert.equal(events.data[3].exitCode, 0)
    assert.equal(events.data[3].stdout.length, 2048)
    assert.equal(events.data[3].truncated, true)
    assert.equal(events.data[5].status, 'completed')
    assert.doesNotMatch(JSON.stringify(events.data), /Private instructions|llmSnapshot|local-key/)
  } finally {
    for (const call of f.llm.calls) call.done.resolve()
    await f.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Web host rejects cross-origin writes, maps errors, and waits for cancellation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-'))
  const f = await fixture(directory)
  try {
    const cross = await request(f.web, 'POST', '/sessions', { projectId: f.project.id, agentId: 'assistant' }, 'https://example.invalid')
    assert.equal(cross.response.status, 403)
    assert.equal(cross.data.error.code, 'forbidden-origin')
    assert.equal(cross.response.headers.get('access-control-allow-origin'), null)
    const invalid = await request(f.web, 'POST', '/sessions', { projectId: f.project.id, agentId: 'missing' })
    assert.equal(invalid.response.status, 404)
    const created = await request(f.web, 'POST', '/sessions', { projectId: f.project.id, agentId: 'assistant' })
    const path = `/sessions/${created.data.id}/runs`
    const run = await request(f.web, 'POST', path, { parentNodeId: null, input: 'Cancel me', idempotencyKey: 'one' })
    const conflict = await request(f.web, 'POST', path, { parentNodeId: null, input: 'Again', idempotencyKey: 'one' })
    assert.equal(conflict.response.status, 409)
    const cancelled = await request(f.web, 'POST', `/runs/${run.data.id}/cancel`, {})
    assert.equal(cancelled.data.status, 'cancelling')
    assert.equal(f.llm.calls[0].cancellations[0], 'user-requested')
    f.llm.calls[0].result.reject(new LLMFailure('provider-failure'))
    f.llm.calls[0].done.resolve()
    await f.harness.waitRun(run.data.id)
    const final = await request(f.web, 'GET', `/runs/${run.data.id}`)
    assert.equal(final.data.status, 'cancelled')
    const failed = await request(f.web, 'POST', path, { parentNodeId: null, input: 'Fail me', idempotencyKey: 'failure' })
    f.llm.calls[1].result.reject(new LLMFailure('provider-failure'))
    f.llm.calls[1].done.resolve()
    await f.harness.waitRun(failed.data.id)
    const failedFinal = await request(f.web, 'GET', `/runs/${failed.data.id}`)
    assert.equal(failedFinal.data.status, 'failed')
    assert.equal(failedFinal.data.errorCategory, 'provider-failure')
    assert.equal(failedFinal.data.error, 'model provider failed')
  } finally {
    for (const call of f.llm.calls) call.done.resolve()
    await f.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a fresh Web host restores persistent sessions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-'))
  let f = await fixture(directory)
  try {
    const created = await request(f.web, 'POST', '/sessions', { projectId: f.project.id, agentId: 'assistant' })
    const oldId = created.data.id
    await f.close()
    f = await fixture(directory)
    const old = await request(f.web, 'GET', `/sessions/${oldId}`)
    assert.equal(old.response.status, 200)
    assert.equal(old.data.id, oldId)
  } finally {
    await f.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Web host shutdown cancels and joins an accepted Run before releasing Harness', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-'))
  const f = await fixture(directory)
  try {
    const created = await request(f.web, 'POST', '/sessions', { projectId: f.project.id, agentId: 'assistant' })
    const accepted = await request(f.web, 'POST', `/sessions/${created.data.id}/runs`, {
      parentNodeId: null, input: 'Stay active', idempotencyKey: 'one',
    })
    assert.equal(accepted.data.status, 'running')
    let closed = false
    const shutdown = f.close().then(() => { closed = true })
    await f.llm.calls[0].cancelled.promise
    assert.equal(f.llm.calls[0].cancellations[0], 'owner-disposed')
    assert.equal(closed, false)
    f.llm.calls[0].result.reject(new LLMFailure('provider-failure'))
    f.llm.calls[0].done.resolve()
    await shutdown
    assert.equal(closed, true)
  } finally {
    for (const call of f.llm.calls) call.done.resolve()
    await f.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Nya stops and restarts the Web frontend with its Run dependency on the same port', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-'))
  const f = await fixture(directory)
  try {
    const originalUrl = f.web.url
    await f.apiFiber.dispose()
    assert.equal(f.root.get(webFrontendServiceKey), undefined)
    const replacement = controlledLLM({ version: 'v2' })
    await f.root.installComponent(replacement.component())
    await serviceReady(f.root, webFrontendServiceKey)
    const current = f.root.get(webFrontendServiceKey)
    assert.equal(current?.url, originalUrl)
    const agents = await request(current, 'GET', '/agents')
    assert.deepEqual(agents.data, [{ id: 'assistant' }])
  } finally {
    await f.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the Web frontend can be replaced without closing Harness', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-'))
  const f = await fixture(directory)
  try {
    const port = Number(new URL(f.web.url).port)
    await f.webFiber.dispose()
    assert.equal(f.root.get(webFrontendServiceKey), undefined)
    const session = await f.harness.createSession(f.project.id, 'assistant')
    assert.equal(session.agentId, 'assistant')
    await f.root.installComponent(createWebFrontendComponent(f.harness.listAgents(), port))
    const replacement = f.root.get(webFrontendServiceKey)
    assert.equal(replacement?.url, f.web.url)
    const fetched = await request(replacement, 'GET', `/sessions/${session.id}`)
    assert.equal(fetched.response.status, 200)
    assert.equal(fetched.data.id, session.id)
  } finally {
    await f.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Web project routes register directories and switching views leaves Runs active', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-projects-'))
  const secondPath = join(directory, '中文 项目')
  mkdirSync(secondPath)
  const picked = [directory, secondPath, undefined]
  const f = await fixture(directory, { runDialog: async () => picked.shift() })
  try {
    const listed = await request(f.web, 'GET', '/projects')
    assert.equal(listed.data.length, 1)
    assert.equal(listed.data[0].id, f.project.id)
    assert.deepEqual((await request(f.web, 'GET', '/projects/picker')).data, { supported: true })
    assert.equal((await request(f.web, 'POST', '/projects/pick', {}, 'https://example.invalid')).response.status, 403)
    const duplicate = await request(f.web, 'POST', '/projects/pick', {})
    assert.equal(duplicate.data.id, f.project.id)
    const added = await request(f.web, 'POST', '/projects/pick', {})
    assert.equal(added.response.status, 200)
    assert.equal(added.data.path, realpathSync(secondPath))
    const cancelled = await request(f.web, 'POST', '/projects/pick', {})
    assert.equal(cancelled.response.status, 200)
    assert.equal(cancelled.data, null)
    assert.equal((await request(f.web, 'POST', '/projects/pick', { path: secondPath })).response.status, 400)
    assert.equal((await request(f.web, 'POST', '/projects', { path: secondPath })).response.status, 404)
    const session = await request(f.web, 'POST', '/sessions', {
      projectId: f.project.id, agentId: 'assistant',
    })
    assert.equal(session.data.projectId, f.project.id)
    const run = await request(f.web, 'POST', `/sessions/${session.data.id}/runs`, {
      parentNodeId: null, input: 'Keep running', idempotencyKey: 'one',
    })
    const otherSessions = await request(f.web, 'GET', `/projects/${added.data.id}/sessions`)
    assert.deepEqual(otherSessions.data, [])
    assert.deepEqual(f.llm.calls[0].cancellations, [])
    const projectSessions = await request(f.web, 'GET', `/projects/${f.project.id}/sessions`)
    assert.equal(projectSessions.data[0].id, session.data.id)
    f.llm.calls[0].result.resolve('Still running')
    f.llm.calls[0].done.resolve()
    await f.harness.waitRun(run.data.id)
    const history = await request(f.web, 'GET', `/sessions/${session.data.id}/runs`)
    assert.equal(history.data[0].output, 'Still running')
    const unknownHistory = await request(f.web, 'GET', '/sessions/missing/runs')
    assert.equal(unknownHistory.response.status, 404)
  } finally { for (const call of f.llm.calls) call.done.resolve(); await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('native project picker maps failures and rejects concurrent selection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-picker-'))
  let started
  let finish
  const entered = new Promise(resolve => { started = resolve })
  const selection = new Promise(resolve => { finish = resolve })
  const f = await fixture(directory, { runDialog: () => { started(); return selection } })
  try {
    const pending = request(f.web, 'POST', '/projects/pick', {})
    await entered
    const busy = await request(f.web, 'POST', '/projects/pick', {})
    assert.equal(busy.response.status, 409)
    assert.deepEqual(busy.data, { error: { code: 'picker-busy' } })
    finish(undefined)
    assert.equal((await pending).data, null)
  } finally { finish(undefined); await f.close(); rmSync(directory, { recursive: true, force: true }) }

  const failedDirectory = mkdtempSync(join(tmpdir(), 'anybox-web-picker-'))
  const failed = await fixture(failedDirectory, {
    runDialog: async () => { throw new Error('private native details') },
  })
  try {
    const response = await request(failed.web, 'POST', '/projects/pick', {})
    assert.equal(response.response.status, 503)
    assert.deepEqual(response.data, { error: { code: 'picker-unavailable' } })
  } finally { await failed.close(); rmSync(failedDirectory, { recursive: true, force: true }) }
})

test('unsupported project picker leaves Web available', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-picker-'))
  const f = await fixture(directory, { platform: 'linux' })
  try {
    assert.deepEqual((await request(f.web, 'GET', '/projects/picker')).data, { supported: false })
    const selected = await request(f.web, 'POST', '/projects/pick', {})
    assert.equal(selected.response.status, 503)
    assert.deepEqual(selected.data, { error: { code: 'picker-unsupported' } })
    assert.equal((await request(f.web, 'GET', '/projects')).data.length, 1)
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('Web shutdown cancels an open picker and waits for it to exit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-picker-'))
  let started
  let aborted
  let release
  const entered = new Promise(resolve => { started = resolve })
  const cancelled = new Promise(resolve => { aborted = resolve })
  const exit = new Promise(resolve => { release = resolve })
  const f = await fixture(directory, { runDialog: async signal => {
    started()
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    aborted()
    await exit
    return undefined
  } })
  try {
    const pending = request(f.web, 'POST', '/projects/pick', {})
    await entered
    let closed = false
    const closing = f.close().then(() => { closed = true })
    await cancelled
    assert.equal(closed, false)
    release()
    await closing
    const response = await pending
    assert.equal(response.response.status, 503)
  } finally { release(); await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('disconnecting a picker request cancels the host dialog without adding a project', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-picker-'))
  let started
  let aborted
  const entered = new Promise(resolve => { started = resolve })
  const cancelled = new Promise(resolve => { aborted = resolve })
  const f = await fixture(directory, { runDialog: signal => new Promise(resolve => {
    started()
    signal.addEventListener('abort', () => { aborted(); resolve(directory) }, { once: true })
  }) })
  try {
    const controller = new AbortController()
    const pending = fetch(`${f.web.url}/api/v1/projects/pick`, {
      method: 'POST', headers: { Origin: f.web.url, 'Content-Type': 'application/json' },
      body: '{}', signal: controller.signal,
    })
    await entered
    controller.abort()
    await assert.rejects(pending, { name: 'AbortError' })
    await cancelled
    assert.equal((await request(f.web, 'GET', '/projects')).data.length, 1)
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('tree HTTP contract requires ancestry, supports sibling attempts and restores accepted keys read-only', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-tree-'))
  const f = await fixture(directory)
  try {
    const session = await f.harness.createSession(f.project.id, 'assistant')
    const path = `/sessions/${session.id}`
    const submit = body => request(f.web, 'POST', `${path}/runs`, body)
    assert.equal((await submit({ input: 'Missing parent', idempotencyKey: 'bad' })).response.status, 400)
    assert.deepEqual((await request(f.web, 'GET', `${path}/runs`)).data, [])
    const input = { parentNodeId: null, input: 'Root', idempotencyKey: 'root/key' }
    const [a, retry, b] = await Promise.all([submit(input), submit(input), submit({ ...input, idempotencyKey: 'other' })])
    assert.equal(a.data.id, retry.data.id)
    assert.notEqual(a.data.id, b.data.id)
    assert.equal(f.llm.calls.length, 2)
    assert.equal((await request(f.web, 'GET', `${path}/runs?status=active&parentNodeId=root`)).data.length, 2)
    const recovered = (await request(f.web, 'GET', `${path}/runs/by-key/root%2Fkey`)).data
    assert.equal(recovered.id, a.data.id)
    assert.deepEqual(recovered.history, { kind: 'tree', parentNodeId: null })
    assert.equal(typeof recovered.revision, 'number')
    assert.equal((await request(f.web, 'GET', `${path}/runs/by-key/missing`)).response.status, 404)
    assert.equal(f.llm.calls.length, 2)
    assert.deepEqual((await request(f.web, 'GET', `${path}/nodes?parentNodeId=root`)).data.nodes, [])
    for (const [i, call] of f.llm.calls.entries()) { call.result.resolve(`Answer ${i}`); call.done.resolve() }
    await Promise.all([f.harness.waitRun(a.data.id), f.harness.waitRun(b.data.id)])
    const page = (await request(f.web, 'GET', `${path}/nodes?parentNodeId=root&limit=1`)).data
    assert.equal(page.nodes.length, 1)
    assert.ok(page.nextCursor)
    const rest = (await request(f.web, 'GET', `${path}/nodes?parentNodeId=root&limit=1&cursor=${encodeURIComponent(page.nextCursor)}`)).data
    assert.equal(rest.nodes.length, 1)
    assert.equal(rest.nextCursor, undefined)
    assert.notEqual(rest.nodes[0].id, page.nodes[0].id)
    const node = page.nodes[0]
    assert.deepEqual((await request(f.web, 'GET', `${path}/nodes/${node.id}`)).data, node)
    assert.deepEqual((await request(f.web, 'GET', `${path}/nodes/${node.id}/path`)).data, [node])
    assert.deepEqual((await request(f.web, 'GET', `${path}/nodes/root/path`)).data, [])
    assert.equal((await submit({ ...input, parentNodeId: node.id })).response.status, 409)
    assert.equal((await submit({ ...input, input: 'Changed' })).response.status, 409)
    const continued = await submit({ parentNodeId: node.id, input: 'Continue', idempotencyKey: 'child' })
    assert.equal(continued.response.status, 200)
    assert.equal((await request(f.web, 'GET', `${path}/runs?status=active&parentNodeId=${node.id}`)).data.length, 1)
    const events = (await request(f.web, 'GET', `/runs/${continued.data.id}/events?afterSeq=0`)).data
    assert.deepEqual(events.map(e => e.kind), ['model-started'])
    f.llm.calls[2].result.resolve('Child answer')
    f.llm.calls[2].done.resolve()
    const done = await f.harness.waitRun(continued.data.id)
    assert.deepEqual((await request(f.web, 'GET', `/runs/${done.id}/events?afterSeq=${events[0].seq}`)).data.map(e => e.kind), ['terminal'])
    assert.equal((await request(f.web, 'GET', `${path}/nodes/${done.resultNodeId}/path`)).data.length, 2)
    const publicRun = (await request(f.web, 'GET', `/runs/${done.id}`)).data
    assert.equal(publicRun.resultNodeId, done.resultNodeId)
    assert.equal(publicRun.llmSnapshot, undefined)
    assert.equal(publicRun.promptVersionIds, undefined)
    assert.equal(publicRun.idempotencyKey, undefined)
    assert.doesNotMatch(JSON.stringify(publicRun), /Private instructions/)
    for (const suffix of ['/nodes', '/nodes?parentNodeId=root&limit=0', '/nodes?parentNodeId=root&limit=101', '/runs?status=bogus']) {
      assert.equal((await request(f.web, 'GET', `${path}${suffix}`)).response.status, 400)
    }
    assert.equal((await request(f.web, 'GET', `${path}/nodes/missing/path`)).response.status, 404)
    assert.equal((await request(f.web, 'GET', `/runs/${done.id}/events?afterSeq=-1`)).response.status, 400)
  } finally {
    for (const call of f.llm.calls) { call.result.resolve('Cleanup'); call.done.resolve() }
    await f.close(); rmSync(directory, { recursive: true, force: true })
  }
})

test('HTTP wait distinguishes timeout from completion and waits for actual resource exit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-wait-'))
  const f = await fixture(directory)
  try {
    const session = await f.harness.createSession(f.project.id, 'assistant')
    const run = await f.harness.startRun({ sessionId: session.id, parentNodeId: null, input: 'Wait', idempotencyKey: 'wait' })
    const waiting = `/runs/${run.id}/wait`
    const timeout = await request(f.web, 'GET', `${waiting}?timeoutMs=0`)
    assert.equal(timeout.data.done, false)
    assert.equal(timeout.data.timedOut, true)
    assert.equal(timeout.data.run.status, 'running')
    for (const ms of ['-1', '25001', '1.5', 'NaN']) assert.equal((await request(f.web, 'GET', `${waiting}?timeoutMs=${ms}`)).response.status, 400)
    f.llm.calls[0].result.resolve('Done but still exiting')
    assert.equal((await request(f.web, 'GET', `${waiting}?timeoutMs=5`)).data.done, false)
    const joined = request(f.web, 'GET', `${waiting}?timeoutMs=25000`)
    f.llm.calls[0].done.resolve()
    const terminal = (await joined).data
    assert.equal(terminal.done, true)
    assert.equal(terminal.timedOut, false)
    assert.equal(terminal.run.status, 'completed')
    assert.ok(terminal.run.resultNodeId)
    assert.deepEqual(f.llm.calls[0].cancellations, [])
  } finally {
    for (const call of f.llm.calls) { call.result.resolve('Cleanup'); call.done.resolve() }
    await f.close(); rmSync(directory, { recursive: true, force: true })
  }
})

test('disconnecting wait and closing Web release waiters without cancelling the Run', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-wait-close-'))
  const f = await fixture(directory)
  try {
    const { runServiceKey } = await import('../dist/run/component.js')
    const port = f.root.get(runServiceKey)
    const original = port.waitRun.bind(port)
    const registrations = []
    let entered = deferred()
    port.waitRun = (id, signal) => { registrations.push(signal); entered.resolve(); return original(id, signal) }
    const session = await f.harness.createSession(f.project.id, 'assistant')
    const run = await f.harness.startRun({ sessionId: session.id, parentNodeId: null, input: 'Wait', idempotencyKey: 'wait' })
    const controller = new AbortController()
    const connection = fetch(`${f.web.url}/api/v1/runs/${run.id}/wait?timeoutMs=25000`, { signal: controller.signal })
    await entered.promise
    controller.abort()
    await assert.rejects(connection, { name: 'AbortError' })
    for (let i = 0; i < 30 && !registrations[0].aborted; i++) await new Promise(resolve => setTimeout(resolve, 2))
    assert.equal(registrations[0].aborted, true)
    entered = deferred()
    const pending = request(f.web, 'GET', `/runs/${run.id}/wait?timeoutMs=25000`)
    await entered.promise
    await f.webFiber.dispose()
    assert.equal((await pending).response.status, 503)
    assert.equal(registrations[1].aborted, true)
    assert.deepEqual(f.llm.calls[0].cancellations, [])
    assert.equal((await f.harness.getRun(run.id)).status, 'running')
    f.llm.calls[0].result.resolve('Still completed')
    f.llm.calls[0].done.resolve()
    assert.equal((await f.harness.waitRun(run.id)).status, 'completed')
  } finally {
    for (const call of f.llm.calls) { call.result.resolve('Cleanup'); call.done.resolve() }
    await f.close(); rmSync(directory, { recursive: true, force: true })
  }
})
