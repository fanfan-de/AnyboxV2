import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { createAnthropicMessagesProtocol, createChatCompletionsProtocol, createGeminiInteractionsProtocol, createResponsesProtocol, nativeSearchTarget } from '../dist/index.js'
import { capabilities, deferred, fixture, params } from './helpers.mjs'
import { chatReply, responseReply, responseText, run } from './native-protocol-helpers.mjs'

const text = { type: 'text', text: 'hello' }
const message = { role: 'user', content: 'hello' }
const fn = { name: 'lookup', description: 'Read one item', parameters: { type: 'object' } }
const anthropicReply = stop => ({ type: 'message', id: 'm', role: 'assistant', model: 'remote', stop_reason: stop, content: [text], usage: { input_tokens: 1, output_tokens: 1 } })
const cases = [
  { create: createResponsesProtocol, intent: { input: [message] }, tool: { type: 'function', ...fn, strict: false }, search: { type: 'web_search' }, reply: responseReply([responseText('hello')]) },
  { create: createAnthropicMessagesProtocol, intent: { messages: [message] }, tool: { name: fn.name, description: fn.description, input_schema: fn.parameters }, search: { type: 'web_search_20250305', name: 'web_search' }, reply: anthropicReply('pause_turn') },
  { create: createChatCompletionsProtocol, intent: { messages: [message] }, tool: { type: 'function', function: fn }, reply: chatReply() },
  { create: createGeminiInteractionsProtocol, intent: { input: [{ type: 'user_input', content: [text] }] }, tool: { type: 'function', ...fn }, reply: { id: 'i', status: 'completed', steps: [{ type: 'model_output', content: [text] }] } },
]

async function scenario(entry, work) {
  const sent = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    sent.push(JSON.parse(Buffer.concat(chunks)))
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(entry.reply))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const protocol = entry.create()
  const f = await fixture({ requireManagedTools: true, protocols: [{ ...protocol, release() {} }] })
  try {
    const protocolId = protocol.descriptor.id
    const provider = await f.addProviderSettings({ id: 'p', name: 'p', enabled: true, auth: 'none', protocolId, timeoutMs: 5000, baseUrl: 'http://127.0.0.1:' + server.address().port })
    const value = { ...protocol.initialParameters?.(), ...(entry.search ? { tools: [entry.search] } : {}) }
    await f.addModelSettings({ id: 'm', providerId: 'p', remoteModelId: 'remote', name: 'm', enabled: true,
      capabilities: capabilities({ streaming: { support: 'unsupported' }, webSearch: { support: 'supported' } }), parameters: params(protocolId, value) })
    await work({ f, provider, sent })
  } finally { await f.close(); await new Promise(resolve => server.close(resolve)) }
}

function policy(functions = [], extra = {}) {
  return { functions, async runSend(_id, start, signal) {
    const op = start(signal)
    try { return await op.result } finally { await op.done }
  }, ...extra }
}

for (const entry of cases) test(entry.create().descriptor.id + ' compares the exact grant against the request received over HTTP', async () => {
  await scenario(entry, async ({ f, provider, sent }) => {
    await assert.rejects(f.open({ modelId: 'm' }), { code: 'capability-unsupported' })
    const empty = await f.open({ modelId: 'm', managedTools: policy() })
    await run(empty, entry.intent)
    assert.deepEqual(sent[0].tools ?? [], [])
    await assert.rejects(async () => run(empty, { ...entry.intent, tools: [entry.tool] }))
    assert.equal(sent.length, 1)
    await empty.close()

    const allowed = policy([fn], entry.search ? { hostedSearchTarget: nativeSearchTarget(provider) } : {})
    const full = await f.open({ modelId: 'm', managedTools: allowed })
    await run(full, { ...entry.intent, tools: [entry.tool] })
    const expected = entry.search ? [entry.tool, entry.search] : [entry.tool]
    assert.deepEqual(sent[1].tools, expected)
    const saved = await full.close()
    const restore = { ...saved.restoreState, records: saved.records }
    await assert.rejects(f.open({ modelId: 'm', managedTools: policy(), restore }))
    const same = await f.open({ modelId: 'm', managedTools: allowed, restore })
    await run(same, entry.create === createAnthropicMessagesProtocol ? { messages: [] } : entry.intent)
    assert.deepEqual(sent[2].tools, expected)
    await same.close()
  })
})

test('standalone text generation on a managed Models root sends an empty tool list', async () => {
  await scenario(cases[0], async ({ f, sent }) => {
    const op = f.models.generateText({ modelId: 'm', input: 'hello' })
    await op.result
    await op.done
    assert.deepEqual(sent[0].tools ?? [], [])
  })
})

for (const change of ['edit', 'delete']) test('hosted search rechecks a provider ' + change + ' after queued admission and before actual HTTP', async () => {
  await scenario(cases[0], async ({ f, provider, sent }) => {
    const waiting = deferred(), resume = deferred()
    const managedTools = policy([], { hostedSearchTarget: nativeSearchTarget(provider), async runSend(id, start, signal) {
      waiting.resolve()
      await resume.promise
      return policy().runSend(id, start, signal)
    } })
    const execution = await f.open({ modelId: 'm', managedTools })
    const operation = execution.prepareExchange(cases[0].intent).start()
    await waiting.promise
    if (change === 'delete') await f.settings.deleteProviderSettings(provider.id, provider.revision)
    else await f.settings.updateProviderSettings(provider.id, { name: 'updated account' }, provider.revision)
    resume.resolve()
    await assert.rejects(operation.result, { code: 'conflict' })
    await operation.done
    assert.equal(sent.length, 0)
    await execution.close()
  })
})
