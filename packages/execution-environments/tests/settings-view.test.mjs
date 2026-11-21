import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountEnvironmentAccess } from '../dist/settings-view.js'

class Element extends EventTarget {
  constructor(tag) { super(); this.tag = tag }
  children = []; dataset = {}; textContent = ''; disabled = false
  get firstElementChild() { return this.children[0] }
  append(...children) { this.children.push(...children) }
  replaceChildren(...children) { this.children = children }
  setAttribute(name, value) { this[name] = value }
  contains(child) { return child === this || this.children.some(el => el.contains(child)) }
  find(predicate) { return predicate(this) ? this : this.children.map(el => el.find(predicate)).find(Boolean) }
}
function mountDOM(t) {
  const original = Object.getOwnPropertyDescriptors(globalThis)
  const storage = new Map()
  Object.defineProperty(globalThis, 'document', { value: { createElement: tag => new Element(tag), activeElement: null }, configurable: true })
  Object.defineProperty(globalThis, 'sessionStorage', { value: { getItem: key => storage.get(key), setItem: (key, id) => storage.set(key, id), removeItem: key => storage.delete(key) }, configurable: true })
  t.after(() => {
    for (const name of ['sessionStorage', 'document']) {
      if (original[name]) Object.defineProperty(globalThis, name, original[name])
      else delete globalThis[name]
    }
  })
  const panel = new Element('main')
  return {
    panel,
    async click(label) {
      const control = panel.find(el => el.tag === 'button' && el.textContent === label)
      assert.ok(control, label); assert.equal(control.disabled, false, label)
      control.dispatchEvent(new Event('click'))
      await new Promise(resolve => setImmediate(resolve))
    },
    toggle(key, selected) {
      const control = panel.find(el => el.dataset.control === key)
      assert.ok(control, key); assert.equal(control.disabled, false, key)
      control.checked = selected
      control.dispatchEvent(new Event('change'))
    },
  }
}

test('settings maintain separate grants, preferences and continuous adoption across an uncertain revoke response', async t => {
  const dom = mountDOM(t), calls = []
  const tool = { environmentId: 'notes', targetId: 'workspace:1', toolId: 'read', version: '1' }
  let access = { pendingChanges: [], targets: [{ environmentId: 'notes', targetId: 'workspace:1', name: 'Work notes', tools: [tool] }],
    authorization: { agentId: 'writer', revision: 4, grants: [{ tool, generation: 2 }] },
    preference: { version: 1, environmentIds: [] } }
  let session = { environmentIds: [], version: 5 }, pending
  const api = async (path, body) => {
    calls.push({ path, body })
    if (path === '/agents/writer/environment-access') return structuredClone({ ...access,
      pendingChanges: pending && pending.state !== 'completed' ? [pending] : [] })
    if (path.endsWith('/preferences')) {
      assert.equal(body.expectedVersion, 1)
      access.preference = { environmentIds: body.environmentIds, toolIdsByEnvironment: body.toolIdsByEnvironment, version: 2 }
      return access.preference
    }
    if (path === '/sessions/session-a/environments') {
      if (body) {
        assert.deepEqual(body, { environmentIds: ['notes'], expectedVersion: 5, expectedGrantRevision: 4 })
        session = { environmentIds: body.environmentIds, version: 6 }
      }
      return session
    }
    if (path.endsWith('/grants')) {
      assert.equal(body.expectedRevision, 4)
      assert.deepEqual(body.tools, [])
      pending = { requestId: body.requestId, revision: 5, agentId: 'writer', state: 'draining', affectedCount: 1, pendingCount: 1, unknownCount: 0 }
      access.authorization = { agentId: 'writer', revision: 5, grants: [] }
      throw new Error('connection lost')
    }
    if (path.endsWith('/changes/' + pending.requestId)) return structuredClone(pending)
    assert.fail('unexpected endpoint ' + path)
  }
  const options = { api, storageKey: 'execution-a', messageFor: error => error.message, continuousSessionId: () => 'session-a' }
  const view = mountEnvironmentAccess(dom.panel, options)
  view.selectAgent('writer')
  assert.equal(view.canLeave(), true, 'a background read is disposable')
  await new Promise(resolve => setImmediate(resolve))
  dom.toggle('env:notes', true)
  dom.toggle('all:notes', false)
  assert.equal(view.canLeave(), false)
  await dom.click('保存环境偏好')
  assert.deepEqual(access.preference.toolIdsByEnvironment, { notes: [] })
  assert.deepEqual(access.authorization.grants[0].tool, tool)
  assert.deepEqual(session.environmentIds, [])
  await dom.click('应用已保存的环境到后续运行')
  assert.deepEqual(session.environmentIds, ['notes'])
  dom.toggle(JSON.stringify(['notes', 'workspace:1', 'read', '1']), false)
  await dom.click('保存授权')
  assert.ok(pending.requestId)
  view.dispose()
  const reopened = mountEnvironmentAccess(dom.panel, options)
  reopened.selectAgent('writer')
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(dom.panel.find(el => el.textContent.includes('等待退出 1 项')))
  assert.equal(dom.panel.find(el => el.dataset.control === JSON.stringify(['notes', 'workspace:1', 'read', '1'])).disabled, false,
    'a known draining operation allows other grant edits')
  pending = { ...pending, state: 'completed', pendingCount: 0 }
  await dom.click('查看原变更进度')
  assert.ok(dom.panel.find(el => el.textContent.includes('授权变更已完成')))
  assert.equal(calls.filter(call => call.path.endsWith('/grants') && call.body).length, 1)
  assert.equal(reopened.canLeave(), true)
})
