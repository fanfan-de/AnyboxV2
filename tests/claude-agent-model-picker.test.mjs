import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mount } from '../packages/app-claude-agent/dist/web/app.js'
import { installClaudeAgentDOM } from './helpers/claude-agent-dom.mjs'

const apiBase = '/api/client/v1/apps/claude-agent', stamp = '2026-10-18T00:00:00.000Z'
const device = id => ({ id, name: `Device ${id}`, endpoint: `https://${id}.example`, instanceId: `instance-${id}`, revision: 1, credentialConfigured: true })
const available = (value, displayName = value) => ({ value, displayName, description: `Description for ${displayName}` })
async function until(check, description) {
  for (let turn = 0; turn < 100; turn++) { if (check()) return; await new Promise(resolve => setImmediate(resolve)) }
  assert.fail(`Timed out: ${description}`)
}

/** The actual app and device client run against controlled discovery responses. */
async function fixture(t, initialRoute = 'host/instance-first/thread/one') {
  const dom = installClaudeAgentDOM(t, { autoRestore: false }), originalFetch = globalThis.fetch, abort = new AbortController()
  const connections = [device('first'), device('second')], requests = [], discoveries = [], submissions = [], holds = [], listeners = new Set()
  let location = initialRoute, mounted, discover = () => Response.json({ schemaVersion: 1, models: [available('available-model', 'Available model')] })
  const thread = id => ({ schemaVersion: 1, id, projectPath: `/projects/${id}`, title: `Thread ${id}`, titleSource: 'user', nativeSessionId: 'native', createdAt: stamp, updatedAt: stamp, lastRun: null, pendingApprovals: 0 })
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), 'https://client.example'), path = url.pathname, method = init.method ?? 'GET'
    requests.push({ path, method })
    if (path === `${apiBase}/connections`) return Response.json({ connections, localInstanceId: null })
    if (path === `${apiBase}/local`) return Response.json({ instanceId: null })
    const match = new RegExp(`^${apiBase}/connections/([^/]+)/v1(.*)$`).exec(path)
    assert.ok(match, `Unexpected request: ${path}`)
    const [, deviceId, target] = match
    assert.equal(init.headers['X-Anybox-Expected-Instance-Id'], `instance-${deviceId}`)
    if (target === '/instance') return Response.json({ capabilities: ['claude-agent.v1', 'sse'] })
    if (target === '/products/claude-agent') return Response.json({ state: 'running' })
    if (target === '/apps/claude-agent/environment') return Response.json({ schemaVersion: 1, platform: 'linux', executable: { path: '/usr/bin/claude', source: 'path' } })
    if (target === '/apps/claude-agent/projects/recent') return Response.json({ schemaVersion: 1, projects: [] })
    if (target === '/apps/claude-agent/models') {
      const request = { device: deviceId, cwd: url.searchParams.get('cwd'), signal: init.signal }
      discoveries.push(request)
      return discover(request)
    }
    if (target === '/apps/claude-agent/threads') return Response.json(['one', 'two'].map(thread))
    if (target === '/apps/claude-agent/events') {
      let controller, closed = false
      const body = new ReadableStream({ start(value) { controller = value }, cancel() { closed = true } })
      init.signal.addEventListener('abort', () => { if (!closed) { closed = true; controller.error(new DOMException('Aborted', 'AbortError')) } }, { once: true })
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
    }
    const item = /^\/apps\/claude-agent\/threads\/(one|two)(?:\/(messages|runs|approvals))?$/.exec(target)
    if (item) {
      const [, id, kind] = item
      if (method === 'POST') {
        const body = JSON.parse(init.body); submissions.push({ device: deviceId, threadId: id, body })
        return Response.json({ schemaVersion: 1, id: 'new-run', threadId: id, status: 'completed', prompt: body.prompt, model: body.model ?? null, resolvedModel: null, effort: body.effort ?? null, nativeSessionId: 'native', createdAt: stamp, finishedAt: stamp, result: null, error: null })
      }
      return Response.json(kind === 'messages' ? { nativeSessionId: 'native', messages: [] } : kind === 'runs' || kind === 'approvals' ? [] : thread(id))
    }
    assert.fail(`Unexpected request: ${method} ${target}`)
  }
  t.after(async () => {
    for (const held of holds) held.release?.()
    try { await mounted?.dispose(); abort.abort(); await dom.flush() }
    finally { globalThis.fetch = originalFetch; dom.restore() }
  })
  mounted = await mount(dom.container, { appId: 'claude-agent', apiBase, signal: abort.signal, domId: id => `models-${id}`, route: {
    read: () => location,
    navigate(value) { location = value; for (const listener of listeners) listener() },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  } })
  return { ...dom, mounted, requests, discoveries, submissions,
    discover(fn) { discover = fn },
    hold(models) {
      const held = { started: false }
      holds.push(held)
      discover = async request => { held.started = true; held.request = request; const response = Response.json({ schemaVersion: 1, models }); await new Promise(resolve => { held.release = resolve }); return response }
      return held
    },
    open() { const picker = dom.find('.ca-model-picker'); picker.open = true; dom.fire(picker, 'toggle'); return picker },
    close() { const picker = dom.find('.ca-model-picker'); picker.open = false; dom.fire(picker, 'toggle') },
  }
}

test('the picker shows the current environment catalog directly and submits its selected value', async t => {
  const f = await fixture(t), held = f.hold([available('sdk-model-id', 'A model from Claude'), available('another-model', 'Another available model')])
  assert.equal(f.discoveries.length, 0, 'mounting a conversation does not start model discovery')
  f.open()
  assert.equal(f.find('.ca-model-option[data-model-value=""]').getAttribute('aria-pressed'), 'true')
  assert.match(f.find('.ca-model-status').textContent, /正在读取/)
  assert.equal(held.request.cwd, '/projects/one')
  held.release()
  await until(() => f.all('.ca-model-option').length === 3, 'all available models are visible without typing')
  assert.match(f.find('.ca-model-list').textContent, /A model from Claude/)
  assert.match(f.find('.ca-model-list').textContent, /Description for A model from Claude/)
  assert.equal(f.requests.some(request => request.path.endsWith('/models/recent')), false, 'history is never presented as current availability')
  assert.equal(f.find('datalist'), null)
  f.fire(f.find('.ca-model-option[data-model-value="sdk-model-id"]'), 'click')
  assert.equal(f.find('.ca-model-picker').open, false)
  assert.equal(f.find('.ca-model-summary').textContent, 'A model from Claude')
  assert.equal(f.find('input[name="model"]').value, 'sdk-model-id')
  assert.equal(f.find('.ca-model-option[data-model-value="sdk-model-id"]').getAttribute('aria-pressed'), 'true')
  const prompt = f.find('textarea[name="prompt"]')
  prompt.value = 'Use the selected available model'; f.fire(prompt, 'input'); f.fire(f.find('.ca-composer'), 'submit')
  await until(() => f.submissions.length === 1, 'the actual submission uses the model value')
  assert.equal(f.submissions[0].body.model, 'sdk-model-id')
  await f.flush()
  f.fire(f.find('.ca-model-option[data-model-value=""]'), 'click')
  prompt.value = 'Use the environment default'; f.fire(prompt, 'input'); f.fire(f.find('.ca-composer'), 'submit')
  await until(() => f.submissions.length === 2, 'the default selection remains usable')
  assert.equal(Object.hasOwn(f.submissions[1].body, 'model'), false)
})

test('a failed discovery explains the failure, offers retry and keeps custom model entry separate', async t => {
  const f = await fixture(t)
  f.discover(() => Response.json({ error: { code: 'models-unavailable', message: 'Sign in to Claude on this device.' } }, { status: 503 }))
  f.open()
  await until(() => f.find('.ca-model-refresh').textContent === '重试', 'a discovery failure offers an inline retry')
  assert.match(f.find('.ca-model-status').textContent, /Sign in to Claude/)
  assert.equal(f.all('.ca-model-option').length, 1, 'a failed discovery does not invent available models')
  assert.equal(f.find('.ca-model-custom').open, false, 'custom entry is secondary')
  f.discover(() => Response.json({ schemaVersion: 1, models: [available('recovered', 'Recovered catalog model')] }))
  f.fire(f.find('.ca-model-refresh'), 'click')
  await until(() => !!f.find('.ca-model-option[data-model-value="recovered"]'), 'retry loads the current environment')
  assert.equal(f.find('.ca-model-status').hidden, true)
  const custom = f.find('input[name="model"]')
  const prompt = f.find('textarea[name="prompt"]')
  prompt.value = 'An existing task draft must not be sent'; f.fire(prompt, 'input')
  custom.value = 'private-endpoint-alias'; f.fire(custom, 'input')
  assert.equal(f.find('.ca-model-summary').textContent, 'private-endpoint-alias')
  assert.equal(f.find('.ca-model-option[data-model-value="private-endpoint-alias"]'), null, 'a custom name is not added to the available catalog')
  const key = f.fire(custom, 'keydown', { key: 'Enter', isComposing: false })
  assert.equal(key.defaultPrevented, true)
  assert.equal(f.find('.ca-model-picker').open, false)
  assert.equal(f.submissions.length, 0, 'confirming a custom name never sends a prompt')
  assert.equal(prompt.value, 'An existing task draft must not be sent')
  assert.equal(f.document.activeElement, f.find('.ca-model-summary'))
})

test('the advertised default enriches the explicit default option without adding a duplicate row', async t => {
  const f = await fixture(t)
  f.discover(() => Response.json({ schemaVersion: 1, models: [available('default', 'Default (recommended)'), available('opus', 'Opus'), available('sonnet', 'Sonnet')] }))
  f.open()
  await until(() => !!f.find('.ca-model-option[data-model-value="sonnet"]'), 'the advertised catalog is visible')
  assert.equal(f.all('.ca-model-option').length, 3)
  assert.equal(f.find('.ca-model-option[data-model-value="default"]'), null, 'the SDK default alias is represented by the explicit default option')
  const option = f.find('.ca-model-option[data-model-value=""]')
  assert.match(option.textContent, /Description for Default \(recommended\)/)
  assert.equal(option.getAttribute('aria-pressed'), 'true')
  const custom = f.find('input[name="model"]')
  custom.value = 'default'; f.fire(custom, 'input')
  assert.equal(f.find('.ca-model-option[data-model-value=""]').getAttribute('aria-pressed'), 'true', 'an existing explicit default alias selects the same default row')
  assert.equal(f.find('.ca-model-summary').textContent, 'Claude 默认模型')
  f.fire(f.find('.ca-model-option[data-model-value=""]'), 'click')
  assert.equal(custom.value, '', 'choosing the default lets Claude use its current setting')
})

test('switching project threads cancels discovery and a late old catalog cannot enter the new picker', async t => {
  const f = await fixture(t), held = f.hold([available('old-project-model')])
  f.open()
  assert.equal(held.started, true)
  f.fire(f.find('button[data-thread-id="two"]'), 'click')
  await until(() => f.find('.ca-thread-title').textContent === 'Thread two', 'the second project opens')
  assert.equal(held.request.signal.aborted, true)
  f.discover(() => Response.json({ schemaVersion: 1, models: [available('new-project-model')] }))
  f.open()
  await until(() => !!f.find('.ca-model-option[data-model-value="new-project-model"]'), 'the new project catalog is loaded')
  assert.equal(f.discoveries.at(-1).cwd, '/projects/two')
  held.release(); await f.flush()
  assert.equal(f.find('.ca-model-option[data-model-value="old-project-model"]'), null)
  assert.ok(f.find('.ca-model-option[data-model-value="new-project-model"]'))
})

test('switching devices aborts an in-flight catalog and never displays models from the previous execution device', async t => {
  const f = await fixture(t), held = f.hold([available('first-device-model')])
  f.open()
  const devices = f.find('select[aria-label="执行设备"]')
  devices.value = 'second'; f.fire(devices, 'change')
  await until(() => f.find('.ca-device-name').textContent === 'Device second', 'the new execution device is selected')
  assert.equal(held.request.signal.aborted, true)
  await until(() => f.find('button[data-thread-id="one"]'), 'the second device threads load')
  f.discover(() => Response.json({ schemaVersion: 1, models: [available('second-device-model')] }))
  f.open()
  await until(() => !!f.find('.ca-model-option[data-model-value="second-device-model"]'), 'the selected device returns its catalog')
  assert.equal(f.discoveries.at(-1).device, 'second')
  held.release(); await f.flush()
  assert.equal(f.find('.ca-model-option[data-model-value="first-device-model"]'), null)
  assert.ok(f.find('.ca-model-option[data-model-value="second-device-model"]'))
})

test('closing or hiding the picker cancels discovery without displaying a stale failure', async t => {
  const f = await fixture(t), held = f.hold([available('cancelled-model')])
  f.open(); f.close()
  assert.equal(held.request.signal.aborted, true)
  held.release(); await f.flush()
  assert.equal(f.find('.ca-model-option[data-model-value="cancelled-model"]'), null)
  assert.doesNotMatch(f.find('.ca-model-status').textContent, /无法读取/)
  const hidden = f.hold([available('hidden-model')])
  f.open(); await f.mounted.setActive(false, 'select')
  assert.equal(hidden.request.signal.aborted, true)
  assert.equal(f.find('.ca-model-picker').open, false)
  hidden.release(); await f.flush()
  assert.equal(f.find('.ca-model-option[data-model-value="hidden-model"]'), null)
})

test('before choosing a project the picker discovers the current device default environment', async t => {
  const f = await fixture(t, '')
  f.open()
  await until(() => !!f.find('.ca-model-option[data-model-value="available-model"]'), 'models are available before a project is selected')
  assert.equal(f.discoveries.length, 1)
  assert.equal(f.discoveries[0].cwd, null)
})

test('Escape closes model selection, aborts its read and restores focus without changing the prompt', async t => {
  const f = await fixture(t), held = f.hold([available('late-model')]), prompt = f.find('textarea[name="prompt"]')
  prompt.value = 'Keep this task draft'; f.fire(prompt, 'input')
  const picker = f.open(), key = f.fire(picker, 'keydown', { key: 'Escape' })
  assert.equal(key.defaultPrevented, true)
  assert.equal(picker.open, false)
  assert.equal(held.request.signal.aborted, true)
  assert.equal(f.document.activeElement, f.find('.ca-model-summary'))
  held.release(); await f.flush()
  assert.equal(prompt.value, 'Keep this task draft')
  assert.equal(f.find('.ca-model-option[data-model-value="late-model"]'), null)
})
