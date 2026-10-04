import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSessionDefaultsClient, defaultModelDescription, setupSessionDefaults } from '../dist/applications/harness/web/session-defaults-client.js'

const settle = () => new Promise(resolve => setImmediate(resolve))
const defaults = (agentId, modelId = null, revision = 0, fallbackModelId = 'startup') =>
  ({ agentId, modelId, revision, fallbackModelId, effectiveModelId: modelId ?? fallbackModelId })
function fixture() {
  const requests = []
  const client = createSessionDefaultsClient((path, body, signal) => new Promise((resolve, reject) => requests.push({ path, body, signal, resolve, reject })), error => error.message)
  return { client, requests }
}

test('late reads from another Agent or an older reload cannot replace the current settings', async () => {
  const { client, requests } = fixture()
  client.selectAgent('first'); client.selectAgent('second'); await settle()
  requests[1].resolve(defaults('second', 'second-model')); await settle()
  requests[0].resolve(defaults('first', 'first-model')); await settle()
  assert.equal(client.snapshot().agentId, 'second')
  assert.equal(client.snapshot().modelId, 'second-model')
  const older = client.reload(), newer = client.reload(); await settle()
  requests[3].resolve(defaults('second', 'new-model', 2)); await newer
  requests[2].resolve(defaults('second', 'old-model', 1)); await older
  assert.equal(client.snapshot().modelId, 'new-model')
  assert.equal(client.snapshot().defaults.revision, 2)
  await client.dispose()
})

test('saving the default captures its Agent and revision without modifying a session selection', async () => {
  const { client, requests } = fixture()
  client.selectAgent('first'); await settle(); requests[0].resolve(defaults('first', null, 4)); await settle()
  client.selectModel('selected-config')
  const saving = client.save(); client.selectAgent('second'); await settle()
  assert.deepEqual(requests[1].body, { modelId: 'selected-config', expectedRevision: 4 })
  assert.equal(requests[1].path, '/agents/first/session-defaults')
  requests[2].resolve(defaults('second', 'other-config')); await settle()
  requests[1].resolve(defaults('first', 'selected-config', 5)); await saving
  assert.equal(client.snapshot().modelId, 'other-config')
  client.selectAgent('first')
  assert.equal(client.snapshot().modelId, 'selected-config')
  assert.equal(client.snapshot().dirty, false)
  client.selectModel(null)
  const clearing = client.save(); await settle()
  assert.deepEqual(requests[3].body, { modelId: null, expectedRevision: 5 })
  requests[3].resolve(defaults('first', null, 6)); await clearing
  assert.equal(client.snapshot().defaults.effectiveModelId, 'startup')
  assert.ok(requests.every(request => !request.path.includes('/sessions/')))
  await client.dispose()
})

test('revision conflicts retain the draft and require an explicit reload', async () => {
  const { client, requests } = fixture()
  client.selectAgent('agent'); await settle(); requests[0].resolve(defaults('agent', 'original', 1)); await settle()
  client.selectModel('draft')
  const saving = client.save(); await settle()
  requests[1].reject(Object.assign(new Error('conflict'), { code: 'session-defaults-conflict' })); await saving
  assert.equal(client.snapshot().modelId, 'draft')
  assert.equal(client.snapshot().dirty, true)
  assert.equal(client.snapshot().conflict, true)
  assert.match(client.snapshot().notice, /当前选择已保留/)
  await client.save(); assert.equal(requests.length, 2)
  const reloading = client.reload(); await settle(); requests[2].resolve(defaults('agent', 'latest', 2)); await reloading
  assert.equal(client.snapshot().modelId, 'latest')
  assert.equal(client.snapshot().conflict, false)
  assert.equal(client.canLeave(), true)
  await client.dispose()
})

test('switching Agent keeps unfinished selections and disposal waits for submitted writes', async () => {
  const { client, requests } = fixture()
  client.selectAgent('first'); await settle(); requests[0].resolve(defaults('first')); await settle()
  client.selectModel('draft'); client.selectAgent('second'); await settle()
  requests[1].resolve(defaults('second')); await settle()
  assert.equal(client.canLeave(), false)
  assert.equal(client.snapshot().agentId, 'first')
  assert.equal(client.snapshot().modelId, 'draft')
  const saving = client.save(); await settle()
  let disposed = false
  const closing = client.dispose().then(() => { disposed = true }); await settle()
  assert.equal(disposed, false)
  assert.equal(requests[2].signal.aborted, false)
  requests[2].resolve(defaults('first', 'draft', 1)); await saving; await closing
  assert.equal(disposed, true)
})

test('default descriptions keep unavailable choices and never substitute another configuration', () => {
  const models = [{ id: 'disabled', name: 'Saved', connectionId: 'account', available: false, unavailableReason: 'credential-missing' },
    { id: 'ready', name: 'Ready', connectionId: 'other', available: true }]
  const providers = [{ id: 'account', name: 'Work' }, { id: 'other', name: 'Personal' }]
  assert.match(defaultModelDescription('disabled', models, providers), /Work · Saved：尚未配置 Key/)
  assert.match(defaultModelDescription('missing', models, providers), /原默认模型已不可用/)
  assert.doesNotMatch(defaultModelDescription('missing', models, providers), /Ready/)
  assert.match(defaultModelDescription(null, models, providers), /需先选择模型/)
})

test('settings translate scoped Agent choices to the fixed device API and restore the scoped draft selection', async () => {
  const instance = '00000000-0000-0000-0000-000000000001', scoped = id => `h:${instance}:${id}`
  class Element {
    constructor() { this.value = ''; this.listeners = new Map(); this.options = [] }
    addEventListener(name, listener) { this.listeners.set(name, listener) }
    replaceChildren(...children) { this.options = children.flatMap(child => child.options ?? [child]) }
    append(child) { this.options.push(child) }
  }
  const previousDocument = globalThis.document
  globalThis.document = { createElement: () => new Element() }
  const elements = new Map(['[data-default-model]', '[data-save-session-defaults]', '[data-reload-session-defaults]',
    '[data-session-defaults-notice]', '[data-default-model-hint]'].map(selector => [selector, new Element()]))
  for (const element of elements.values()) element.dataset = {}
  const agentSelect = new Element(); agentSelect.options = ['first', 'second'].map(id => ({ value: scoped(id) }))
  const requests = []
  const settings = setupSessionDefaults(async (path, body) => {
    requests.push({ path, body }); return defaults(decodeURIComponent(path.split('/')[2]), null, 0, null)
  }, error => error.message, { snapshot: () => ({ models: [], providers: [], loading: false }), subscribe: () => () => {} },
  { querySelector: selector => elements.get(selector) }, agentSelect)
  try {
    settings.selectAgent(scoped('first')); await settle()
    assert.equal(requests[0].path, '/agents/first/session-defaults')
    const select = elements.get('[data-default-model]'); select.value = 'draft'; select.listeners.get('change')()
    settings.selectAgent(scoped('second')); await settle()
    assert.equal(settings.canLeave(), false)
    assert.equal(agentSelect.value, scoped('first'))
  } finally { await settings.dispose(); globalThis.document = previousDocument }
})
