import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createModelEventQueue } from '../dist/event-queue.js'
import { capabilities, code, complete, fixture } from './helpers.mjs'

test('malformed model queries fail with a public category instead of native errors or empty results', async () => {
  const f = await fixture()
  try {
    await f.add()
    for (const query of [null, false, [], { available: 'false' }, { connectionId: 42 }, { misspelled: true }]) {
      assert.throws(() => f.models.list(query), code('invalid-config'))
    }
    assert.equal(f.models.list({ available: true }).length, 1)
    assert.deepEqual(f.models.list({ connectionId: 'unknown-provider' }), [])
  } finally { await f.close() }
})

test('malformed cancellation signals fail before execution admission using a public error', async () => {
  const f = await fixture()
  try {
    await f.add()
    for (const signal of [{}, { aborted: false }, 'not-a-signal', 1]) {
      await assert.rejects(f.models.open({ modelId: 'model', signal }), code('invalid-config'))
    }
    const execution = await f.models.open({ modelId: 'model', signal: new AbortController().signal })
    await execution.close()
  } finally { await f.close() }
})

test('missing and malformed capability fields fail without storing partial models or exposing input', async () => {
  const f = await fixture()
  try {
    await f.add()
    for (const value of [undefined, null, {}, { tools: { support: 'supported' } }, capabilities({ reasoning: null }), capabilities({ tools: { support: 'private-sensitive-value' } })]) {
      await assert.rejects(f.addConfiguration({
        id: 'malformed', name: 'Malformed', providerId: 'provider', remoteModelId: 'remote', enabled: true,
        capabilities: value, defaults: {},
      }), error => error.code === 'invalid-config' && !String(error).includes('private-sensitive-value'))
    }
    assert.equal(f.settings.configurations().length, 1)
    assert.deepEqual(f.settings.configurationHistory('malformed'), [])
  } finally { await f.close() }
})

test('legal JSON property names survive tool schema and arguments without prototype mutation', async () => {
  const f = await fixture()
  try {
    await f.add()
    const parameters = JSON.parse('{"type":"object","properties":{"constructor":{"type":"string"},"prototype":{"type":"string"},"__proto__":{"type":"object"}}}')
    const argumentsValue = JSON.parse('{"constructor":"button","prototype":"template","__proto__":{"polluted":true}}')
    const execution = await f.models.open({ modelId: 'model', tools: [{ name: 'make', parameters }] })
    f.protocols[0].next(call => call.succeed({ result: complete('', [{ id: 'call', name: 'make', arguments: argumentsValue }]) }))
    const reply = await execution.generate({ messages: [{ role: 'user', content: 'make the button' }] }).result
    assert.deepEqual(reply.toolCalls[0].arguments, argumentsValue)
    assert.equal(Object.hasOwn(reply.toolCalls[0].arguments, '__proto__'), true)
    assert.equal(Object.getPrototypeOf(reply.toolCalls[0].arguments), Object.prototype)
    assert.equal({}.polluted, undefined)
    await execution.close()
  } finally { await f.close() }
})

test('unknown per-call parameters are rejected before starting a provider request', async () => {
  const f = await fixture()
  try {
    await f.add()
    const execution = await f.models.open({ modelId: 'model' })
    assert.throws(() => execution.generate({ messages: [{ role: 'user', content: 'request' }], temperature: 0.5 }), code('invalid-config'))
    assert.equal(f.protocols[0].calls.length, 0)
    await execution.generate({ messages: [{ role: 'user', content: 'valid request' }] }).result
    await execution.close()
  } finally { await f.close() }
})

test('event queue rejects malformed bounds with fixed errors and counts UTF-8 bytes', () => {
  for (const options of [null, false, [], { capacity: 0 }, { capacity: Infinity }, { maxBufferedBytes: '100' }, { capacity: 1.1 }]) {
    assert.throws(() => createModelEventQueue(options), code('invalid-config'))
  }
  const event = { type: 'text-delta', delta: '汉字' }
  const queue = createModelEventQueue({ maxBufferedBytes: Buffer.byteLength(JSON.stringify(event), 'utf8') - 1 })
  queue.onEvent(event)
  assert.equal(queue.status, 'overflow')
  assert.equal(queue.buffered, 0)
})
