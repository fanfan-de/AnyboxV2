import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setupConnections } from '../packages/app-harness/dist/web/connections-view.js'

class Element extends EventTarget {
  hidden = false
  disabled = false
  value = ''
  textContent = ''
  children = []
  nodes = new Map()
  append(...children) { this.children.push(...children) }
  replaceChildren(...children) { this.children = children }
  querySelector(selector) { return this.nodes.get(selector) }
  querySelectorAll() { return [] }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')) }
}
const flush = () => new Promise(resolve => setImmediate(resolve))
function viewFixture(t, connections = [], options = {}) {
  const root = new Element(), panel = new Element(), form = new Element(), dialog = new Element(), select = new Element()
  const fields = new Map(['name', 'endpoint', 'token'].map(name => [name, new Element()]))
  form.elements = { namedItem: name => fields.get(name) }
  for (const name of ['list', 'status', 'local', 'local-status', 'local-retry', 'new', 'heading', 'tokens', 'computer', 'attachments']) panel.nodes.set(`[data-${name}]`, new Element())
  panel.nodes.set('[data-form]', form)
  root.nodes.set('#agent--harness-select', select); root.nodes.set('#agent--settings-dialog', dialog); root.nodes.set('#agent--connections-settings', panel)
  const connectionSection = new Element(), openSettings = new Element()
  root.nodes.set('[data-settings-section="connections"]', connectionSection); root.nodes.set('#agent--open-settings', openSettings)
  let selectedSection
  connectionSection.addEventListener('click', () => { selectedSection = 'connections' })
  openSettings.addEventListener('click', () => { dialog.open = true })
  let state = { enabled: true, state: 'pending', instanceId: 'local', connectionId: null }, reads = 0, changes = 0, retries = 0
  const changedConnections = [], targetRequests = [], values = new Map()
  const previousDocument = globalThis.document, previousFetch = globalThis.fetch, previousStorage = globalThis.sessionStorage
  globalThis.document = { createElement: () => new Element() }
  globalThis.sessionStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  globalThis.fetch = async (url, options) => {
    if (url === '/api/client/v1/local/retry') { assert.equal(options.method, 'POST'); retries++; return Response.json(state) }
    assert.equal(url, '/api/client/v1/local'); reads++
    return Response.json({ status: state })
  }
  const api = { connections, forConnection: id => async (path, body) => { targetRequests.push({ id, path, body }); return path === '/instance' ? { capabilities: [] } : {} } }
  const view = setupConnections(root, api, options.selectedId, () => 'error', options.canLeave ?? (() => true), connection => { changes++; changedConnections.push(connection) }, '/api/client/v1', () => {})
  t.after(async () => { await view.dispose(); globalThis.document = previousDocument; globalThis.fetch = previousFetch; if (previousStorage === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = previousStorage })
  return { view, fields, panel, select, dialog, changedConnections, targetRequests, values, setState(value) { state = value }, get selectedSection() { return selectedSection }, get reads() { return reads }, get changes() { return changes }, get retries() { return retries } }
}

test('pending-to-ready bootstrap keeps observing while unsaved input prevents rebuilding, then refreshes safely', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = viewFixture(t)
  await flush(); f.view.setActive(true); await flush()
  f.fields.get('name').value = 'unsaved connection'
  f.setState({ enabled: true, state: 'ready', instanceId: 'local', connectionId: 'saved', connectionRevision: 1 })
  t.mock.timers.tick(500); await flush()
  assert.equal(f.changes, 0)
  f.fields.get('name').value = ''
  t.mock.timers.tick(5000); await flush()
  assert.equal(f.changes, 1)
  const reads = f.reads
  f.view.setActive(false); t.mock.timers.tick(10000); await flush()
  assert.equal(f.reads, reads)
})

test('an explicitly restarted local worker refreshes a changed ready revision without issuing a pairing request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = viewFixture(t, [{ id: 'saved', name: 'Local', endpoint: 'http://127.0.0.1:12345', instanceId: 'local', revision: 1 }])
  f.setState({ enabled: true, state: 'ready', instanceId: 'local', connectionId: 'saved', connectionRevision: 1 })
  await flush(); f.view.setActive(true); await flush()
  assert.equal(f.changes, 0)
  f.setState({ enabled: true, state: 'ready', instanceId: 'local', connectionId: 'saved', connectionRevision: 2 })
  t.mock.timers.tick(5000); await flush()
  assert.equal(f.changes, 1)
  assert.ok(f.reads >= 2)
})

test('ordinary Web mode does not start desktop status timers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = viewFixture(t)
  f.setState(undefined); await flush(); f.view.setActive(true); await flush()
  const reads = f.reads
  t.mock.timers.tick(20000); await flush()
  assert.equal(f.reads, reads); assert.equal(f.changes, 0)
})

test('a stopped local service offers an explicit start; observation and unsaved forms never start it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = viewFixture(t)
  f.setState({ enabled: true, state: 'disabled', instanceId: null, connectionId: null })
  await flush(); f.view.setActive(true); await flush()
  const button = f.panel.nodes.get('[data-local-retry]')
  assert.equal(button.hidden, false); assert.equal(button.textContent, '启动本机服务')
  assert.equal(f.panel.nodes.get('[data-local]').hidden, false)
  t.mock.timers.tick(5000); await flush(); assert.equal(f.retries, 0)
  f.fields.get('name').value = 'unsaved'
  button.dispatchEvent(new Event('click')); await flush(); assert.equal(f.retries, 0)
  f.fields.get('name').value = ''
  f.setState({ enabled: true, state: 'ready', instanceId: 'local', connectionId: 'saved', connectionRevision: 1 })
  button.dispatchEvent(new Event('click')); await flush()
  assert.equal(f.retries, 1); assert.equal(f.panel.nodes.get('[data-local]').hidden, true)
})

const devices = [
  { id: 'local', name: 'Local', endpoint: 'http://127.0.0.1:12345', instanceId: 'local-instance', revision: 1 },
  { id: 'remote', name: 'Remote', endpoint: 'https://remote.example', instanceId: 'remote-instance', revision: 1 },
]

test('settings and sidebar use the same guarded selection without starting the new device', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let allowed = false
  const f = viewFixture(t, devices, { selectedId: 'local', canLeave: () => allowed })
  f.setState(undefined); await flush()
  assert.equal(f.view.selectConnection('remote'), false)
  assert.equal(f.select.value, 'local'); assert.equal(f.changes, 0)
  assert.equal(f.values.has('anybox.client.selected'), false)
  allowed = true
  f.select.value = 'remote'; f.select.dispatchEvent(new Event('change'))
  assert.equal(f.select.value, 'remote')
  assert.deepEqual(f.changedConnections, [devices[1]])
  assert.equal(f.values.get('anybox.client.selected'), 'remote')
  assert.ok(f.targetRequests.every(request => request.body === undefined), 'device selection only observes target state')
  assert.equal(f.retries, 0)
})

test('a hidden connection draft blocks the shared settings selector and reveals its form', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = viewFixture(t, devices, { selectedId: 'local' })
  f.setState(undefined); await flush()
  assert.equal(f.dialog.open, undefined)
  f.fields.get('name').value = 'Unsaved connection'
  assert.equal(f.view.selectConnection('remote'), false)
  assert.equal(f.select.value, 'local'); assert.equal(f.changes, 0)
  assert.equal(f.selectedSection, 'connections'); assert.equal(f.dialog.open, true)
  assert.match(f.panel.nodes.get('[data-status]').textContent, /保存或放弃尚未保存的连接修改/)
  f.fields.get('name').value = ''
  assert.equal(f.view.selectConnection('remote'), true)
  assert.deepEqual(f.changedConnections, [devices[1]])
})

test('unchanged, unknown and disposed device selections cannot trigger replacement or new work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = viewFixture(t, devices, { selectedId: 'local' })
  f.setState(undefined); await flush()
  assert.equal(f.view.selectConnection('local'), true)
  assert.equal(f.view.selectConnection('unknown'), false)
  assert.equal(f.changes, 0)
  await f.view.dispose()
  assert.equal(f.view.selectConnection('remote'), false)
  f.select.value = 'remote'; f.select.dispatchEvent(new Event('change'))
  assert.equal(f.changes, 0)
  assert.equal(f.values.has('anybox.client.selected'), false)
  assert.ok(f.targetRequests.every(request => request.body === undefined))
})
