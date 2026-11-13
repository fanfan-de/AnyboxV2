import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createClientHost } from '@anybox/host/client'
import { personalAgentApplication } from '../dist/registration.js'

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-personal-api-')), values = new Map(), calls = []
  const modelsPath = join(directory, 'models.json'), path = join(directory, 'client.sqlite')
  const host = await createClientHost({ path, applications: [personalAgentApplication({
    databasePath: path, modelsPath,
    openEntry: (namespace, key) => ({
      getPassword: async () => values.get(`${namespace}:${key}`),
      setPassword: async value => { values.set(`${namespace}:${key}`, value) },
      deleteCredential: async () => { values.delete(`${namespace}:${key}`) },
    }),
    fetch: async (_url, init) => {
      calls.push({ body: JSON.parse(init.body), headers: new Headers(init.headers) })
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '可以验证的成果：第一步明确目标。' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } })
    }, ...options,
  })] })
  t.after(async () => { await host.close(); await rm(directory, { recursive: true, force: true }) })
  await host.products.open('personal-agent')
  const request = async (path, body, expectedStatus = 200) => {
    const response = await fetch(`${host.url}/api/client/v1/apps/personal-agent${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { Origin: host.url, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = await response.json()
    assert.equal(response.status, expectedStatus, `${path}: ${JSON.stringify(data)}`)
    return data
  }
  const waitRun = async id => {
    for (let tries = 0; tries < 200; tries++) {
      const detail = await request(`/works/${id}`)
      if (detail.runs.length && detail.runs.every(run => run.status !== 'running')) return detail
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('Run did not finish')
  }
  return { request, waitRun, host, values, calls, modelsPath }
}

test('real host API configures private Models, performs work and preserves explicit facts', async t => {
  const { request, waitRun, values, calls, modelsPath } = await fixture(t)
  const initial = await request('/state')
  assert.equal(initial.agents.length, 1)
  assert.equal((await request('/models')).models.length, 0)
  const choices = await request('/models', { name: '验证模型', protocolId: 'chat-completions', baseUrl: 'https://model.example/v1', remoteModelId: 'private-text-model', auth: 'api-key', apiKey: 'private-api-secret' })
  assert.equal(choices.models.length, 1)
  assert.equal(choices.models[0].available, true)
  assert.equal(choices.connections[0].credentialConfigured, true)
  assert.equal(values.size, 1)
  assert.ok([...values.keys()].every(key => key.startsWith('anybox.personal-agent.models:')))
  assert.ok(!JSON.stringify(choices).includes('private-api-secret'))
  assert.ok(!(await readFile(modelsPath, 'utf8')).includes('private-api-secret'))
  let agent = await request('/agents', { ...initial.agents[0], id: initial.agents[0].id, expectedRevision: 1 }, 400)
  const { id, revision, createdAt, updatedAt, ...configuration } = initial.agents[0]
  agent = await request('/agents', { ...configuration, id, expectedRevision: revision, modelId: choices.models[0].id, memory: '用户明确告知：偏好中文。', skills: '先澄清，再给建议。' })
  const task = await request('/works', { agentId: agent.id, kind: 'task', title: '验证产品', goal: '生成一个最小验证步骤' })
  const accepted = await request(`/works/${task.id}/runs`, { expectedRevision: task.revision, input: '请给出第一步' })
  assert.equal(accepted.agent.revision, agent.revision)
  assert.match(accepted.instruction, /偏好中文/)
  const detail = await waitRun(task.id)
  assert.equal(detail.work.status, 'open', 'a model reply never marks a task complete automatically')
  assert.equal(detail.runs[0].status, 'succeeded')
  assert.match(detail.runs[0].output, /明确目标/)
  assert.equal(detail.runs[0].modelRevision, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].headers.get('authorization'), 'Bearer private-api-secret')
  assert.match(JSON.stringify(calls[0].body), /最小验证步骤/)
  const artifact = await request(`/works/${task.id}/artifacts`, { title: '验证成果', content: detail.runs[0].output, runId: accepted.id })
  assert.equal(artifact.runId, accepted.id)
  const { id: _id, revision: _revision, createdAt: _created, updatedAt: _updated, ...same } = agent
  const second = await request('/agents', { ...same, name: '审阅 Agent' })
  const child = await request(`/works/${task.id}/delegate`, { agentId: second.id, title: '独立审阅', goal: '检查验证步骤是否清楚' })
  await request(`/works/${task.id}`, { expectedRevision: detail.work.revision, status: 'cancelled' })
  assert.equal((await request(`/works/${child.id}`)).work.status, 'open')
  assert.equal((await request(`/works/${task.id}`)).delegations[0].sourceWorkId, task.id)
  assert.equal((await request(`/works/${task.id}`)).artifacts.length, 1)
})

test('HTTP rejects malformed model setup before metadata writes and does not expose internal failures', async t => {
  const { request } = await fixture(t)
  const input = { name: '测试', protocolId: 'chat-completions', baseUrl: 'https://example.test/v1', remoteModelId: 'text', auth: 'none' }
  await request('/models', { ...input, protocolId: 'guess-provider' }, 400)
  await request('/models', { ...input, baseUrl: 'https://username:secret@example.test/v1' }, 400)
  await request('/models', { ...input, baseUrl: 'https://example.test/v1/chat/completions' }, 400)
  await request('/models', { ...input, command: 'never' }, 400)
  assert.deepEqual(await request('/models'), { models: [], connections: [] })
  assert.equal((await request('/state?unexpected=true', undefined, 400)).error.code, 'invalid-input')
  assert.equal((await request('/works/missing', undefined, 404)).error.code, 'not-found')
})

test('unavailable OS Vault retains visible editable metadata without persisting the supplied Key', async t => {
  const { request, modelsPath } = await fixture(t, { openEntry: () => { throw new Error('OS failure includes secret detail') } })
  const response = await request('/models', { name: '无系统凭据', protocolId: 'chat-completions', baseUrl: 'https://example.test/v1', remoteModelId: 'text', auth: 'api-key', apiKey: 'vault-only-secret' }, 503)
  assert.deepEqual(response, { error: { code: 'credential-unavailable' } })
  const state = await request('/models')
  assert.equal(state.connections.length, 1)
  assert.equal(state.connections[0].credentialConfigured, false)
  assert.ok(state.models.every(model => !model.available))
  assert.ok(!(await readFile(modelsPath, 'utf8')).includes('vault-only-secret'))
})

test('a saved connection can receive its Key after Vault recovery and become runnable', async t => {
  let available = false
  const secrets = new Map()
  const { request } = await fixture(t, { openEntry: (_namespace, id) => {
    if (!available) throw new Error('Vault temporarily unavailable')
    return { getPassword: async () => secrets.get(id), setPassword: async value => { secrets.set(id, value) }, deleteCredential: async () => secrets.delete(id) }
  } })
  await request('/models', { name: '稍后补 Key', protocolId: 'chat-completions', baseUrl: 'https://example.test/v1', remoteModelId: 'text', auth: 'api-key', apiKey: 'initial-secret' }, 503)
  const connection = (await request('/models')).connections[0]
  available = true
  const state = await request(`/models/connections/${connection.id}/key`, { expectedRevision: connection.revision, apiKey: 'recovered-secret' })
  assert.equal(state.connections.length, 1)
  assert.equal(state.connections[0].credentialConfigured, true)
  assert.equal(state.models.length, 1)
  assert.equal(state.models[0].available, true)
  assert.deepEqual([...secrets.values()], ['recovered-secret'])
  assert.ok(!JSON.stringify(state).includes('recovered-secret'))
})
