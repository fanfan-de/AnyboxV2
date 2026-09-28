import test from 'node:test'
import assert from 'node:assert/strict'
import { createResponsesProtocol, createChatCompletionsProtocol, createAnthropicMessagesProtocol, createGeminiInteractionsProtocol } from '../dist/index.js'
import { jsonResponse, nativeSession, run } from './native-protocol-helpers.mjs'
import { deferred, tick } from './helpers.mjs'

const cases = [
  { create: createResponsesProtocol, valid: { input: [{ role: 'user', content: 'text' }] }, media: { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:test' }] }] }, tools: [{ type: 'function', name: 'lookup', parameters: {} }] },
  { create: createChatCompletionsProtocol, valid: { messages: [{ role: 'user', content: 'text' }] }, media: { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:test' } }] }] }, tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }] },
  { create: createAnthropicMessagesProtocol, valid: { messages: [{ role: 'user', content: 'text' }] }, media: { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'data:test' } }] }] }, tools: [{ name: 'lookup', input_schema: {} }] },
  { create: createGeminiInteractionsProtocol, valid: { input: [{ type: 'user_input', content: [{ type: 'text', text: 'text' }] }] }, media: { input: [{ type: 'user_input', content: [{ type: 'image', uri: 'data:test' }] }] }, tools: [{ type: 'function', name: 'lookup', parameters: {} }] },
]
for (const entry of cases) test(`${entry.create().descriptor.id} rejects media and unavailable local tools before transport`, async () => {
  let requests = 0; const protocol = entry.create({ fetch: async () => { requests++; throw new Error('unexpected request') } })
  const original = protocol.effectiveCapabilities; protocol.effectiveCapabilities = (declared, parameters) => ({ ...original(declared, parameters), tools: false })
  const execution = nativeSession(protocol)
  assert.throws(() => execution.prepareExchange(entry.media)); assert.throws(() => execution.prepareExchange({ ...entry.valid, tools: entry.tools }), { code: 'capability-unsupported' })
  assert.equal(requests, 0); assert.equal((await execution.close()).records.length, 0)
})

for (const create of [createAnthropicMessagesProtocol, createGeminiInteractionsProtocol]) {
  const anthropic = create === createAnthropicMessagesProtocol, id = create().descriptor.id
  const first = anthropic ? { data: [{ id: 'first' }], has_more: true, last_id: 'first' } : { models: [{ name: 'models/first' }], nextPageToken: 'next' }
  const input = () => ({ provider: { baseUrl: 'https://unit.invalid', auth: 'none' }, signal: new AbortController().signal })
  test(`${id} paged discovery cancellation waits for its active reader`, async () => {
    const entered = deferred(), cancelling = deferred(), release = deferred(); let count = 0
    const protocol = create({ fetch: async () => ++count === 1 ? jsonResponse(first) : new Response(new ReadableStream({ start() { entered.resolve() }, async cancel() { cancelling.resolve(); await release.promise } })) })
    const operation = protocol.discover(input()); await entered.promise; await tick(); operation.cancel(); await cancelling.promise
    let done = false, result = false; void operation.done.then(() => { done = true }); void operation.result.catch(() => { result = true }); await tick(); assert.equal(done, false); assert.equal(result, false)
    release.resolve(); await assert.rejects(operation.result, { code: 'cancelled' }); await operation.done; assert.equal(count, 2)
  })
  test(`${id} malformed pages and repeated identities never return partial discovery`, async () => {
    const malformed = anthropic ? [{ data: [], has_more: true, last_id: 'none' }, { data: [{ id: 'first', capabilities: { thinking: { supported: 'yes' } } }], has_more: false }, { data: [{ id: 'first' }], has_more: true, last_id: 'wrong' }] : [{ models: [{ name: 'models/' }] }, { models: [], nextPageToken: 3 }]
    for (const value of malformed) { const operation = create({ fetch: async () => jsonResponse(value) }).discover(input()); await assert.rejects(operation.result, { code: 'invalid-response' }); await operation.done }
    const duplicate = create({ fetch: async () => jsonResponse(first) }).discover(input()); await assert.rejects(duplicate.result, { code: 'invalid-response' }); await duplicate.done
  })
}

test('an already errored response stream does not invent a cleanup failure', async () => {
  const execution = nativeSession(createResponsesProtocol({ fetch: async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('private-native-test-key')) } })) }))
  await assert.rejects(run(execution, { input: [{ role: 'user', content: 'text' }] }), error => error.code === 'provider-failure' && !String(error).includes('private-native-test-key'))
  assert.equal((await execution.close()).cleanup, 'succeeded')
})
