import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { createHarness } from '../dist/harness.js'
import { LLMFailure } from '../dist/llm/port.js'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { createWebFrontendComponent, webFrontendServiceKey } from '../dist/web/component.js'
import { controlledLLM } from './helpers/controlled-llm.mjs'
import { createApiKeyServiceComponent } from '../dist/credentials/settings.js'
import { deepSeekCredentialId } from '../dist/llm/deepseek-chat-completions/component.js'

const videoCredentialId = 'video/example/default'
const managed = [
  { id: deepSeekCredentialId, label: 'DeepSeek Chat', category: '大语言模型' },
  { id: videoCredentialId, label: 'Video API', category: '视频模型' },
]
const credentialPath = id => `/credentials/${encodeURIComponent(id)}`

async function fixture(directory) {
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
    const webFiber = root.installComponent(createWebFrontendComponent())
    await webFiber
    const web = root.get(webFrontendServiceKey)
    assert.ok(web)
    return { root, keyFiber, apiFiber, webFiber, harness, llm, web, secrets, close: () => harness.close() }
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

    const agents = await request(f.web, 'GET', '/agents')
    assert.deepEqual(agents.data, [{ id: 'assistant' }])
    assert.doesNotMatch(JSON.stringify(agents.data), /Private instructions/)
    const created = await request(f.web, 'POST', '/sessions', { agentId: 'assistant' })
    assert.equal(created.response.status, 200)
    const sessionId = created.data.id
    const body = { input: 'Hello', idempotencyKey: 'send-1' }
    const first = await request(f.web, 'POST', `/sessions/${sessionId}/runs`, body)
    const replay = await request(f.web, 'POST', `/sessions/${sessionId}/runs`, body)
    assert.equal(first.response.status, 200)
    assert.equal(replay.data.id, first.data.id)
    assert.equal(f.llm.calls.length, 1)
    assert.deepEqual(Object.keys(first.data).sort(), ['createdAt', 'id', 'input', 'sessionId', 'status', 'updatedAt'])
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
    assert.deepEqual(session.data.turns, [{ input: 'Hello', output: 'Hello back' }])
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
    const cross = await request(f.web, 'POST', '/sessions', { agentId: 'assistant' }, 'https://example.invalid')
    assert.equal(cross.response.status, 403)
    assert.equal(cross.data.error.code, 'forbidden-origin')
    assert.equal(cross.response.headers.get('access-control-allow-origin'), null)
    const invalid = await request(f.web, 'POST', '/sessions', { agentId: 'missing' })
    assert.equal(invalid.response.status, 404)
    const created = await request(f.web, 'POST', '/sessions', { agentId: 'assistant' })
    const path = `/sessions/${created.data.id}/runs`
    const run = await request(f.web, 'POST', path, { input: 'Cancel me', idempotencyKey: 'one' })
    const conflict = await request(f.web, 'POST', path, { input: 'Again', idempotencyKey: 'two' })
    assert.equal(conflict.response.status, 409)
    const cancelled = await request(f.web, 'POST', `/runs/${run.data.id}/cancel`, {})
    assert.equal(cancelled.data.status, 'cancelling')
    assert.equal(f.llm.calls[0].cancellations[0], 'user-requested')
    f.llm.calls[0].result.reject(new LLMFailure('provider-failure'))
    f.llm.calls[0].done.resolve()
    await f.harness.waitRun(run.data.id)
    const final = await request(f.web, 'GET', `/runs/${run.data.id}`)
    assert.equal(final.data.status, 'cancelled')
    const failed = await request(f.web, 'POST', path, { input: 'Fail me', idempotencyKey: 'failure' })
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

test('a fresh Web host reports old in-memory sessions as missing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-'))
  let f = await fixture(directory)
  try {
    const created = await request(f.web, 'POST', '/sessions', { agentId: 'assistant' })
    const oldId = created.data.id
    await f.close()
    f = await fixture(directory)
    const old = await request(f.web, 'GET', `/sessions/${oldId}`)
    assert.equal(old.response.status, 404)
    assert.deepEqual(old.data, { error: { code: 'not-found' } })
  } finally {
    await f.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Web host shutdown cancels and joins an accepted Run before releasing Harness', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-web-'))
  const f = await fixture(directory)
  try {
    const created = await request(f.web, 'POST', '/sessions', { agentId: 'assistant' })
    const accepted = await request(f.web, 'POST', `/sessions/${created.data.id}/runs`, {
      input: 'Stay active', idempotencyKey: 'one',
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
    const session = f.harness.createSession('assistant')
    assert.equal(session.agentId, 'assistant')
    await f.root.installComponent(createWebFrontendComponent(port))
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
