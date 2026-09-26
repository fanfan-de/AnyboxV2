import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toolTrace } from '../dist/web/tool-trace.js'
import { createToolCallCard } from '../dist/web/session-view.js'

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
  return { tag, className: '', textContent: '', children: [], append(...children) { this.children.push(...children) } }
}
function content(node) { return [node.textContent, ...node.children.map(content)].join('\n') }

test('Apply Patch cards render every outcome, preview truncation, actual changes and unfinished moves', () => {
  const previous = globalThis.document
  globalThis.document = { createElement: element }
  try {
    const labels = { applied: '已应用', rejected: '已拒绝', partial: '部分完成', cancelled: '已取消' }
    for (const status of Object.keys(labels)) {
      const p = { ...patch(), patch: '<script>untrusted patch</script>', patchTruncated: true }
      const call = toolTrace({ status: 'cancelled' }, [batch(p), start(p), observed(p, status)])[0]
      const card = createToolCallCard(call), text = content(card)
      assert.match(text, /Apply Patch/)
      assert.ok(text.includes(labels[status]))
      assert.match(text, /补丁预览已截断/)
      assert.equal(card.children.find(child => child.tag === 'pre').textContent, p.patch)
      if (status !== 'rejected') assert.match(text, /实际文件变更\n创建 \/project\/created.txt/)
      if (status !== 'applied') assert.match(text, /\/project\/old.txt → \/project\/new.txt/)
      if (status === 'partial' || status === 'rejected') assert.match(text, /conflict：File changed · \/project\/old.txt:3/)
    }
    const call = { ...patch(), state: 'failed', category: 'tool-cleanup-failure', result: result('partial') }
    assert.match(content(createToolCallCard(call)), /失败类别：tool-cleanup-failure/)
    assert.match(content(createToolCallCard(call)), /创建 \/project\/created.txt/)
    assert.match(content(createToolCallCard({ ...bash(), state: 'completed', exitCode: 0, stdout: 'hello', truncated: true })),
      /Bash[\s\S]*\$ printf hello[\s\S]*退出码：0[\s\S]*stdout[\s\S]*hello[\s\S]*输出摘要已截断/)
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
})
