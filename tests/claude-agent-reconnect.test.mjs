import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { mount } from '../packages/app-claude-agent/dist/web/app.js'
import { emptyRunView } from '../packages/app-claude-agent/dist/core/events.js'
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
  let held, heldSubmission
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
    const queued=/^\/apps\/claude-agent\/runs\/([^/]+)\/messages$/.exec(target)
    if(queued){const current=[...state.values()].find(x=>x.run.id===queued[1]);assert.ok(current);current.queuedMessages??=[];if(method==='POST'){const body=JSON.parse(init.body);const message={id:'queued-'+current.queuedMessages.length,runId:queued[1],prompt:body.prompt,attachments:[],status:'queued',createdAt:stamp};current.queuedMessages.push(message);return Response.json(message,{status:202})}return Response.json(current.queuedMessages)}
    const match = /^\/apps\/claude-agent\/threads\/([^/]+)(?:\/(messages|runs|approvals))?$/.exec(target)
    if (match) {
      const [, id, kind] = match, current = state.get(id)
      assert.ok(current, `Unknown thread: ${id}`)
      if (method === 'POST') {
        assert.equal(kind, 'runs')
        const body = JSON.parse(init.body)
        submissions.push({ threadId: id, body })
        const rejected = heldSubmission?.threadId === id && heldSubmission.failure
        if (!rejected) current.run = { ...makeRun(id), id: `next-${id}`, prompt: body.prompt }
        const response = rejected
          ? Response.json({ error: { code: 'product-unavailable', message: 'The previous submission failed' } }, { status: 503 })
          : Response.json(current.run)
        if (heldSubmission?.threadId === id && !heldSubmission.started) {
          heldSubmission.started = true
          await new Promise(resolve => { heldSubmission.release = resolve })
        }
        return response
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
    heldSubmission?.release?.()
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
  return { ...dom, mounted, state, streams, submissions, decisions, count,
    holdMessages(threadId) { held = { threadId, started: false }; return () => held },
    holdSubmission(threadId, { failure = false } = {}) { heldSubmission = { threadId, started: false, failure }; return () => heldSubmission },
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
  const prompt = f.find('textarea[name="prompt"]')
  prompt.value = 'Continue after reconnecting'
  f.fire(prompt, 'input')
  await until(() => send.disabled === false && f.find('.ca-cancel').hidden && f.find('.ca-transcript').textContent.includes('The durable answer produced during the outage'), 'ready reconciles the completed Run and durable history')
  for (const [index, suffix] of suffixes.entries()) assert.ok(f.count(suffix) > before[index], `Reconnect refreshes ${suffix}`)
  assert.match(f.find('.ca-transcript').textContent, /The durable answer produced during the outage/)
  assert.doesNotMatch(f.find('.ca-transcript').textContent, /Initial transcript/)
  assert.equal(f.find('.ca-cancel').hidden, true)
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
  const allow = f.all('.ca-approval-actions button').find(button => button.textContent === '仅允许这次')
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

test('an active Run accepts one queued follow-up through Enter and prevents a concurrent duplicate form submission', async t => {
  const f = await fixture(t)
  const prompt = f.find('textarea[name="prompt"]')
  prompt.value = 'The follow-up I am writing while Claude works'
  f.fire(prompt, 'input')
  assert.equal(prompt.disabled, false, 'the next message can be prepared during execution')
  assert.equal(f.find('.ca-composer button[type="submit"]').disabled, false)
  const enter = f.fire(prompt, 'keydown', { key: 'Enter', shiftKey: false, isComposing: false })
  assert.equal(enter.defaultPrevented, true)
  f.fire(f.find('.ca-composer'), 'submit')
  await f.flush()
  assert.equal(f.submissions.length, 0, 'neither submission path starts a competing Run')
  assert.equal(prompt.value, '')
  assert.equal(f.state.get('one').queuedMessages.length,1)
  assert.equal(f.state.get('one').queuedMessages[0].prompt,'The follow-up I am writing while Claude works')
  assert.equal(f.find('.ca-notice-close').parentElement.hidden, true, 'blocked input does not produce an avoidable server error')
})

test('reading earlier transcript content pauses scrolling until the user returns to the latest content', async t => {
  const f = await fixture(t)
  const transcript = f.find('.ca-transcript'), latest = f.find('.ca-latest')
  transcript.scrollHeight = 1_400; transcript.clientHeight = 400; transcript.scrollTop = 120
  f.fire(transcript, 'scroll')
  assert.equal(latest.hidden, false)
  const current = f.state.get('one')
  const project = (seq, text) => ({ ...emptyRunView(current.run.id, 'one'), seq, items: [{ id: `answer-${seq}`, role: 'assistant', blocks: [{ block: { kind: 'text', text, truncated: false }, state: 'streaming' }] }] })
  current.live = project(1, 'New output arrived while reading earlier messages')
  transcript.scrollHeight = 1_800
  f.streams[0].ready()
  await until(() => transcript.textContent.includes('New output arrived while reading earlier messages'), 'the activity refresh reaches the real transcript')
  assert.equal(transcript.scrollTop, 120, 'new output does not steal the reading position')
  assert.equal(latest.hidden, false)
  f.fire(latest, 'click')
  assert.equal(transcript.scrollTop, 1_800)
  assert.equal(latest.hidden, true)
  transcript.scrollHeight = 2_200
  current.live = project(2, 'Output after following the latest content again')
  f.streams[0].ready()
  await until(() => transcript.textContent.includes('Output after following the latest content again'), 'the next activity refresh is rendered')
  assert.equal(transcript.scrollTop, 2_200, 'the explicit action restores automatic following')
})

test('each thread restores its own draft and settings and all unsent drafts protect closing', async t => {
  const f = await fixture(t, ['one', 'two'], state => {
    for (const current of state.values()) current.run = { ...current.run, status: 'completed', finishedAt: stamp }
  })
  const prompt = f.find('textarea[name="prompt"]'), model = f.find('input[name="model"]'), effort = f.find('select[name="effort"]')
  assert.equal(await f.mounted.canClose(), true)
  prompt.value = 'Draft for the first project'; f.fire(prompt, 'input')
  model.value = 'custom-first-model'; f.fire(model, 'input')
  effort.value = 'high'; f.fire(effort, 'change')
  assert.equal(await f.mounted.canClose(), false)
  f.fire(f.find('button[data-thread-id="two"]'), 'click')
  await until(() => f.find('.ca-thread-title').textContent === 'Thread two' && f.find('.ca-transcript').textContent.includes('Initial transcript for two'), 'the second thread opens')
  assert.equal(prompt.value, '')
  assert.equal(model.value, '')
  assert.equal(effort.value, '')
  assert.equal(await f.mounted.canClose(), false, 'a draft in the other thread still prevents closing')
  prompt.value = 'Different draft for the second project'; f.fire(prompt, 'input')
  model.value = 'custom-second-model'; f.fire(model, 'input')
  effort.value = 'low'; f.fire(effort, 'change')
  f.fire(f.find('button[data-thread-id="one"]'), 'click')
  await until(() => f.find('.ca-thread-title').textContent === 'Thread one', 'the first thread opens again')
  assert.equal(prompt.value, 'Draft for the first project')
  assert.equal(model.value, 'custom-first-model')
  assert.equal(effort.value, 'high')
  prompt.value = ''; f.fire(prompt, 'input')
  assert.equal(await f.mounted.canClose(), false, 'clearing one draft preserves the other draft guard')
  f.fire(f.find('button[data-thread-id="two"]'), 'click')
  await until(() => f.find('.ca-thread-title').textContent === 'Thread two', 'the second draft can be revisited')
  assert.equal(prompt.value, 'Different draft for the second project')
  assert.equal(model.value, 'custom-second-model')
  assert.equal(effort.value, 'low')
  prompt.value = '   '; f.fire(prompt, 'input')
  assert.equal(await f.mounted.canClose(), true, 'clearing every unsent draft allows closing')
})

test('thread search filters navigation without changing the selected conversation or its draft', async t => {
  const f = await fixture(t, ['one', 'two'])
  const prompt = f.find('textarea[name="prompt"]'), search = f.find('.ca-thread-search')
  prompt.value = 'Keep this draft in the selected first thread'; f.fire(prompt, 'input')
  const subscriptions = f.streams.length, historyReads = f.count('/threads/one/messages')
  search.value = 'Thread two'; f.fire(search, 'input')
  assert.equal(f.all('button[data-thread-id]').length, 1)
  assert.equal(f.find('button[data-thread-id="two"]').textContent.includes('Thread two'), true)
  assert.equal(f.find('button[data-thread-id="one"]'), null)
  assert.equal(f.find('.ca-thread-title').textContent, 'Thread one')
  assert.match(f.find('.ca-transcript').textContent, /Initial transcript for one/)
  assert.equal(prompt.value, 'Keep this draft in the selected first thread')
  assert.equal(f.streams.length, subscriptions, 'search does not switch subscriptions')
  assert.equal(f.count('/threads/one/messages'), historyReads, 'search does not reload the selected history')
  search.value = 'there-is-no-such-project'; f.fire(search, 'input')
  assert.equal(f.all('button[data-thread-id]').length, 0)
  assert.match(f.find('.ca-thread-list').textContent, /没有匹配/)
  assert.equal(f.find('.ca-thread-title').textContent, 'Thread one')
  search.value = ''; f.fire(search, 'input')
  assert.equal(f.all('button[data-thread-id]').length, 2)
  assert.equal(f.find('button[data-thread-id="one"]').getAttribute('aria-current'), 'true')
  assert.equal(prompt.value, 'Keep this draft in the selected first thread')
})

test('a submission accepted after switching threads cannot replace the selected transcript, status or draft', async t => {
  const f = await fixture(t, ['one', 'two'], state => {
    for (const current of state.values()) current.run = { ...current.run, status: 'completed', finishedAt: stamp }
  })
  const held = f.holdSubmission('one'), prompt = f.find('textarea[name="prompt"]')
  prompt.value = 'A request submitted to the first thread'; f.fire(prompt, 'input')
  f.fire(f.find('.ca-composer'), 'submit')
  await until(() => held().started, 'the first submission is awaiting its response')
  assert.equal(await f.mounted.canClose(), false, 'an unsettled submission prevents closing')
  f.fire(f.find('button[data-thread-id="two"]'), 'click')
  await until(() => f.find('.ca-thread-title').textContent === 'Thread two' && f.find('.ca-transcript').textContent.includes('Initial transcript for two'), 'another thread remains accessible while submitting')
  await f.flush()
  prompt.value = 'Keep the second thread draft'; f.fire(prompt, 'input')
  held().release()
  await until(() => f.find('.ca-composer button[type="submit"]').disabled === false, 'the pending request settles without blocking the second composer')
  await f.flush()
  assert.equal(f.submissions.length, 1)
  assert.equal(f.submissions[0].threadId, 'one')
  assert.equal(f.find('.ca-thread-title').textContent, 'Thread two')
  assert.match(f.find('.ca-transcript').textContent, /Initial transcript for two/)
  assert.doesNotMatch(f.find('.ca-transcript').textContent, /A request submitted to the first thread/)
  assert.equal(f.find('.ca-cancel').hidden, true, 'the old response cannot mark the selected completed thread running')
  assert.equal(prompt.value, 'Keep the second thread draft')
  f.fire(f.find('button[data-thread-id="one"]'), 'click')
  await until(() => f.find('.ca-thread-title').textContent === 'Thread one' && !f.find('.ca-cancel').hidden, 'the accepted Run is observed by returning to its original thread')
  assert.equal(prompt.value, '', 'the accepted message is removed from only its original draft')
})

test('a failed submission after switching threads preserves its original draft without showing an error in the selected thread', async t => {
  const f = await fixture(t, ['one', 'two'], state => {
    for (const current of state.values()) current.run = { ...current.run, status: 'completed', finishedAt: stamp }
  })
  const held = f.holdSubmission('one', { failure: true }), prompt = f.find('textarea[name="prompt"]')
  prompt.value = 'Retain the rejected message for a retry'; f.fire(prompt, 'input')
  f.fire(f.find('.ca-composer'), 'submit')
  await until(() => held().started, 'the first request is waiting for its rejection')
  f.fire(f.find('button[data-thread-id="two"]'), 'click')
  await until(() => f.find('.ca-thread-title').textContent === 'Thread two' && f.find('.ca-transcript').textContent.includes('Initial transcript for two'), 'the second thread loads before the rejection')
  await f.flush()
  prompt.value = 'The second thread remains independent'; f.fire(prompt, 'input')
  held().release()
  await until(() => !f.find('.ca-composer button[type="submit"]').disabled, 'the rejected request releases submission admission')
  assert.equal(f.find('.ca-notice-close').parentElement.hidden, true, 'the first thread error is not attributed to the second thread')
  assert.equal(prompt.value, 'The second thread remains independent')
  assert.match(f.find('.ca-transcript').textContent, /Initial transcript for two/)
  f.fire(f.find('button[data-thread-id="one"]'), 'click')
  await until(() => f.find('.ca-thread-title').textContent === 'Thread one', 'the rejected draft can be revisited')
  assert.equal(prompt.value, 'Retain the rejected message for a retry')
})

test('a late accepted submission keeps a newer draft written in its original thread while another thread is selected', async t => {
  const f = await fixture(t, ['one', 'two'], state => {
    for (const current of state.values()) current.run = { ...current.run, status: 'completed', finishedAt: stamp }
  })
  const held = f.holdSubmission('one'), prompt = f.find('textarea[name="prompt"]')
  const open = async id => {
    f.fire(f.find(`button[data-thread-id="${id}"]`), 'click')
    await until(() => f.find('.ca-thread-title').textContent === `Thread ${id}` && f.find('.ca-transcript').textContent.includes(`Initial transcript for ${id}`), `thread ${id} loads`)
    await f.flush()
  }
  prompt.value = 'The message whose response is delayed'; f.fire(prompt, 'input')
  f.fire(f.find('.ca-composer'), 'submit')
  await until(() => held().started, 'the first response is delayed')
  await open('two')
  await open('one')
  prompt.value = 'A new follow-up that has not been sent'; f.fire(prompt, 'input')
  await open('two')
  held().release()
  await until(() => !f.find('.ca-composer-hint').textContent.includes('正在发送'), 'the delayed response settles')
  await open('one')
  assert.equal(prompt.value, 'A new follow-up that has not been sent', 'only the accepted message is cleared, not later work')
  assert.equal(await f.mounted.canClose(), false)
})

test('the draft manager can discard another thread draft without changing the selected conversation', async t => {
  const f = await fixture(t, ['one', 'two'], state => {
    for (const current of state.values()) current.run = { ...current.run, status: 'completed', finishedAt: stamp }
  })
  const prompt = f.find('textarea[name="prompt"]')
  prompt.value = 'A draft that is no longer needed'; f.fire(prompt, 'input')
  f.fire(f.find('button[data-thread-id="two"]'), 'click')
  await until(() => f.find('.ca-thread-title').textContent === 'Thread two' && f.find('.ca-transcript').textContent.includes('Initial transcript for two'), 'the other conversation finishes loading')
  await f.flush()
  assert.equal(prompt.value, '')
  assert.equal(await f.mounted.canClose(), false, 'the first thread draft still protects closing')
  const subscriptions = f.streams.length, button = f.find('.ca-drafts-button')
  assert.equal(button.hidden, false)
  f.fire(button, 'click')
  const dialog = f.find('.ca-drafts-dialog')
  assert.equal(dialog.open, true)
  assert.match(dialog.textContent, /Thread one/)
  assert.match(dialog.textContent, /A draft that is no longer needed/)
  const discard = f.find('.ca-draft-discard', dialog)
  assert.equal(discard.getAttribute('aria-label'), '丢弃 Thread one 的草稿')
  f.fire(discard, 'click')
  assert.equal(await f.mounted.canClose(), true, 'the explicit discard removes the final draft guard')
  assert.equal(button.hidden, true)
  assert.match(dialog.textContent, /没有未发送草稿/)
  assert.equal(f.find('.ca-thread-title').textContent, 'Thread two')
  assert.match(f.find('.ca-transcript').textContent, /Initial transcript for two/)
  assert.doesNotMatch(f.find('.ca-transcript').textContent, /A draft that is no longer needed/)
  assert.equal(prompt.value, '')
  assert.equal(f.find('button[data-thread-id="two"]').getAttribute('aria-current'), 'true')
  assert.equal(f.streams.length, subscriptions, 'discarding a draft does not navigate or replace the current subscription')
  assert.equal(f.submissions.length, 0)
})
