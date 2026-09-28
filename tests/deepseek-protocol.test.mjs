import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDeepSeekProtocol, convertLegacyDeepSeekParameters } from '../dist/web/deepseek-protocol.js'
import { fixture, capabilities } from '../packages/models/tests/helpers.mjs'

const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] })
function stream(chunks) {
  const bytes = new TextEncoder().encode(chunks.map(chunk => `data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\r\n\r\n`).join(''))
  return new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += 3) controller.enqueue(bytes.slice(offset, offset + 3))
    controller.close()
  } }), { headers: { 'Content-Type': 'text/event-stream' } })
}
async function configured(t, fetch, declaration = capabilities(), defaults = {}) {
  const protocol = createDeepSeekProtocol({ fetch })
  const f = await fixture({ protocols: [protocol] })
  t.after(() => f.root.fiber.dispose())
  await f.addConnection({ id: 'provider', name: 'Provider', enabled: true, protocolId: 'deepseek-chat-completions', baseUrl: 'https://example.invalid/v1', auth: 'none', timeoutMs: 10000 })
  await f.addConfiguration({ id: 'model', name: 'Model', enabled: true, providerId: 'provider', remoteModelId: 'same-remote-model', capabilities: declaration, parameters: { protocolId: 'deepseek-chat-completions', formatVersion: 1, value: convertLegacyDeepSeekParameters(defaults) } })
  return f
}

test('DeepSeek extension maps native non-thinking parameters while retaining shared fragmented streaming and tool parsing', async t => {
  const requests = [], events = []
  const f = await configured(t, async (url, init) => {
    requests.push({ url, ...init, body: JSON.parse(init.body) })
    return requests.length === 1 ? stream([
      chunk({ content: '准备查询🙂' }),
      chunk({ tool_calls: [{ index: 0, id: 'lookup-1', type: 'function', function: { name: 'lookup', arguments: '{"query":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"已完成"}' } }] }),
      chunk({}, 'tool_calls'), { choices: [], usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 } }, '[DONE]',
    ]) : stream([chunk({ content: '答案' }, 'stop'), '[DONE]'])
  }, capabilities(), { temperature: 0.4, maxOutputTokens: 789 })
  const execution = await f.open({ modelId: 'model' })
  const first = await execution.prepareExchange({ messages: [{ role: 'user', content: 'start' }], tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { query: { type: 'string' } } } } }] }).start(event => events.push(event)).result
  assert.deepEqual(first.response.choices[0].message.tool_calls.map(call => ({ id: call.id, name: call.function.name, arguments: JSON.parse(call.function.arguments) })), [{ id: 'lookup-1', name: 'lookup', arguments: { query: '已完成' } }])
  assert.equal(first.response.choices[0].message.content, '准备查询🙂')
  assert.equal(first.response.usage.total_tokens, 8)
  assert.ok(events[0].choices[0].delta.content)
  assert.equal(events.filter(event => event.choices[0]?.delta.tool_calls).length, 2)
  const second = await execution.prepareExchange({ messages: [{ role: 'tool', tool_call_id: 'lookup-1', content: 'found' }] }).start().result
  assert.equal(second.response.choices[0].message.content, '答案')
  await execution.close()
  const body = requests[0].body
  assert.deepEqual(body.thinking, { type: 'disabled' })
  assert.equal(body.max_tokens, 789)
  assert.equal(body.max_completion_tokens, undefined)
  assert.equal(body.reasoning_effort, undefined)
  assert.equal(body.temperature, 0.4)
  assert.equal(body.stream, true)
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.equal(body.tools[0].function.name, 'lookup')
  assert.equal(requests[1].body.messages.at(-1).tool_call_id, 'lookup-1')
  assert.equal(requests[1].body.messages.at(-2).tool_calls[0].function.arguments, '{"query":"已完成"}')
})

test('DeepSeek discovery and connection checks use authenticated GET and do not attach generation fields', async t => {
  const requests = []
  const protocol = createDeepSeekProtocol({ fetch: async (url, init) => {
    requests.push({ url, ...init })
    return json({ data: [{ id: 'remote-a' }, { id: 'remote-b' }] })
  } })
  const f = await fixture({ protocols: [protocol] })
  t.after(() => f.root.fiber.dispose())
  await f.addConnection({ id: 'provider', name: 'Provider', enabled: true, protocolId: 'deepseek-chat-completions', baseUrl: 'https://example.invalid/v1', auth: 'api-key', apiKey: 'private-deepseek-key', timeoutMs: 10000 })
  assert.deepEqual(await f.settings.discoverModels('provider'), [
    { remoteModelId: 'remote-a', name: 'remote-a' }, { remoteModelId: 'remote-b', name: 'remote-b' },
  ])
  await f.settings.checkConnection('provider')
  assert.equal(requests.length, 2)
  for (const request of requests) {
    assert.equal(request.method, 'GET')
    assert.equal(request.url, 'https://example.invalid/v1/models')
    assert.equal(request.body, undefined)
    assert.equal(request.headers.Authorization, 'Bearer private-deepseek-key')
  }
  assert.equal(f.settings.configurations().length, 0)
})

test('DeepSeek rejects unsupported reasoning options and required reasoning before any network call', async t => {
  let calls = 0
  const f = await configured(t, async () => { calls++; throw new Error('must not call provider') },
    capabilities({ reasoning: { support: 'supported', efforts: ['low', 'high'] } }))
  const descriptor = f.settings.protocols()[0]
  assert.ok(descriptor.modelFields.every(field => !field.key.startsWith('protocol.')))
  assert.equal(f.models.get('model').effectiveCapabilities.reasoning.support, 'unsupported')
  await assert.rejects(f.open({ modelId: 'model', requirements: { reasoning: true } }), { code: 'capability-unsupported' })
  await assert.rejects(f.settings.updateConfiguration('model', { parameters: { protocolId: 'deepseek-chat-completions', formatVersion: 1, value: { reasoning_effort: 'high' } } }, 1), { code: 'invalid-config' })
  await assert.rejects(f.settings.updateConfiguration('model', { parameters: { protocolId: 'deepseek-chat-completions', formatVersion: 1, value: { unknown: 1 } } }, 1), { code: 'invalid-config' })
  assert.equal(calls, 0)
})

test('DeepSeek rejects developer messages without sending them and supports non-streaming text through the common parser', async t => {
  const requests = []
  const f = await configured(t, async (_url, init) => {
    requests.push(JSON.parse(init.body))
    return json({ choices: [{ index: 0, message: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' }] })
  }, capabilities({ streaming: { support: 'unsupported' } }))
  const execution = await f.open({ modelId: 'model' })
  assert.throws(() => execution.prepareExchange({ messages: [{ role: 'developer', content: 'do something' }] }), { code: 'invalid-config' })
  assert.equal(requests.length, 0)
  assert.equal((await execution.prepareExchange({ messages: [{ role: 'system', content: 'instructions' }, { role: 'user', content: 'hello' }] }).start().result).response.choices[0].message.content, 'ready')
  await execution.close()
  assert.equal(requests[0].stream, false)
  assert.deepEqual(requests[0].thinking, { type: 'disabled' })
  assert.equal(requests[0].max_tokens, undefined)
})
