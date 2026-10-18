import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setupUnitsSettings, setupLocalAttachments, parseGrantList, computerScope, describeAttachment, describeLocalAttachment } from '../packages/app-harness/dist/web/units-client.js'
import { allowedProxyPath } from '../packages/app-harness/dist/client/gateway.js'

class Element extends EventTarget {
  hidden = false; disabled = false; value = ''; textContent = ''; className = ''; children = []; dataset = {}
  append(...children) { this.children.push(...children) }
  replaceChildren(...children) { this.children = children }
  setAttribute(name, value) { this[name] = value }
  find(predicate) { for (const child of this.children) { if (predicate(child)) return child; const nested = child.find?.(predicate); if (nested) return nested } return undefined }
}
const flush = async () => { for (let n = 0; n < 5; n++) await new Promise(resolve => setImmediate(resolve)) }
function dom(t) {
  const previous = globalThis.document
  globalThis.document = { createElement: () => new Element() }
  t.after(() => { globalThis.document = previous })
}
function api(handlers) {
  const calls = []
  const source = async (path, body) => { calls.push({ path, body }); const handler = handlers[path]; if (!handler) throw Object.assign(new Error('not-found'), { status: 404, code: 'not-found' }); return handler(body) }
  return { source, calls }
}
const messageFor = error => `message:${error?.code ?? 'unknown'}`
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('closing an attachment view drops its code immediately and joins writes without clearing a replacement view', async t => {
  dom(t)
  const pending = deferred(), section = new Element()
  const old = setupLocalAttachments(async (_path, body) => body ? pending.promise : { state: 'running', supported: true, attachments: [] }, messageFor, section, 'Old device')
  let replacement, closing, submitted
  t.after(async () => { pending.resolve({ attachmentId: 'old' }); await Promise.allSettled([submitted, closing, old.dispose(), replacement?.dispose()]) })
  await flush()
  const codeInput = section.find(node => node.type === 'password'); codeInput.value = 'one-time-code'
  submitted = old.attach({ harnessUrl: 'https://remote.example', code: codeInput.value, projects: [], tools: [] })
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
  issuing = old.issue({ projects: [], tools: [] })
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
    '/units/attach-codes': body => { const attachment = { attachmentId: 'remote-1', unitKind: body.unitKind, origin: 'remote', state: 'pending', unitId: null, epoch: 1, scope: null, requestedScope: body.scope }; attachments = [...attachments, attachment]; return { attachment, code: 'secret-code' } },
    '/units/attachments/remote-1/revoke': () => { attachments = attachments.map(a => a.attachmentId === 'remote-1' ? { ...a, state: 'revoked', epoch: 2 } : a); return attachments[1] },
  })
  const panel = new Element()
  const view = setupUnitsSettings(source, messageFor, panel)
  t.after(() => view.dispose())
  await flush()
  assert.equal(view.snapshot().attachments.length, 1)
  assert.ok(panel.find(node => node.textContent === '尚无附着记录。') === undefined)
  const code = await view.issue({ projects: ['/work'], tools: [] })
  assert.equal(code, 'secret-code')
  assert.deepEqual(calls[1], { path: '/units/attach-codes', body: { unitKind: 'computer', scope: { kind: 'computer', projects: ['/work'], tools: 'all' } } })
  assert.ok(panel.find(node => typeof node.textContent === 'string' && node.textContent.includes('secret-code')), 'the code is shown once after issuing')
  assert.equal(view.snapshot().attachments.length, 2)
  const row = panel.find(node => node.dataset?.attachmentId === 'remote-1')
  assert.ok(row); assert.ok(row.find(node => node.textContent === '撤销附着'), 'remote attachments can be revoked')
  assert.equal(panel.find(node => node.dataset?.attachmentId === 'local:computer').find(node => node.textContent === '撤销附着'), undefined, 'local attachments cannot be revoked')
  await view.revoke('remote-1')
  assert.equal(view.snapshot().attachments[1].state, 'revoked')
  assert.equal(calls.at(-2).path, '/units/attachments/remote-1/revoke')
  const failing = api({ '/units/attachments': () => { throw Object.assign(new Error('closed'), { status: 503, code: 'unit-attachments-closed' }) } })
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
  assert.ok(section.find(node => node.textContent === '这台设备尚未附着到其他 harness server。'))
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

test('the client gateway proxies only the owner-side unit routes', () => {
  for (const [method, path] of [['GET', '/units/attachments'], ['GET', '/units/local-computer/attachments'], ['POST', '/units/attach-codes'], ['POST', '/units/local-computer/attachments'],
    ['POST', '/units/attachments/abc/revoke'], ['POST', '/units/local-computer/attachments/abc/revoke']]) assert.equal(allowedProxyPath(method, path), true, `${method} ${path}`)
  for (const [method, path] of [['POST', '/units/unit/attach'], ['GET', '/units/unit/poll'], ['POST', '/units/unit/replies'], ['POST', '/units/unit/bytes'], ['POST', '/units/attachments'], ['GET', '/units/attach-codes'],
    ['POST', '/units/attachments/../revoke']]) assert.equal(allowedProxyPath(method, path), false, `${method} ${path}`)
})
