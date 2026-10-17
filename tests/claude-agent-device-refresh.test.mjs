import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mount } from '../dist/applications/claude-agent/web/app.js'
import { emptyRunView } from '../dist/applications/claude-agent/core/events.js'
import { installClaudeAgentDOM } from './helpers/claude-agent-dom.mjs'

const apiBase = '/api/client/v1/apps/claude-agent'
const stamp = '2026-10-17T00:00:00.000Z'
const device = (id, revision = 1) => ({ id, name: `Device ${id}`, instanceId: `instance-${id}`, endpoint: `https://${id}.example`, revision, credentialConfigured: true })
const thread = { schemaVersion: 1, id: 'thread', projectPath: '/project', title: 'Current thread', titleSource: 'user', nativeSessionId: 'native', createdAt: stamp, updatedAt: stamp, lastRun: { id: 'run', status: 'running' }, pendingApprovals: 0 }
const run = { schemaVersion: 1, id: 'run', threadId: 'thread', status: 'running', prompt: 'Current task', model: null, resolvedModel: null, effort: null, nativeSessionId: 'native', createdAt: stamp, finishedAt: null, result: null, error: null }
const environment = { schemaVersion: 1, platform: 'darwin', executable: { path: '/usr/local/bin/claude', source: 'path' } }

async function until(check, description) {
  for (let turn = 0; turn < 100; turn++) {
    if (check()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail(`Timed out: ${description}`)
}

/** Mounts the real controller/client. Only the network and DOM are replaced. */
async function fixture(t, initial = [], initialRoute = '') {
  const dom = installClaudeAgentDOM(t, { autoRestore: false }), originalFetch = globalThis.fetch
  const state = { connections: initial, localInstanceId: null, product: 'running', environment, offline: new Set(), unsupported: new Set() }
  const requests = [], streams = [], holds = [], listeners = new Set(), abort = new AbortController()
  let location = initialRoute, mounted
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), 'https://client.example'), path = url.pathname, method = init.method ?? 'GET'
    const match = new RegExp(`^${apiBase}/connections/([^/]+)/v1(.*)$`).exec(path)
    const request = { path, target: match?.[2] ?? path, device: match?.[1], method, signal: init.signal, headers: init.headers }
    requests.push(request)
    let response
    if (path === `${apiBase}/connections`) response = Response.json({ connections: state.connections, localInstanceId: state.localInstanceId })
    else if (path === `${apiBase}/local`) response = Response.json({ instanceId: state.localInstanceId, picker: state.localInstanceId !== null })
    else {
      assert.ok(match, `Unexpected request: ${method} ${path}`)
      const target = request.target
      if (target === '/instance') response = state.offline.has(request.device) ? Response.json({ error: { code: 'connection-unavailable' } }, { status: 502 }) : Response.json({ capabilities: state.unsupported.has(request.device) ? ['sse'] : ['claude-agent.v1', 'sse'] })
      else if (target === '/products/claude-agent') response = Response.json({ state: state.product })
      else if (target === '/products/claude-agent/open' || target === '/products/claude-agent/retry') { state.product = 'running'; response = Response.json({ state: state.product }) }
      else if (target === '/apps/claude-agent/environment') response = Response.json(state.environment)
      else if (target === '/apps/claude-agent/projects/recent') response = Response.json({ schemaVersion: 1, projects: [] })
      else if (target === '/apps/claude-agent/models/recent') response = Response.json({ schemaVersion: 1, models: [] })
      else if (target === '/apps/claude-agent/threads') response = Response.json([thread])
      else if (target === '/apps/claude-agent/threads/thread') response = Response.json(thread)
      else if (target === '/apps/claude-agent/threads/thread/runs') response = Response.json([run])
      else if (target === '/apps/claude-agent/threads/thread/messages') response = Response.json({ nativeSessionId: 'native', messages: [{ id: 'message', role: 'assistant', blocks: [{ kind: 'text', text: 'The current transcript', truncated: false }] }] })
      else if (target === '/apps/claude-agent/threads/thread/approvals') response = Response.json([])
      else if (target === '/apps/claude-agent/runs/run/view') response = Response.json(emptyRunView('run', 'thread'))
      else if (target === '/apps/claude-agent/events') {
        let controller
        const stream = { device: request.device, closed: false }
        const body = new ReadableStream({ start(value) { controller = value }, cancel() { stream.closed = true } })
        init.signal.addEventListener('abort', () => { if (!stream.closed) { stream.closed = true; controller.error(new DOMException('Aborted', 'AbortError')) } }, { once: true })
        streams.push(stream); response = new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
      } else assert.fail(`Unexpected request: ${method} ${target}`)
    }
    const held = holds.find(item => !item.started && item.match(request))
    if (held) {
      held.started = true; held.request = request
      // A response already in flight can arrive after cancellation. Keep its original snapshot.
      await new Promise(resolve => { held.release = resolve })
    }
    return response
  }
  t.after(async () => {
    for (const held of holds) held.release?.()
    try { await mounted?.dispose(); abort.abort(); await dom.flush() }
    finally { globalThis.fetch = originalFetch; dom.restore() }
  })
  mounted = await mount(dom.container, { appId: 'claude-agent', apiBase, signal: abort.signal, domId: id => `refresh-${id}`, route: {
    read: () => location,
    navigate(value) { location = value; for (const listener of listeners) listener() },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  } })
  return { ...dom, state, requests, streams, mounted, route: () => location,
    hold(match) { const held = { match, started: false }; holds.push(held); return held },
    starts: () => requests.filter(item => item.method === 'POST' && item.target.startsWith('/products/claude-agent/')),
  }
}

test('activating Claude discovers a newly paired local connection, while only open starts its Agent', async t => {
  const f = await fixture(t)
  assert.match(f.find('.ca-device-status').textContent, /尚未配置/)
  await f.mounted.setActive(false, 'select')
  f.state.connections = [device('local')]; f.state.localInstanceId = 'instance-local'; f.state.product = 'disabled'
  await f.mounted.setActive(true, 'select')
  assert.equal(f.find('.ca-device-name').textContent, '本机')
  assert.equal(f.find('.ca-start').hidden, false)
  assert.equal(f.starts().length, 0, 'select only reads the new execution device')
  await f.mounted.setActive(true, 'restore')
  await f.mounted.setActive(true, 'navigate')
  assert.equal(f.starts().length, 0, 'restoring and navigating also leave the Agent stopped')
  await f.mounted.setActive(true, 'open')
  assert.equal(f.starts().length, 1)
  assert.equal(f.starts()[0].device, 'local')
  assert.equal(f.find('.ca-start').hidden, true)
  assert.equal(f.find('.ca-pick-native').hidden, false)
  assert.ok(f.find('button[data-thread-id="thread"]'))
})

test('activation retains the selected device, thread, running subscription and unsaved fields when a local connection appears or a probe fails', async t => {
  const f = await fixture(t, [device('remote')], 'host/instance-remote/thread/thread')
  assert.equal(f.streams.length, 1)
  f.find('textarea[name="prompt"]').value = 'Unsent prompt'
  f.find('input[name="model"]').value = 'my-model'
  f.find('select[name="effort"]').value = 'high'
  f.find('input[name="projectPath"]').value = '/unfinished-project'
  f.find('input[name="title"]').value = 'Unfinished title'
  f.state.connections = [device('local'), device('remote')]; f.state.localInstanceId = 'instance-local'
  await f.mounted.setActive(false, 'select'); await f.mounted.setActive(true, 'select')
  f.state.offline.add('remote')
  await f.mounted.setActive(true, 'open')
  assert.equal(f.requests.filter(item => item.path === `${apiBase}/connections`).length, 3, 'both activations re-read the shared connection directory')
  assert.equal(f.find('select[aria-label="执行设备"]').value, 'remote', 'new local pairing does not take over a valid current selection')
  assert.equal(f.find('.ca-thread-title').textContent, 'Current thread')
  assert.match(f.find('.ca-transcript').textContent, /The current transcript/)
  assert.equal(f.find('.ca-cancel').hidden, false)
  assert.equal(f.find('textarea[name="prompt"]').value, 'Unsent prompt')
  assert.equal(f.find('input[name="model"]').value, 'my-model')
  assert.equal(f.find('select[name="effort"]').value, 'high')
  assert.equal(f.find('input[name="projectPath"]').value, '/unfinished-project')
  assert.equal(f.find('input[name="title"]').value, 'Unfinished title')
  assert.equal(f.route(), 'host/instance-remote/thread/thread')
  assert.equal(f.streams.length, 1, 'the existing SSE observation is reused')
  assert.equal(f.streams[0].closed, false)
  assert.equal(f.starts().length, 0, 'an already running Agent is never reopened')
})

test('connection revisions replace the client and cancel old reads; deletion clears observation without clearing the draft', async t => {
  const f = await fixture(t, [device('remote')], 'host/instance-remote/thread/thread')
  f.find('textarea[name="prompt"]').value = 'Keep my draft'
  f.state.environment = { ...environment, executable: { error: { code: 'old-error', message: 'Obsolete environment error' } } }
  const held = f.hold(request => request.target === '/apps/claude-agent/environment')
  const old = f.mounted.setActive(true, 'select')
  await until(() => held.started, 'the old client is refreshing')
  f.state.connections = [device('remote', 2)]; f.state.environment = environment
  await f.mounted.setActive(true, 'select')
  assert.equal(held.request.signal.aborted, true)
  assert.equal(f.streams[0].closed, true, 'the old revision no longer observes the device')
  assert.equal(f.streams.length, 2)
  assert.equal(f.requests.filter(item => item.target === '/products/claude-agent').at(-1).headers['X-Anybox-Connection-Revision'], '2')
  held.release(); await old
  assert.equal(f.find('.ca-environment').hidden, true, 'a late old-revision result cannot overwrite the new environment')
  assert.equal(f.find('.ca-thread-title').textContent, 'Current thread')
  f.state.connections = []
  await f.mounted.setActive(true, 'select')
  assert.equal(f.streams[1].closed, true)
  assert.match(f.find('.ca-device-status').textContent, /尚未配置/)
  assert.equal(f.find('textarea[name="prompt"]').value, 'Keep my draft')
  assert.equal(f.find('textarea[name="prompt"]').disabled, true)
})

test('a successful capability probe withdrawing Claude support removes the current device instead of retaining it as offline', async t => {
  const f = await fixture(t, [device('remote')], 'host/instance-remote/thread/thread')
  f.find('textarea[name="prompt"]').value = 'An unsent draft'
  f.state.unsupported.add('remote')
  await f.mounted.setActive(true, 'open')
  assert.equal(f.streams[0].closed, true)
  assert.match(f.find('.ca-device-status').textContent, /1 台未安装 Claude Agent/)
  assert.equal(f.find('textarea[name="prompt"]').disabled, true)
  assert.equal(f.find('textarea[name="prompt"]').value, 'An unsent draft')
  assert.equal(f.starts().length, 0, 'unsupported devices never receive product activation')
})

test('a newer activation and deactivation supersede late connection discovery without starting the old device', async t => {
  const f = await fixture(t)
  f.state.connections = [device('old')]; f.state.product = 'disabled'
  const held = f.hold(request => request.path === `${apiBase}/connections`)
  const old = f.mounted.setActive(true, 'open')
  await until(() => held.started, 'the old discovery is in flight')
  f.state.connections = [device('new')]
  await f.mounted.setActive(true, 'select')
  assert.equal(held.request.signal.aborted, true)
  held.release(); await old
  assert.equal(f.find('.ca-device-name').textContent, 'Device new')
  assert.equal(f.starts().length, 0)
  const hidden = f.hold(request => request.target === '/products/claude-agent')
  const activating = f.mounted.setActive(true, 'open')
  await until(() => hidden.started, 'the discovered device has a pending product status read')
  await f.mounted.setActive(false, 'select')
  assert.equal(hidden.request.signal.aborted, true)
  hidden.release(); await activating
  assert.equal(f.starts().length, 0, 'a hidden view cannot start an Agent from a late product status read')
})

test('dispose cancels discovery, clears the view and waits for an already returning connection response', async t => {
  const f = await fixture(t)
  f.state.connections = [device('late')]
  const held = f.hold(request => request.path === `${apiBase}/connections`)
  const activating = f.mounted.setActive(true, 'open')
  await until(() => held.started, 'discovery started before disposal')
  let closed = false
  const disposal = f.mounted.dispose().then(() => { closed = true })
  await f.flush()
  assert.equal(held.request.signal.aborted, true)
  assert.equal(closed, false, 'disposal joins its cancelled discovery')
  assert.equal(f.container.children.length, 0)
  held.release(); await activating; await disposal
  assert.equal(f.container.children.length, 0)
  assert.equal(f.starts().length, 0)
})

test('dispose also joins an explicit start-button request and prevents its late status from starting the Agent', async t => {
  const f = await fixture(t)
  f.state.connections = [device('local')]; f.state.product = 'disabled'
  await f.mounted.setActive(true, 'select')
  const held = f.hold(request => request.target === '/products/claude-agent')
  f.fire(f.find('.ca-start'), 'click')
  await until(() => held.started, 'the explicit start is checking product state')
  let closed = false
  const disposal = f.mounted.dispose().then(() => { closed = true })
  await f.flush()
  assert.equal(held.request.signal.aborted, true)
  assert.equal(closed, false)
  held.release(); await disposal
  assert.equal(f.starts().length, 0)
  assert.equal(f.container.children.length, 0)
})
