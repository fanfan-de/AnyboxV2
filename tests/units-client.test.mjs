import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setupUnitsSettings, setupLocalAttachments, parseGrantList, computerScope, describeAttachment, describeLocalAttachment } from '../packages/app-harness/dist/web/units-client.js'
import { setupUnitsSettings as setupPersonalUnitsSettings } from '../packages/app-personal-agent/dist/web/units-client.js'
import { allowedProxyPath } from '../packages/app-harness/dist/client/gateway.js'

class Element extends EventTarget {
  hidden = false; disabled = false; open = false; value = ''; textContent = ''; className = ''; children = []; dataset = {}
  constructor(tagName) { super(); this.tagName = tagName }
  append(...children) { this.children.push(...children) }
  replaceChildren(...children) { this.children = children }
  focus() {}
  setAttribute(name, value) {
    this[name] = value
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value
  }
  find(predicate) { for (const child of this.children) { if (predicate(child)) return child; const nested = child.find?.(predicate); if (nested) return nested } return undefined }
}
const flush = async () => { for (let n = 0; n < 5; n++) await new Promise(resolve => setImmediate(resolve)) }
function dom(t) {
  const previous = globalThis.document
  globalThis.document = { createElement: tagName => new Element(tagName) }
  t.after(() => { globalThis.document = previous })
}
function api(handlers) {
  const calls = []
  const source = async (path, body) => { calls.push({ path, body }); const handler = handlers[path]; if (!handler) throw Object.assign(new Error('not-found'), { status: 404, code: 'not-found' }); return handler(body) }
  return { source, calls }
}
const messageFor = error => `message:${error?.code ?? 'unknown'}`
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

for (const [app, setup] of [['Harness', setupUnitsSettings], ['Personal Agent', setupPersonalUnitsSettings]]) {
  test(`${app} keeps local Computer management in execution settings without a selected connection`, async t => {
    dom(t)
    const pending = deferred()
    const { source, calls } = api({
      '/computer/status': () => ({ state: 'running', supported: true, workerId: 'local-worker', attachments: [] }),
      '/computer/attachments': () => pending.promise,
    })
    const panel = new Element(), view = setup(undefined, messageFor, panel, source)
    t.after(async () => { pending.resolve({ attachmentId: 'accepted' }); await view.dispose() })
    const control = () => panel.find(node => node.tagName === 'button' && node.textContent === '管理本机 Computer worker')
    const codeField = () => panel.find(node => node.type === 'password')
    const openLocalWorker = async () => {
      assert.ok(control(), 'execution settings contains the client-local Computer worker entry')
      control().dispatchEvent(new Event('click'))
      await flush()
      assert.ok(panel.find(node => node.textContent === '运行中'))
    }
    assert.ok(panel.find(node => node.textContent === '执行环境'))
    assert.deepEqual(calls, [], 'mounting the settings does not start or query the worker')
    await openLocalWorker()
    const sharing = panel.find(node => node.tagName === 'details' && node.find(child => child.textContent === '连接到其他执行设备'))
    assert.ok(sharing)
    assert.equal(sharing.open, false, 'sharing is collapsed even when the worker is running')
    sharing.open = true
    const draft = codeField()
    draft.value = 'unsent-code'
    sharing.open = false
    sharing.dispatchEvent(new Event('toggle'))
    assert.equal(draft.value, '', 'collapsing sharing clears a typed attachment code')
    draft.value = 'another-unsent-code'
    await view.closeLocalComputer()
    assert.equal(draft.value, '', 'closing settings clears a typed attachment code')
    assert.deepEqual(calls.map(call => call.path), ['/computer/status'])

    await openLocalWorker()
    const code = codeField()
    code.value = 'one-time-code'
    panel.find(node => node.type === 'url').value = 'https://remote.example'
    const form = panel.find(node => node.tagName === 'form' && node.find(child => child === code))
    assert.ok(form)
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()
    assert.equal(view.canLeave(), false, 'an accepted attachment blocks leaving the page')
    assert.equal(code.value, '')
    assert.deepEqual(calls.find(call => call.path === '/computer/attachments'), {
      path: '/computer/attachments', body: { harnessUrl: 'https://remote.example', code: 'one-time-code', ceiling: computerScope([], []) },
    })
    let exited = false
    const closing = view.closeLocalComputer().then(() => { exited = true })
    await flush()
    assert.equal(exited, false, 'closing the settings still owns the accepted local request')
    assert.equal(view.canLeave(), false, 'a closed panel still protects the pending write')
    pending.resolve({ attachmentId: 'accepted' })
    await closing
    assert.equal(view.canLeave(), true)
    assert.ok(calls.every(call => call.path.startsWith('/computer/')), 'only client-local worker routes are used')
  })

  test(`${app} prioritizes the selected execution device and hides codes when settings close`, async t => {
    dom(t)
    const pending = deferred()
    const environment = { environmentId: 'local:computer', origin: 'local', state: 'approved', unitId: 'computer-local', connectionState: 'on-demand' }
    const { source } = api({
      '/units/attachments': () => [],
      '/computer-environments': () => ({ defaultEnvironmentId: environment.environmentId, environments: [environment] }),
      '/tool-environments': () => [{ environmentId: 'mcp', targetId: 'mcp-notes', name: 'Notes', agents: [], tools: [{ toolId: 'notes.read' }] }],
      '/units/attach-codes': () => pending.promise,
    })
    const local = api({ '/computer/status': () => ({ state: 'stopped', supported: true, attachments: [] }) })
    const panel = new Element(), view = setup(source, messageFor, panel, local.source)
    t.after(async () => { pending.resolve({ attachment: {}, code: 'one-time-code' }); await view.dispose() })
    await flush()
    const sections = panel.children.filter(node => node.className.split(' ').includes('execution-environment-section'))
    assert.equal(sections.length, 3)
    assert.ok(sections[0].find(node => node.dataset.attachmentId === 'local:computer'))
    assert.ok(sections[1].find(node => node.tagName === 'summary' && node.textContent.includes('Notes')))
    assert.ok(sections[2].find(node => node.textContent === '管理本机 Computer worker'))
    assert.deepEqual(local.calls, [])
    const connecting = sections[0].find(node => node.tagName === 'details' && node.find(child => child.textContent === '接入另一台电脑'))
    assert.equal(connecting?.open, false)
    connecting.open = true
    const issuing = view.issue({ projects: [], tools: [] })
    await flush()
    await view.close()
    pending.resolve({ attachment: {}, code: 'one-time-code' })
    assert.equal(await issuing, 'one-time-code')
    assert.equal(view.snapshot().code, '')
    assert.equal(connecting.open, false)
    assert.equal(panel.find(node => node.textContent.includes('one-time-code')), undefined)
  })
}

test('closing an attachment view drops its code immediately and joins writes without clearing a replacement view', async t => {
  dom(t)
  const pending = deferred(), section = new Element()
  const old = setupLocalAttachments(async (_path, body) => body ? pending.promise : { state: 'running', supported: true, attachments: [] }, messageFor, section, 'Old device')
  let replacement, closing, submitted
  t.after(async () => { pending.resolve({ attachmentId: 'old' }); await Promise.allSettled([submitted, closing, old.dispose(), replacement?.dispose()]) })
  await flush()
  const codeInput = section.find(node => node.type === 'password'); codeInput.value = 'one-time-code'
  assert.equal(old.canLeave(), true)
  submitted = old.attach({ harnessUrl: 'https://remote.example', code: codeInput.value, projects: [], tools: [] })
  assert.equal(old.canLeave(), false, 'a submitted attachment must finish before switching devices')
  await flush()
  let closed = false
  closing = old.dispose().then(() => { closed = true })
  assert.equal(codeInput.value, '', 'closing drops the typed secret before the write exits')
  assert.equal(closed, false)
  replacement = setupLocalAttachments(async () => ({ state: 'running', supported: true, attachments: [] }), messageFor, section, 'New device')
  await flush()
  const replacementNodes = [...section.children]
  pending.resolve({ attachmentId: 'old' })
  await Promise.allSettled([submitted, closing])
  assert.equal(closed, true)
  assert.deepEqual(section.children, replacementNodes, 'old cleanup cannot remove the new view')
  await old.dispose()
  assert.deepEqual(section.children, replacementNodes, 'repeated old cleanup remains harmless')
})

test('a closed units settings view joins code issuance without publishing its late secret or clearing its replacement', async t => {
  dom(t)
  const pending = deferred(), panel = new Element()
  const old = setupUnitsSettings(async (_path, body) => body ? pending.promise : [], messageFor, panel)
  let replacement, closing, issuing
  t.after(async () => { pending.resolve({ attachment: {}, code: 'late-secret' }); await Promise.allSettled([issuing, closing, old.dispose(), replacement?.dispose()]) })
  await flush()
  assert.equal(old.canLeave(), true)
  issuing = old.issue({ projects: [], tools: [] })
  assert.equal(old.canLeave(), false, 'a submitted one-time code must finish before switching devices')
  await flush()
  let closed = false
  closing = old.dispose().then(() => { closed = true })
  assert.equal(closed, false)
  replacement = setupUnitsSettings(async () => [], messageFor, panel)
  await flush()
  const replacementNodes = [...panel.children]
  pending.resolve({ attachment: {}, code: 'late-secret' })
  await Promise.allSettled([issuing, closing])
  assert.equal(closed, true)
  assert.equal(old.snapshot().code, '')
  assert.deepEqual(panel.children, replacementNodes)
  assert.equal(JSON.stringify(panel).includes('late-secret'), false)
  await old.dispose()
  assert.deepEqual(panel.children, replacementNodes)
})

test('grant lists and scopes are pure and attachment descriptions stay free of secrets', () => {
  assert.deepEqual(parseGrantList(' /a\n/b,/a , '), ['/a', '/b'])
  assert.deepEqual(computerScope([], []), { kind: 'computer', projects: 'all', tools: 'all' })
  assert.deepEqual(computerScope(['/a'], ['anybox.bash']), { kind: 'computer', projects: ['/a'], tools: ['anybox.bash'] })
  const text = describeAttachment({ attachmentId: 'a', unitKind: 'computer', origin: 'remote', state: 'approved', unitId: 'laptop', epoch: 2, scope: { kind: 'computer', projects: ['/work'], tools: 'all' }, requestedScope: { kind: 'computer', projects: ['/work'], tools: 'all' } })
  assert.ok(text.includes('laptop') && text.includes('/work') && text.includes('epoch 2'))
  assert.ok(describeLocalAttachment({ attachmentId: 'a', harnessUrl: 'https://h.example', instanceId: 'i', state: 'approved', connection: 'offline', lastError: 'unit-unreachable', ceiling: { kind: 'computer', projects: 'all', tools: 'all' } }).includes('离线'))
})

test('the owner-side units settings list, issue one-time codes and revoke through the fixed device API', async t => {
  dom(t)
  let attachments = [{ attachmentId: 'local:computer', unitKind: 'computer', origin: 'local', state: 'approved', unitId: 'computer-local', epoch: 1, scope: { kind: 'computer', projects: 'all', tools: 'all' }, requestedScope: { kind: 'computer', projects: 'all', tools: 'all' } }]
  const { source, calls } = api({
    '/units/attachments': () => attachments,
    '/computer-environments': () => ({ defaultEnvironmentId: 'local:computer', environments: attachments.filter(a => a.unitKind === 'computer').map(a => ({ environmentId: a.attachmentId, origin: a.origin, state: a.state, unitId: a.unitId, platform: null, architecture: null, connectionState: a.state === 'approved' ? a.origin === 'local' ? 'on-demand' : 'offline' : a.state })) }),
    '/units/attach-codes': body => { const attachment = { attachmentId: 'remote-1', unitKind: body.unitKind, origin: 'remote', state: 'pending', unitId: null, epoch: 1, scope: null, requestedScope: body.scope }; attachments = [...attachments, attachment]; return { attachment, code: 'secret-code' } },
    '/units/attachments/remote-1/revoke': () => { attachments = attachments.map(a => a.attachmentId === 'remote-1' ? { ...a, state: 'revoked', epoch: 2 } : a); return attachments[1] },
  })
  const panel = new Element()
  const view = setupUnitsSettings(source, messageFor, panel)
  t.after(() => view.dispose())
  await flush()
  assert.equal(view.snapshot().attachments.length, 1)
  assert.ok(panel.find(node => node.textContent === '本机（默认）')); assert.ok(panel.find(node => node.textContent === '执行环境'))
  const code = await view.issue({ projects: ['/work'], tools: [] })
  assert.equal(code, 'secret-code')
  assert.deepEqual(calls.find(call => call.path === '/units/attach-codes'), { path: '/units/attach-codes', body: { unitKind: 'computer', scope: { kind: 'computer', projects: ['/work'], tools: 'all' } } })
  assert.ok(panel.find(node => typeof node.textContent === 'string' && node.textContent.includes('secret-code')), 'the code is shown once after issuing')
  assert.equal(view.snapshot().attachments.length, 2)
  const row = panel.find(node => node.dataset?.attachmentId === 'remote-1')
  assert.ok(row); assert.ok(row.find(node => node.textContent === '撤销附着'), 'remote attachments can be revoked')
  assert.equal(panel.find(node => node.dataset?.attachmentId === 'local:computer').find(node => node.textContent === '撤销附着'), undefined, 'local attachments cannot be revoked')
  await view.revoke('remote-1')
  assert.equal(view.snapshot().attachments[1].state, 'revoked')
  assert.ok(calls.some(call => call.path === '/units/attachments/remote-1/revoke'))
  const failing = api({ '/units/attachments': () => { throw Object.assign(new Error('closed'), { status: 503, code: 'unit-attachments-closed' }) }, '/computer-environments': () => ({ defaultEnvironmentId: 'local:computer', environments: [] }) })
  const broken = setupUnitsSettings(failing.source, messageFor, new Element())
  t.after(() => broken.dispose())
  await flush()
  assert.equal(broken.snapshot().notice, 'message:unit-attachments-closed')
})

test('the device-owner attachment entry consumes codes with explicit ceilings and revokes locally', async t => {
  dom(t)
  let attachments = []
  const { source, calls } = api({
    '/computer/status': () => ({ state: 'running', supported: true, workerId: 'worker', attachments }),
    '/computer/attachments': body => {
      if (body.code !== 'good') throw Object.assign(new Error('unit-code-invalid'), { status: 409, code: 'unit-code-invalid' })
      const attached = { attachmentId: 'remote-1', harnessUrl: body.harnessUrl, instanceId: 'remote-instance', state: 'approved', ceiling: body.ceiling, connection: 'connecting', lastError: null }
      attachments = [attached]; return attached
    },
    '/computer/attachments/remote-1/permissions': body => { attachments = attachments.map(a => ({ ...a, ceiling: body.ceiling })); return attachments[0] },
    '/computer/attachments/remote-1/revoke': () => { attachments = attachments.map(a => ({ ...a, state: 'revoked', connection: 'revoked' })); return attachments[0] },
  })
  const section = new Element()
  const view = setupLocalAttachments(source, messageFor, section, 'Laptop')
  t.after(() => view.dispose())
  await flush()
  assert.ok(section.find(node => node.textContent === '尚未连接到其他执行设备。'))
  await assert.rejects(view.attach({ harnessUrl: 'https://h.example', code: 'bad', projects: [], tools: [] }), { code: 'unit-code-invalid' })
  assert.equal(view.snapshot().notice, 'message:unit-code-invalid')
  const attached = await view.attach({ harnessUrl: 'https://h.example', code: 'good', projects: ['/work'], tools: ['anybox.bash'] })
  assert.equal(attached.attachmentId, 'remote-1')
  assert.deepEqual(calls.find(call => call.body?.code === 'good').body, { harnessUrl: 'https://h.example', code: 'good', ceiling: { kind: 'computer', projects: ['/work'], tools: ['anybox.bash'] } })
  assert.ok(!JSON.stringify(section.children.map(child => child.textContent)).includes('good'), 'the consumed code is not displayed')
  assert.equal(view.snapshot().attachments[0].connection, 'connecting')
  await view.permissions('remote-1', { projects: ['/restricted'], tools: [] })
  assert.deepEqual(view.snapshot().attachments[0].ceiling, { kind: 'computer', projects: ['/restricted'], tools: [] })
  assert.ok(calls.every(call => call.path.startsWith('/computer/')), 'management uses the local client, never a connection gateway')
  await view.revoke('remote-1')
  assert.equal(view.snapshot().attachments[0].state, 'revoked')
})

test('execution environment settings show Computer sources and their connection states without including Models', async t => {
  dom(t)
  const attachments = [
    { attachmentId: 'local:computer', unitKind: 'computer', origin: 'local', state: 'approved', unitId: 'computer-local', epoch: 1, scope: computerScope([], []), requestedScope: computerScope([], []) },
    { attachmentId: 'local:models', unitKind: 'models', origin: 'local', state: 'approved', unitId: 'models-local', epoch: 1, scope: { kind: 'models', access: 'manage', configurations: 'all' }, requestedScope: { kind: 'models', access: 'manage', configurations: 'all' } },
  ]
  const environments = [
    { environmentId: 'local:computer', origin: 'local', state: 'approved', unitId: 'computer-local', platform: 'linux', architecture: 'x64', connectionState: 'on-demand' },
    { environmentId: 'remote-laptop', origin: 'remote', state: 'approved', unitId: 'laptop', platform: 'win32', architecture: 'x64', connectionState: 'offline' },
    { environmentId: 'remote-server', origin: 'remote', state: 'approved', unitId: 'server', platform: 'linux', architecture: 'arm64', connectionState: 'connected' },
  ]
  const { source } = api({ '/units/attachments': () => attachments,
    '/computer-environments': () => ({ defaultEnvironmentId: 'local:computer', environments }) })
  const panel = new Element(), view = setupUnitsSettings(source, messageFor, panel)
  t.after(() => view.dispose())
  await flush()
  assert.equal(view.snapshot().attachments.length, 1)
  assert.ok(panel.find(node => node.textContent === '本机（默认）'))
  assert.ok(panel.find(node => node.textContent === '远端环境 · win32/x64 · remote-l'))
  assert.ok(panel.find(node => node.textContent === '远端环境 · linux/arm64 · remote-s'))
  assert.equal(panel.find(node => node.textContent === '远端环境 · win32/x64 · remote-l').title, 'remote-laptop · laptop')
  assert.ok(panel.find(node => node.textContent === '离线'))
  assert.ok(panel.find(node => node.textContent === '已连接'))
  assert.equal(panel.find(node => node.textContent === 'local:models'), undefined)
})

test('opening and refreshing local worker management never starts it; explicit start enables attachment controls', async t => {
  dom(t)
  let running = false
  const { source, calls } = api({
    '/computer/status': () => ({ state: running ? 'running' : 'stopped', supported: true, attachments: [] }),
    '/computer/start': () => { running = true; return {} },
  })
  const section = new Element(), view = setupLocalAttachments(source, messageFor, section, '本机')
  t.after(() => view.dispose())
  await flush(); await view.refresh()
  assert.deepEqual(calls.map(call => call.path), ['/computer/status', '/computer/status'])
  const start = section.find(node => node.textContent === '启动 Computer worker')
  assert.equal(start.disabled, false)
  start.dispatchEvent(new Event('click')); await flush()
  assert.equal(calls.filter(call => call.path === '/computer/start').length, 1)
  assert.equal(start.hidden, true)
  await view.dispose(); assert.equal(running, true, 'closing the panel does not stop the worker')
})

test('a worker requiring restart explains the blocked admission and keeps revocation available', async t => {
  dom(t)
  const attachment = { attachmentId: 'old-worker', harnessUrl: 'https://remote.example', instanceId: 'remote', state: 'approved',
    connection: 'offline', lastError: null, ceiling: { kind: 'computer', projects: 'all', tools: 'all' } }
  const { source, calls } = api({
    '/computer/status': () => ({ state: 'restart-required', supported: true, workerId: 'worker', attachments: [attachment] }),
    '/computer/attachments/old-worker/revoke': () => ({ ...attachment, state: 'revoked' }),
  })
  const section = new Element(), view = setupLocalAttachments(source, messageFor, section, '本机')
  t.after(() => view.dispose())
  await view.refresh()
  assert.ok(section.find(node => node.textContent.includes('已暂停新工具调用')))
  assert.equal(section.find(node => node.textContent === '启动 Computer worker').hidden, true)
  assert.equal(section.find(node => node.textContent === '附着').disabled, true)
  assert.ok(section.find(node => node.textContent === '撤销附着'))
  await view.revoke('old-worker')
  assert.equal(calls.some(call => call.path === '/computer/attachments/old-worker/revoke'), true)
  assert.equal(calls.some(call => call.path === '/computer/start' || call.path === '/computer/stop'), false)
})

test('the client gateway proxies only the owner-side unit routes', () => {
  for (const [method, path] of [['GET', '/computer-environments'], ['GET', '/units/attachments'], ['GET', '/units/local-computer/attachments'], ['POST', '/units/attach-codes'], ['POST', '/units/local-computer/attachments'],
    ['POST', '/units/attachments/abc/revoke'], ['POST', '/units/local-computer/attachments/abc/revoke']]) assert.equal(allowedProxyPath(method, path), true, `${method} ${path}`)
  for (const [method, path] of [['POST', '/units/unit/attach'], ['GET', '/units/unit/poll'], ['POST', '/units/unit/replies'], ['POST', '/units/unit/bytes'], ['POST', '/units/attachments'], ['GET', '/units/attach-codes'],
    ['POST', '/units/attachments/../revoke']]) assert.equal(allowedProxyPath(method, path), false, `${method} ${path}`)
})
