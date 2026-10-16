import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { mount } from '../dist/applications/claude-agent/web/app.js'
import { emptyRunView } from '../dist/applications/claude-agent/core/events.js'
import { installClaudeAgentDOM } from './helpers/claude-agent-dom.mjs'

const apiBase = '/api/client/v1/apps/claude-agent'
const stamp = '2026-10-17T00:00:00.000Z'
const connection = { id: 'device', name: 'Device', endpoint: 'https://device.example', instanceId: 'instance', revision: 1, credentialConfigured: true }
const message = (id, text) => ({ id, role: 'assistant', blocks: [{ kind: 'text', text, truncated: false }] })
const makeRun = (threadId, status = 'running') => ({ schemaVersion: 1, id: `run-${threadId}`, threadId, status, prompt: 'Work on this project', model: null, resolvedModel: null, effort: null, nativeSessionId: 'native-session', createdAt: stamp, finishedAt: status === 'running' ? null : stamp, result: null, error: null })
const makeApproval = (threadId, id = 'approval') => ({ schemaVersion: 1, id, runId: `run-${threadId}`, threadId, toolUseId: 'tool', toolName: 'Bash', kind: 'permission', title: 'Run the project check?', description: null, reason: null, input: { command: 'npm test' }, inputTruncated: false, questions: null, allowSessionAvailable: false, defaultToNo: true, requestedAt: stamp, decision: null, answers: null, resolvedAt: null })
async function until(check, description, timeout = 5_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await delay(10) }
  assert.fail(`Timed out: ${description}`)
}

/** The mounted app uses its real device client and SSE parser; only the network and DOM are replaced. */
async function fixture(t, ids = ['one'], initialize = () => {}) {
  const dom = installClaudeAgentDOM(t, { autoRestore: false })
  const state = new Map(ids.map(id => [id, { run: makeRun(id), history: [message(`initial-${id}`, `Initial transcript for ${id}`)], approvals: [] }]))
  initialize(state)
  const initialRuns = new Map([...state.values()].map(current => [current.run.id, current.run]))
  const reads = [], streams = [], submissions = [], decisions = []
  let held
  const thread = id => ({ schemaVersion: 1, id, projectPath: `/projects/${id}`, title: `Thread ${id}`, titleSource: 'user', nativeSessionId: 'native-session', createdAt: stamp, updatedAt: stamp, lastRun: { id: state.get(id).run.id, status: state.get(id).run.status }, pendingApprovals: state.get(id).approvals.length })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), 'https://client.example'), path = url.pathname
    const method = init.method ?? 'GET'
    reads.push({ path, method })
    if (path === `${apiBase}/connections`) return Response.json({ connections: [connection], localInstanceId: null })
    if (path === `${apiBase}/local`) return Response.json({ instanceId: null, picker: false })
    const prefix = `${apiBase}/connections/device/v1`
    assert.ok(path.startsWith(prefix), `Unexpected request: ${path}`)
    assert.equal(init.headers['X-Anybox-Expected-Instance-Id'], connection.instanceId)
    assert.equal(init.headers['X-Anybox-Connection-Revision'], String(connection.revision))
    const target = path.slice(prefix.length)
    if (target === '/instance') return Response.json({ capabilities: ['claude-agent.v1', 'sse'] })
    if (target === '/products/claude-agent') return Response.json({ state: 'running' })
    if (target === '/apps/claude-agent/environment') return Response.json({ schemaVersion: 1, platform: 'linux', executable: { path: '/usr/bin/claude', source: 'path' } })
    if (target === '/apps/claude-agent/projects/recent') return Response.json({ schemaVersion: 1, projects: [] })
    if (target === '/apps/claude-agent/models/recent') return Response.json({ schemaVersion: 1, models: [] })
    if (target === '/apps/claude-agent/threads') return Response.json(ids.map(thread))
    if (target === '/apps/claude-agent/events') {
      let controller, closed = false
      const body = new ReadableStream({ start(value) { controller = value }, cancel() { closed = true } })
      const emit = (event, data) => { assert.equal(closed, false); controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) }
      const stream = { threadId: url.searchParams.get('threadId'), ready() { emit('ready', {}) }, change(value) { emit('run-changed', value) }, disconnect() { if (!closed) { closed = true; controller.error(new TypeError('network disconnected')) } } }
      streams.push(stream)
      init.signal?.addEventListener('abort', () => { if (!closed) { closed = true; controller.error(new DOMException('Aborted', 'AbortError')) } }, { once: true })
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
    }
    const match = /^\/apps\/claude-agent\/threads\/([^/]+)(?:\/(messages|runs|approvals))?$/.exec(target)
    if (match) {
      const [, id, kind] = match, current = state.get(id)
      assert.ok(current, `Unknown thread: ${id}`)
      if (method === 'POST') {
        assert.equal(kind, 'runs')
        const body = JSON.parse(init.body)
        submissions.push({ threadId: id, body })
        current.run = { ...makeRun(id), id: `next-${id}`, prompt: body.prompt }
        return Response.json(current.run)
      }
      const value = kind === 'messages' ? { nativeSessionId: 'native-session', messages: current.history } : kind === 'runs' ? [current.run] : kind === 'approvals' ? current.approvals : thread(id)
      if (held?.threadId === id && kind === 'messages' && !held.started) {
        held.started = true; held.signal = init.signal
        // Deliberately ignore cancellation here: an already completed response can still reach an awaiting continuation.
        const response = Response.json(value)
        await new Promise(resolve => { held.release = resolve })
        return response
      }
      return Response.json(value)
    }
    const view = /^\/apps\/claude-agent\/runs\/([^/]+)\/view$/.exec(target)
    if (view) {
      const current = [...state.values()].find(item => item.run.id === view[1])
      const run = current?.run ?? initialRuns.get(view[1])
      assert.ok(run, `Unknown Run: ${view[1]}`)
      return Response.json(current?.live ?? { ...emptyRunView(run.id, run.threadId), approvals: current?.approvals ?? [] })
    }
    const runRequest = /^\/apps\/claude-agent\/runs\/([^/]+)$/.exec(target)
    if (runRequest) {
      const run = [...state.values()].find(current => current.run.id === runRequest[1])?.run ?? initialRuns.get(runRequest[1])
      assert.ok(run, `Unknown Run: ${runRequest[1]}`)
      return Response.json(run)
    }
    const approval = /^\/apps\/claude-agent\/approvals\/([^/]+)$/.exec(target)
    if (approval && method === 'POST') {
      const current = [...state.values()].find(item => item.approvals.some(item => item.id === approval[1]))
      assert.ok(current, `Unknown approval: ${approval[1]}`)
      const original = current.approvals.find(item => item.id === approval[1]), body = JSON.parse(init.body)
      decisions.push({ id: approval[1], ...body }); current.approvals = current.approvals.filter(item => item.id !== approval[1])
      return Response.json({ ...original, decision: body.decision, resolvedAt: stamp })
    }
    assert.fail(`Unexpected request: ${method} ${target}`)
  }
  let location = `host/instance/thread/${ids[0]}`
  const listeners = new Set(), abort = new AbortController()
  let mounted
  t.after(async () => {
    held?.release?.()
    try { await mounted?.dispose(); abort.abort(); await dom.flush() }
    finally { globalThis.fetch = originalFetch; dom.restore() }
  })
  mounted = await mount(dom.container, { appId: 'claude-agent', apiBase, signal: abort.signal, domId: id => `reconnect-${id}`, route: {
    read: () => location,
    navigate(value) { location = value; for (const listener of listeners) listener() },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  } })
  await until(() => streams.length === 1, 'the selected thread subscribes')
  streams[0].ready()
  await dom.flush()
  const count = suffix => reads.filter(read => read.path.endsWith(suffix) && read.method === 'GET').length
  return { ...dom, state, streams, submissions, decisions, count,
    holdMessages(threadId) { held = { threadId, started: false }; return () => held },
    async reconnect(stream, change) {
      const before = streams.length
      stream.disconnect(); change()
      await until(() => streams.length === before + 1, 'the real SSE client reconnects')
      streams.at(-1).ready()
      return streams.at(-1)
    },
  }
}

test('SSE ready reconciles a Run completed while disconnected and restores sending with its durable transcript', async t => {
  const f = await fixture(t)
  const send = f.find('.ca-composer button[type="submit"]')
  assert.equal(send.disabled, true, 'the initial active Run blocks sending')
  const suffixes = ['/threads/one/messages', '/threads/one/runs', '/threads/one/approvals']
  const before = suffixes.map(f.count)
  await f.reconnect(f.streams[0], () => {
    const current = f.state.get('one')
    current.run = { ...current.run, status: 'completed', finishedAt: stamp }
    current.history = [message('final-one', 'The durable answer produced during the outage')]
  })
  await until(() => send.disabled === false, 'ready re-reads the completed Run and enables sending')
  for (const [index, suffix] of suffixes.entries()) assert.ok(f.count(suffix) > before[index], `Reconnect refreshes ${suffix}`)
  assert.match(f.find('.ca-transcript').textContent, /The durable answer produced during the outage/)
  assert.doesNotMatch(f.find('.ca-transcript').textContent, /Initial transcript/)
  assert.equal(f.find('.ca-cancel').hidden, true)
  f.find('textarea[name="prompt"]').value = 'Continue after reconnecting'
  f.fire(f.find('.ca-composer'), 'submit')
  await until(() => f.submissions.length === 1 && f.find('textarea[name="prompt"]').value === '' && !f.find('.ca-cancel').hidden, 'the restored composer finishes sending through the real device client')
  await f.flush()
  assert.equal(f.submissions[0].body.prompt, 'Continue after reconnecting')
  assert.equal(f.submissions[0].threadId, 'one')
})

test('SSE ready restores approvals missed during disconnection and removes approvals resolved during a later outage', async t => {
  const f = await fixture(t)
  let stream = await f.reconnect(f.streams[0], () => { f.state.get('one').approvals = [makeApproval('one')] })
  await until(() => !f.find('.ca-approvals').hidden, 'a missed approval appears after reconnecting')
  assert.match(f.find('.ca-approvals').textContent, /Run the project check/)
  const allow = f.all('.ca-approval-actions button').find(button => button.textContent === '允许')
  f.fire(allow, 'click')
  await until(() => f.decisions.length === 1 && f.find('.ca-approvals').hidden, 'the recovered approval remains actionable')
  assert.deepEqual(f.decisions[0], { id: 'approval', decision: 'allow' })
  stream = await f.reconnect(stream, () => { f.state.get('one').approvals = [makeApproval('one', 'next-approval')] })
  await until(() => !f.find('.ca-approvals').hidden, 'the next outstanding approval is restored')
  await f.reconnect(stream, () => { f.state.get('one').approvals = [] })
  await until(() => f.find('.ca-approvals').hidden, 'an approval resolved during the outage is removed on ready')
  assert.equal(f.find('.ca-composer button[type="submit"]').disabled, true, 'an active Run still blocks a second Run')
})

test('a delayed reconnect snapshot from the previous thread cannot overwrite the newly selected thread', async t => {
  const f = await fixture(t, ['one', 'two'])
  const held = f.holdMessages('one')
  await f.reconnect(f.streams[0], () => {
    f.state.get('one').history = [message('stale-one', 'Stale content from the previous thread')]
  })
  await until(() => held().started, 'the old thread has a pending reconnect snapshot')
  f.fire(f.find('button[data-thread-id="two"]'), 'click')
  await until(() => f.find('.ca-thread-title').textContent === 'Thread two' && f.find('.ca-transcript').textContent.includes('Initial transcript for two'), 'the second thread finishes loading')
  assert.equal(held().signal.aborted, true, 'switching threads cancels the old subscription reads')
  held().release()
  await f.flush()
  assert.equal(f.find('.ca-thread-title').textContent, 'Thread two')
  assert.match(f.find('.ca-transcript').textContent, /Initial transcript for two/)
  assert.doesNotMatch(f.find('.ca-transcript').textContent, /Stale content from the previous thread/)
})


test('reconnecting to a newer Run accepts its lower sequence projection and restores that Run approval', async t => {
  const item = text => ({ id: text, role: 'assistant', blocks: [{ block: { kind: 'text', text, truncated: false }, state: 'streaming' }] })
  const f = await fixture(t, ['one'], state => {
    state.get('one').live = { ...emptyRunView('run-one', 'one'), seq: 10, items: [item('The old Run streaming projection')] }
  })
  assert.match(f.find('.ca-transcript').textContent, /The old Run streaming projection/)
  await f.reconnect(f.streams[0], () => {
    const current = f.state.get('one')
    current.run = { ...makeRun('one'), id: 'replacement-run', prompt: 'A new Run started by another client' }
    current.approvals = [{ ...makeApproval('one', 'replacement-approval'), runId: current.run.id, title: 'Approve the replacement Run?' }]
    current.live = { ...emptyRunView(current.run.id, 'one'), seq: 1, items: [item('The newer Run projection')], approvals: current.approvals }
  })
  await until(() => f.find('.ca-transcript').textContent.includes('The newer Run projection') && !f.find('.ca-approvals').hidden, 'ready adopts the newer Run with a lower per-Run sequence')
  assert.ok(f.count('/runs/replacement-run/view') > 0, 'the replacement Run receives its own projection read')
  assert.doesNotMatch(f.find('.ca-transcript').textContent, /The old Run streaming projection/)
  assert.match(f.find('.ca-transcript').textContent, /A new Run started by another client/)
  assert.match(f.find('.ca-approvals').textContent, /Approve the replacement Run/)
  assert.equal(f.find('.ca-composer button[type="submit"]').disabled, true)
  assert.equal(f.find('.ca-cancel').hidden, false)
})


test('a new Run event supersedes an older reconnect snapshot still waiting for transcript history', async t => {
  const f = await fixture(t)
  const held = f.holdMessages('one')
  const stream = await f.reconnect(f.streams[0], () => {
    f.state.get('one').history = [message('stale-history', 'A stale reconnect snapshot')]
  })
  await until(() => held().started, 'ready is waiting for the previous transcript snapshot')
  await f.flush()
  const current = f.state.get('one')
  current.run = { ...makeRun('one'), id: 'run-announced-after-ready', prompt: 'A new Run announced after reconnecting' }
  current.live = { ...emptyRunView(current.run.id, 'one'), seq: 1, items: [{ id: 'new-answer', role: 'assistant', blocks: [{ block: { kind: 'text', text: 'The new Run remains selected', truncated: false }, state: 'streaming' }] }] }
  stream.change({ threadId: 'one', runId: current.run.id, status: 'running', seq: 1 })
  await until(() => f.find('.ca-transcript').textContent.includes('The new Run remains selected'), 'the newer event selects the new Run and reads its projection')
  assert.ok(f.count('/runs/run-announced-after-ready') > 0)
  held().release()
  await f.flush()
  assert.match(f.find('.ca-transcript').textContent, /A new Run announced after reconnecting/)
  assert.match(f.find('.ca-transcript').textContent, /The new Run remains selected/)
  assert.doesNotMatch(f.find('.ca-transcript').textContent, /A stale reconnect snapshot/)
  assert.equal(f.find('.ca-composer button[type="submit"]').disabled, true)
  assert.equal(f.find('.ca-cancel').hidden, false)
})
