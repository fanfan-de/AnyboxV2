import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toolTrace } from '../dist/applications/harness/web/tool-trace.js'
import { createToolCallCard } from '../dist/applications/harness/web/session-view.js'
import { mountToolCallDetails } from '../dist/applications/harness/web/tool-call-view.js'

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

test('mixed library names keep literal arguments, result and immutable image references', () => {
  const calls = [
    { id: 'same', name: 'codex_exec_command', arguments: { cmd: 'printf hello' } },
    { id: 'same', name: 'claude_code_Read', arguments: { file_path: 'file.txt' } },
    { id: 'picture', name: 'deepseek_harness_read_image', arguments: { file_path: 'image.png' } },
  ]
  const images = [{ assetId: 'asset', mediaType: 'image/png', sha256: 'hash', byteLength: 10, width: 2, height: 2 }]
  const events = calls.flatMap((call, index) => [start(call), { kind: 'tool-observed', requestId: call.id, name: call.name,
    result: index === 0 ? { output: 'hello', session_id: 1 } : index === 1 ? 'literal <script>content</script>' : { read: true },
    ...(index === 2 ? { images } : {}) }])
  const traced = toolTrace({ status: 'completed' }, events)
  assert.deepEqual(traced.map(call => call.name), calls.map(call => call.name))
  assert.deepEqual(traced[0].arguments, calls[0].arguments)
  assert.equal(traced[1].result, 'literal <script>content</script>')
  assert.deepEqual(traced[2].images, images)
  assert.ok(traced.every(call => call.state === 'completed'))
})

test('persisted process cleanup joins final exit and remaining output onto matching exec and stdin cards', () => {
  const exec = { id: 'exec', name: 'codex_exec_command', arguments: { cmd: 'read value' } }
  const stdin = { id: 'stdin', name: 'codex_write_stdin', arguments: { session_id: 9, chars: 'value' } }
  const unrelated = { id: 'other', name: 'codex_exec_command', arguments: { cmd: 'sleep' } }
  const events = [start(exec), { kind: 'tool-observed', requestId: exec.id, name: exec.name, result: { session_id: 9, exit_code: null, output: 'begin\n' } },
    start(stdin), { kind: 'tool-observed', requestId: stdin.id, name: stdin.name, result: { session_id: 9, exit_code: null, output: 'value\n' } },
    start(unrelated), { kind: 'tool-observed', requestId: unrelated.id, name: unrelated.name, result: { session_id: 10, exit_code: null, output: '' } },
    { kind: 'operation-observed', at: '2026-10-04T00:00:02Z', operationId: 'close', processes: [{ sessionId: 9, exitCode: 3, signal: null, output: 'end\n', truncated: true, terminated: false, timedOut: false }] }]
  const calls = toolTrace({ status: 'completed' }, events)
  for (const call of calls.slice(0, 2)) { assert.equal(call.state, 'failed'); assert.equal(call.result.exit_code, 3); assert.equal(call.result.closed, true); assert.equal(call.finishedAt, events.at(-1).at) }
  assert.equal(calls[0].result.output, 'begin\nend\n'); assert.equal(calls[1].result.output, 'value\nend\n')
  assert.equal(calls[2].result.closed, undefined); assert.equal(events[1].result.closed, undefined)
  const cancelled = toolTrace({ status: 'cancelled' }, [...events.slice(0, 2), { ...events.at(-1), processes: [{ ...events.at(-1).processes[0], exitCode: null, signal: 'SIGTERM', terminated: true }] }])[0]
  assert.equal(cancelled.result.terminated, true); assert.equal(cancelled.result.signal, 'SIGTERM')
})

test('library observed errors and failed cleanup retain partial result and images without replacing earlier facts', () => {
  const edit = { id: 'edit', name: 'codex_apply_patch', arguments: { patch: 'literal' } }, image = { id: 'image', name: 'codex_view_image', arguments: { path: 'image.png' } }
  const images = [{ assetId: 'picture', width: 2, height: 2 }]
  const events = [start(edit), { kind: 'tool-failed', name: edit.name, requestId: edit.id, category: 'cleanup-failed', result: result('partial') },
    start(image), { kind: 'tool-observed', name: image.name, requestId: image.id, result: { path: 'image.png' }, images },
    { kind: 'tool-failed', name: image.name, requestId: image.id, category: 'cleanup-failed' }]
  const calls = toolTrace({ status: 'failed' }, events)
  assert.equal(calls[0].result.status, 'partial'); assert.equal(calls[0].result.changes.length, 1)
  assert.deepEqual(calls[1].images, images); assert.deepEqual(calls[1].result, { path: 'image.png' })
  assert.equal(toolTrace({ status: 'completed' }, [start(image), { kind: 'tool-observed', name: image.name, requestId: image.id, result: { status: 'error', code: 'image-unavailable' } }])[0].state, 'failed')
})

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

test('library tool details render retained images, readable process output and observed plan lists safely', () => {
  const previous = globalThis.document
  globalThis.document = { createElement: element }
  try {
    const image = { id: 'image', name: 'codex_view_image', arguments: { path: 'photo.png' }, state: 'completed', result: { path: 'photo.png' },
      images: [{ assetId: 'asset', mediaType: 'image/png', byteLength: 10, sha256: 'hash', width: 20, height: 30 }] }
    const picture = mountToolCallDetails(image, 'session')
    assert.equal(picture.element.querySelector('img').src, '/api/v1/sessions/session/images/asset/content')
    assert.match(picture.element.querySelector('img').alt, /20 × 30/)
    const call = { id: 'command', name: 'codex_exec_command', state: 'failed', arguments: { cmd: 'printf output' }, result: { output: '<script>literal</script>', exit_code: 2, signal: null, closed: true } }
    const card = mountToolCallDetails(call).element
    assert.equal(field(card, 'command').querySelector('.tool-command').textContent, '$ printf output')
    assert.equal(field(card, 'output').querySelector('.tool-output').textContent, '<script>literal</script>')
    assert.match(card.textContent, /退出码：2/); assert.equal(card.querySelectorAll('script').length, 0)
    assert.equal(field(card, 'result').tag, 'details')
    const plan = mountToolCallDetails({ id: 'plan', name: 'codex_update_plan', arguments: {}, state: 'completed', result: { status: 'updated', plan: [{ step: '<b>Implement</b>', status: 'in_progress' }] } }).element
    assert.equal(plan.querySelector('li').dataset.status, 'in_progress'); assert.match(plan.textContent, /最新计划/)
    assert.equal(plan.querySelectorAll('b').length, 0)
    picture.dispose()
  } finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous }
})

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
