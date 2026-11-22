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
    select(key, value) {
      const control = panel.find(el => el.tag === 'select' && el.dataset.control === key)
      assert.ok(control, key); assert.equal(control.disabled, false, key)
      control.value = value
      control.dispatchEvent(new Event('change'))
    },
    fill(key, value) {
      const control = panel.find(el => el.dataset.control === key)
      assert.ok(control, key); assert.equal(control.disabled, false, key)
      control.value = value
      control.dispatchEvent(new Event('input'))
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

test('settings manage MCP connections and adopt explicitly selected targets independently of grants', async t => {
  const dom = mountDOM(t)
  const work = { id: 'work', targetId: 'work@1', name: 'Work', endpoint: 'https://work.test/mcp', status: 'ready', toolCount: 1 }
  const workTool = { environmentId: 'mcp', targetId: work.targetId, toolId: 'search', version: '1' }
  const personal = { id: 'personal', targetId: 'personal@1', name: 'Personal', endpoint: 'https://personal.test/mcp', status: 'unverified', toolCount: 0 }
  const personalTool = { ...workTool, targetId: personal.targetId }
  const workKey = JSON.stringify(['mcp', work.id]), personalKey = JSON.stringify(['mcp', personal.id])
  const connections = [work]
  const view = { mcpManagement: true, pendingChanges: [], targets: [],
    authorization: { agentId: 'writer', revision: 3, grants: [{ tool: workTool, generation: 1 }] },
    preference: { environmentIds: ['mcp'], version: 1, toolIdsByTarget: { [workKey]: ['search'] } } }
  let session = { environmentIds: ['mcp'], version: 2, toolIdsByTarget: { [workKey]: [] } }
  const paths = []
  const api = async (path, body) => {
    paths.push(path)
    if (path === '/agents/writer/environment-access') return structuredClone({ ...view, targets: connections.filter(connection => connection.status === 'ready').map(connection =>
      ({ environmentId: 'mcp', targetId: connection.targetId, selectionId: connection.id, name: connection.name, tools: [connection === work ? workTool : personalTool] })) })
    if (path === '/mcp-connections') {
      if (!body) return structuredClone(connections)
      assert.deepEqual(body, { name: personal.name, endpoint: personal.endpoint })
      connections.push(personal)
      return structuredClone(personal)
    }
    if (path === '/mcp-connections/personal/refresh') {
      personal.status = 'ready'; personal.toolCount = 1
      return structuredClone(personal)
    }
    if (path === '/mcp-connections/personal/disable') {
      personal.status = 'disabled'
      throw new Error('响应丢失')
    }
    if (path.endsWith('/preferences')) {
      assert.deepEqual(body.toolIdsByTarget, { [workKey]: ['search'], [personalKey]: ['search'] })
      view.preference = { ...view.preference, version: 2, toolIdsByTarget: body.toolIdsByTarget }
      return view.preference
    }
    if (path === '/sessions/session-a/environments') {
      if (body) {
        assert.deepEqual(body, { environmentIds: ['mcp'], expectedVersion: 2, expectedGrantRevision: 3,
          toolIdsByTarget: { [workKey]: ['search'], [personalKey]: ['search'] } })
        session = { ...session, version: 3, toolIdsByTarget: { [workKey]: [], [personalKey]: [] } }
      }
      return structuredClone(session)
    }
    assert.fail('unexpected endpoint ' + path)
  }
  const settings = mountEnvironmentAccess(dom.panel, { api, storageKey: 'execution-a', messageFor: error => error.message,
    continuousSessionId: () => 'session-a' })
  settings.selectAgent('writer')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(dom.panel.find(el => el.dataset.control === 'mcp:transport'), undefined)
  assert.equal(dom.panel.find(el => el.tag === 'button' && el.textContent === '应用已保存的环境到后续运行').disabled, true)
  dom.fill('mcp:name', 'Personal')
  dom.fill('mcp:endpoint', 'https://personal.test/mcp')
  await dom.click('添加 MCP 连接')
  await dom.click('发现工具 · Personal')
  const pick = JSON.stringify(['pick-target', personalKey, 'search'])
  assert.equal(dom.panel.find(el => el.dataset.control === pick).checked, false)
  dom.toggle(pick, true)
  await dom.click('保存环境偏好')
  await dom.click('应用已保存的环境到后续运行')
  assert.equal(dom.panel.find(el => el.tag === 'button' && el.textContent === '应用已保存的环境到后续运行').disabled, true)
  assert.equal(paths.some(path => path.endsWith('/grants')), false)
  await dom.click('停用 · Personal')
  assert.ok(dom.panel.find(el => el.textContent === '已停用'))
  assert.ok(dom.panel.find(el => el.textContent === '响应丢失'))
  assert.equal(paths.filter(path => path === '/mcp-connections/personal/disable').length, 1)
})

test('stdio settings send argument vectors to the execution device and leave discovery explicit', async t => {
  const dom = mountDOM(t), requests = []
  let connection
  const access = { mcpManagement: true, mcpStdio: true, pendingChanges: [], targets: [],
    authorization: { agentId: 'writer', revision: 0, grants: [] }, preference: { environmentIds: [], version: 0 } }
  const api = async (path, body) => {
    if (path === '/agents/writer/environment-access') return access
    if (path === '/mcp-connections' && body === undefined) return connection ? [connection] : []
    requests.push({ path, body })
    if (path === '/mcp-connections') {
      connection = { ...body, id: 'local', targetId: 'local@1', status: 'unverified', toolCount: 0 }
      return connection
    }
    if (path === '/mcp-connections/local/refresh') {
      connection = { ...connection, status: 'ready', toolCount: 2 }
      return connection
    }
    assert.fail('unexpected endpoint ' + path)
  }
  const settings = mountEnvironmentAccess(dom.panel, { api, storageKey: 'execution-a', messageFor: error => error.message })
  settings.selectAgent('writer')
  await new Promise(resolve => setImmediate(resolve))
  dom.fill('mcp:name', 'Local server')
  dom.select('mcp:transport', 'stdio')
  assert.equal(dom.panel.find(el => el.dataset.control === 'mcp:endpoint'), undefined)
  dom.fill('mcp:command', '/opt/example tools/node')
  dom.fill('mcp:args', '["server.mjs", 2]')
  dom.fill('mcp:cwd', '/opt/example tools')
  await dom.click('添加 MCP 连接')
  assert.deepEqual(requests, [])
  assert.ok(dom.panel.find(el => el.textContent === '参数必须是 JSON 字符串数组。'))
  dom.fill('mcp:args', '["server.mjs", "", "a b", "$(literal)"]')
  await dom.click('添加 MCP 连接')
  assert.deepEqual(requests, [{ path: '/mcp-connections', body: { name: 'Local server', transport: 'stdio',
    command: '/opt/example tools/node', args: ['server.mjs', '', 'a b', '$(literal)'], cwd: '/opt/example tools' } }])
  assert.ok(dom.panel.find(el => el.textContent === 'stdio · /opt/example tools/node'))
  await dom.click('发现工具 · Local server')
  assert.deepEqual(requests.at(-1), { path: '/mcp-connections/local/refresh', body: {} })
  assert.ok(dom.panel.find(el => el.textContent === '可用 · 2 个工具'))
})
