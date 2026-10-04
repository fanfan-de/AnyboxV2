import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toolTrace } from '../dist/applications/harness/web/tool-trace.js'
import { createToolCallCard } from '../dist/applications/harness/web/session-view.js'

const bash = (id = 'bash') => ({ id, name: 'bash', command: 'printf hello' })
const patch = (id = 'patch') => ({ id, name: 'apply_patch', patch: '*** Begin Patch\n*** End Patch', patchTruncated: false })
const batch = (...calls) => ({ kind: 'model-tool-calls', calls })
const start = call => ({ kind: 'tool-started', requestId: call.id, ...call })
const result = status => ({ status, changes: status === 'rejected' ? [] : [{ kind: 'added', path: '/project/created.txt' }],
  pending: status === 'applied' ? [] : [{ kind: 'update', path: '/project/old.txt', moveTo: '/project/new.txt' }],
  ...(status === 'rejected' || status === 'partial' ? { diagnostic: { code: 'conflict', message: 'File changed', path: '/project/old.txt', line: 3 } } : {}),
})
const observed = (call, status) => call.name === 'bash' ? {
  kind: 'tool-observed', requestId: call.id, name: call.name,
  exitCode: 0, signal: null, stdout: 'hello', stderr: '', truncated: false,
} : { kind: 'tool-observed', requestId: call.id, name: call.name, result: result(status) }

test('mixed tools retain result details and associate reused request IDs with the latest batch', () => {
  const b = bash('shared'), p = patch('shared')
  const events = [batch(b), start(b), observed(b), batch(p), start(p), observed(p, 'rejected'),
    batch(p), start(p), observed(p, 'applied'), batch(b), start(b), { ...observed(b), exitCode: 1, stderr: 'failed' }]
  const calls = toolTrace({ status: 'completed' }, events)
  assert.deepEqual(calls.map(call => [call.name, call.state]), [
    ['bash', 'completed'], ['apply_patch', 'rejected'], ['apply_patch', 'applied'], ['bash', 'failed'],
  ])
  assert.equal(calls[0].stdout, 'hello')
  assert.equal(calls[1].result.diagnostic.code, 'conflict')
  assert.equal(calls[2].result.changes[0].path, '/project/created.txt')
  assert.equal(calls[3].stderr, 'failed')
  assert.equal(events[0].calls[0].state, undefined)
})

test('native operation ledgers render tools without a legacy model-tool-calls event', () => {
  const b = bash('reused'), p = patch('patch')
  const calls = toolTrace({ status: 'completed' }, [
    { kind: 'operation-started', operationId: 'exchange-1', operationKind: 'model' },
    { kind: 'operation-observed', operationId: 'exchange-1' },
    start(b), observed(b), start(p), observed(p, 'partial'), start(b), { ...observed(b), stdout: 'second observation' },
  ])
  assert.deepEqual(calls.map(call => [call.name, call.state]), [['bash', 'completed'], ['apply_patch', 'partial'], ['bash', 'completed']])
  assert.equal(calls[0].stdout, 'hello')
  assert.equal(calls[1].result.changes.length, 1)
  assert.equal(calls[2].stdout, 'second observation')
})

test('cancellation and interruption preserve completed file changes and finish unresolved cards', () => {
  const p = patch(), b = bash()
  for (const status of ['cancelled', 'interrupted']) {
    const calls = toolTrace({ status }, [batch(p, b), start(p), observed(p, 'cancelled')])
    assert.equal(calls[0].state, 'cancelled')
    assert.equal(calls[0].result.changes.length, 1)
    assert.equal(calls[1].state, status)
    assert.equal(toolTrace({ status }, [batch(p), start(p)])[0].state, status)
  }
})

test('cleanup failure preserves results carried by failure or already observed', () => {
  const p = patch(), b = bash()
  const failure = { kind: 'tool-failed', name: 'apply_patch', requestId: p.id, category: 'tool-cleanup-failure' }
  for (const events of [
    [batch(p, b), start(p), { ...failure, result: result('partial') }],
    [batch(p, b), start(p), observed(p, 'partial'), failure],
  ]) {
    const calls = toolTrace({ status: 'failed' }, events)
    assert.equal(calls[0].state, 'failed')
    assert.equal(calls[0].category, 'tool-cleanup-failure')
    assert.equal(calls[0].result.status, 'partial')
    assert.equal(calls[0].result.changes.length, 1)
    assert.equal(calls[1].state, 'skipped')
  }
})

// Only the DOM surface used by the renderer is needed to inspect its text safely.
function element(tag) {
  let ownText = ''
  const matches = (node, selector) => selector.startsWith('.') ? node.className.split(/\s+/).includes(selector.slice(1)) : node.tag === selector
  const node = { tag, className: '', dataset: {}, attributes: {}, children: [], hidden: false, parentElement: undefined,
    setAttribute(name, value) { this.attributes[name] = String(value) },
    addEventListener(type, listener, options) { (this.listeners ??= []).push({ type, listener, signal: options?.signal }) },
    append(...children) { for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child) } },
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = undefined },
    querySelectorAll(selector) { return this.children.flatMap(child => [...(matches(child, selector) ? [child] : []), ...child.querySelectorAll(selector)]) },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null },
  }
  Object.defineProperty(node, 'textContent', { get: () => ownText + node.children.map(child => child.textContent).join(''),
    set(value) { ownText = String(value); for (const child of node.children) child.parentElement = undefined; node.children = [] } })
  return node
}
const field = (card, key) => card.querySelectorAll('.tool-copy').find(button => button.dataset.copyField === key)?.parentElement.parentElement

test('Apply Patch cards render every outcome, preview truncation, actual changes and unfinished moves', () => {
  const previous = globalThis.document
  globalThis.document = { createElement: element }
  try {
    const labels = { applied: '已应用', rejected: '已拒绝', partial: '部分完成', cancelled: '已取消' }
    for (const status of Object.keys(labels)) {
      const p = { ...patch(), patch: '<script>untrusted patch</script>', patchTruncated: true }
      const call = toolTrace({ status: 'cancelled' }, [batch(p), start(p), observed(p, status)])[0]
      const card = createToolCallCard(call), text = card.textContent
      assert.match(text, /Apply Patch/)
      assert.ok(text.includes(labels[status]))
      assert.match(text, /补丁预览已截断/)
      assert.equal(field(card, 'patch').querySelector('.tool-output').textContent, p.patch)
      assert.equal(card.querySelectorAll('script').length, 0, 'literal patch HTML does not become executable DOM')
      assert.equal(field(card, 'changes').hidden, status === 'rejected')
      if (status !== 'rejected') assert.equal(field(card, 'changes').querySelector('.tool-output').textContent, '创建 /project/created.txt')
      assert.equal(field(card, 'pending').hidden, status === 'applied')
      if (status !== 'applied') assert.equal(field(card, 'pending').querySelector('.tool-output').textContent, '修改 /project/old.txt → /project/new.txt')
      if (status === 'partial' || status === 'rejected') assert.match(text, /conflict：File changed · \/project\/old.txt:3/)
    }
    const call = { ...patch(), state: 'failed', category: 'tool-cleanup-failure', result: result('partial') }
    assert.match(createToolCallCard(call).textContent, /失败类别：tool-cleanup-failure/)
    assert.match(createToolCallCard(call).textContent, /创建 \/project\/created.txt/)
    const bashCard = createToolCallCard({ ...bash(), state: 'completed', exitCode: 0, stdout: 'hello', truncated: true })
    assert.match(bashCard.textContent, /Bash[\s\S]*\$ printf hello[\s\S]*退出码：0[\s\S]*stdout[\s\S]*hello[\s\S]*输出摘要已截断/)
    assert.equal(field(bashCard, 'stdout').querySelector('.tool-output').textContent, 'hello')
    assert.equal(field(bashCard, 'patch').hidden, true); assert.equal(field(bashCard, 'changes').hidden, true)
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
})
