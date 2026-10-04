import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setupConnections } from '../dist/applications/harness/web/connections-view.js'

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
}
const flush = () => new Promise(resolve => setImmediate(resolve))
function viewFixture(t, connections = []) {
  const root = new Element(), panel = new Element(), form = new Element(), dialog = new Element(), select = new Element()
  const fields = new Map(['name', 'endpoint', 'token'].map(name => [name, new Element()]))
  form.elements = { namedItem: name => fields.get(name) }
  for (const name of ['list', 'status', 'local', 'local-status', 'local-retry', 'new', 'heading', 'tokens']) panel.nodes.set(`[data-${name}]`, new Element())
  panel.nodes.set('[data-form]', form)
  root.nodes.set('#agent--harness-select', select); root.nodes.set('#agent--settings-dialog', dialog); root.nodes.set('#agent--connections-settings', panel)
  let state = { enabled: true, state: 'pending', instanceId: 'local', connectionId: null }, reads = 0, changes = 0
  const previousDocument = globalThis.document, previousFetch = globalThis.fetch
  globalThis.document = { createElement: () => new Element() }
  globalThis.fetch = async url => {
    assert.equal(url, '/api/client/v1/local'); reads++
    return Response.json({ status: state })
  }
  const api = { connections, forConnection: () => async path => path === '/instance' ? { capabilities: [] } : {} }
  const view = setupConnections(root, api, undefined, () => 'error', () => true, () => { changes++ }, '/api/client/v1', () => {})
  t.after(async () => { await view.dispose(); globalThis.document = previousDocument; globalThis.fetch = previousFetch })
  return { view, fields, setState(value) { state = value }, get reads() { return reads }, get changes() { return changes } }
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
