import test from 'node:test'
import assert from 'node:assert/strict'
import { createResponsesProtocol } from '../dist/protocols/responses.js'
import { createChatCompletionsProtocol } from '../dist/protocols/chat-completions.js'
import { capabilities, fixture, params } from './helpers.mjs'
import { chatReply, jsonResponse, responseReply, responseText } from './native-protocol-helpers.mjs'

const refusal = { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'private refusal explanation' }] }
const call = { id: 'call', type: 'function', function: { name: 'lookup', arguments: '{}' } }
const cases = [
  { id: 'responses', create: createResponsesProtocol, replies: [
    [responseReply([refusal]), 'refused-response'],
    [responseReply([refusal], 'incomplete'), 'refused-response'],
    [{ ...responseReply([], 'incomplete'), incomplete_details: { reason: 'content_filter' } }, 'refused-response'],
    [{ ...responseReply([responseText('partial')], 'incomplete'), incomplete_details: { reason: 'max_output_tokens' } }, 'incomplete-response'],
    [responseReply([responseText('partial')], 'incomplete'), 'incomplete-response'],
    [responseReply([{ type: 'function_call', call_id: 'call', name: 'lookup', arguments: '{}' }]), 'capability-unsupported'],
    [responseReply([{ type: 'web_search_call', status: 'completed' }]), 'capability-unsupported'],
    [responseReply([{ type: 'future_output' }]), 'invalid-response'],
    [responseReply([{ type: 'message', role: 'assistant', content: [{ type: 'image', data: 'unknown' }] }]), 'invalid-response'],
    [responseReply([responseText(' \t\n')]), 'invalid-response'],
    [responseReply([{ type: 'reasoning', encrypted_content: 'private continuation', summary: [{ type: 'summary_text', text: 'private reasoning' }] }]), 'invalid-response'],
    [responseReply([]), 'invalid-response'],
  ] },
  { id: 'chat-completions', create: createChatCompletionsProtocol, replies: [
    [chatReply({ role: 'assistant', content: null, refusal: 'private refusal explanation' }), 'refused-response'],
    [chatReply({ role: 'assistant', content: 'partial' }, 'content_filter'), 'refused-response'],
    [chatReply({ role: 'assistant', content: 'partial' }, 'length'), 'incomplete-response'],
    [chatReply({ role: 'assistant', content: null, tool_calls: [call] }, 'tool_calls'), 'capability-unsupported'],
    [chatReply({ role: 'assistant', content: 'answer', tool_calls: [call] }), 'capability-unsupported'],
    [chatReply({ role: 'assistant', content: [{ type: 'text', text: 'unknown shape' }] }), 'invalid-response'],
    [chatReply({ role: 'assistant', content: 'answer' }, 'future_finish_reason'), 'invalid-response'],
    [chatReply({ role: 'assistant', content: ' \t\n' }), 'invalid-response'],
    [chatReply({ role: 'assistant', content: null, reasoning_content: 'private reasoning' }), 'invalid-response'],
    [{ choices: [] }, 'invalid-response'],
    [{ choices: [chatReply().choices[0], chatReply().choices[0]] }, 'invalid-response'],
  ] },
]

for (const item of cases) test(`${item.id} generateText projects terminal JSON errors without retries or persistence, and ordinary failures keep done successful`, async () => {
  const replies = [...item.replies], requests = []
  const protocol = item.create({ fetch: async (_url, init) => {
    requests.push(JSON.parse(init.body))
    const next = replies.shift()
    assert.ok(next, 'every generation sends exactly one request')
    return jsonResponse(next[0])
  } })
  const f = await fixture({ protocols: [{ ...protocol, release() {} }] })
  try {
    await f.add()
    const before = f.store.configurationHistory('model'), commit = f.store.commit.bind(f.store)
    let writes = 0
    f.store.commit = async change => { writes += 1; return commit(change) }
    for (const [, code] of item.replies) {
      const prior = requests.length, operation = f.models.generateText({ modelId: 'model', input: 'question' })
      await assert.rejects(operation.result, error => {
        assert.equal(error.code, code)
        assert.deepEqual(Object.keys(error).sort(), ['code', 'name'])
        assert.equal(String(error).includes('private'), false)
        return true
      })
      await operation.done
      assert.equal(requests.length, prior + 1, 'failures never retry or continue')
    }
    assert.equal(replies.length, 0)
    assert.ok(requests.every(request => request.stream === false))
    assert.equal(writes, 0, 'temporary native records and errors never reach the configuration store')
    assert.deepEqual(f.store.configurationHistory('model'), before)
  } finally { await f.close() }
})

test('Responses generateText accepts declared search support and preserves saved reasoning, but saved search tools reject before fetch', async () => {
  const requests = [], protocol = createResponsesProtocol({ fetch: async (_url, init) => {
    requests.push(JSON.parse(init.body))
    return jsonResponse(responseReply([{ type: 'reasoning', encrypted_content: 'private continuation', summary: [] }, responseText('  # Final\n'), responseText('Answer  ')]))
  } })
  const f = await fixture({ protocols: [{ ...protocol, release() {} }] })
  try {
    const { model } = await f.add({ defaults: { maxOutputTokens: 120, protocol: { reasoningEffort: 'high', reasoningSummary: 'auto' } },
      capabilityDeclarations: capabilities({ webSearch: { support: 'supported' }, reasoning: { support: 'supported', efforts: ['high'] } }) })
    const before = f.store.configurationHistory(model.id), parameters = model.parameters.value
    const operation = f.models.generateText({ modelId: model.id, input: 'question' })
    assert.deepEqual(await operation.result, { text: '  # Final\n\nAnswer  ', modelId: model.id, modelRevision: model.revision, protocolId: 'responses' })
    await operation.done
    assert.equal(requests.length, 1)
    assert.equal(requests[0].stream, false)
    assert.equal(requests[0].max_output_tokens, 120)
    assert.deepEqual(requests[0].reasoning, { effort: 'high', summary: 'auto' })
    assert.equal('tools' in requests[0], false)
    assert.deepEqual(f.store.configurationHistory(model.id), before)
    const updated = await f.settings.updateConfiguration(model.id, { parameters: params('responses', { ...parameters, tools: [{ type: 'web_search' }] }) }, model.revision)
    const withSearch = f.store.configurationHistory(model.id)
    const rejected = f.models.generateText({ modelId: model.id, input: 'question' })
    await assert.rejects(rejected.result, { code: 'capability-unsupported' })
    await rejected.done
    assert.equal(requests.length, 1, 'saved search is rejected before transport')
    assert.deepEqual(f.settings.configurations().find(value => value.id === model.id).parameters, updated.parameters)
    assert.deepEqual(f.store.configurationHistory(model.id), withSearch)
  } finally { await f.close() }
})

test('Chat generateText keeps saved token and enabled thinking parameters unchanged while hiding private reasoning', async () => {
  const requests = [], protocol = createChatCompletionsProtocol({ fetch: async (_url, init) => {
    requests.push(JSON.parse(init.body))
    return jsonResponse(chatReply({ role: 'assistant', content: '  # Final\n\nAnswer  ', reasoning_content: 'private reasoning' }))
  } })
  const f = await fixture({ protocols: [{ ...protocol, release() {} }] })
  try {
    const { model } = await f.add({ capabilityDeclarations: capabilities({ reasoning: { support: 'supported', modes: ['enabled'], efforts: ['high'] } }) })
    const parameters = params('chat-completions', { max_tokens: 120, thinking: { type: 'enabled' }, reasoning_effort: 'high' })
    const saved = await f.settings.updateConfiguration(model.id, { parameters }, model.revision)
    const before = f.store.configurationHistory(model.id)
    const operation = f.models.generateText({ modelId: model.id, input: 'question' })
    assert.deepEqual(await operation.result, { text: '  # Final\n\nAnswer  ', modelId: model.id, modelRevision: saved.revision, protocolId: 'chat-completions' })
    await operation.done
    assert.equal(requests.length, 1)
    assert.equal(requests[0].stream, false)
    assert.equal('stream_options' in requests[0], false)
    assert.equal(requests[0].max_tokens, 120)
    assert.equal('max_completion_tokens' in requests[0], false)
    assert.deepEqual(requests[0].thinking, { type: 'enabled' })
    assert.equal(requests[0].reasoning_effort, 'high')
    assert.deepEqual(f.settings.configurations().find(value => value.id === model.id).parameters, parameters)
    assert.deepEqual(f.store.configurationHistory(model.id), before)
  } finally { await f.close() }
})
