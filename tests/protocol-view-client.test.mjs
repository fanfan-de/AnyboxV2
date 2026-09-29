import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeProtocolView, reduceProtocolView, safeSourceUrl } from '../dist/client/protocols/view.js'

const snapshot = (patch = {}) => ({ envelopeVersion: 1, viewSchemaVersion: 1, protocolId: 'responses',
  sessionId: 'session', runId: 'run', viewRevision: 1, status: 'provisional',
  exchanges: [{ id: 'first', blocks: [{ id: 'text', kind: 'text', text: 'First answer' }] }], ...patch })

test('protocol views preserve exchange and block identities while stripping private extras', () => {
  const decoded = decodeProtocolView(snapshot({ signature: 'private', exchanges: [
    { id: 'first', blocks: [{ id: 'text', kind: 'reasoning', text: 'Summary', encrypted_content: 'secret' }] },
    { id: 'second', blocks: [{ id: 'text', kind: 'text', text: 'Final' }, { id: 'search', kind: 'tool', label: 'Web search', status: 'completed' }] },
  ] }))
  assert.deepEqual(decoded.exchanges.map(exchange => exchange.id), ['first', 'second'])
  assert.equal(decoded.exchanges[0].blocks[0].kind, 'reasoning')
  assert.equal(decoded.exchanges[1].blocks[0].text, 'Final')
  assert.doesNotMatch(JSON.stringify(decoded), /private|secret|signature|encrypted_content/)
  assert.equal(decodeProtocolView(snapshot({ viewSchemaVersion: 99 })), undefined)
  assert.equal(decodeProtocolView(snapshot({ exchanges: [{ id: 'e', blocks: [{ id: 'b', kind: 'text', text: 'x'.repeat(65_537) }] }] })), undefined)
  assert.equal(decodeProtocolView(snapshot({ exchanges: [{ id: 'same', blocks: [] }, { id: 'same', blocks: [] }] })), undefined)
})

test('replacement projections handle duplicate, missing and stale frames without joining texts', () => {
  const initial = decodeProtocolView(snapshot())
  const jumped = decodeProtocolView(snapshot({ viewRevision: 8, exchanges: [{ id: 'later', blocks: [{ id: 'text', kind: 'text', text: 'Complete current projection' }] }] }))
  assert.equal(reduceProtocolView(initial, jumped), jumped)
  assert.equal(reduceProtocolView(jumped, initial), jumped)
  assert.equal(reduceProtocolView(jumped, jumped), jumped)
  assert.equal(reduceProtocolView(jumped, snapshot({ runId: 'other', viewRevision: 99 })), jumped)
  assert.equal(reduceProtocolView(jumped, snapshot({ protocolId: 'anthropic-messages', viewRevision: 99 })), jumped)
  const committed = snapshot({ viewRevision: 2, status: 'committed', exchanges: [] })
  assert.equal(reduceProtocolView(jumped, committed), committed, 'durable projection replaces provisional output even with a separate revision')
  assert.equal(reduceProtocolView(committed, snapshot({ viewRevision: 100 })), committed)
})

test('citation decoding checks original block offsets and accepts only safe source links', () => {
  const value = snapshot({ exchanges: [{ id: 'e', blocks: [{ id: 'b', kind: 'text', text: '中文 answer', citations: [
    { start: 0, end: 2, url: 'https://example.test/source', title: 'Source' },
    { start: 0, end: 2, url: 'javascript:alert(1)' },
    { start: 0, end: 2, url: 'https://secret:password@example.test/' },
  ] }] }] })
  assert.deepEqual(decodeProtocolView(value).exchanges[0].blocks[0].citations, [{ start: 0, end: 2, url: 'https://example.test/source', title: 'Source' }])
  value.exchanges[0].blocks[0].citations[0].end = 100
  assert.equal(decodeProtocolView(value), undefined)
  assert.equal(safeSourceUrl('data:text/html,x'), undefined)
  assert.equal(safeSourceUrl('/relative'), undefined)
})
