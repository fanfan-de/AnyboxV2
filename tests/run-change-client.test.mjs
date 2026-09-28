import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRunChangeClient } from '../dist/web/run-change-client.js'

test('one workspace connection serves four sessions and reconciles every reconnect', () => {
  const connections = [], refreshed = [], states = []
  const client = createRunChangeClient({
    open(url, handlers) { const entry = { url, handlers, closed: false, close() { this.closed = true } }; connections.push(entry); return entry },
    refresh: id => refreshed.push(id), connected: value => states.push(value),
  })
  client.update(['d', 'a', 'c', 'b'])
  client.update(['a', 'b', 'c', 'd'])
  assert.equal(connections.length, 1)
  assert.deepEqual(new URL(connections[0].url, 'http://local').searchParams.getAll('sessionId'), ['a', 'b', 'c', 'd'])
  const first = connections[0]
  first.handlers.ready()
  assert.deepEqual(refreshed, ['a', 'b', 'c', 'd'])
  first.handlers.change(JSON.stringify({ sessionId: 'b', runId: 'r', revision: 3 }))
  first.handlers.change(JSON.stringify({ sessionId: 'outside', runId: 'r', revision: 3 }))
  first.handlers.change('{broken')
  assert.deepEqual(refreshed, ['a', 'b', 'c', 'd', 'b'])
  first.handlers.error(); first.handlers.ready()
  assert.deepEqual(states, [true, false, true])
  assert.deepEqual(refreshed.slice(-4), ['a', 'b', 'c', 'd'])
  client.update(['a', 'c'])
  assert.equal(first.closed, true)
  const count = refreshed.length
  first.handlers.ready(); first.handlers.change(JSON.stringify({ sessionId: 'a', runId: 'old', revision: 5 }))
  assert.equal(refreshed.length, count)
  connections[1].handlers.ready()
  assert.deepEqual(refreshed.slice(-2), ['a', 'c'])
  client.dispose()
  assert.equal(connections[1].closed, true)
  connections[1].handlers.ready(); client.update(['x'])
  assert.equal(connections.length, 2)
})

test('closing every pane closes the stream; opening a pane creates a fresh subscription', () => {
  let opened = 0, closed = 0
  const client = createRunChangeClient({ open() { opened++; return { close() { closed++ } } }, refresh() {}, connected() {} })
  client.update([]); assert.equal(opened, 0)
  client.update(['a']); client.update([])
  assert.equal(closed, 1)
  client.update(['a']); assert.equal(opened, 2)
  assert.throws(() => client.update(['a', 'b', 'c', 'd', 'e']), /four/)
  client.dispose(); assert.equal(closed, 2)
})

test('protocol snapshots reach only its subscribed session and old stream generations cannot publish', () => {
  const streams = [], events = []
  const client = createRunChangeClient({
    open(_url, handlers) { streams.push(handlers); return { close() {} } }, refresh() {}, connected() {},
    view: snapshot => events.push(snapshot),
  })
  client.update(['a'])
  const snapshot = { envelopeVersion: 1, viewSchemaVersion: 1, protocolId: 'responses', sessionId: 'a', runId: 'run', viewRevision: 1, status: 'provisional', exchanges: [{ id: 'e', blocks: [{ id: 'b', kind: 'text', text: 'hello' }] }] }
  const message = { sessionId: 'a', runId: 'run', snapshot }
  streams[0].view(JSON.stringify(message))
  streams[0].view(JSON.stringify({ ...message, sessionId: 'elsewhere' }))
  streams[0].view(JSON.stringify({ ...message, snapshot: { ...snapshot, viewSchemaVersion: 42 } }))
  streams[0].view(JSON.stringify({ ...message, snapshot: { ...snapshot, exchanges: [{ id: 'e', blocks: [{ id: 'b', kind: 'text', text: 'x'.repeat(70_000) }] }] } }))
  assert.deepEqual(events, [snapshot])
  client.update(['b'])
  streams[0].view(JSON.stringify(message))
  assert.equal(events.length, 1)
  client.dispose()
})
