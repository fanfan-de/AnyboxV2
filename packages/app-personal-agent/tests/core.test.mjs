import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context, FiberState } from '@nya/core'
import { createLocalSqliteComponent } from '@anybox/storage-sqlite'
import { createModelsJsonStoreComponent, createModelsVaultComponent, createModelsComponent, createChatCompletionsProtocolComponent, unknownCapabilities } from '@anybox/models'
import { createPersonalAgentComponent } from '../dist/core/component.js'

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const reply = text => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } })
const errorCode = code => error => error?.code === code
const waitUntil = async predicate => { for (let i = 0; i < 200; i++) { const result = await predicate(); if (result) return result; await tick() } throw new Error('condition did not settle') }

function activityFixture() {
  const entries = new Set(), guards = new Set()
  return { entries, guards,
    enter() { const entry = {}; entries.add(entry); return { release: () => entries.delete(entry) } },
    registerGuard(_id, guard) { guards.add(guard); return () => guards.delete(guard) },
    freeze() { throw new Error('not used') }, stop() {}, async wait() {},
  }
}

async function open(directory, fetch = async () => reply('已完成')) {
  const root = new Context(), activity = activityFixture(), values = new Map()
  const database = join(directory, 'workspace.sqlite'), modelsPath = join(directory, 'models.json')
  for (const component of [
    { name: 'personal-test-activity', apply(ctx) { ctx.provide('app.activity', activity) } },
    createLocalSqliteComponent(database),
    createModelsJsonStoreComponent({ path: modelsPath, reservedPaths: [database] }),
    createModelsVaultComponent({ namespace: 'personal-agent-tests', openEntry: (_namespace, id) => ({ getPassword: async () => values.get(id), setPassword: async value => { values.set(id, value) }, deleteCredential: async () => values.delete(id) }) }),
    createModelsComponent(),
    createChatCompletionsProtocolComponent({ fetch }),
    createPersonalAgentComponent(),
  ]) { const fiber = root.installComponent(component); await fiber; assert.equal(fiber.state, FiberState.ACTIVE) }
  return { root, api: root.get('personal-agent.workspace'), admission: root.get('personal-agent.admission'), settings: root.get('models.settings'), storage: root.get('local-storage'), activity, modelsPath,
    close: () => root.fiber.dispose(),
  }
}

async function fixture(t, fetch) {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-'))
  const f = await open(directory, fetch)
  t.after(async () => { try { await f.close() } finally { await rm(directory, { recursive: true, force: true }) } })
  return { ...f, directory }
}

async function configure(f, changes = {}) {
  let choices = f.root.get('models').list()
  if (!choices.length) {
    const provider = await f.settings.createProvider({ name: 'Test provider', connectionHints: { protocolIds: ['chat-completions'] } })
    await f.settings.createModel({ providerId: provider.id, remoteModelId: 'test-model', name: 'Test model', capabilities: unknownCapabilities(), controls: { temperature: 'unknown' }, modalities: { input: ['text'], output: ['text'] }, limits: {}, connectionHints: { protocolIds: ['chat-completions'] } })
    await f.settings.createConnection({ providerDefinitionId: provider.id, name: 'Test account', enabled: true, protocolId: 'chat-completions', baseUrl: 'https://example.invalid/v1', auth: 'none', timeoutMs: 30000 })
    choices = f.root.get('models').list()
  }
  const agent = (await f.api.state()).agents[0]
  return f.api.saveAgent({ ...agent, modelId: choices[0].id, ...changes, expectedRevision: agent.revision })
}
const work = (f, agent, title = '验证任务', kind = 'task') => f.api.createWork({ agentId: agent.id, kind, title, goal: kind === 'task' ? `目标：${title}` : '' })
const finished = (f, id) => waitUntil(async () => { const detail = await f.api.detail(id); return detail.work.status !== 'running' && detail.runs.length ? detail : undefined })

test('independent Agent work runs concurrently; one work remains serial through actual model exit', async t => {
  const calls = [], gates = [deferred(), deferred()]
  const f = await fixture(t, async (_url, init) => { const index = calls.length; calls.push(JSON.parse(init.body)); await gates[index].promise; return reply(`成果 ${index}`) })
  const agent = await configure(f), first = await work(f, agent, '一'), second = await work(f, agent, '二')
  const [a, b] = await Promise.all([f.api.startRun(first.id, { input: '推进一', expectedRevision: first.revision }), f.api.startRun(second.id, { input: '推进二', expectedRevision: second.revision })])
  await waitUntil(() => calls.length === 2)
  assert.equal(a.status, 'running'); assert.equal(b.status, 'running')
  assert.equal(f.admission.busy(), true); assert.equal([...f.activity.guards][0](), undefined)
  await assert.rejects(f.api.startRun(first.id, { input: '重复', expectedRevision: 2 }), errorCode('work-busy'))
  gates.forEach(gate => gate.resolve())
  const [one, two] = await Promise.all([finished(f, first.id), finished(f, second.id)])
  assert.equal(one.runs[0].status, 'succeeded'); assert.equal(two.runs[0].status, 'succeeded')
  assert.equal(f.admission.busy(), false); assert.equal(f.activity.entries.size, 0)
  const release = [...f.activity.guards][0](); assert.equal(typeof release, 'function')
  await assert.rejects(f.api.createWork({ agentId: agent.id, title: '冻结', kind: 'task', goal: '冻结' }), errorCode('application-unavailable'))
  release()
})

test('cancellation and root disposal wait for an aborted fetch to actually finish', async t => {
  const gate = deferred(), arrived = deferred()
  let signal
  const f = await fixture(t, async (_url, init) => { signal = init.signal; arrived.resolve(); await gate.promise; return reply('延迟到达') })
  const agent = await configure(f), task = await work(f, agent)
  const run = await f.api.startRun(task.id, { input: '等待', expectedRevision: task.revision }); await arrived.promise
  let settled = false
  const cancellation = f.api.cancelRun(task.id, run.id).then(value => { settled = true; return value })
  await waitUntil(() => signal.aborted); await tick()
  assert.equal(settled, false); assert.equal((await f.api.detail(task.id)).runs[0].status, 'running')
  assert.equal(f.activity.entries.size > 0, true)
  let closed = false
  const closing = f.close().then(() => { closed = true }); await tick(); assert.equal(closed, false)
  gate.resolve()
  assert.equal((await cancellation).status, 'cancelled'); await closing
})

test('every Run captures latest configuration and complete bounded context; a new segment explicitly excludes old history', async t => {
  const calls = []
  const f = await fixture(t, async (_url, init) => { calls.push(JSON.parse(init.body)); return reply('保留的历史成果') })
  let agent = await configure(f, { systemPrompt: '第一版提示', memory: '用户明确记忆', skills: '用户维护技能', contextLimit: 10000 })
  const task = await work(f, agent)
  await f.api.startRun(task.id, { input: '第一轮输入', expectedRevision: task.revision }); let detail = await finished(f, task.id)
  agent = await f.api.saveAgent({ ...agent, systemPrompt: '第二版提示', expectedRevision: agent.revision })
  await f.api.startRun(task.id, { input: '第二轮输入', expectedRevision: detail.work.revision }); detail = await finished(f, task.id)
  assert.match(detail.runs[0].instruction, /第一版提示/); assert.match(detail.runs[1].instruction, /第二版提示/)
  assert.match(detail.runs[1].context, /第一轮输入/); assert.match(detail.runs[1].context, /保留的历史成果/)
  assert.match(calls[1].messages[0].content, /用户明确记忆/); assert.match(calls[1].messages[0].content, /用户维护技能/)
  const longInput = '容量不足输入'.repeat(2000)
  await assert.rejects(f.api.startRun(task.id, { input: longInput, expectedRevision: detail.work.revision }), errorCode('context-capacity'))
  detail = await f.api.detail(task.id)
  assert.equal(detail.work.status, 'waiting'); assert.equal(detail.work.waitReason, 'context-capacity'); assert.equal(detail.runs.length, 2); assert.equal(calls.length, 2)
  const next = await f.api.newContext(task.id, detail.work.revision)
  await f.api.startRun(task.id, { input: '从新上下文开始', expectedRevision: next.revision }); detail = await finished(f, task.id)
  assert.equal(detail.runs[2].contextSegment, 2); assert.doesNotMatch(detail.runs[2].context, /第一轮输入|第二轮输入|保留的历史成果/)
  assert.equal(detail.runs[0].agent.revision, agent.revision - 1)
  assert.equal((await f.api.state()).agents[0].memory, '用户明确记忆')
})

test('delegation creates independent tasks, keeps source links and results, and does not cascade cancellation', async t => {
  const f = await fixture(t), agent = await configure(f)
  const other = await f.api.saveAgent({ name: '另一 Agent', description: '', systemPrompt: '独立工作', memory: '', skills: '', modelId: agent.modelId, contextLimit: 10000 })
  const parent = await work(f, agent)
  const child = await f.api.delegate(parent.id, { agentId: other.id, title: '独立子任务', goal: '产出自己的成果' })
  assert.equal(child.sourceWorkId, parent.id); assert.equal(child.kind, 'task')
  await f.api.updateWork(parent.id, { expectedRevision: parent.revision, status: 'cancelled' })
  await f.api.startRun(child.id, { input: '开始独立推进', expectedRevision: child.revision }); let childDetail = await finished(f, child.id)
  const artifact = await f.api.saveArtifact(child.id, { title: '验证成果', content: '用户可编辑的成果正文', runId: childDetail.runs[0].id })
  await f.api.updateWork(child.id, { expectedRevision: childDetail.work.revision, status: 'completed', progress: '已经交付成果' })
  const parentDetail = await f.api.detail(parent.id)
  childDetail = await f.api.detail(child.id)
  assert.equal(parentDetail.work.status, 'cancelled'); assert.equal(parentDetail.delegations[0].status, 'completed'); assert.equal(parentDetail.delegations[0].progress, '已经交付成果')
  assert.equal(childDetail.artifacts[0].id, artifact.id); assert.equal(childDetail.runs[0].agent.id, other.id)
  assert.doesNotMatch(childDetail.runs[0].context, /验证任务/)
  await assert.rejects(f.api.newContext(parent.id, parentDetail.work.revision), errorCode('work-closed'))
  await assert.rejects(f.api.saveArtifact(parent.id, { title: '错误关联', content: '正文', runId: childDetail.runs[0].id }), errorCode('not-found'))
})

test('unproved cleanup remains a failure and blocks new admission and activation guards', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-cleanup-')), f = await open(directory)
  t.after(async () => { try { await f.close().catch(() => {}) } finally { await rm(directory, { recursive: true, force: true }) } })
  const agent = await configure(f), task = await work(f, agent)
  f.root.get('models').generateText = () => ({ result: Promise.reject(Object.assign(new Error('cleanup failed'), { code: 'cleanup-failure' })), done: Promise.reject(Object.assign(new Error('cleanup failed'), { code: 'cleanup-failure' })), cancel() {} })
  const run = await f.api.startRun(task.id, { input: '验证清理', expectedRevision: task.revision })
  const detail = await finished(f, task.id)
  assert.equal(detail.runs[0].status, 'failed'); assert.equal(detail.runs[0].error, 'cleanup-failure')
  assert.equal(detail.work.status, 'waiting'); assert.equal(detail.work.waitReason, 'cleanup-failure')
  assert.equal(f.admission.busy(), true); assert.equal([...f.activity.guards][0](), undefined)
  await assert.rejects(f.api.cancelRun(task.id, run.id), errorCode('application-unavailable'))
  await assert.rejects(f.close())
})

test('restart marks persisted in-flight execution interrupted and waits for explicit continuation without replay', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-recovery-'))
  let calls = 0, f = await open(directory, async () => { calls++; return reply('一次成功') })
  t.after(async () => { try { await f.close() } finally { await rm(directory, { recursive: true, force: true }) } })
  const agent = await configure(f), task = await work(f, agent)
  const run = await f.api.startRun(task.id, { input: '执行意图', expectedRevision: task.revision }); await finished(f, task.id)
  await f.storage.transaction(tx => {
    const storedRun = JSON.parse(tx.get('SELECT record FROM personal_agent_runs WHERE id=?', [run.id]).record)
    tx.execute('UPDATE personal_agent_runs SET record=? WHERE id=?', [JSON.stringify({ ...storedRun, status: 'running', finishedAt: null }), run.id])
    const storedWork = JSON.parse(tx.get('SELECT record FROM personal_agent_works WHERE id=?', [task.id]).record)
    tx.execute('UPDATE personal_agent_works SET record=? WHERE id=?', [JSON.stringify({ ...storedWork, status: 'running' }), task.id])
  })
  await f.close(); f = await open(directory, async () => { calls++; return reply('不应自动调用') })
  const detail = await f.api.detail(task.id)
  assert.equal(detail.runs[0].status, 'interrupted'); assert.equal(detail.work.status, 'waiting'); assert.equal(detail.work.waitReason, 'interrupted'); assert.equal(calls, 1)
  assert.equal((await f.api.state()).preferredAgentId, agent.id)
  assert.doesNotMatch(await readFile(f.modelsPath, 'utf8'), /执行意图|一次成功/)
})
