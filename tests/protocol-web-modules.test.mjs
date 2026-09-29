import assert from 'node:assert/strict'
import test from 'node:test'
import { getProtocolWebModule, decodeProtocolWebView } from '../dist/web/protocols/modules.js'

const snapshot = protocolId => ({ envelopeVersion: 1, viewSchemaVersion: 1, protocolId,
  sessionId: 's', runId: 'r', viewRevision: 1, status: 'provisional',
  exchanges: [{ id: 'e', blocks: [{ id: 'b', kind: 'text', text: 'Answer', signature: 'private' }] }] })

test('five independent Web bindings preserve text and own protocol decoding, reduction and mounts', () => {
  const ids = ['responses', 'chat-completions', 'deepseek-chat-completions', 'anthropic-messages', 'gemini-interactions']
  const modules = ids.map(getProtocolWebModule)
  assert.equal(new Set(modules).size, 5)
  for (const module of modules) {
    const input = '  {{input}}\n<script>literal text</script> 中文  '
    assert.equal(module.encodeInput(input), input, 'no browser template expansion or semantic rewrite')
    assert.throws(() => module.encodeInput('   '), /请输入消息/)
    const decoded = module.decode(snapshot(module.protocolId))
    assert.equal(decoded.protocolId, module.protocolId)
    assert.doesNotMatch(JSON.stringify(decoded), /signature|private/)
    const other = snapshot(ids.find(id => id !== module.protocolId))
    assert.equal(module.decode(other), undefined)
    assert.equal(module.reduce(decoded, other), decoded)
    assert.throws(() => module.mount(other), /不兼容/, 'reject foreign mount before creating DOM')
    assert.equal(typeof module.mount, 'function')
    const latest = { ...decoded, viewRevision: 8, exchanges: [] }
    assert.equal(module.reduce(decoded, latest), latest)
    assert.equal(module.reduce(latest, decoded), latest)
    const committed = { ...decoded, status: 'committed' }
    assert.equal(module.reduce(latest, committed), committed)
    assert.equal(module.reduce(committed, latest), committed)
  }
})

test('unknown protocol and incompatible view schema never select a generic fallback', () => {
  for (const id of ['unknown', '__proto__', 'constructor', '', null, undefined]) {
    assert.equal(getProtocolWebModule(id), undefined)
    assert.equal(decodeProtocolWebView(snapshot(id)), undefined)
  }
  assert.equal(decodeProtocolWebView({ ...snapshot('responses'), viewSchemaVersion: 2 }), undefined)
  assert.equal(decodeProtocolWebView(null), undefined)
})

test('only Chat and DeepSeek encode image-only input and leave template expansion to the host', () => {
  for (const id of ['chat-completions', 'deepseek-chat-completions']) {
    const module = getProtocolWebModule(id)
    assert.equal(module.imageInput, true)
    assert.equal(module.encodeInput('', 2), '')
    assert.equal(module.encodeInput(' {{input}} ', 1), ' {{input}} ')
  }
  for (const id of ['responses', 'anthropic-messages', 'gemini-interactions']) {
    assert.throws(() => getProtocolWebModule(id).encodeInput('text', 1), /不支持图片/)
  }
})
