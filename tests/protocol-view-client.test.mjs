import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeProtocolView, reduceProtocolView, safeSourceUrl } from '../dist/applications/harness/core/view/decode.js'
const message = text => ({ id: 'message', type: 'responses.message', content: [{ id: 'part', type: 'output_text', text }] })
const snapshot = (patch = {}) => ({ envelopeVersion: 1, viewSchemaVersion: 2, protocolId: 'responses', sessionId: 'session', runId: 'run', viewRevision: 1, status: 'provisional',
  exchanges: [{ id: 'first', blocks: [message('First answer')] }], ...patch })

test('v2 grouped views preserve identities and whitelist native fields without interpreting old views', () => {
  const decoded = decodeProtocolView(snapshot({ signature: 'private', exchanges: [
    { id: 'first', nativeState: { type: 'responses.state', status: 'completed', credential: 'private-key' }, blocks: [{ id: 'reasoning', type: 'responses.reasoning', summary: [{ id: 'summary', text: 'Summary', signature: 'private-signature' }], encrypted_content: 'secret' }] },
    { id: 'second', blocks: [message('Final'), { id: 'search', type: 'responses.web_search_call', status: 'completed', action: 'search', query: 'topic', encrypted_content: 'private-page' }] },
  ] }))
  assert.deepEqual(decoded.exchanges.map(exchange => exchange.id), ['first', 'second'])
  assert.equal(decoded.exchanges[0].blocks[0].type, 'responses.reasoning')
  assert.equal(decoded.exchanges[1].blocks[0].content[0].text, 'Final')
  assert.deepEqual(decoded.exchanges[0].nativeState, { type: 'responses.state', status: 'completed' })
  assert.doesNotMatch(JSON.stringify(decoded), /private|secret|signature|encrypted_content|credential/)
  for (const version of [1, 99]) assert.equal(decodeProtocolView(snapshot({ viewSchemaVersion: version })), undefined)
  assert.equal(decodeProtocolView(snapshot({ exchanges: [{ id: 'e', blocks: [message('x'.repeat(65_537))] }] })), undefined)
  assert.equal(decodeProtocolView(snapshot({ exchanges: [{ id: 'same', blocks: [] }, { id: 'same', blocks: [] }] })), undefined)
  assert.equal(decodeProtocolView(snapshot({ exchanges: [{ id: 'e', blocks: [{ id: 'm', type: 'responses.message', content: [{ id: 'same', type: 'output_text', text: 'a' }, { id: 'same', type: 'output_text', text: 'b' }] }] }] })), undefined)
})

test('literal protocol, block namespace, role, phase and native state types reject lookalikes', () => {
  for (const protocolId of ['unknown', '__proto__', 'constructor', '', { toString: () => 'responses' }]) assert.equal(decodeProtocolView(snapshot({ protocolId, exchanges: [] })), undefined)
  assert.equal(decodeProtocolView(snapshot({ exchanges: [{ id: 'e', blocks: [{ id: 'b', type: 'chat.content', text: 'foreign' }] }] })), undefined)
  assert.equal(decodeProtocolView(snapshot({ exchanges: [{ id: 'e', nativeState: { type: 'gemini.state', status: 'completed' }, blocks: [] }] })), undefined)
  assert.equal(decodeProtocolView(snapshot({ exchanges: [{ id: 'e', nativeState: { type: 'responses.state', partial: 'true' }, blocks: [] }] })), undefined)
  assert.equal(decodeProtocolView(snapshot({ exchanges: [{ id: 'e', inputs: [{ id: 'i', role: { toString: () => 'user' }, text: 'Input' }], blocks: [] }] })), undefined)
  assert.equal(decodeProtocolView(snapshot({ exchanges: [{ id: 'e', blocks: [{ ...message('Answer'), phase: { toString: () => 'final_answer' } }] }] })), undefined)
})

test('replacement snapshots ignore duplicates, missing revisions and late provisional frames without splicing content', () => {
  const initial = decodeProtocolView(snapshot()), jumped = decodeProtocolView(snapshot({ viewRevision: 8, exchanges: [{ id: 'later', blocks: [message('Complete current projection')] }] }))
  assert.equal(reduceProtocolView(initial, jumped), jumped)
  assert.equal(reduceProtocolView(jumped, initial), jumped)
  assert.equal(reduceProtocolView(jumped, jumped), jumped)
  assert.equal(reduceProtocolView(jumped, snapshot({ runId: 'other', viewRevision: 99 })), jumped)
  assert.equal(reduceProtocolView(jumped, snapshot({ protocolId: 'anthropic-messages', viewRevision: 99 })), jumped)
  const committed = snapshot({ viewRevision: 2, status: 'committed', exchanges: [] })
  assert.equal(reduceProtocolView(jumped, committed), committed)
  assert.equal(reduceProtocolView(committed, snapshot({ viewRevision: 100 })), committed)
})

test('nested citations validate original offsets and expose safe URLs only', () => {
  const value = snapshot({ exchanges: [{ id: 'e', blocks: [{ id: 'b', type: 'responses.message', phase: 'final_answer', content: [{ id: 'part', type: 'output_text', text: '中文 answer', citations: [
    { start: 0, end: 2, url: 'https://example.test/source', title: 'Source' }, { start: 0, end: 2, url: 'javascript:alert(1)' }, { start: 0, end: 2, url: 'https://secret:password@example.test/' },
  ] }] }] }] })
  assert.deepEqual(decodeProtocolView(value).exchanges[0].blocks[0].content[0].citations, [{ start: 0, end: 2, url: 'https://example.test/source', title: 'Source' }])
  value.exchanges[0].blocks[0].content[0].citations[0].end = 100
  assert.equal(decodeProtocolView(value), undefined)
  assert.equal(safeSourceUrl('data:text/html,x'), undefined); assert.equal(safeSourceUrl('/relative'), undefined)
})

test('tool arguments remain literal strings and native thinking placeholders never expose continuation', () => {
  const value = snapshot({ protocolId: 'anthropic-messages', exchanges: [{ id: 'e', blocks: [
    { id: 'thinking', type: 'anthropic.thinking', text: 'Thought', signature: 'private-signature' },
    { id: 'hidden', type: 'anthropic.redacted_thinking', data: 'private-redacted' },
    { id: 'tool', type: 'anthropic.tool_use', requestId: 'call', name: 'bash', arguments: '{"id":"literal","command":"pwd"}', input: { credential: 'private' } },
    { id: 'result', type: 'anthropic.web_search_tool_result', requestId: 'server-call', status: 'completed', sources: [{ url: 'https://example.test/', title: 'Source', encrypted_content: 'private' }, { url: 'javascript:bad' }] },
  ] }] })
  const decoded = decodeProtocolView(value)
  assert.deepEqual(decoded.exchanges[0].blocks[1], { id: 'hidden', type: 'anthropic.redacted_thinking' })
  assert.match(decoded.exchanges[0].blocks[2].arguments, /"id":"literal"/)
  assert.equal(decoded.exchanges[0].blocks[3].sources.length, 1)
  assert.doesNotMatch(JSON.stringify(decoded), /private|signature|encrypted_content|credential/)
  value.exchanges[0].blocks[2].arguments = { command: 'pwd' }
  assert.equal(decodeProtocolView(value), undefined)
})

test('request inputs decode by whitelist without accepting image bodies, credentials or assistant continuation', () => {
  const value = snapshot({ exchanges: [{ id: 'e', inputs: [
    { id: 'system', role: 'system', text: 'Instructions', signature: 'private' }, { id: 'context', role: 'context', text: 'Context', credential: 'private' }, { id: 'user', role: 'user', text: 'Question', image: 'private-base64' },
  ], blocks: [] }] })
  const decoded = decodeProtocolView(value)
  assert.deepEqual(decoded.exchanges[0].inputs, [{ id: 'system', role: 'system', text: 'Instructions' }, { id: 'context', role: 'context', text: 'Context' }, { id: 'user', role: 'user', text: 'Question' }])
  assert.doesNotMatch(JSON.stringify(decoded), /private|signature|credential|image/)
  for (const inputs of [[{ id: 'i', role: 'assistant', text: 'Answer' }], [{ id: 'i', role: 'user', text: 'x'.repeat(65_537) }], [{ id: '', role: 'user', text: 'Question' }], [{ id: 'i', role: 'user', text: 'A' }, { id: 'i', role: 'user', text: 'B' }], 'private-json']) {
    assert.equal(decodeProtocolView(snapshot({ exchanges: [{ id: 'e', inputs, blocks: [] }] })), undefined)
  }
})
